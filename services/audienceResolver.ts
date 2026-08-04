// ============================================================================
// AUDIENCE RESOLVER
// ============================================================================
// File: services/audienceResolver.ts
// ----------------------------------------------------------------------------
// SINGLE RESPONSIBILITY: decide WHICH people a campaign targets, and write them
// into the shared send list (email_campaign_recipients). Nothing here sends
// email, compiles HTML, or manages campaigns — that stays in
// emailBroadcastService / the worker. This module is the seam that lets one
// campaign engine serve multiple, independent audience SOURCES.
//
// SOURCES (each owns its OWN table + its OWN filters — never intertwined):
//   * 'users'    -> users            (verified/locked/intake/role/date filters)
//   * 'waitlist' -> waitlist_signups (waitlist status + signup source/date)
//
// Waitlist people are NOT subject to any user check (email_verified,
// account_locked, intake_completed, role, last_login) — those columns don't
// exist for them. They are filtered on their own terms.
//
// SECURITY
//   * Every value goes in as a bound parameter (?). No string interpolation of
//     user input into SQL — zero injection surface.
//   * Enum-like inputs (waitlist statuses) are validated against a fixed
//     allow-list before use; anything unknown is dropped.
//
// IDEMPOTENCY (shared send list)
//   * users    rows dedupe on UNIQUE(campaign_id, user_id).
//   * waitlist rows dedupe on UNIQUE(campaign_id, waitlist_id) (migration 019).
//   Both inserts use INSERT IGNORE, so re-resolving an audience is a no-op and
//   a crash/retry can never double-insert -> never double-send.
// ============================================================================

import { DB } from '../db';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type AudienceSource = 'users' | 'waitlist';

export interface AudienceFilter {
  /** Which table the audience is drawn from. Defaults to 'users' for full
   *  backward-compatibility with campaigns created before waitlist support. */
  source?: AudienceSource;

  // --- users-source selectors (ignored for the waitlist source) ---
  mode: 'all' | 'filter' | 'specific';
  /** Only users with email_verified=1. Defaults to true for deliverability. */
  verifiedOnly?: boolean;
  /** true => intake_completed=1, false => =0, undefined => no constraint. */
  intakeCompleted?: boolean;
  /** Restrict by users.role. */
  role?: string | null;
  /** ISO date — created strictly before this. */
  registeredBefore?: string;
  /** ISO date — created on/after this. */
  registeredAfter?: string;
  /** ISO date — users whose last_login >= this. */
  activeSince?: string;
  /** Exclude locked accounts. Defaults to true. */
  excludeLocked?: boolean;
  /** For mode='specific': explicit user ids. */
  userIds?: number[];

  // --- waitlist-source selectors (ignored for the users source) ---
  /** Restrict to these waitlist lifecycle statuses. Validated against an
   *  allow-list; defaults to the subscribable set below. */
  waitlistStatuses?: string[];
  /** Restrict to a single signup surface, e.g. 'landing'. */
  waitlistSource?: string | null;
}

export interface AudiencePreview {
  total: number;
  suppressed: number;
  sample: { username: string; email: string }[];
}

// ----------------------------------------------------------------------------
// Config / allow-lists
// ----------------------------------------------------------------------------

// waitlist_signups.status values that are eligible to receive campaigns.
// 'converted' (already a user) and 'unsubscribed' are deliberately excluded.
export const SUBSCRIBABLE_WAITLIST_STATUSES = ['pending', 'confirmed', 'invited'] as const;

// Every valid waitlist status, used to validate operator-supplied filters.
const ALL_WAITLIST_STATUSES = new Set<string>([
  'pending', 'confirmed', 'invited', 'converted', 'unsubscribed',
]);

export function resolveSource(filter: AudienceFilter | undefined | null): AudienceSource {
  return filter?.source === 'waitlist' ? 'waitlist' : 'users';
}

/** Accurate CAN-SPAM/consent line for the footer, per source. */
export function consentLineFor(source: AudienceSource): string {
  if (source === 'waitlist') {
    return "You're receiving this because you joined the Mirror waitlist.";
  }
  return "You're receiving this because you have a Mirror account.";
}

// ----------------------------------------------------------------------------
// USERS source — WHERE builder (operates on alias `u`)
// (Behaviour preserved verbatim from the original emailBroadcastService.)
// ----------------------------------------------------------------------------

export function buildUsersWhere(filter: AudienceFilter): { where: string; params: any[] } {
  const clauses: string[] = ["u.email IS NOT NULL", "u.email <> ''"];
  const params: any[] = [];

  if (filter.mode === 'specific') {
    const ids = Array.isArray(filter.userIds) ? filter.userIds.filter(n => Number.isInteger(n)) : [];
    if (ids.length === 0) {
      clauses.push('1 = 0'); // no valid ids -> match nothing
    } else {
      clauses.push('u.id IN (?)');
      params.push(ids);
    }
  }

  if (filter.verifiedOnly !== false) {
    clauses.push('u.email_verified = 1');
  }
  if (filter.excludeLocked !== false) {
    clauses.push("(u.account_locked = 0 OR u.account_locked IS NULL)");
  }
  if (typeof filter.intakeCompleted === 'boolean') {
    clauses.push('u.intake_completed = ?');
    params.push(filter.intakeCompleted ? 1 : 0);
  }
  if (filter.role) {
    clauses.push('u.role = ?');
    params.push(String(filter.role));
  }
  if (filter.registeredBefore) {
    clauses.push('u.created_at < ?');
    params.push(filter.registeredBefore);
  }
  if (filter.registeredAfter) {
    clauses.push('u.created_at >= ?');
    params.push(filter.registeredAfter);
  }
  if (filter.activeSince) {
    clauses.push('u.last_login >= ?');
    params.push(filter.activeSince);
  }

  return { where: clauses.join(' AND '), params };
}

// ----------------------------------------------------------------------------
// WAITLIST source — WHERE builder (operates on alias `w`)
// Entirely independent of the users checks.
// ----------------------------------------------------------------------------

export function buildWaitlistWhere(filter: AudienceFilter): { where: string; params: any[] } {
  const clauses: string[] = ["w.email IS NOT NULL", "w.email <> ''"];
  const params: any[] = [];

  // Status filter: validate against the allow-list, else fall back to the
  // subscribable set. Never let an unvalidated string into the query.
  const requested = Array.isArray(filter.waitlistStatuses) ? filter.waitlistStatuses : [];
  const validRequested = requested.filter((s) => ALL_WAITLIST_STATUSES.has(String(s)));
  const statuses = validRequested.length > 0
    ? validRequested
    : [...SUBSCRIBABLE_WAITLIST_STATUSES];
  clauses.push('w.status IN (?)');
  params.push(statuses);

  if (filter.waitlistSource) {
    clauses.push('w.source = ?');
    params.push(String(filter.waitlistSource));
  }
  if (filter.registeredBefore) {
    clauses.push('w.created_at < ?');
    params.push(filter.registeredBefore);
  }
  if (filter.registeredAfter) {
    clauses.push('w.created_at >= ?');
    params.push(filter.registeredAfter);
  }

  return { where: clauses.join(' AND '), params };
}

// ----------------------------------------------------------------------------
// Materialisation — write resolved people into the shared send list.
// Dispatches by source; each branch owns exactly one table.
// ----------------------------------------------------------------------------

// Pure builder (no DB) so the idempotency-critical SQL shape is unit-testable.
// Each source targets exactly one table and inserts with the discriminator +
// the key that makes INSERT IGNORE idempotent for that source:
//   users    -> UNIQUE(campaign_id, user_id)
//   waitlist -> UNIQUE(campaign_id, waitlist_id)   (migration 019)
export function buildRecipientInsert(
  campaignId: number,
  filter: AudienceFilter,
): { sql: string; params: any[] } {
  if (resolveSource(filter) === 'waitlist') {
    const { where, params } = buildWaitlistWhere(filter);
    return {
      sql:
        `INSERT IGNORE INTO email_campaign_recipients
           (campaign_id, source, user_id, waitlist_id, email, status)
         SELECT ?, 'waitlist', NULL, w.id, LOWER(w.email), 'pending'
           FROM waitlist_signups w
          WHERE ${where}`,
      params: [campaignId, ...params],
    };
  }

  const { where, params } = buildUsersWhere(filter);
  return {
    sql:
      `INSERT IGNORE INTO email_campaign_recipients
         (campaign_id, source, user_id, email, status)
       SELECT ?, 'user', u.id, LOWER(u.email), 'pending'
         FROM users u
        WHERE ${where}`,
    params: [campaignId, ...params],
  };
}

export async function insertRecipients(campaignId: number, filter: AudienceFilter): Promise<void> {
  const { sql, params } = buildRecipientInsert(campaignId, filter);
  await DB.query(sql, params);
}

// ----------------------------------------------------------------------------
// Preview — counts + a small sample, without materialising anything.
// Dispatches by source.
// ----------------------------------------------------------------------------

export async function previewAudience(filter: AudienceFilter): Promise<AudiencePreview> {
  return resolveSource(filter) === 'waitlist'
    ? previewWaitlist(filter)
    : previewUsers(filter);
}

async function previewUsers(filter: AudienceFilter): Promise<AudiencePreview> {
  const { where, params } = buildUsersWhere(filter);

  const [countRows] = await DB.query(`SELECT COUNT(*) AS n FROM users u WHERE ${where}`, params);
  const total = Number((countRows as any[])[0]?.n ?? 0);

  const [supRows] = await DB.query(
    `SELECT COUNT(*) AS n FROM users u
       JOIN email_suppressions s ON s.email = LOWER(u.email)
      WHERE ${where}`,
    params,
  );
  const suppressed = Number((supRows as any[])[0]?.n ?? 0);

  const [sampleRows] = await DB.query(
    `SELECT username, email FROM users u WHERE ${where} ORDER BY u.id DESC LIMIT 5`,
    params,
  );
  const sample = (sampleRows as any[]).map(r => ({ username: r.username, email: r.email }));

  return { total, suppressed, sample };
}

async function previewWaitlist(filter: AudienceFilter): Promise<AudiencePreview> {
  const { where, params } = buildWaitlistWhere(filter);

  const [countRows] = await DB.query(`SELECT COUNT(*) AS n FROM waitlist_signups w WHERE ${where}`, params);
  const total = Number((countRows as any[])[0]?.n ?? 0);

  // waitlist_signups.email and email_suppressions.email were created with
  // different collations (utf8mb4_0900_ai_ci vs utf8mb4_unicode_ci), so an
  // implicit `=` across them raises "Illegal mix of collations". Force the
  // comparison to the system collation (utf8mb4_unicode_ci, the convention used
  // by email_suppressions / users). The literal is a fixed identifier, not user
  // input. Migration 020 aligns the table so this hint becomes belt-and-braces.
  const [supRows] = await DB.query(
    `SELECT COUNT(*) AS n FROM waitlist_signups w
       JOIN email_suppressions s
         ON s.email = LOWER(w.email) COLLATE utf8mb4_unicode_ci
      WHERE ${where}`,
    params,
  );
  const suppressed = Number((supRows as any[])[0]?.n ?? 0);

  // Waitlist has no username; surface the email local-part so the sample is
  // still human-readable in the admin preview.
  const [sampleRows] = await DB.query(
    `SELECT email FROM waitlist_signups w WHERE ${where} ORDER BY w.id DESC LIMIT 5`,
    params,
  );
  const sample = (sampleRows as any[]).map(r => ({
    username: String(r.email || '').split('@')[0] || 'there',
    email: r.email,
  }));

  return { total, suppressed, sample };
}
