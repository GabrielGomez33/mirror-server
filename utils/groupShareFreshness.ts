// utils/groupShareFreshness.ts
// ----------------------------------------------------------------------------
// PURE freshness comparison for the Groups snapshot-vs-live question. No DB, no
// imports with side effects — so it is unit-testable in isolation (the test:ci
// suites are all pure; a DB import would keep the event loop open and hang the
// runner). The DB-backed reads live in services/groupShareFreshness.ts, which
// re-exports these so existing importers keep one entry point.
// ----------------------------------------------------------------------------

export interface GroupShareFreshness {
  groupId: string;
  groupName: string;
  /** ISO timestamp of the user's most recent share to this group, or null. */
  sharedAt: string | null;
  /** True when the user's data changed since that share (prompt to re-share). */
  outdated: boolean;
  /** Which data types the user currently shares with this group. */
  dataTypes: string[];
}

/**
 * A group's shared snapshot is OUTDATED when the user's assessment data changed
 * AFTER they last shared it with that group. Semantics:
 *  - No share yet (`sharedAt` null) -> NOT outdated (nothing shared to be stale;
 *    the UI shows a "Share" affordance, not an "Update" one).
 *  - No known intake-change time (`latestIntakeChangeAt` null) -> NOT outdated.
 *  - Strict `>`: an equal timestamp (shared right after a change) is current, so
 *    a fresh re-share deterministically clears the flag.
 * Pure + total — no DB, no throw.
 */
export function isShareOutdated(
  latestIntakeChangeAt: Date | null,
  sharedAt: Date | null
): boolean {
  if (!sharedAt || !latestIntakeChangeAt) return false;
  return latestIntakeChangeAt.getTime() > sharedAt.getTime();
}
