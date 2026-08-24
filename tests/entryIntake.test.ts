// ============================================================================
// UNIT TESTS — Entry intake validation + merge read-model (pure; no DB/env)
// ============================================================================
// Run:  npx ts-node tests/entryIntake.test.ts
// Exit code 0 = all passed, 1 = at least one failed.
//
// Proves (spec §5, §6):
//   validateEntrySubmit  — shape/size/date/time rules; requires >=1 section
//   coerceJson           — object passthrough, string parse, junk -> null
//   entryToIntakeSections— entry row -> partial intakeData sections
//   mergeCoreOverEntry   — CORE wins per section; entry fills gaps; both empty -> null
// ============================================================================

import { validateEntrySubmit, MAX_SECTION_BYTES } from '../utils/entryIntakeValidation';
import {
  coerceJson,
  entryToIntakeSections,
  mergeCoreOverEntry,
  type EntryResult,
} from '../utils/intakeMerge';

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
group('validateEntrySubmit — happy path');
{
  const r = validateEntrySubmit({
    personalityResult: { mbtiType: 'INFP', big5Profile: {} },
    astrologyResult: { western: { sunSign: 'Leo' } },
    birthDate: '1990-07-30', birthTime: '14:05', birthPlace: '  Denver  ', displayName: '  Gabriel  ',
  });
  ok(r.ok === true, 'valid payload accepted');
  if (r.ok) {
    eq(r.value.birthTime, '14:05:00', 'birthTime normalized to HH:MM:SS');
    eq(r.value.birthPlace, 'Denver', 'birthPlace trimmed');
    eq(r.value.displayName, 'Gabriel', 'displayName trimmed');
    eq(r.value.birthDate, '1990-07-30', 'birthDate preserved');
  }
}

group('validateEntrySubmit — rejections');
ok(validateEntrySubmit(null).ok === false, 'null body rejected');
ok(validateEntrySubmit('x').ok === false, 'string body rejected');
ok(validateEntrySubmit({}).ok === false, 'empty payload rejected (needs a section)');
ok(validateEntrySubmit({ birthDate: '1990-07-30' }).ok === false, 'only birthDate (no section) rejected');
ok(validateEntrySubmit({ personalityResult: [1, 2] }).ok === false, 'array section rejected');
ok(validateEntrySubmit({ personalityResult: {}, birthDate: '07/30/1990' }).ok === false, 'bad date format rejected');
ok(validateEntrySubmit({ personalityResult: {}, birthDate: '1990-13-40' }).ok === false, 'impossible date rejected');
ok(validateEntrySubmit({ personalityResult: {}, birthTime: '25:00' }).ok === false, 'bad hour rejected');
ok(validateEntrySubmit({ personalityResult: {}, displayName: 'x'.repeat(200) }).ok === false, 'overlong name rejected');
{
  const big = { blob: 'x'.repeat(MAX_SECTION_BYTES + 10) };
  ok(validateEntrySubmit({ personalityResult: big }).ok === false, 'oversized section rejected');
}
// Accepts the alternate astrology key the client may send.
ok(validateEntrySubmit({ astrologicalResult: { western: {} } }).ok === true, 'astrologicalResult key accepted');
// Empty/whitespace optional strings normalize to null, not error.
{
  const r = validateEntrySubmit({ personalityResult: {}, birthPlace: '   ' });
  ok(r.ok === true && r.value.birthPlace === null, 'blank birthPlace -> null');
}

// ---------------------------------------------------------------------------
group('coerceJson');
eq(coerceJson({ a: 1 }), { a: 1 }, 'object passthrough');
eq(coerceJson('{"a":1}'), { a: 1 }, 'json string parsed');
ok(coerceJson('not json') === null, 'junk string -> null');
ok(coerceJson(null) === null, 'null -> null');
ok(coerceJson(undefined) === null, 'undefined -> null');

// ---------------------------------------------------------------------------
group('entryToIntakeSections + mergeCoreOverEntry');
const entry: EntryResult = {
  personalityResult: { mbtiType: 'INFP' },
  astrologicalResult: { western: { sunSign: 'Leo' } },
  birthDate: '1990-07-30',
  displayName: 'Gabriel',
  confidence: 'preliminary',
  updatedAt: null,
};
const sections = entryToIntakeSections(entry);
eq(Object.keys(sections).sort(), ['astrologicalResult', 'birthDate', 'name', 'personalityResult'],
  'entry maps to its four sections (name from displayName)');
eq(entryToIntakeSections(null), {}, 'null entry -> {}');

// Core wins per section; entry fills the gaps.
{
  const core = { personalityResult: { mbtiType: 'ENTJ' }, iqResults: { iqScore: 130 } };
  const merged = mergeCoreOverEntry(sections, core);
  eq((merged as any).personalityResult, { mbtiType: 'ENTJ' }, 'CORE personality overrides entry');
  eq((merged as any).astrologicalResult, { western: { sunSign: 'Leo' } }, 'entry astrology fills gap');
  eq((merged as any).iqResults, { iqScore: 130 }, 'core-only section present');
}
ok(mergeCoreOverEntry({}, null) === null, 'both empty -> null');
eq(mergeCoreOverEntry(sections, null), sections, 'entry-only -> entry sections');
eq(mergeCoreOverEntry({}, { iqResults: { iqScore: 100 } }), { iqResults: { iqScore: 100 } }, 'core-only passthrough');

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '✓' : '✗'} entryIntake: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
