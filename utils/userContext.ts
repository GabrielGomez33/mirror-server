// utils/userContext.ts
// ----------------------------------------------------------------------------
// The user-context fields every auth response (login / verify) carries:
// email, verification, BOTH intake flags, and subscription tier.
//
// ROBUSTNESS CONTRACT — the hardening this module exists for
//   The CORE user-row read MUST succeed. If that query THROWS (DB down, unknown
//   column, connection loss) we THROW UserContextUnavailableError. We do NOT
//   fabricate a blank "unverified / not-onboarded / free" identity on a read
//   failure — that silent all-false fallback was a latent footgun: a transient
//   blip would force an onboarded user back through onboarding, hide a premium
//   subscription, and drop verified state, all while looking like a normal
//   response. Callers translate the throw into a RETRYABLE 503, never a
//   fabricated session.
//
//   A read failure is NOT the same as "the user has no data" — exactly the same
//   invariant the client-side root gate (components/auth/rootGate) enforces.
//
// WHAT IS NOT an error
//   * A query that SUCCEEDS with no matching row is a DEFINITE "no such user"
//     (e.g. a deleted account with a still-live token), not a failure — it maps
//     to the empty/false projection and never throws.
//   * The SUBSCRIPTION read is BEST EFFORT: a missing/erroring paywall table
//     legitimately means "free" and must never fail the whole load.
//
// The DB is injected (QueryFn) so the whole contract is unit-testable with no
// live database and no module-singleton mocking.
// ----------------------------------------------------------------------------

export class UserContextUnavailableError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'UserContextUnavailableError';
    this.cause = cause;
  }
}

export type SubscriptionStatus = 'free' | 'premium' | 'enterprise';

export interface UserContextFields {
  email: string;
  emailVerified: boolean;
  intakeCompleted: boolean;
  initialIntakeCompleted: boolean;
  subscriptionStatus: SubscriptionStatus;
}

/** mysql2-shaped query: resolves to [rows, fields]. */
export type QueryFn = (sql: string, params: unknown[]) => Promise<any>;

export interface LoadUserContextOptions {
  /** Extra attempts for the CORE row read after the first (absorbs a transient
   *  pool/network blip before failing loud). Default 1. */
  retries?: number;
  /** Delay between core-read attempts, ms. Default 100. Tests pass 0. */
  delayMs?: number;
}

/** Map a raw subscription tier to the gate's enum. Anything that is not exactly
 *  'premium' or 'enterprise' (including 'active', 'basic', null, undefined) is
 *  'free'. Pure. */
export function pickSubscriptionStatus(tier: unknown): SubscriptionStatus {
  return tier === 'premium' || tier === 'enterprise' ? tier : 'free';
}

/** Pure projection of a `users` row → context fields. A null/undefined row is a
 *  genuine "no such user" (query succeeded, matched nothing) and maps to
 *  empty/false — it NEVER throws. Read FAILURES are handled in loadUserContext
 *  (they throw before we ever get here). */
export function projectUserContextRow(
  row: Record<string, any> | null | undefined,
  subscriptionStatus: SubscriptionStatus,
): UserContextFields {
  const r = row || {};
  return {
    email: String(r.email || ''),
    emailVerified: Boolean(r.email_verified),
    intakeCompleted: Boolean(r.intake_completed),
    initialIntakeCompleted: Boolean(r.initial_intake_completed),
    subscriptionStatus,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Load the user-context fields via the injected query fn. See the module header
 * for the robustness contract. Throws UserContextUnavailableError iff the CORE
 * row read fails on every attempt.
 */
export async function loadUserContext(
  userId: number,
  query: QueryFn,
  opts: LoadUserContextOptions = {},
): Promise<UserContextFields> {
  const retries = Math.max(0, opts.retries ?? 1);
  const delayMs = Math.max(0, opts.delayMs ?? 100);

  // --- CORE read: MUST succeed (bounded retry, then fail loud). --------------
  let row: Record<string, any> | undefined;
  let lastErr: unknown;
  let ok = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const [rows] = await query(
        `SELECT email, email_verified, intake_completed, initial_intake_completed FROM users WHERE id = ? LIMIT 1`,
        [userId],
      );
      row = (rows as any[])[0];
      ok = true;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < retries && delayMs > 0) await sleep(delayMs);
    }
  }
  if (!ok) {
    // NEVER fabricate all-false here — that is the footgun we are removing.
    throw new UserContextUnavailableError(`Failed to read user context for user ${userId}`, lastErr);
  }

  // --- SUBSCRIPTION read: BEST EFFORT, degrades to 'free'. -------------------
  // Table names are hard-coded literals, never user input. Read
  // `user_subscriptions` first (the table the premium gate enforces) so the
  // response agrees with what the gate allows; fall back to legacy `subscriptions`.
  let subscriptionStatus: SubscriptionStatus = 'free';
  for (const table of ['user_subscriptions', 'subscriptions']) {
    try {
      const [subRows] = await query(
        `SELECT tier FROM ${table} WHERE user_id = ? AND status IN ('active','trialing','past_due') ORDER BY id DESC LIMIT 1`,
        [userId],
      );
      const picked = pickSubscriptionStatus((subRows as any[])[0]?.tier);
      if (picked !== 'free') {
        subscriptionStatus = picked;
        break;
      }
    } catch {
      // table missing in this environment — try the next one (best effort → free)
    }
  }

  return projectUserContextRow(row, subscriptionStatus);
}
