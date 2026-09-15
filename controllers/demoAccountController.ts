// controllers/demoAccountController.ts
// ----------------------------------------------------------------------------
// DEMO / TRIAL account provisioner. Mints a REAL, persistent, premium-enabled
// account whose credentials an operator hands to an umbrella client's testers.
//
// Deliberately SEPARATE from the intake simulation. The sim's whole safety model
// is "everything I touch is disposable, lives in the __sim_ / *.invalid
// namespace, and gets torn down". Demo accounts are the opposite — real,
// persistent, real-domain email, must survive. Keeping them apart means the
// sim's destructive teardown + orphan sweeper can NEVER see a demo account, and
// this module can never invoke teardown. Shared low-level building blocks
// (createUserInDB, grantPermanentPremium, strongRandomPassword) are reused so
// there is no duplicated logic — only the orchestration differs.
//
// Namespace: username `demo_<id>`, email `demo+<id>@<DEMO_EMAIL_DOMAIN>`. Both
// are provably outside the sim's reserved namespace (asserted in tests), so the
// sim sweeper's `__sim_%` / `@*.invalid` criteria never match a demo account.
//
// The generated password is returned ONCE to the caller and is never logged or
// persisted in plaintext (only the bcrypt hash exists, via createUserInDB). The
// `demo_accounts` registry stores no password.
// ----------------------------------------------------------------------------

import { DB } from '../db';
import { createUserInDB, deleteUserFromDB } from './userController';
import { grantPermanentPremium } from '../services/premiumGrant';
import { strongRandomPassword } from '../utils/passwordGen';
import { newDemoIdentity, assertRevocable, normalizeRecipientEmail } from '../utils/demoIdentity';
import { emailService } from '../services/emailService';
import { Logger } from '../utils/logger';

const logger = new Logger('DemoAccount');

/** Base URL a tester logs in at. Uses the deployment's APP_URL, else the app domain. */
function loginUrl(): string {
  const base = (process.env.APP_URL || 'https://www.trymirror.world').replace(/\/+$/, '');
  return `${base}/login`;
}

export interface DemoAccount {
  userId: number;
  username: string;
  email: string;
  label: string | null;
  createdBy: string | null;
  createdAt: string;
  userExists?: boolean;    // list-only: false if the underlying user was removed out-of-band
  emailVerified?: boolean; // list-only: live status — should be true for a healthy demo account
  premiumActive?: boolean; // list-only: live status — should be true for a healthy demo account
  premiumTier?: string | null; // list-only: the subscription tier, if any
}
/** Best-effort outcome of the optional "email the credentials" step. */
export interface DemoEmailDelivery {
  attempted: boolean;
  sent: boolean;
  to?: string;
  error?: string;
}
export interface ProvisionedDemo extends DemoAccount {
  password: string; // returned ONCE — never logged or stored
  loginUrl: string;
  emailDelivery?: DemoEmailDelivery;
}

/** Self-bootstrapping registry (additive; same pattern as intake_simulation_runs). */
async function ensureRegistry(): Promise<void> {
  await DB.query(`
    CREATE TABLE IF NOT EXISTS demo_accounts (
      user_id     BIGINT       PRIMARY KEY,
      username    VARCHAR(64)  NOT NULL,
      email       VARCHAR(255) NOT NULL,
      label       VARCHAR(120) NULL,
      created_by  VARCHAR(120) NULL,
      created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_demo_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

/**
 * Provision one demo account: real user (dirs + keys + hashed pw) → email
 * pre-verified (friction-free login) → permanent premium → registry row.
 * Returns the credentials once. Retries on the rare identity collision.
 */
export async function provisionDemoAccount(
  opts: { label?: string | null; createdBy?: string | null; deliverTo?: string | null } = {},
): Promise<ProvisionedDemo> {
  await ensureRegistry();
  const label = opts.label ? String(opts.label).slice(0, 120) : null;
  const createdBy = opts.createdBy ? String(opts.createdBy).slice(0, 120) : null;
  // Validate the optional credential-email recipient up front (pure check).
  const deliverTo = normalizeRecipientEmail(opts.deliverTo);
  const password = strongRandomPassword();

  let userId: number | null = null;
  let identity = newDemoIdentity();
  for (let attempt = 0; attempt < 3 && userId === null; attempt++) {
    try {
      userId = await createUserInDB(identity.username, identity.email, password);
    } catch (e) {
      const msg = (e as Error)?.message || '';
      if (msg === 'USERNAME_TAKEN' || msg === 'EMAIL_ALREADY_REGISTERED') {
        identity = newDemoIdentity(); // fresh random id and retry
        continue;
      }
      throw e;
    }
  }
  if (userId === null) throw new Error('could not allocate a unique demo identity after retries');

  // Pre-verify (login works without an email round-trip) + grant premium.
  await DB.query('UPDATE users SET email_verified = 1 WHERE id = ?', [userId]);
  await grantPermanentPremium(userId);

  await DB.query(
    `INSERT INTO demo_accounts (user_id, username, email, label, created_by) VALUES (?, ?, ?, ?, ?)`,
    [userId, identity.username, identity.email, label, createdBy],
  );

  // Audit WITHOUT the password.
  logger.info('Provisioned demo account', { userId, username: identity.username, label, createdBy });

  const url = loginUrl();

  // Optional: email the tester their credentials, reusing the shared email
  // service + a stylized template. Best-effort — a delivery failure NEVER fails
  // the provision (the account already exists and the caller still gets the
  // credentials on screen). The password is passed to the template but the
  // email service logs only to/subject/messageId, never the body.
  let emailDelivery: DemoEmailDelivery | undefined;
  if (opts.deliverTo !== undefined) {
    if (!deliverTo) {
      emailDelivery = { attempted: true, sent: false, error: 'invalid recipient email' };
    } else {
      try {
        const r = await emailService.sendTemplate(deliverTo, 'demo_credentials', {
          greetingName: label || 'there',
          email: identity.email,
          password,
          loginUrl: url,
        });
        emailDelivery = { attempted: true, sent: r.success, to: deliverTo, error: r.success ? undefined : (r.error || 'send failed') };
      } catch (e) {
        emailDelivery = { attempted: true, sent: false, to: deliverTo, error: (e as Error)?.message || 'send exception' };
      }
    }
    // Audit the delivery attempt WITHOUT the password.
    logger.info('Demo credential email', { userId, to: deliverTo || null, sent: !!emailDelivery?.sent });
  }

  return {
    userId,
    username: identity.username,
    email: identity.email,
    label,
    createdBy,
    createdAt: new Date().toISOString(),
    password,
    loginUrl: url,
    emailDelivery,
  };
}

/** List demo accounts (newest first), flagging any whose underlying user is gone. */
export async function listDemoAccounts(): Promise<DemoAccount[]> {
  await ensureRegistry();
  // Left-join the live user + subscription rows so the operator can confirm at
  // a glance that each demo account is where it should be: user still exists,
  // email verified, premium active. 'active' status alone confers the tier
  // (see services/premiumGrant), matching how the app's own gate reads it.
  const [rows] = await DB.query(
    `SELECT d.user_id, d.username, d.email, d.label, d.created_by, d.created_at,
            u.id AS live_user_id, u.email_verified,
            s.tier AS sub_tier, s.status AS sub_status
       FROM demo_accounts d
       LEFT JOIN users u ON u.id = d.user_id
       LEFT JOIN user_subscriptions s ON s.user_id = d.user_id
      ORDER BY d.created_at DESC
      LIMIT 500`,
  );
  return (rows as any[]).map((r) => {
    const userExists = r.live_user_id != null;
    const premiumTier = r.sub_tier ?? null;
    const premiumActive = userExists && r.sub_status === 'active' && premiumTier === 'premium';
    return {
      userId: Number(r.user_id),
      username: String(r.username),
      email: String(r.email),
      label: r.label ?? null,
      createdBy: r.created_by ?? null,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      userExists,
      emailVerified: userExists ? Number(r.email_verified) === 1 : false,
      premiumActive,
      premiumTier,
    };
  });
}

/**
 * Revoke a demo account: delete the user via the canonical teardown, then drop
 * the registry row. GUARD (defense in depth): refuses any user_id NOT registered
 * in demo_accounts, so this can never delete a real user even if handed one.
 */
export async function revokeDemoAccount(userId: number, revokedBy?: string | null): Promise<{ deleted: boolean }> {
  await ensureRegistry();
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('invalid user id');

  const [rows] = await DB.query('SELECT user_id FROM demo_accounts WHERE user_id = ? LIMIT 1', [uid]);
  assertRevocable((rows as any[]).length > 0);

  await deleteUserFromDB(String(uid), uid); // filesystem + transactional DB cascade
  await DB.query('DELETE FROM demo_accounts WHERE user_id = ?', [uid]);
  logger.info('Revoked demo account', { userId: uid, revokedBy: revokedBy ? String(revokedBy).slice(0, 120) : null });
  return { deleted: true };
}
