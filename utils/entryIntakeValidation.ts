// utils/entryIntakeValidation.ts
// ----------------------------------------------------------------------------
// PURE validation + normalization for an Entry ("initial") intake submission.
// No DB, no Express. The controller calls validateEntrySubmit() and either
// rejects with 400 (ok:false) or persists the normalized value. Keeping this
// pure makes the input contract testable in isolation and keeps unvalidated
// client data from ever reaching SQL.
// ----------------------------------------------------------------------------

/** Max serialized bytes accepted for each JSON section (anti-bloat / anti-DoS). */
export const MAX_SECTION_BYTES = 50_000;

export interface NormalizedEntry {
  personalityResult: unknown | null;
  astrologyResult: unknown | null;
  birthDate: string | null;   // YYYY-MM-DD
  birthTime: string | null;   // HH:MM:SS
  birthPlace: string | null;
  displayName: string | null;
}

export type EntryValidation =
  | { ok: true; value: NormalizedEntry }
  | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Accept an optional JSON section: absent -> null; present -> must be an object
// within the size cap. Returns { section } or throws a message string.
function normalizeSection(value: unknown, label: string): unknown | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw `${label} must be an object`;
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SECTION_BYTES) {
    throw `${label} is too large`;
  }
  return value;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

function normalizeBirthDate(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw 'birthDate must be YYYY-MM-DD';
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw 'birthDate is not a real date';
  return v;
}

function normalizeBirthTime(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw 'birthTime must be a string';
  const m = TIME_RE.exec(v);
  if (!m) throw 'birthTime must be HH:MM or HH:MM:SS';
  const hh = Number(m[1]), mm = Number(m[2]), ss = m[3] ? Number(m[3]) : 0;
  if (hh > 23 || mm > 59 || ss > 59) throw 'birthTime is out of range';
  return `${m[1]}:${m[2]}:${m[3] ?? '00'}`;
}

function normalizeString(v: unknown, label: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw `${label} must be a string`;
  const t = v.trim();
  if (t.length === 0) return null;
  if (t.length > max) throw `${label} exceeds ${max} characters`;
  return t;
}

/**
 * Validate + normalize an Entry submit body. At least one substantive section
 * (personality or astrology) must be present — an Entry with neither carries no
 * signal and is rejected.
 */
export function validateEntrySubmit(body: unknown): EntryValidation {
  if (!isPlainObject(body)) return { ok: false, error: 'Body must be a JSON object' };
  try {
    const personalityResult = normalizeSection(body.personalityResult, 'personalityResult');
    // Accept either key the client might send.
    const astroRaw = body.astrologyResult ?? body.astrologicalResult;
    const astrologyResult = normalizeSection(astroRaw, 'astrologyResult');

    if (personalityResult === null && astrologyResult === null) {
      return { ok: false, error: 'At least one of personalityResult or astrologyResult is required' };
    }

    const value: NormalizedEntry = {
      personalityResult,
      astrologyResult,
      birthDate: normalizeBirthDate(body.birthDate),
      birthTime: normalizeBirthTime(body.birthTime),
      birthPlace: normalizeString(body.birthPlace, 'birthPlace', 180),
      displayName: normalizeString(body.displayName, 'displayName', 120),
    };
    return { ok: true, value };
  } catch (msg) {
    return { ok: false, error: typeof msg === 'string' ? msg : 'Invalid entry payload' };
  }
}
