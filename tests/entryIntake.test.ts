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
  mergeCoreRecordsNewestFirst,
  isNonEmptyValue,
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
group('isNonEmptyValue');
ok(isNonEmptyValue({ a: 1 }) === true, 'non-empty object -> true');
ok(isNonEmptyValue({}) === false, 'empty object -> false');
ok(isNonEmptyValue('x') === true, 'non-empty string -> true');
ok(isNonEmptyValue('  ') === false, 'blank string -> false');
ok(isNonEmptyValue([]) === false, 'empty array -> false');
ok(isNonEmptyValue([1]) === true, 'non-empty array -> true');
ok(isNonEmptyValue(0) === true, 'zero (number) -> true');
ok(isNonEmptyValue(null) === false, 'null -> false');
ok(isNonEmptyValue(undefined) === false, 'undefined -> false');

// ---------------------------------------------------------------------------
group('mergeCoreRecordsNewestFirst — a junk latest must NOT mask a full record');
{
  // This is the user-48 production case: newest record is {name:"x"}, the real
  // full intake is older. The merge must recover every section.
  const junkNewest = { name: 'x' };
  const fullOlder = {
    name: 'Gabriel',
    personalityResult: { mbtiType: 'INFP' },
    astrologicalResult: { western: { sunSign: 'Leo' } },
    iqResults: { iqScore: 128 },
    faceAnalysis: { expressions: {} },
    voiceMetadata: { duration: 8 },
  };
  const merged = mergeCoreRecordsNewestFirst([junkNewest, fullOlder]); // newest first
  eq((merged as any).personalityResult, { mbtiType: 'INFP' }, 'personality recovered from older full record');
  eq((merged as any).astrologicalResult, { western: { sunSign: 'Leo' } }, 'astrology recovered');
  eq((merged as any).iqResults, { iqScore: 128 }, 'iq recovered');
  ok(!!(merged as any).faceAnalysis && !!(merged as any).voiceMetadata, 'face + voice recovered');
  eq((merged as any).name, 'x', 'newest non-empty name wins (cosmetic, newest record)');
}
{
  // Newer record UPDATES a section -> newest non-empty wins.
  const merged = mergeCoreRecordsNewestFirst([
    { personalityResult: { mbtiType: 'ENTJ' } }, // newer
    { personalityResult: { mbtiType: 'INFP' }, iqResults: { iqScore: 100 } }, // older
  ]);
  eq((merged as any).personalityResult, { mbtiType: 'ENTJ' }, 'newer personality wins');
  eq((merged as any).iqResults, { iqScore: 100 }, 'older iq still filled in');
}
ok(mergeCoreRecordsNewestFirst([]) && Object.keys(mergeCoreRecordsNewestFirst([])).length === 0, 'empty -> {}');
ok(Object.keys(mergeCoreRecordsNewestFirst([null, undefined, { a: 1 }])).length === 1, 'skips null/undefined records');

group('mergeCoreRecordsNewestFirst — DEEP: a partial SECTION must not erase sibling fields');
{
  // The exact production case: a newest record with only western.sunSign must
  // NOT wipe moon/rising/chinese/numerology from the earlier full chart.
  const partialNewest = { astrologicalResult: { western: { sunSign: 'Leo' } } };
  const fullOlder = {
    astrologicalResult: {
      western: { sunSign: 'Aries', moonSign: 'Cancer', risingSign: 'Virgo' },
      chinese: { animal: 'Dragon', element: 'Wood' },
      numerology: { lifePathNumber: 7 },
      synthesis: { lifeDirection: 'x' },
    },
    personalityResult: { mbtiType: 'INFP' },
  };
  const merged = mergeCoreRecordsNewestFirst([partialNewest, fullOlder]); // newest first
  const a = (merged as any).astrologicalResult;
  eq(a.western.sunSign, 'Leo', 'newest sunSign wins');
  eq(a.western.moonSign, 'Cancer', 'moonSign preserved from full chart');
  eq(a.western.risingSign, 'Virgo', 'risingSign preserved');
  eq(a.chinese, { animal: 'Dragon', element: 'Wood' }, 'chinese section preserved');
  eq(a.numerology, { lifePathNumber: 7 }, 'numerology preserved');
  eq((merged as any).personalityResult, { mbtiType: 'INFP' }, 'other sections intact');
}
{
  // Empty nested object in the newer record must not wipe the older section.
  const merged = mergeCoreRecordsNewestFirst([
    { astrologicalResult: { western: {} } },
    { astrologicalResult: { western: { sunSign: 'Leo' } } },
  ]);
  eq((merged as any).astrologicalResult.western.sunSign, 'Leo', 'empty {western:{}} does not erase sunSign');
}

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '✓' : '✗'} entryIntake: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
