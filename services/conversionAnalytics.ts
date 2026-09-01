// services/conversionAnalytics.ts
// ----------------------------------------------------------------------------
// DB layer for anonymous conversion-funnel instrumentation. ONE concern: read
// and write the PII-free `conversion_events` table (migration 023). No HTTP
// here; the pure vocabulary + sanitizer live in utils/conversionFunnel.
//
// Everything this module writes has already passed sanitizeConversionEvent, so
// only allowlisted, non-identifying fields ever reach SQL. Nothing here reads or
// writes a user id — by design there is none on this table.
// ----------------------------------------------------------------------------

import { DB } from '../db';
import type { CleanConversionEvent } from '../utils/conversionFunnel';
import { FUNNEL_STAGES, funnelStageOrder } from '../utils/conversionFunnel';
import { findPiiColumns } from '../utils/piiColumnGuard';

/** Default retention window (days). Aggregate signal decays fast. */
export const CONVERSION_RETENTION_DAYS = 180;

const TABLE = 'conversion_events';

/**
 * Insert one sanitized funnel event. Returns true on success. Best-effort: the
 * caller (a fire-and-forget beacon) treats failure as a no-op, so a transient
 * DB hiccup never breaks the anonymous client.
 */
export async function recordConversionEvent(e: CleanConversionEvent): Promise<boolean> {
  await DB.query(
    `INSERT INTO conversion_events
       (stage, session_token, utm_source, utm_medium, utm_campaign, surface)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [e.stage, e.sessionToken, e.utmSource, e.utmMedium, e.utmCampaign, e.surface]
  );
  return true;
}

/**
 * Delete events older than `days` (retention enforcement — the authoritative
 * pruner; the nightly MySQL EVENT is only a deployment convenience). Returns the
 * number of rows removed.
 */
export async function pruneConversionEvents(days = CONVERSION_RETENTION_DAYS): Promise<number> {
  const n = Math.max(1, Math.floor(days));
  const [result] = await DB.query(
    `DELETE FROM conversion_events WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [n]
  );
  return (result as { affectedRows?: number }).affectedRows ?? 0;
}

// ---------------------------------------------------------------------------
// READ / AGGREGATE (admin, internal-secret gated at the route)
// ---------------------------------------------------------------------------

export interface FunnelStageCount {
  stage: string;
  order: number;
  events: number;    // total events at this stage in the window
  sessions: number;  // distinct anonymous sessions that reached this stage
}

export interface FunnelAggregate {
  sinceDays: number;
  generatedAt: string;
  totalEvents: number;
  stages: FunnelStageCount[];
}

/**
 * Aggregate funnel counts over the trailing `sinceDays`. Returns one row per
 * KNOWN stage (zero-filled), in funnel order, so drop-off is directly readable.
 * Purely aggregate — no row-level or per-user data leaves this function.
 */
export async function getFunnelAggregate(sinceDays = 30): Promise<FunnelAggregate> {
  const days = Math.max(1, Math.floor(sinceDays));
  const [rows] = await DB.query(
    `SELECT stage,
            COUNT(*)                        AS events,
            COUNT(DISTINCT session_token)   AS sessions
       FROM conversion_events
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY stage`,
    [days]
  );
  const byStage = new Map<string, { events: number; sessions: number }>();
  for (const r of rows as any[]) {
    byStage.set(String(r.stage), { events: Number(r.events) || 0, sessions: Number(r.sessions) || 0 });
  }
  const stages: FunnelStageCount[] = FUNNEL_STAGES.map((stage) => {
    const c = byStage.get(stage) ?? { events: 0, sessions: 0 };
    return { stage, order: funnelStageOrder(stage), events: c.events, sessions: c.sessions };
  });
  return {
    sinceDays: days,
    generatedAt: new Date().toISOString(),
    totalEvents: stages.reduce((s, x) => s + x.events, 0),
    stages,
  };
}

// ---------------------------------------------------------------------------
// COMPLIANCE INTROSPECTION (generated from the LIVE schema, so it can't drift)
// ---------------------------------------------------------------------------

export interface ColumnInfo { name: string; type: string; nullable: boolean }

export interface ConversionInventory {
  table: string;
  exists: boolean;
  columns: ColumnInfo[];
  piiSuspectColumns: string[];   // MUST be empty — asserted in CI
  hasUserForeignKey: boolean;    // MUST be false — asserted in CI
}

/**
 * Read the LIVE column list + foreign keys for conversion_events and run the
 * PII-name guard over them. This is the authoritative, drift-proof basis for
 * the "no personal data" compliance claim: it reflects the real schema, not a
 * hand-maintained doc.
 */
export async function getConversionInventory(): Promise<ConversionInventory> {
  const [cols] = await DB.query(
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [TABLE]
  );
  const columns: ColumnInfo[] = (cols as any[]).map((c) => ({
    name: String(c.name),
    type: String(c.type),
    nullable: String(c.nullable).toUpperCase() === 'YES',
  }));
  const [fks] = await DB.query(
    `SELECT COUNT(*) AS n
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        AND REFERENCED_TABLE_NAME = 'users'`,
    [TABLE]
  );
  return {
    table: TABLE,
    exists: columns.length > 0,
    columns,
    piiSuspectColumns: findPiiColumns(columns.map((c) => c.name)),
    hasUserForeignKey: Number((fks as any[])[0]?.n) > 0,
  };
}

export interface RetentionStatus {
  retentionDays: number;
  rowCount: number;
  oldestEventAgeDays: number | null; // null when empty
  withinRetention: boolean;          // oldest row is inside the window
  purgeEventInstalled: boolean;      // the nightly MySQL EVENT exists
}

/** Live retention posture: row count, oldest-row age, and whether the purge EVENT exists. */
export async function getRetentionStatus(): Promise<RetentionStatus> {
  const [agg] = await DB.query(
    `SELECT COUNT(*) AS n,
            TIMESTAMPDIFF(DAY, MIN(created_at), NOW()) AS oldest_age
       FROM conversion_events`
  );
  const row = (agg as any[])[0] ?? {};
  const rowCount = Number(row.n) || 0;
  const oldest = row.oldest_age == null ? null : Number(row.oldest_age);
  const [ev] = await DB.query(
    `SELECT COUNT(*) AS n FROM information_schema.EVENTS
      WHERE EVENT_SCHEMA = DATABASE() AND EVENT_NAME = 'purge_conversion_events'`
  );
  return {
    retentionDays: CONVERSION_RETENTION_DAYS,
    rowCount,
    oldestEventAgeDays: oldest,
    withinRetention: oldest == null ? true : oldest <= CONVERSION_RETENTION_DAYS,
    purgeEventInstalled: Number((ev as any[])[0]?.n) > 0,
  };
}
