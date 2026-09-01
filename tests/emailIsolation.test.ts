// ============================================================================
// UNIT TESTS — cross-environment email link isolation (pure; no I/O)
// ============================================================================
// Run:  npx ts-node tests/emailIsolation.test.ts
// Exit 0 = all passed, 1 = at least one failed.
//
// Guards the intertwining hazard: a staging env that kept prod's APP_URL /
// EMAIL_PUBLIC_BASE_URL would email staging signups a link into PRODUCTION (the
// token lives in mirror_staging, so it fails on prod and hands the tester to the
// live app). Proves: leak flagged ONLY when staging AND a base hits the prod
// host; prod itself is never a "leak"; malformed URLs never throw.
// ============================================================================

import {
  emailLinksLeakAcrossEnv,
  isStagingEnv,
  hostOf,
  PROD_EMAIL_HOST,
} from '../utils/emailIsolation';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function group(name: string): void { console.log(`\n• ${name}`); }

const PROD = `https://${PROD_EMAIL_HOST}/Mirror`;
const PROD_BASE = `https://${PROD_EMAIL_HOST}`;
const STAGE = 'https://staging.theundergroundrailroad.world/Mirror';
const STAGE_BASE = 'https://staging.theundergroundrailroad.world';

// ---------------------------------------------------------------------------
group('isStagingEnv — DB name marks the environment');
ok(isStagingEnv('mirror_staging') === true, 'mirror_staging -> staging');
ok(isStagingEnv('MIRROR_STAGING') === true, 'case-insensitive');
ok(isStagingEnv('mirror') === false, 'prod db -> not staging');
ok(isStagingEnv('') === false, 'empty -> not staging');
ok(isStagingEnv(undefined) === false, 'undefined -> not staging (no throw)');

// ---------------------------------------------------------------------------
group('THE leak: staging DB + prod link base');
ok(emailLinksLeakAcrossEnv({ dbName: 'mirror_staging', appUrl: PROD, emailPublicBaseUrl: PROD_BASE }).leaksToProd === true,
  'staging + both prod bases -> LEAK');
ok(emailLinksLeakAcrossEnv({ dbName: 'mirror_staging', appUrl: PROD, emailPublicBaseUrl: STAGE_BASE }).leaksToProd === true,
  'staging + prod APP_URL only -> LEAK');
ok(emailLinksLeakAcrossEnv({ dbName: 'mirror_staging', appUrl: STAGE, emailPublicBaseUrl: PROD_BASE }).leaksToProd === true,
  'staging + prod EMAIL_PUBLIC_BASE_URL only -> LEAK');
const v = emailLinksLeakAcrossEnv({ dbName: 'mirror_staging', appUrl: PROD, emailPublicBaseUrl: STAGE_BASE });
ok(/APP_URL/.test(v.reason) && !/EMAIL_PUBLIC_BASE_URL/.test(v.reason), 'reason names only the offending var');

// ---------------------------------------------------------------------------
group('no leak — staging correctly isolated');
ok(emailLinksLeakAcrossEnv({ dbName: 'mirror_staging', appUrl: STAGE, emailPublicBaseUrl: STAGE_BASE }).leaksToProd === false,
  'staging + staging bases -> isolated');
ok(emailLinksLeakAcrossEnv({ dbName: 'mirror_staging', appUrl: STAGE, emailPublicBaseUrl: STAGE_BASE }).isStaging === true,
  'still reported as staging');

// ---------------------------------------------------------------------------
group('prod is never a leak');
ok(emailLinksLeakAcrossEnv({ dbName: 'mirror', appUrl: PROD, emailPublicBaseUrl: PROD_BASE }).leaksToProd === false,
  'prod DB + prod bases -> NOT a leak (expected)');
ok(emailLinksLeakAcrossEnv({ dbName: 'mirror', appUrl: PROD, emailPublicBaseUrl: PROD_BASE }).isStaging === false,
  'prod DB -> not staging');

// ---------------------------------------------------------------------------
group('robustness — malformed / empty never throw');
ok(hostOf(undefined) === '', 'hostOf(undefined) -> ""');
ok(hostOf('not a url') === '', 'hostOf(garbage) -> ""');
ok(hostOf('https://staging.theundergroundrailroad.world/x').includes('staging'), 'hostOf parses valid url');
ok(emailLinksLeakAcrossEnv({ dbName: 'mirror_staging' }).leaksToProd === false,
  'staging + no URLs set -> no leak (nothing points anywhere)');
ok(emailLinksLeakAcrossEnv({}).leaksToProd === false, 'empty env -> no leak, no throw');

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '✓' : '✗'} emailIsolation: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
