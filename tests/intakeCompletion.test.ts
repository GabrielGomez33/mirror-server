// ============================================================================
// UNIT TESTS — intake completion derivation (pure logic; no DB, no env)
// ============================================================================
// Run:  npx ts-node tests/intakeCompletion.test.ts
// Exit code 0 = all passed, 1 = at least one failed.
//
// Proves the PURE decision logic that drives users.intake_completed
// (docs/entry-core-intake-spec.md §3, §8 case 8). The DB-backed behaviours
// (per-user serialization, concurrent complete => 1 row, transactional flip)
// require a live MySQL and are exercised by the integration steps documented at
// the end of Phase 2 — not here.
//
// Covers:
//   isCoreStep         — allowlist membership, rejects everything else
//   stepsPresentInPayload — section->step mapping for the legacy /store bridge
//   isIntakeComplete   — TRUE only when all five core steps are completed
// ============================================================================

import {
  isCoreStep,
  stepsPresentInPayload,
  isIntakeComplete,
  CORE_STEPS,
} from '../services/intakeCompletion';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function eq(a: unknown, b: unknown, msg: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);
}
function group(name: string): void { console.log(`\n• ${name}`); }

// ---------------------------------------------------------------------------
group('isCoreStep — allowlist');
for (const s of CORE_STEPS) ok(isCoreStep(s) === true, `accepts "${s}"`);
ok(isCoreStep('welcome') === false, 'rejects non-core step');
ok(isCoreStep('') === false, 'rejects empty');
ok(isCoreStep('IQ') === false, 'case-sensitive: rejects "IQ"');
ok(isCoreStep(undefined) === false, 'rejects undefined');
ok(isCoreStep(5 as unknown) === false, 'rejects non-string');
ok(isCoreStep('personality; DROP TABLE users') === false, 'rejects injection-y string');

// ---------------------------------------------------------------------------
group('stepsPresentInPayload — section -> step');
eq(stepsPresentInPayload(null), [], 'null -> []');
eq(stepsPresentInPayload({}), [], 'empty payload -> []');
eq(stepsPresentInPayload({ personalityResult: { mbtiType: 'INFP' } }), ['personality'],
  'personality only');
eq(stepsPresentInPayload({ iqResults: { rawScore: 10 } }), ['iq'], 'iq only');
eq(stepsPresentInPayload({ astrologicalResult: { western: {} } }), ['astrology'], 'astrology only');
eq(stepsPresentInPayload({ faceAnalysis: { detection: {} } }), ['visual'], 'faceAnalysis -> visual');
eq(stepsPresentInPayload({ photoFileRef: { id: 'x' } }), ['visual'], 'photoFileRef -> visual');
eq(stepsPresentInPayload({ voiceMetadata: { duration: 5 } }), ['vocal'], 'voiceMetadata -> vocal');
eq(stepsPresentInPayload({ voiceFileRef: { id: 'x' } }), ['vocal'], 'voiceFileRef -> vocal');
eq(
  stepsPresentInPayload({
    faceAnalysis: {}, voiceMetadata: {}, iqResults: {}, astrologicalResult: {}, personalityResult: {},
  }),
  ['visual', 'vocal', 'iq', 'astrology', 'personality'],
  'full payload -> all five in canonical order'
);
// Entry-shaped payload (personality + astrology) must NOT imply visual/vocal/iq.
eq(
  stepsPresentInPayload({ personalityResult: {}, astrologicalResult: {} }),
  ['astrology', 'personality'],
  'entry-shaped payload maps only to its two sections'
);

// ---------------------------------------------------------------------------
group('isIntakeComplete — all five required');
ok(isIntakeComplete(CORE_STEPS) === true, 'all five -> true');
ok(isIntakeComplete(['visual', 'vocal', 'iq', 'astrology']) === false, 'four -> false');
ok(isIntakeComplete([]) === false, 'none -> false');
ok(isIntakeComplete(['personality']) === false, 'one -> false');
ok(
  isIntakeComplete([...CORE_STEPS, 'welcome', 'visual']) === true,
  'extra/duplicate keys ignored -> still true'
);

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '✓' : '✗'} intakeCompletion: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
