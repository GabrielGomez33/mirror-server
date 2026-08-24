// services/intakeReadModel.ts
// ----------------------------------------------------------------------------
// The single MERGE SEAM for the two-tier intake. Entry results live in their
// own table (entry_intake_results); Core results live in the existing tiered
// intake storage. Downstream consumers (dashboard, Dina personal-analysis)
// should read through resolveLatest() instead of getLatestIntakeData() so they
// light up from EITHER source — with CORE winning per section when present.
//
// resolveLatest returns the SAME `intakeData` shape those consumers already
// expect, so nothing downstream of the seam changes. See spec §5.2.
// ----------------------------------------------------------------------------

import { DB } from '../db';
import { IntakeDataManager } from '../controllers/intakeController';
import type { DataAccessContext } from '../controllers/directoryController';
import {
  coerceJson,
  entryToIntakeSections,
  mergeCoreOverEntry,
  mergeCoreRecordsNewestFirst,
  isNonEmptyValue,
  type EntryResult,
} from '../utils/intakeMerge';

// Re-export the pure helpers so existing importers of this module keep working.
export { coerceJson, entryToIntakeSections, mergeCoreOverEntry, EntryResult };

// The load-bearing Core sections. Once all are gathered we can stop scanning.
const CORE_SECTION_KEYS = ['personalityResult', 'astrologicalResult', 'iqResults', 'faceAnalysis', 'voiceMetadata'];
// Cap the number of historical records we decrypt per resolve (perf bound).
const MAX_CORE_RECORDS_SCANNED = 8;

/**
 * The user's Core intake, assembled by merging their recent stored records
 * (newest non-empty wins per key). This is deliberately NOT "the single latest
 * record" — a later partial/junk submission (e.g. `{name:"x"}`) must never mask
 * an earlier full one. Scans newest-first and stops early once every core
 * section is found.
 */
export async function getMergedCoreIntake(
  userId: number | string,
  context: DataAccessContext
): Promise<Record<string, any> | null> {
  let metas: Array<{ intakeId: string }>;
  try {
    metas = (await IntakeDataManager.listUserIntakes(String(userId))) as Array<{ intakeId: string }>;
  } catch (e) {
    console.error(`[intakeReadModel] listUserIntakes failed for user ${userId}:`, (e as Error)?.message || e);
    return null;
  }
  if (!metas || metas.length === 0) return null;

  const recordsNewestFirst: Array<Record<string, any>> = [];
  const found = new Set<string>();
  let scanned = 0;
  for (const m of metas) {
    if (scanned >= MAX_CORE_RECORDS_SCANNED) break;
    scanned++;
    try {
      const r = await IntakeDataManager.retrieveIntakeData(String(userId), m.intakeId, context, false);
      const rec = r?.intakeData as Record<string, any> | undefined;
      if (rec) {
        recordsNewestFirst.push(rec);
        for (const k of CORE_SECTION_KEYS) if (isNonEmptyValue(rec[k])) found.add(k);
      }
    } catch (e) {
      console.error(`[intakeReadModel] retrieve ${m.intakeId} failed for user ${userId}:`, (e as Error)?.message || e);
    }
    if (found.size === CORE_SECTION_KEYS.length) break; // full profile assembled
  }
  const merged = mergeCoreRecordsNewestFirst(recordsNewestFirst);
  return Object.keys(merged).length ? merged : null;
}

// --- DB-backed API ----------------------------------------------------------

/** Read the single Entry result row for a user (or null). */
export async function getEntryResult(userId: number): Promise<EntryResult | null> {
  const [rows] = await DB.query(
    `SELECT personality_result, astrology_result, birth_date, display_name, confidence, updated_at
       FROM entry_intake_results WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  const r = (rows as any[])[0];
  if (!r) return null;
  return {
    personalityResult: coerceJson(r.personality_result),
    astrologicalResult: coerceJson(r.astrology_result),
    birthDate: r.birth_date ? new Date(r.birth_date).toISOString().slice(0, 10) : null,
    displayName: r.display_name ?? null,
    confidence: r.confidence ?? null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

/**
 * The merged latest intake for a user: Core (full) overlaid on Entry
 * (preliminary), returned as the standard `intakeData` object or null.
 * Core and Entry reads run concurrently; a failure in either degrades to the
 * other rather than throwing (the dashboard must still render).
 */
export async function resolveLatest(
  userId: number | string,
  context: DataAccessContext
): Promise<Record<string, any> | null> {
  const uidNum = Number(userId);
  const [core, entry] = await Promise.all([
    // Assemble Core across recent records (newest non-empty wins) so a partial
    // "latest" never masks an earlier full submission. Logs real failures.
    getMergedCoreIntake(userId, context).catch((e) => {
      console.error(`[intakeReadModel] CORE read failed for user ${userId}:`, (e as Error)?.message || e);
      return null;
    }),
    getEntryResult(uidNum).catch((e) => {
      console.error(`[intakeReadModel] ENTRY read failed for user ${userId}:`, (e as Error)?.message || e);
      return null;
    }),
  ]);
  const merged = mergeCoreOverEntry(entryToIntakeSections(entry), core);
  console.log(
    `[intakeReadModel] resolveLatest user=${userId} core=${!!core} entry=${!!entry} ` +
    `sections=${merged ? Object.keys(merged).join(',') : 'none'}`
  );
  return merged;
}
