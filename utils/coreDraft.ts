// utils/coreDraft.ts
// ----------------------------------------------------------------------------
// Pure, I/O-free helpers for RESUMABLE Core-intake drafts. One concern: the
// shape + safety of the per-step `draft_state` we persist in
// `core_intake_progress`. No DB, no HTTP — unit-tested in isolation.
//
// A draft holds ONLY the text answers a user has entered so far for one step
// (e.g. IQ: { questions, currentQuestionIndex, userAnswers }; personality:
// { orderIds, index, answers }). Media (photo/voice) is NEVER a draft — it is
// re-captured on resume by design. `sanitizeDraftState` defensively strips any
// media-ish keys, data: URLs, and oversized strings a client might stuff in, so
// `draft_state` can never become a blob/DoS vector. The 100 KB byte cap in the
// service is the SIZE backstop; this module is the CONTENT backstop.
//
// SECURITY: drafts are only ever read back through the per-step progress
// endpoint (JWT-scoped to req.user.id) and are NEVER merged into resolveLatest,
// so nothing here can leak partial/unvalidated data into the Mirror read-model.
// ----------------------------------------------------------------------------

import type { CoreStep, StepStatus } from '../services/intakeCompletion';

// Top-level or nested keys whose name signals a media/binary payload. Any such
// key is dropped from a draft entirely.
const MEDIA_KEY_RE = /(photo|voice|image|audio|video|blob|dataurl|base64|binary|buffer|file)/i;
// A single string value longer than this is not a plausible "answer" — dropped.
export const MAX_DRAFT_STRING = 8_000;
// Bound pathological nesting so a crafted deep object can't blow the stack.
const MAX_DEPTH = 12;

/**
 * Recursively strip media-ish keys, data: URLs, and oversized strings from an
 * arbitrary JSON value. Objects: drop media-named keys, recurse the rest.
 * Arrays: recurse elements (indices preserved). Strings: drop (→ null) if a
 * data: URL or over the length cap. Primitives pass through.
 */
export function stripMedia(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === 'string') {
    if (value.startsWith('data:') || value.length > MAX_DRAFT_STRING) return null;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => stripMedia(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (MEDIA_KEY_RE.test(k)) continue;
      out[k] = stripMedia(v, depth + 1);
    }
    return out;
  }
  return value; // number | boolean | null | undefined
}

/**
 * Normalize an incoming draft to a safe, storable plain object — or null to
 * clear the draft. A draft MUST be a plain object; arrays / primitives / null /
 * undefined all normalize to null (no draft). Media is stripped recursively.
 */
export function sanitizeDraftState(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  return stripMedia(raw) as Record<string, unknown>;
}

export interface StepDraft {
  step: CoreStep;
  status: StepStatus;
  completedAt: string | null;
  draftState: Record<string, unknown> | null;
  // TOMBSTONE flag for cross-device authoritative erase. A `not_started` ROW only
  // ever exists because an explicit erase turned an in-progress draft into one
  // (a never-started step has NO row). So `erased` = "a row exists and it is
  // not_started" is the durable signal a second device reads on hydrate to wipe
  // its own stale local draft. false for a completed/in-progress row or no row.
  erased: boolean;
}

/**
 * Map a `core_intake_progress` row (or its absence) to the API draft shape.
 * A missing row is a never-started step. `draft_state` may arrive already
 * parsed (mysql2 JSON column) or as a string; both are tolerated, and any
 * non-object / unparseable value degrades safely to null rather than throwing.
 */
export function projectStepDraft(step: CoreStep, row: Record<string, any> | undefined | null): StepDraft {
  if (!row) return { step, status: 'not_started', completedAt: null, draftState: null, erased: false };
  let draftState: Record<string, unknown> | null = null;
  const raw = row.draft_state;
  if (raw !== null && raw !== undefined) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      draftState = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      draftState = null;
    }
  }
  const status = (row.status as StepStatus) ?? 'not_started';
  return {
    step,
    status,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    draftState,
    erased: status === 'not_started', // a row that is not_started is an erase tombstone
  };
}
