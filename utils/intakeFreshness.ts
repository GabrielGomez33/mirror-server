// utils/intakeFreshness.ts
// ----------------------------------------------------------------------------
// PURE freshness predicate shared by every "is X stale relative to the user's
// current intake?" check (group shared-snapshots, personal-analysis reports, …).
// No DB, no side-effecting imports, so it unit-tests in isolation. The DB read
// that answers "when did the user's intake last change?" lives in
// services/intakeReadModel (getLatestIntakeChangeAt); this only compares.
// ----------------------------------------------------------------------------

/**
 * True when the user's assessment data changed AFTER some reference moment
 * (e.g. when a group snapshot was shared, or when an analysis was generated).
 * Semantics, chosen to avoid false "outdated" alarms:
 *  - No reference (`referenceAt` null) -> false (nothing to be stale against).
 *  - No known intake-change time (`latestChangeAt` null) -> false.
 *  - Strict `>`: an equal timestamp reads as current, so acting immediately
 *    after a change (re-share / regenerate) deterministically clears the flag.
 * Pure + total — no DB, no throw.
 */
export function isDataChangedSince(
  latestChangeAt: Date | null,
  referenceAt: Date | null
): boolean {
  if (!referenceAt || !latestChangeAt) return false;
  return latestChangeAt.getTime() > referenceAt.getTime();
}
