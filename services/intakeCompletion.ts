// services/intakeCompletion.ts
// ----------------------------------------------------------------------------
// Single source of truth for CORE intake completion.
//
// Responsibility (one concern): translate per-step progress rows in
// `core_intake_progress` into the derived `users.intake_completed` flag, and
// provide the read/write primitives the progress endpoints + the legacy
// /store bridge both use. NO HTTP here; NO business rules about Entry intake
// (that is a separate pipeline). See docs/entry-core-intake-spec.md §3.
//
// The PURE helpers (CORE_STEPS, isCoreStep, stepsPresentInPayload,
// isIntakeComplete) carry no I/O and are unit-tested in isolation. The DB
// helpers hold a per-user row lock so completion + derivation are atomic and
// concurrency-safe (spec §8 cases 1, 2, 8).
// ----------------------------------------------------------------------------

import { DB } from '../db';
import type { PoolConnection } from 'mysql2/promise';
import { sanitizeDraftState, projectStepDraft, type StepDraft } from '../utils/coreDraft';

// The five deep-intake steps, in canonical order. This is the allowlist that
// gates every `:step` path param — nothing else ever reaches SQL.
export const CORE_STEPS = ['visual', 'vocal', 'iq', 'astrology', 'personality'] as const;
export type CoreStep = (typeof CORE_STEPS)[number];

export type StepStatus = 'not_started' | 'in_progress' | 'completed';
export interface ProgressRow {
  step: CoreStep;
  status: StepStatus;
  completedAt: string | null;
}

/** Max serialized size of a resumable draft (defense against draft bloat). */
export const MAX_DRAFT_BYTES = 100_000;

export class DraftTooLargeError extends Error {
  constructor() {
    super('draft_state exceeds maximum size');
    this.name = 'DraftTooLargeError';
  }
}

// ---------------------------------------------------------------------------
// PURE helpers (no I/O)
// ---------------------------------------------------------------------------

/** Type guard: is `x` one of the five canonical core step keys? */
export function isCoreStep(x: unknown): x is CoreStep {
  return typeof x === 'string' && (CORE_STEPS as readonly string[]).includes(x);
}

/**
 * Which core steps does this intake payload supply data for? Used by the legacy
 * /store bridge to mark the right steps completed. A section counts as "present"
 * when its load-bearing field exists on the payload.
 */
export function stepsPresentInPayload(intakeData: unknown): CoreStep[] {
  if (!intakeData || typeof intakeData !== 'object') return [];
  const d = intakeData as Record<string, unknown>;
  const steps: CoreStep[] = [];
  if (d.faceAnalysis || d.photoFileRef) steps.push('visual');
  if (d.voiceMetadata || d.voiceFileRef) steps.push('vocal');
  if (d.iqResults) steps.push('iq');
  if (d.astrologicalResult) steps.push('astrology');
  if (d.personalityResult) steps.push('personality');
  return steps;
}

/** True iff every core step appears in the set of completed step keys. */
export function isIntakeComplete(completedStepKeys: Iterable<string>): boolean {
  const set = new Set(completedStepKeys);
  return CORE_STEPS.every((s) => set.has(s));
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/** Read all five steps' status for a user (missing rows => 'not_started'). */
export async function getProgress(userId: number): Promise<ProgressRow[]> {
  const [rows] = await DB.query(
    `SELECT step_key, status, completed_at FROM core_intake_progress WHERE user_id = ?`,
    [userId]
  );
  return projectProgress(rows as any[]);
}

function projectProgress(rows: any[]): ProgressRow[] {
  const byStep = new Map<string, any>(rows.map((r) => [r.step_key, r]));
  return CORE_STEPS.map((step) => {
    const r = byStep.get(step);
    return {
      step,
      status: (r?.status as StepStatus) ?? 'not_started',
      completedAt: r?.completed_at ? new Date(r.completed_at).toISOString() : null,
    };
  });
}

/**
 * Upsert a step to 'in_progress' with an optional resumable draft. Never
 * downgrades a 'completed' step. Throws DraftTooLargeError if the draft is too
 * big to store.
 */
export async function saveStepDraft(
  userId: number,
  step: CoreStep,
  draftState: unknown
): Promise<void> {
  // Content backstop: strip any media/blob a client tried to smuggle into the
  // draft BEFORE it ever reaches storage (utils/coreDraft, pure + tested).
  const clean = sanitizeDraftState(draftState);
  const json = clean === null ? null : JSON.stringify(clean);
  if (json !== null && Buffer.byteLength(json, 'utf8') > MAX_DRAFT_BYTES) {
    throw new DraftTooLargeError();
  }
  await DB.query(
    `INSERT INTO core_intake_progress (user_id, step_key, status, draft_state)
     VALUES (?, ?, 'in_progress', ?)
     ON DUPLICATE KEY UPDATE
       draft_state = VALUES(draft_state),
       status = IF(status = 'completed', 'completed', 'in_progress')`,
    [userId, step, json]
  );
}

/**
 * Read ONE step's draft + status (the resume read-path). Returns a never-started
 * shape when no row exists. draft_state is sanitized on the way IN (saveStepDraft)
 * and projected safely on the way OUT (projectStepDraft), so a legacy/corrupt
 * value degrades to null rather than throwing. JWT-scoped by the caller — this
 * takes a userId, never a param, so there is no IDOR surface.
 */
export async function getStepDraft(userId: number, step: CoreStep): Promise<StepDraft> {
  const [rows] = await DB.query(
    `SELECT step_key, status, completed_at, draft_state
       FROM core_intake_progress WHERE user_id = ? AND step_key = ? LIMIT 1`,
    [userId, step]
  );
  return projectStepDraft(step, (rows as any[])[0]);
}

/**
 * Reset ONE step's progress — the "erase progress" affordance for a resumable
 * draft. Rather than DELETE the row, it turns an in-progress draft into a
 * not_started TOMBSTONE (status='not_started', draft_state=NULL). That row is
 * the durable, cross-device signal an erase happened: a second device reads it
 * on hydrate (StepDraft.erased) and wipes its own stale local draft, so erase is
 * authoritative everywhere, not just on the device that clicked it.
 *
 * SECURITY/INVARIANT: the `AND status = 'in_progress'` guard means a COMPLETED
 * step is never touched (never silently un-completed) and a commit/erase race
 * cannot lose a completion — whichever of complete/erase runs first, a completed
 * row no longer matches the WHERE. Returns true iff an in-progress draft was
 * actually cleared (a second erase, a completed step, or a never-started step
 * all report false — there was nothing to erase).
 */
export async function resetStepDraft(userId: number, step: CoreStep): Promise<boolean> {
  const [result] = await DB.query(
    `UPDATE core_intake_progress
        SET status = 'not_started', draft_state = NULL, completed_at = NULL
      WHERE user_id = ? AND step_key = ? AND status = 'in_progress'`,
    [userId, step]
  );
  return (result as { affectedRows?: number }).affectedRows ? true : false;
}

/**
 * Mark ONE step completed and recompute intake_completed, serialized per-user.
 * Returns the full progress set + the new completion flag.
 */
export async function completeStep(
  userId: number,
  step: CoreStep
): Promise<{ steps: ProgressRow[]; intakeCompleted: boolean }> {
  const conn = await DB.getConnection();
  try {
    await conn.beginTransaction();
    // Serialize every completion txn for this user on the users row, so two
    // concurrent completes can't both read a stale "completed count" (case 2).
    await conn.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
    await upsertCompleted(conn, userId, [step]);
    const intakeCompleted = await recomputeCompletion(conn, userId);
    const [rows] = await conn.query(
      `SELECT step_key, status, completed_at FROM core_intake_progress WHERE user_id = ?`,
      [userId]
    );
    await conn.commit();
    return { steps: projectProgress(rows as any[]), intakeCompleted };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Mark SEVERAL steps completed (legacy /store bridge) and recompute, serialized
 * per-user. Optionally participates in a caller-provided transaction.
 */
export async function markStepsCompleted(
  userId: number,
  steps: CoreStep[],
  outerConn?: PoolConnection
): Promise<boolean> {
  if (steps.length === 0) {
    // Nothing to mark; do not touch the flag (avoids a needless lock).
    const [rows] = await DB.query(
      `SELECT step_key FROM core_intake_progress WHERE user_id = ? AND status = 'completed'`,
      [userId]
    );
    return isIntakeComplete((rows as any[]).map((r) => r.step_key));
  }
  const conn = outerConn ?? (await DB.getConnection());
  const ownTxn = !outerConn;
  try {
    if (ownTxn) await conn.beginTransaction();
    await conn.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId]);
    await upsertCompleted(conn, userId, steps);
    const done = await recomputeCompletion(conn, userId);
    if (ownTxn) await conn.commit();
    return done;
  } catch (e) {
    if (ownTxn) await conn.rollback();
    throw e;
  } finally {
    if (ownTxn) conn.release();
  }
}

// Insert-or-update the given steps to 'completed'. Idempotent via the
// UNIQUE(user_id, step_key) key — concurrent completes of the same step
// collapse to one row (case 1).
async function upsertCompleted(conn: PoolConnection, userId: number, steps: CoreStep[]): Promise<void> {
  for (const step of steps) {
    await conn.query(
      `INSERT INTO core_intake_progress (user_id, step_key, status, completed_at)
       VALUES (?, ?, 'completed', NOW())
       ON DUPLICATE KEY UPDATE status = 'completed', completed_at = NOW()`,
      [userId, step]
    );
  }
}

// Recompute users.intake_completed from the completed progress rows. MUST run
// inside a txn holding the per-user lock. Returns the new boolean.
async function recomputeCompletion(conn: PoolConnection, userId: number): Promise<boolean> {
  const [rows] = await conn.query(
    `SELECT step_key FROM core_intake_progress WHERE user_id = ? AND status = 'completed'`,
    [userId]
  );
  const done = isIntakeComplete((rows as any[]).map((r) => r.step_key));
  await conn.query('UPDATE users SET intake_completed = ? WHERE id = ?', [done ? 1 : 0, userId]);
  return done;
}
