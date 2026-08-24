// utils/intakeMerge.ts
// ----------------------------------------------------------------------------
// PURE merge helpers for the two-tier intake read-model. No DB, no controller
// imports — so they are unit-testable in isolation and free of the import-time
// coupling that the DB-backed services/intakeReadModel carries. The read-model
// composes these; tests target them directly.
// ----------------------------------------------------------------------------

/** Coerce a MySQL JSON column (object already, or a JSON string) to an object. */
export function coerceJson(v: unknown): unknown | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return null;
}

export interface EntryResult {
  personalityResult: unknown | null;
  astrologicalResult: unknown | null;
  birthDate: string | null;
  displayName: string | null;
  confidence: string | null;
  updatedAt: string | null;
}

/** Map an entry_intake_results row into partial `intakeData` sections. */
export function entryToIntakeSections(entry: EntryResult | null): Record<string, any> {
  const out: Record<string, any> = {};
  if (!entry) return out;
  if (entry.personalityResult) out.personalityResult = entry.personalityResult;
  if (entry.astrologicalResult) out.astrologicalResult = entry.astrologicalResult;
  if (entry.displayName) out.name = entry.displayName;
  if (entry.birthDate) out.birthDate = entry.birthDate;
  return out;
}

/**
 * A value counts as "present" only if it carries real content: non-null,
 * non-empty string, non-empty array, non-empty object. Junk/partial records
 * like `{ name: "x" }` therefore contribute only their non-empty fields.
 */
export function isNonEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true; // numbers, booleans
}

/**
 * Merge multiple intake records given NEWEST FIRST into one: for each key, the
 * newest record with a non-empty value wins. This recovers a complete profile
 * even when the newest stored record is partial/junk and would otherwise MASK
 * an earlier full submission (each /store appends a new "latest"). Essential for
 * incremental Core saves, where each step stores only its own section.
 */
export function mergeCoreRecordsNewestFirst(
  recordsNewestFirst: Array<Record<string, any> | null | undefined>
): Record<string, any> {
  const merged: Record<string, any> = {};
  for (const rec of recordsNewestFirst) {
    if (!rec || typeof rec !== 'object') continue;
    for (const [k, v] of Object.entries(rec)) {
      if (merged[k] === undefined && isNonEmptyValue(v)) merged[k] = v;
    }
  }
  return merged;
}

/**
 * Merge Core over Entry, section by section. Entry provides the base; any
 * section present in Core overrides it (Core is the richer, full-depth source).
 * Neither present -> null (caller treats as "no intake").
 */
export function mergeCoreOverEntry(
  entrySections: Record<string, any>,
  core: Record<string, any> | null
): Record<string, any> | null {
  const hasEntry = Object.keys(entrySections).length > 0;
  const hasCore = !!core && Object.keys(core).length > 0;
  if (!hasEntry && !hasCore) return null;
  return { ...entrySections, ...(core || {}) };
}
