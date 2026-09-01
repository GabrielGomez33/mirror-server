// tests/conversionStorage.int.test.ts
// ----------------------------------------------------------------------------
// INTEGRATION proof for the anonymous conversion-analytics storage layer, run
// against a REAL MySQL (the CI service). It proves the parts only a database can
// — the funnel round-trip, aggregate counts, retention pruning — and, most
// importantly, the COMPLIANCE GUARDRAIL:
//
//   the live conversion_events schema has NO PII-shaped column and NO users FK.
//
// That guardrail is what makes "the funnel table holds no personal data" a
// CI-enforced invariant: if a future migration adds user_id / ip_address /
// email / a users FK, this test fails before the change can ship.
//
// SAFETY: identical to coreDraftStorage.int.test.ts — runs only under
// INTEGRATION_DB=1 and refuses destructive DDL unless DB_NAME matches /test|ci/i.
// ----------------------------------------------------------------------------

import { DB } from '../db';
import { sanitizeConversionEvent } from '../utils/conversionFunnel';
import { findPiiColumns } from '../utils/piiColumnGuard';
import {
  recordConversionEvent,
  pruneConversionEvents,
  getFunnelAggregate,
  getConversionInventory,
  getRetentionStatus,
} from '../services/conversionAnalytics';
import { buildComplianceRecord } from '../services/complianceRecord';
import crypto from 'crypto';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } };

async function createSchema(): Promise<void> {
  await DB.query('DROP TABLE IF EXISTS conversion_events');
  // Verbatim shape from migration 023 (minus the nightly EVENT, which needs the
  // scheduler). The column list here is what the guardrail asserts against.
  await DB.query(`
    CREATE TABLE conversion_events (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      stage         VARCHAR(48)  NOT NULL,
      session_token CHAR(36)     NULL,
      utm_source    VARCHAR(64)  NULL,
      utm_medium    VARCHAR(64)  NULL,
      utm_campaign  VARCHAR(96)  NULL,
      surface       VARCHAR(16)  NULL,
      created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_stage_time (stage, created_at),
      INDEX idx_time (created_at),
      INDEX idx_session (session_token),
      INDEX idx_utm (utm_source, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

async function record(stage: string, session: string): Promise<void> {
  const clean = sanitizeConversionEvent({ stage, sessionToken: session, utmSource: 'instagram', surface: 'web' });
  if (!clean) throw new Error(`fixture stage not accepted: ${stage}`);
  await recordConversionEvent(clean);
}

async function main() {
  if (!process.env.INTEGRATION_DB) {
    console.log('SKIP: conversionStorage integration test (set INTEGRATION_DB=1 + a test DB to run)');
    return;
  }
  const dbName = process.env.DB_NAME || '';
  if (!process.env.DB_HOST || !dbName) {
    throw new Error('INTEGRATION_DB=1 but DB_HOST/DB_NAME are not configured — refusing to false-green.');
  }
  if (!/test|ci/i.test(dbName)) {
    throw new Error(`Refusing to run destructive integration DDL against DB_NAME="${dbName}" (name must match /test|ci/i).`);
  }

  await createSchema();

  // --- COMPLIANCE GUARDRAIL: no PII column, no users FK -----------------------
  {
    const inv = await getConversionInventory();
    ok(inv.exists, 'conversion_events exists');
    const names = inv.columns.map((c) => c.name).sort().join(',');
    ok(names === 'created_at,id,session_token,stage,surface,utm_campaign,utm_medium,utm_source', 'exact expected column set');
    ok(inv.piiSuspectColumns.length === 0, `COMPLIANCE: no PII-shaped column (found: ${inv.piiSuspectColumns.join(',') || 'none'})`);
    ok(!inv.hasUserForeignKey, 'COMPLIANCE: no foreign key to users');
    // Belt-and-suspenders: re-run the guard directly over the live names.
    ok(findPiiColumns(inv.columns.map((c) => c.name)).length === 0, 'COMPLIANCE: live column names pass the PII guard');
  }

  // --- round-trip + aggregate -------------------------------------------------
  const sesA = crypto.randomUUID();
  const sesB = crypto.randomUUID();
  await record('landing_view', sesA);
  await record('landing_view', sesB);
  await record('signup_view', sesA);
  await record('signup_completed', sesA);
  {
    const agg = await getFunnelAggregate(30);
    ok(agg.stages.length === 11, 'aggregate returns all 11 known stages (zero-filled)');
    ok(agg.stages[0].stage === 'landing_view' && agg.stages[0].order === 0, 'stages returned in funnel order');
    const byStage = new Map(agg.stages.map((s) => [s.stage, s]));
    ok(byStage.get('landing_view')!.events === 2, 'landing_view: 2 events');
    ok(byStage.get('landing_view')!.sessions === 2, 'landing_view: 2 distinct sessions');
    ok(byStage.get('signup_completed')!.events === 1, 'signup_completed: 1 event');
    ok(byStage.get('signup_completed')!.sessions === 1, 'signup_completed: 1 session');
    ok(byStage.get('premium_activated')!.events === 0, 'unreached stage zero-filled');
    ok(agg.totalEvents === 4, 'total events = 4');
  }

  // --- retention prune --------------------------------------------------------
  {
    await record('core_completed', crypto.randomUUID());
    // Backdate that event beyond the window; a naive prune must remove exactly it.
    await DB.query(`UPDATE conversion_events SET created_at = DATE_SUB(NOW(), INTERVAL 200 DAY) WHERE stage = 'core_completed'`);
    const removed = await pruneConversionEvents(180);
    ok(removed === 1, 'prune removes exactly the one out-of-window event');
    const agg = await getFunnelAggregate(3650);
    ok(new Map(agg.stages.map((s) => [s.stage, s])).get('core_completed')!.events === 0, 'pruned event is gone');
    ok(new Map(agg.stages.map((s) => [s.stage, s])).get('landing_view')!.events === 2, 'in-window events survive prune');
  }

  // --- retention status -------------------------------------------------------
  {
    const rs = await getRetentionStatus();
    ok(rs.retentionDays === 180, 'retention window is 180 days');
    ok(rs.rowCount === 4, 'row count reflects surviving events');
    ok(rs.oldestEventAgeDays !== null && rs.oldestEventAgeDays <= 180, 'oldest surviving event is within retention');
    ok(rs.withinRetention === true, 'withinRetention true after prune');
  }

  // --- compliance record ------------------------------------------------------
  {
    const rec = await buildComplianceRecord();
    ok(rec.conversionAnalytics.noPersonalData === true, 'compliance record: funnel has no personal data');
    ok(rec.regimes.some((r) => /GDPR/.test(r)) && rec.regimes.some((r) => /CCPA/.test(r)), 'compliance record: GDPR + CCPA in scope');
    ok(!!rec.policyVersion, 'compliance record: policy version present');
    ok(!!rec.accountData.dataSubjectRights.erasure && !!rec.accountData.dataSubjectRights.access_portability, 'compliance record: erasure + export rights described');
    ok(rec.privacySignals.globalPrivacyControl.toLowerCase().includes('honored'), 'compliance record: GPC honored');
  }

  await DB.query('DROP TABLE IF EXISTS conversion_events');
}

main()
  .then(() => {
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: conversionStorage(int) ${pass} passed, ${fail} failed`);
    return DB.end().then(() => { if (fail) process.exit(1); });
  })
  .catch(async (err) => {
    console.error('conversionStorage(int) ERROR:', err);
    try { await DB.end(); } catch { /* noop */ }
    process.exit(1);
  });
