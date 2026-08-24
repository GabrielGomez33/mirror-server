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
  type EntryResult,
} from '../utils/intakeMerge';

// Re-export the pure helpers so existing importers of this module keep working.
export { coerceJson, entryToIntakeSections, mergeCoreOverEntry, EntryResult };

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
  const [coreRes, entry] = await Promise.all([
    IntakeDataManager.getLatestIntakeData(String(userId), context, false).catch(() => null),
    getEntryResult(uidNum).catch(() => null),
  ]);
  const core = (coreRes?.intakeData as Record<string, any> | undefined) ?? null;
  return mergeCoreOverEntry(entryToIntakeSections(entry), core);
}
