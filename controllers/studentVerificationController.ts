// ============================================================================
// STUDENT VERIFICATION CONTROLLER
// ============================================================================
// File: controllers/studentVerificationController.ts
//
// Orchestrates the L1 student-access flow:
//   1. POST /request  (auth)  — validate eligibility, rate-limit, email a
//                               single-use token to the CAMPUS address.
//   2. POST /verify   (token) — token is the credential (proves inbox control);
//                               records the verification and grants the comp.
//   3. GET  /status   (auth)  — current student state for the UI.
//
// Depends on:
//   - services/studentDomainService  (pure eligibility — heavily unit-tested)
//   - paywall/student.config         (env-tunable knobs)
//   - subscription.service           (grantStudentComp — the ONLY entitlement path)
//   - accredited_domains / student_verifications / student_verification_tokens
//
// SECURITY NOTES
//   - The campus email is canonicalized (lower + strip "+tag") BEFORE any
//     uniqueness decision; the DB UNIQUE(normalized_email) is the authoritative
//     one-inbox-one-seat guard, the pre-checks here are UX.
//   - /verify trusts ONLY token.user_id (server-side), never a client id, so a
//     token can never grant premium to a different account.
//   - No SQL is built by concatenation — every dynamic value is a bound param.
// ============================================================================

import crypto from 'crypto';
import { RequestHandler } from 'express';
import { DB } from '../db';
import { mirrorRedis } from '../config/redis';
import { emailService } from '../services/emailService';
import { Logger } from '../utils/logger';
import { checkEligibility } from '../services/studentDomainService';
import type { SubscriptionService } from '../paywall/services/subscription.service';
import type { StudentConfig } from '../paywall/student.config';
import { addMonths } from '../paywall/student.config';

const logger = new Logger('StudentVerification');

const TOKEN_LENGTH = 32; // 32 bytes -> 64 hex chars
const DOMAIN_CACHE_KEY = 'student:domains';
const DOMAIN_CACHE_TTL = 300; // 5 minutes

interface DomainLists {
  allow: string[];
  deny: string[];
}

// ----------------------------------------------------------------------------
// Factory — receives the singleton subscriptionService + student config.
// ----------------------------------------------------------------------------
export function createStudentVerificationHandlers(
  subscriptionService: SubscriptionService,
  config: StudentConfig,
) {
  const appUrl = () => process.env.APP_URL || 'https://www.theundergroundrailroad.world/Mirror';

  /** Load allow/deny domain lists from DB, cached in Redis (fail-closed on error). */
  async function loadDomainLists(): Promise<DomainLists> {
    try {
      const cached = (await mirrorRedis.get(DOMAIN_CACHE_KEY)) as DomainLists | null;
      if (cached && Array.isArray(cached.allow) && Array.isArray(cached.deny)) {
        return cached;
      }
    } catch {
      // ignore cache read errors; fall through to DB
    }

    const [rows] = await DB.query(
      'SELECT domain, status FROM accredited_domains WHERE status IN (?, ?)',
      ['active', 'blocked'],
    );
    const lists: DomainLists = { allow: [], deny: [] };
    for (const r of rows as any[]) {
      const d = String(r.domain || '').trim().toLowerCase();
      if (!d) continue;
      if (r.status === 'blocked') lists.deny.push(d);
      else lists.allow.push(d);
    }

    try {
      await mirrorRedis.set(DOMAIN_CACHE_KEY, lists, DOMAIN_CACHE_TTL);
    } catch {
      // non-fatal
    }
    return lists;
  }

  // ==========================================================================
  // POST /mirror/api/student/request   (authenticated)
  // Body: { campusEmail: string, attest18: boolean }
  // ==========================================================================
  const requestVerification: RequestHandler = async (req, res) => {
    try {
      if (!config.enabled) {
        res.status(403).json({ error: 'Student access is not currently available.', code: 'STUDENT_ACCESS_DISABLED' });
        return;
      }

      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
        return;
      }

      const campusEmail = req.body?.campusEmail;
      const attest18 = req.body?.attest18;

      if (typeof campusEmail !== 'string' || campusEmail.length > 254) {
        res.status(400).json({ error: 'A valid school email is required.', code: 'INVALID_INPUT' });
        return;
      }
      if (typeof attest18 !== 'boolean') {
        res.status(400).json({ error: 'Age confirmation is required.', code: 'AGE_REQUIRED' });
        return;
      }

      // Eligibility (pure, tested). Fail-closed: empty allowlist => nobody passes.
      const lists = await loadDomainLists();
      const eligibility = checkEligibility({
        email: campusEmail,
        attest18,
        allowlist: lists.allow,
        denylist: lists.deny,
        mode: config.mode,
      });

      if (!eligibility.ok || !eligibility.email || !eligibility.matchedDomain) {
        const httpCode =
          eligibility.code === 'AGE_NOT_ATTESTED' ? 400 :
          eligibility.code === 'BLOCKED_DOMAIN' ? 400 :
          eligibility.code === 'NOT_ACCREDITED' ? 400 : 400;
        res.status(httpCode).json({ error: eligibility.reason, code: eligibility.code });
        return;
      }

      const normalizedEmail = eligibility.email.normalized;
      const matchedDomain = eligibility.matchedDomain;

      // Anti-abuse: campus mailbox already claimed by a DIFFERENT account.
      const [claimRows] = await DB.query(
        'SELECT user_id FROM student_verifications WHERE normalized_email = ? LIMIT 1',
        [normalizedEmail],
      );
      const claim = (claimRows as any[])[0];
      if (claim && claim.user_id !== userId) {
        // Neutral message — does not reveal which account holds it.
        res.status(409).json({
          error: 'This school email is already linked to a Mirror account and can\'t be reused.',
          code: 'EMAIL_ALREADY_CLAIMED',
        });
        return;
      }

      // Per-user resend cooldown.
      const [recent] = await DB.query(
        'SELECT created_at FROM student_verification_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
        [userId],
      );
      if ((recent as any[]).length > 0) {
        const elapsed = Date.now() - new Date((recent as any[])[0].created_at).getTime();
        const cooldownMs = config.resendCooldownSeconds * 1000;
        if (elapsed < cooldownMs) {
          const retryAfter = Math.ceil((cooldownMs - elapsed) / 1000);
          res.status(429).json({
            error: `Please wait ${retryAfter} seconds before requesting another confirmation email.`,
            code: 'RATE_LIMITED',
            retryAfter,
          });
          return;
        }
      }

      // Per-user active-token cap: purge stale pending tokens when exceeded.
      const [countRows] = await DB.query(
        'SELECT COUNT(*) AS c FROM student_verification_tokens WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW()',
        [userId],
      );
      if ((countRows as any[])[0].c >= config.maxActiveTokens) {
        await DB.query('DELETE FROM student_verification_tokens WHERE user_id = ? AND used_at IS NULL', [userId]);
      }

      // Per-domain daily cap: blunts catch-all / bulk abuse from one institution.
      const [domainCountRows] = await DB.query(
        `SELECT COUNT(*) AS c FROM student_verification_tokens
         WHERE matched_domain = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)`,
        [matchedDomain],
      );
      if ((domainCountRows as any[])[0].c >= config.maxPerDomainPerDay) {
        logger.warn('Per-domain daily student cap hit', { matchedDomain });
        res.status(429).json({
          error: 'Too many student verifications from this school today. Please try again tomorrow.',
          code: 'DOMAIN_RATE_LIMITED',
        });
        return;
      }

      // Issue single-use token.
      const token = crypto.randomBytes(TOKEN_LENGTH).toString('hex');
      const expiresAt = new Date(Date.now() + config.tokenExpiryHours * 60 * 60 * 1000);

      await DB.query(
        `INSERT INTO student_verification_tokens
           (user_id, normalized_email, matched_domain, attested_18, token, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, normalizedEmail, matchedDomain, attest18 ? 1 : 0, token, expiresAt],
      );

      const verificationUrl = `${appUrl()}/students/verify?token=${token}`;
      const result = await emailService.sendTemplate(normalizedEmail, 'student_verification', {
        verificationUrl,
        expiresInHours: String(config.tokenExpiryHours),
      });

      if (!result.success) {
        logger.error('Failed to send student verification email', new Error(result.error || 'Unknown'), { userId });
        res.status(503).json({
          error: 'Could not send the confirmation email. Please try again in a few minutes.',
          code: 'EMAIL_SEND_FAILED',
        });
        return;
      }

      logger.info('Student verification email sent', { userId, matchedDomain });
      res.json({
        message: 'Check your school email to confirm and activate free Premium.',
        expiresIn: `${config.tokenExpiryHours} hours`,
      });
    } catch (error: any) {
      logger.error('Student verification request error', error);
      res.status(500).json({ error: 'Could not start student verification.', code: 'INTERNAL_ERROR' });
    }
  };

  // ==========================================================================
  // POST /mirror/api/student/verify   (unauthenticated — token is the credential)
  // Body: { token: string }
  // ==========================================================================
  const verifyToken: RequestHandler = async (req, res) => {
    try {
      if (!config.enabled) {
        res.status(403).json({ error: 'Student access is not currently available.', code: 'STUDENT_ACCESS_DISABLED' });
        return;
      }

      const { token } = req.body || {};
      if (!token || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
        res.status(400).json({ error: 'Invalid or missing token.', code: 'INVALID_TOKEN' });
        return;
      }

      const [tokenRows] = await DB.query(
        `SELECT id, user_id, normalized_email, matched_domain, attested_18, expires_at, used_at
         FROM student_verification_tokens WHERE token = ?`,
        [token],
      );
      const tk = (tokenRows as any[])[0];

      if (!tk) {
        res.status(404).json({ error: 'This confirmation link is invalid.', code: 'TOKEN_NOT_FOUND' });
        return;
      }

      const userId: number = tk.user_id;
      const normalizedEmail: string = tk.normalized_email;
      const matchedDomain: string = tk.matched_domain;

      if (tk.used_at) {
        // Idempotent success if this user already holds an active verification for it.
        const [vrows] = await DB.query(
          'SELECT id FROM student_verifications WHERE user_id = ? AND normalized_email = ? AND status = ? LIMIT 1',
          [userId, normalizedEmail, 'active'],
        );
        if ((vrows as any[]).length > 0) {
          res.json({ verified: true, message: 'Student access already active.' });
          return;
        }
        res.status(410).json({ error: 'This confirmation link has already been used.', code: 'TOKEN_USED' });
        return;
      }

      if (new Date(tk.expires_at) < new Date()) {
        res.status(410).json({ error: 'This confirmation link has expired. Request a new one.', code: 'TOKEN_EXPIRED' });
        return;
      }

      // Race guard: a DIFFERENT account may have claimed this mailbox meanwhile.
      const [claimRows] = await DB.query(
        'SELECT user_id FROM student_verifications WHERE normalized_email = ? LIMIT 1',
        [normalizedEmail],
      );
      const claim = (claimRows as any[])[0];
      if (claim && claim.user_id !== userId) {
        res.status(409).json({
          error: 'This school email is already linked to another Mirror account.',
          code: 'EMAIL_ALREADY_CLAIMED',
        });
        return;
      }

      const grantExpiry = addMonths(new Date(), config.grantMonths);

      // Upsert the verification record WITHOUT the cross-row hazard of a blind
      // ON DUPLICATE KEY (which could mutate another user's email-keyed row).
      const [existingForUser] = await DB.query(
        'SELECT id FROM student_verifications WHERE user_id = ? LIMIT 1',
        [userId],
      );
      const method = config.mode === 'suffix_edu' ? 'email_suffix' : 'email_allowlist';

      try {
        if ((existingForUser as any[]).length > 0) {
          await DB.query(
            `UPDATE student_verifications
             SET normalized_email = ?, matched_domain = ?, method = ?, attested_18 = ?,
                 status = 'active', verified_at = NOW(), expires_at = ?, revoked_reason = NULL
             WHERE user_id = ?`,
            [normalizedEmail, matchedDomain, method, tk.attested_18 ? 1 : 0, grantExpiry, userId],
          );
        } else {
          await DB.query(
            `INSERT INTO student_verifications
               (user_id, normalized_email, matched_domain, method, attested_18, status, verified_at, expires_at)
             VALUES (?, ?, ?, ?, ?, 'active', NOW(), ?)`,
            [userId, normalizedEmail, matchedDomain, method, tk.attested_18 ? 1 : 0, grantExpiry],
          );
        }
      } catch (e: any) {
        if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) {
          res.status(409).json({
            error: 'This school email is already linked to another Mirror account.',
            code: 'EMAIL_ALREADY_CLAIMED',
          });
          return;
        }
        throw e;
      }

      // Grant the comp (the ONLY entitlement path). Never clobbers a paid sub.
      const grant = await subscriptionService.grantStudentComp(userId, {
        expiresAt: grantExpiry,
        matchedDomain,
      });

      // Consume this token + invalidate this user's other pending tokens.
      await DB.query('UPDATE student_verification_tokens SET used_at = NOW() WHERE id = ?', [tk.id]);
      await DB.query(
        'UPDATE student_verification_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL AND id != ?',
        [userId, tk.id],
      );

      // Audit (non-blocking).
      try {
        await DB.query(
          `INSERT INTO activity_logs (user_id, action, metadata, risk_level, page_url, created_at)
           VALUES (?, 'student_verified', ?, 'low', '/students/verify', NOW())`,
          [userId, JSON.stringify({ matchedDomain, granted: grant.granted, reason: grant.reason })],
        );
      } catch { /* non-blocking */ }

      // Confirmation email to the ACCOUNT owner.
      try {
        const [urows] = await DB.query('SELECT email FROM users WHERE id = ?', [userId]);
        const accountEmail = (urows as any[])[0]?.email;
        if (accountEmail) {
          await emailService.queueEmail(accountEmail, 'student_access_granted', {
            expiresOn: grantExpiry.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
          });
        }
      } catch { /* non-blocking */ }

      logger.info('Student verified', { userId, matchedDomain, granted: grant.granted });
      res.json({
        verified: true,
        premiumGranted: grant.granted,
        alreadyPremium: !grant.granted,
        accessUntil: grantExpiry.toISOString(),
        message: grant.granted
          ? 'Your student status is confirmed — Premium is now active.'
          : 'Your student status is confirmed. You already have Premium via your current plan.',
      });
    } catch (error: any) {
      logger.error('Student verification error', error);
      res.status(500).json({ error: 'Verification failed. Please try again.', code: 'INTERNAL_ERROR' });
    }
  };

  // ==========================================================================
  // GET /mirror/api/student/status   (authenticated)
  // ==========================================================================
  const getStatus: RequestHandler = async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
        return;
      }

      const [rows] = await DB.query(
        `SELECT normalized_email, matched_domain, status, verified_at, expires_at
         FROM student_verifications WHERE user_id = ? LIMIT 1`,
        [userId],
      );
      const row = (rows as any[])[0];

      if (!row) {
        res.json({ enabled: config.enabled, isStudent: false, status: null });
        return;
      }

      const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
      const daysLeft = expiresAt
        ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
        : null;

      res.json({
        enabled: config.enabled,
        isStudent: row.status === 'active',
        status: row.status,
        campusEmail: row.normalized_email,
        institutionDomain: row.matched_domain,
        verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        daysLeft,
      });
    } catch (error: any) {
      logger.error('Student status error', error);
      res.status(500).json({ error: 'Could not load student status.', code: 'INTERNAL_ERROR' });
    }
  };

  return { requestVerification, verifyToken, getStatus };
}
