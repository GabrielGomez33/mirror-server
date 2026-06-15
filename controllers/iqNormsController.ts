// controllers/iqNormsController.ts
// ---------------------------------------------------------------------------
// Self-norming for the intake IQ / cognitive assessment.
//
// We do not score against a purchased population norm. Instead we accumulate a
// de-identified distribution of our own users' scores (table: iq_norm_samples,
// migration 015) and report each result as a percentile RELATIVE TO OTHER
// MIRROR USERS. That is an honest, owned comparison — not a clinical IQ.
//
// Integrity model:
//   * Scoring is server-authoritative. The raw score is re-derived here from
//     the submitted answers against a VERSIONED answer key, so a client that
//     POSTs `iqScore: 145` cannot inflate the norm. Samples whose item-set
//     version we do not recognise are stored verified = FALSE and excluded
//     from norm computation.
//   * One sample per (user_id, item_set_version): first attempt wins
//     (INSERT IGNORE), so retakes don't skew the distribution upward.
//
// SYNC WARNING: ANSWER_KEYS below must mirror the client question bank
// (client/src/components/intake/IQStep.tsx) for the matching version string.
// When the bank changes, bump CURRENT_ITEM_SET_VERSION on BOTH sides and add a
// new entry here. A mismatched/unknown version is safe (it just yields an
// unverified, norm-excluded sample) but stops new verified data accruing, so
// keep them in lockstep.
// ---------------------------------------------------------------------------

import { RequestHandler } from 'express';
import { DB } from '../db';

// Minimum verified samples before a norm is considered stable enough to report.
// Below this we return ready=false and the client shows a provisional estimate.
const MIN_SAMPLES = 300;

// The version string the current client bank reports. Must match the client.
export const CURRENT_ITEM_SET_VERSION = 'mirror-iq-v1';

interface AnswerKeyEntry {
  correct: string;
  type: 'numerical' | 'spatial' | 'logical' | 'verbal';
  options: number; // option count, for the chance-correction floor
}

// Mirror of IQStep.tsx's iqQuestions (id -> correct answer / type / #options).
// All items are 4-option multiple choice (chance floor = 0.25).
const ANSWER_KEYS: Record<string, Record<string, AnswerKeyEntry>> = {
  'mirror-iq-v1': {
    'iq-num-1': { correct: '32', type: 'numerical', options: 4 },
    'iq-num-2': { correct: '10', type: 'numerical', options: 4 },
    'iq-num-3': { correct: '20', type: 'numerical', options: 4 },
    'iq-num-4': { correct: '3:30 PM', type: 'numerical', options: 4 },
    'iq-num-5': { correct: '21', type: 'numerical', options: 4 },
    'iq-num-6': { correct: '7', type: 'numerical', options: 4 },
    'iq-num-7': { correct: '20', type: 'numerical', options: 4 },
    'iq-spat-4': { correct: 'overlap', type: 'spatial', options: 4 },
    'iq-spat-6': { correct: 'circle', type: 'spatial', options: 4 },
    'iq-spat-7': { correct: '27', type: 'spatial', options: 4 },
    'iq-spat-8': { correct: '11', type: 'spatial', options: 4 },
    'iq-log-1': { correct: 'It cannot be determined whether any roses fade quickly.', type: 'logical', options: 4 },
    'iq-log-2': { correct: 'It is not raining.', type: 'logical', options: 4 },
    'iq-log-3': { correct: 'I16', type: 'logical', options: 4 },
    'iq-log-4': { correct: 'Foot', type: 'logical', options: 4 },
    'iq-log-5': { correct: 'It is impossible to tell if any cats like blue fish.', type: 'logical', options: 4 },
    'iq-log-6': { correct: 'All A are C', type: 'logical', options: 4 },
    'iq-log-7': { correct: 'Some polygons are not circles.', type: 'logical', options: 4 },
    'iq-log-8': { correct: 'Some artists are writers.', type: 'logical', options: 4 },
    'iq-verb-1': { correct: 'Carrot', type: 'verbal', options: 4 },
    'iq-verb-2': { correct: 'Pessimistic', type: 'verbal', options: 4 },
    'iq-verb-3': { correct: 'PLENTY', type: 'verbal', options: 4 },
    'iq-verb-4': { correct: 'Pervasive', type: 'verbal', options: 4 },
    'iq-verb-5': { correct: 'Trumpet', type: 'verbal', options: 4 },
    'iq-verb-6': { correct: 'Lasting a very short time', type: 'verbal', options: 4 },
    'iq-verb-7': { correct: 'Airplane', type: 'verbal', options: 4 },
    // Re-classified as logical in the client (originally spatial ids).
    'iq-spat-1': { correct: 'No circles are squares.', type: 'logical', options: 4 },
    'iq-spat-2': { correct: 'The alarm is not set.', type: 'logical', options: 4 },
    'iq-spat-3': { correct: 'A', type: 'logical', options: 4 },
    'iq-spat-5': { correct: 'Some musicians are not poets.', type: 'logical', options: 4 },
  },
};

interface CategoryScore {
  type: string;
  label: string;
  correct: number;
  total: number;
}

// Startup self-check: catch answer-key drift (wrong count / duplicate ids)
// before it silently corrupts the norm. Runs once at import.
(function selfCheckAnswerKeys() {
  for (const [version, key] of Object.entries(ANSWER_KEYS)) {
    const ids = Object.keys(key);
    if (ids.length !== 30) {
      console.warn(`[iqNorms] answer key "${version}" has ${ids.length} items (expected 30)`);
    }
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) console.warn(`[iqNorms] answer key "${version}" duplicate id: ${id}`);
      seen.add(id);
    }
  }
})();

// There is no migration runner in this project (the .sql files are applied
// manually, and sibling tables like intake_metadata are created inline). We
// therefore lazily ensure the norm table exists, once per process. The
// canonical schema (with the users FK) lives in migrations/015_iq_norm_samples.sql;
// this inline copy omits the FK to guarantee the create can't fail at runtime.
let ensureTablePromise: Promise<void> | null = null;
function ensureNormTable(): Promise<void> {
  if (!ensureTablePromise) {
    ensureTablePromise = DB.query(`
      CREATE TABLE IF NOT EXISTS iq_norm_samples (
        id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id            INT             NOT NULL,
        item_set_version   VARCHAR(32)     NOT NULL,
        raw_score          SMALLINT        NOT NULL,
        total_questions    SMALLINT        NOT NULL,
        ability            DECIMAL(6,4)    NOT NULL,
        category_breakdown JSON            NULL,
        age_years          SMALLINT        NULL,
        verified           BOOLEAN         NOT NULL DEFAULT FALSE,
        created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_user_version (user_id, item_set_version),
        KEY idx_norm_lookup (item_set_version, verified, raw_score),
        KEY idx_norm_age (item_set_version, verified, age_years)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).then(() => undefined).catch((err) => {
      // Reset so a later call can retry, and surface the cause.
      ensureTablePromise = null;
      throw err;
    });
  }
  return ensureTablePromise;
}

interface ScoreResult {
  rawScore: number;
  totalQuestions: number;
  ability: number; // chance-corrected proportion, clamped [0,1]
  categoryBreakdown: CategoryScore[];
}

/**
 * Re-score an attempt from the submitted answers against a versioned key.
 * Returns null when the version is unknown (caller records it unverified).
 * Mirrors the client's chance-corrected ability calculation.
 */
export function scoreFromAnswers(
  itemSetVersion: string,
  answers: Record<string, string> | undefined,
): ScoreResult | null {
  const key = ANSWER_KEYS[itemSetVersion];
  if (!key) return null;

  const types = ['numerical', 'spatial', 'logical', 'verbal'] as const;
  const byType: Record<string, { correct: number; total: number }> = {};
  types.forEach((t) => { byType[t] = { correct: 0, total: 0 }; });

  const ids = Object.keys(key);
  let rawScore = 0;
  let chanceSum = 0;

  for (const id of ids) {
    const entry = key[id];
    byType[entry.type].total++;
    chanceSum += entry.options > 0 ? 1 / entry.options : 0.25;
    if (answers && answers[id] != null && answers[id] === entry.correct) {
      rawScore++;
      byType[entry.type].correct++;
    }
  }

  const total = ids.length;
  const p = total > 0 ? rawScore / total : 0;
  const chance = total > 0 ? chanceSum / total : 0.25;
  const ability = Math.max(0, Math.min(1, (p - chance) / (1 - chance)));

  const categoryBreakdown: CategoryScore[] = types.map((t) => ({
    type: t,
    label: `${t[0].toUpperCase()}${t.slice(1)}`,
    correct: byType[t].correct,
    total: byType[t].total,
  }));

  return { rawScore, totalQuestions: total, ability, categoryBreakdown };
}

/**
 * Record a de-identified norm sample for a user's IQ attempt. Idempotent and
 * first-attempt-only (INSERT IGNORE on the unique (user_id, item_set_version)).
 * Never throws into the caller's request path — norm recording must not be able
 * to fail an intake submission.
 */
export async function recordIqNormSample(
  userId: number | string,
  iqResults: { rawScore?: number; totalQuestions?: number; itemSetVersion?: string } | undefined,
  iqAnswers: Record<string, string> | undefined,
  ageYears: number | null = null,
): Promise<void> {
  try {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) return;
    if (!iqResults && !iqAnswers) return;

    const version = iqResults?.itemSetVersion || CURRENT_ITEM_SET_VERSION;
    const scored = scoreFromAnswers(version, iqAnswers);

    let rawScore: number;
    let totalQuestions: number;
    let ability: number;
    let categoryBreakdown: CategoryScore[] | null;
    let verified: boolean;

    if (scored) {
      ({ rawScore, totalQuestions, ability, categoryBreakdown } = scored);
      verified = true;
    } else {
      // Unknown version: keep the client's reported figures but mark unverified
      // so the sample is excluded from norm computation.
      rawScore = Number(iqResults?.rawScore ?? 0);
      totalQuestions = Number(iqResults?.totalQuestions ?? 0);
      const p = totalQuestions > 0 ? rawScore / totalQuestions : 0;
      ability = Math.max(0, Math.min(1, (p - 0.25) / 0.75));
      categoryBreakdown = null;
      verified = false;
    }

    const age = Number.isFinite(Number(ageYears)) && Number(ageYears) > 0
      ? Math.min(120, Math.round(Number(ageYears)))
      : null;

    await ensureNormTable();
    await DB.query(
      `INSERT IGNORE INTO iq_norm_samples
         (user_id, item_set_version, raw_score, total_questions, ability,
          category_breakdown, age_years, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uid,
        version,
        rawScore,
        totalQuestions,
        ability.toFixed(4),
        categoryBreakdown ? JSON.stringify(categoryBreakdown) : null,
        age,
        verified,
      ],
    );
  } catch (error) {
    // Best-effort: a norm-recording failure must never break intake.
    console.warn('[iqNorms] failed to record sample:', (error as Error).message);
  }
}

// Broad age bands for later stratification. A band is only used when it
// individually clears MIN_SAMPLES; otherwise we fall back to the pooled norm.
function ageBand(age: number): { min: number; max: number; label: string } | null {
  if (!Number.isFinite(age) || age <= 0) return null;
  if (age < 25) return { min: 0, max: 24, label: 'under-25' };
  if (age < 40) return { min: 25, max: 39, label: '25-39' };
  return { min: 40, max: 200, label: '40-plus' };
}

// Coarse, false-precision-free label from a percentile.
function percentileBand(pct: number): string {
  if (pct >= 90) return 'top 10%';
  if (pct >= 75) return 'top 25%';
  if (pct >= 50) return 'top half';
  if (pct >= 25) return 'bottom half';
  return 'bottom 25%';
}

interface NormResult {
  ready: boolean;
  n: number;
  threshold: number;
  scope: 'pooled' | 'age-band';
  itemSetVersion: string;
  ageBand?: string;
  percentile?: number; // midrank percentile of the supplied rawScore
  band?: string;
}

/**
 * Compute where a raw score falls in the verified distribution for an item set.
 * Uses the midrank ((#below + 0.5·#equal) / n) so ties are handled fairly.
 * Prefers an age-banded norm when that band clears the gate, else pools.
 */
export async function computeNorms(
  itemSetVersion: string,
  rawScore: number | null,
  ageYears: number | null,
): Promise<NormResult> {
  const base: NormResult = {
    ready: false,
    n: 0,
    threshold: MIN_SAMPLES,
    scope: 'pooled',
    itemSetVersion,
  };

  await ensureNormTable();
  const band = ageYears != null ? ageBand(ageYears) : null;

  // Try an age-banded norm first when an age is supplied.
  if (band) {
    const banded = await queryNorm(itemSetVersion, rawScore, band);
    if (banded.n >= MIN_SAMPLES) {
      return { ...base, ...banded, scope: 'age-band', ageBand: band.label };
    }
  }

  const pooled = await queryNorm(itemSetVersion, rawScore, null);
  return { ...base, ...pooled, scope: 'pooled' };
}

async function queryNorm(
  itemSetVersion: string,
  rawScore: number | null,
  band: { min: number; max: number } | null,
): Promise<{ ready: boolean; n: number; threshold: number; percentile?: number; band?: string }> {
  const params: any[] = [itemSetVersion];
  let ageClause = '';
  if (band) {
    ageClause = ' AND age_years BETWEEN ? AND ?';
    params.push(band.min, band.max);
  }

  let percentileExpr = 'NULL AS below, NULL AS eq';
  if (rawScore != null) {
    // Two extra bound params for the below/equal sums.
    percentileExpr =
      'SUM(CASE WHEN raw_score < ? THEN 1 ELSE 0 END) AS below, ' +
      'SUM(CASE WHEN raw_score = ? THEN 1 ELSE 0 END) AS eq';
  }

  const sql =
    `SELECT COUNT(*) AS n` +
    (rawScore != null ? `, ${percentileExpr}` : '') +
    ` FROM iq_norm_samples WHERE item_set_version = ? AND verified = TRUE${ageClause}`;

  // Param order must match placeholder order in the SELECT then WHERE.
  const queryParams =
    rawScore != null ? [rawScore, rawScore, ...params] : params;

  const [rows] = await DB.query(sql, queryParams);
  const row = (rows as any[])[0] || {};
  const n = Number(row.n) || 0;
  const ready = n >= MIN_SAMPLES;

  if (rawScore == null || n === 0) {
    return { ready, n, threshold: MIN_SAMPLES };
  }

  const below = Number(row.below) || 0;
  const eq = Number(row.eq) || 0;
  const percentile = Math.round(((below + 0.5 * eq) / n) * 100);
  return { ready, n, threshold: MIN_SAMPLES, percentile, band: percentileBand(percentile) };
}

/**
 * GET /api/intake/iq/norms?rawScore=&itemSetVersion=&age=
 * Returns the user's percentile relative to other Mirror users, plus the
 * sample size and a readiness flag (false until MIN_SAMPLES is reached).
 */
export const getIqNormsHandler: RequestHandler = async (req, res) => {
  try {
    const itemSetVersion =
      (req.query.itemSetVersion as string) || CURRENT_ITEM_SET_VERSION;
    const rawScoreRaw = req.query.rawScore;
    const ageRaw = req.query.age;

    const rawScore =
      rawScoreRaw != null && rawScoreRaw !== '' ? Number(rawScoreRaw) : null;
    const age = ageRaw != null && ageRaw !== '' ? Number(ageRaw) : null;

    if (rawScore != null && !Number.isFinite(rawScore)) {
      res.status(400).json({ success: false, error: 'rawScore must be numeric' });
      return;
    }

    const norms = await computeNorms(
      itemSetVersion,
      rawScore,
      age != null && Number.isFinite(age) ? age : null,
    );

    res.json({ success: true, ...norms });
  } catch (error) {
    console.error('[getIqNormsHandler ERROR]:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to compute IQ norms',
      details: (error as Error).message,
    });
  }
};