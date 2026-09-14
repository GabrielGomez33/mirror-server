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
import {
  buildReachedFunnel,
  computeFunnelMetrics,
  ratePct,
  type FunnelMetrics,
  type ReachedRow,
} from '../utils/funnelMetrics';

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
// FULL ANALYTICS (drop-off, conversion, per-source, trend) — for the operator
// dashboard. Purely aggregate over anonymous session tokens; no row-level or
// per-user data leaves this function. The arithmetic lives in utils/funnelMetrics.
// ---------------------------------------------------------------------------

export interface SourceFunnelRow {
  source: string; // utm_source, or '(direct)' when absent
  sessions: number; // distinct sessions attributed to this source
  signups: number; // sessions reaching signup_completed
  aha: number; // sessions reaching entry_first_value
  core: number; // sessions reaching core_completed
  premium: number; // sessions reaching premium_activated
  signupRatePct: number | null; // signups / sessions
  premiumRatePct: number | null; // premium / sessions
}

export interface TrendPoint {
  day: string; // YYYY-MM-DD
  landing: number;
  signups: number;
  aha: number;
  premium: number;
}

export interface FunnelAnalytics {
  sinceDays: number;
  generatedAt: string;
  totalSessions: number; // distinct sessions that reached any known stage
  metrics: FunnelMetrics; // monotonic funnel + drop-off + milestones + biggest drop
  sources: SourceFunnelRow[];
  trend: TrendPoint[];
}

// A parameterized `FIELD(stage, ...)` fragment returning the 1-based funnel
// position of a row's stage (0 for unknown). The stage list is a CLOSED code
// constant, but we still bind it as parameters rather than interpolate.
const STAGE_FIELD = `FIELD(stage, ${FUNNEL_STAGES.map(() => '?').join(', ')})`;
const STAGE_PARAMS: string[] = [...FUNNEL_STAGES];
const pos = (stage: string): number => funnelStageOrder(stage) + 1; // 1-based FIELD position

/**
 * Everything the traffic-analytics dashboard needs, over the trailing `sinceDays`.
 * Three aggregate reads: a per-session furthest-stage funnel (accurate drop-off),
 * a per-utm_source milestone breakdown, and a per-day trend of key stages.
 */
export async function getFunnelAnalytics(sinceDays = 30): Promise<FunnelAnalytics> {
  const days = Math.max(1, Math.floor(sinceDays));

  // 1) Monotonic reached-funnel: furthest stage each session reached.
  const [reachedRows] = await DB.query(
    `SELECT reached, COUNT(*) AS sessions FROM (
        SELECT session_token, MAX(${STAGE_FIELD}) AS reached
          FROM conversion_events
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
           AND session_token IS NOT NULL
         GROUP BY session_token
     ) t
     WHERE reached >= 1
     GROUP BY reached`,
    [...STAGE_PARAMS, days]
  );
  const reached: ReachedRow[] = (reachedRows as any[]).map((r) => ({
    reached: Number(r.reached) || 0,
    sessions: Number(r.sessions) || 0,
  }));
  const stageReach = buildReachedFunnel(reached);
  const metrics = computeFunnelMetrics(stageReach);
  const totalSessions = reached.reduce((s, r) => s + r.sessions, 0);

  // 2) Per-source milestone breakdown (first stage of the source's sessions).
  const [srcRows] = await DB.query(
    `SELECT COALESCE(NULLIF(utm_source, ''), '(direct)') AS source,
            COUNT(DISTINCT session_token) AS sessions,
            COUNT(DISTINCT CASE WHEN ${STAGE_FIELD} >= ? THEN session_token END) AS signups,
            COUNT(DISTINCT CASE WHEN ${STAGE_FIELD} >= ? THEN session_token END) AS aha,
            COUNT(DISTINCT CASE WHEN ${STAGE_FIELD} >= ? THEN session_token END) AS core,
            COUNT(DISTINCT CASE WHEN ${STAGE_FIELD} >= ? THEN session_token END) AS premium
       FROM conversion_events
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        AND session_token IS NOT NULL
      GROUP BY COALESCE(NULLIF(utm_source, ''), '(direct)')
      ORDER BY sessions DESC
      LIMIT 50`,
    [
      ...STAGE_PARAMS, pos('signup_completed'),
      ...STAGE_PARAMS, pos('entry_first_value'),
      ...STAGE_PARAMS, pos('core_completed'),
      ...STAGE_PARAMS, pos('premium_activated'),
      days,
    ]
  );
  const sources: SourceFunnelRow[] = (srcRows as any[]).map((r) => {
    const sessions = Number(r.sessions) || 0;
    const signups = Number(r.signups) || 0;
    const premium = Number(r.premium) || 0;
    return {
      source: String(r.source),
      sessions,
      signups,
      aha: Number(r.aha) || 0,
      core: Number(r.core) || 0,
      premium,
      signupRatePct: ratePct(signups, sessions),
      premiumRatePct: ratePct(premium, sessions),
    };
  });

  // 3) Daily trend of key stages (activity per stage per day).
  const [trendRows] = await DB.query(
    `SELECT DATE(created_at) AS day,
            COUNT(DISTINCT CASE WHEN stage = ? THEN session_token END) AS landing,
            COUNT(DISTINCT CASE WHEN stage = ? THEN session_token END) AS signups,
            COUNT(DISTINCT CASE WHEN stage = ? THEN session_token END) AS aha,
            COUNT(DISTINCT CASE WHEN stage = ? THEN session_token END) AS premium
       FROM conversion_events
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        AND session_token IS NOT NULL
      GROUP BY DATE(created_at)
      ORDER BY day`,
    ['landing_view', 'signup_completed', 'entry_first_value', 'premium_activated', days]
  );
  const trend: TrendPoint[] = (trendRows as any[]).map((r) => ({
    day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
    landing: Number(r.landing) || 0,
    signups: Number(r.signups) || 0,
    aha: Number(r.aha) || 0,
    premium: Number(r.premium) || 0,
  }));

  return {
    sinceDays: days,
    generatedAt: new Date().toISOString(),
    totalSessions,
    metrics,
    sources,
    trend,
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
