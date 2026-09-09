// services/groupShareFreshness.ts
// ----------------------------------------------------------------------------
// FRESHNESS SEAM between a user's intake data and the SNAPSHOT that Mirror
// Groups holds. Groups do not read intake live — a member's assessment is
// frozen into mirror_group_shared_data at explicit share time (with consent),
// so when the user later RETAKES a section their groups keep showing the old
// snapshot. Rather than silently re-disclosing new data into groups from the
// intake write path (which would couple two domains and bypass a fresh consent),
// we DETECT staleness here and let the UI prompt the user to re-share.
//
// This module owns ONLY the read-side freshness question ("is what a group sees
// older than my current data?"). The actual (re)capture stays the existing,
// consented POST /:groupId/share-data. Pure comparison split out from the DB
// reads so it is unit-tested in isolation (tests/groupShareFreshness.test.ts).
// ----------------------------------------------------------------------------

import { DB } from '../db';
import { getLatestIntakeChangeAt } from './intakeReadModel';
import { isShareOutdated, type GroupShareFreshness } from '../utils/groupShareFreshness';

// Re-export the pure helper so existing importers keep a single entry point. The
// pure logic lives in utils/ (no DB import) so it is unit-testable without
// dragging the connection pool into the test runner. "When did intake change?"
// now lives with the read model (intakeReadModel.getLatestIntakeChangeAt) so it
// is shared with the personal-analysis freshness check rather than duplicated.
export { isShareOutdated, GroupShareFreshness };

/**
 * For every group the user is an ACTIVE member of, report whether their shared
 * snapshot is stale relative to their current intake. Groups they haven't shared
 * with come back with sharedAt=null / outdated=false. One intake-change read +
 * one grouped share read; the comparison is the pure helper above.
 */
export async function getGroupShareFreshness(userId: number): Promise<GroupShareFreshness[]> {
  const [rows] = await DB.query(
    `SELECT g.id AS group_id, g.name AS group_name,
            MAX(sd.shared_at) AS shared_at,
            GROUP_CONCAT(DISTINCT sd.data_type) AS data_types
       FROM mirror_group_members m
       JOIN mirror_groups g ON g.id = m.group_id
       LEFT JOIN mirror_group_shared_data sd
         ON sd.group_id = m.group_id AND sd.user_id = m.user_id
      WHERE m.user_id = ? AND m.status = 'active'
      GROUP BY g.id, g.name`,
    [userId]
  );

  const latestChange = await getLatestIntakeChangeAt(userId);

  return (rows as any[]).map((r) => {
    const sharedAt = r.shared_at ? new Date(r.shared_at) : null;
    return {
      groupId: String(r.group_id),
      groupName: r.group_name,
      sharedAt: sharedAt ? sharedAt.toISOString() : null,
      outdated: isShareOutdated(latestChange, sharedAt),
      dataTypes: r.data_types ? String(r.data_types).split(',').filter(Boolean) : [],
    };
  });
}
