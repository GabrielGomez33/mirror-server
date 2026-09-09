// tests/intakeMerge.test.ts
// Regression proof for the intake read-model MASKING bug (user 48).
//
// THE BUG: getMergedCoreIntake early-stopped as soon as every CORE_SECTION_KEY
// was non-empty at the SECTION level — so a newer PARTIAL record (astrologicalResult
// {western:{sunSign}}, empty big5Profile, empty expressions) marked all sections
// "found" and the loop stopped before reading the older FULL records, masking a
// complete profile behind a skeletal latest. And mergeCoreOverEntry used a shallow
// `{...entry,...core}` that let a partial core section discard a fuller entry one.
//
// This pins the merge invariants the fix relies on: a NEWER EMPTY leaf must NEVER
// erase an OLDER FULL leaf, and Core-over-Entry must be a DEEP (leaf) overlay.
// Run: ts-node tests/intakeMerge.test.ts

import { mergeCoreRecordsNewestFirst, mergeCoreOverEntry, deepOverlay } from '../utils/intakeMerge';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } };

// The exact user-48 shape: a skeletal NEWEST record...
const skeletalNewest = {
  astrologicalResult: { western: { sunSign: 'Aries' } },
  personalityResult: { mbtiType: 'INFP', big5Profile: {} },
  faceAnalysis: { expressions: {} },
  voiceMetadata: { duration: 8 },
};
// ...and an older FULL record.
const fullOlder = {
  astrologicalResult: {
    western: { sunSign: 'Aries', moonSign: 'Cancer', risingSign: 'Leo' },
    numerology: { lifePathNumber: 7 },
  },
  personalityResult: { mbtiType: 'INFP', big5Profile: { openness: 82, conscientiousness: 60, extraversion: 45, agreeableness: 71, neuroticism: 38 } },
  faceAnalysis: { expressions: { happy: 0.7, neutral: 0.3 } },
  voiceMetadata: { duration: 8, mimeType: 'audio/webm', size: 12345 },
};

// --- mergeCoreRecordsNewestFirst: newest empty leaves must NOT erase older full ones ---
const merged = mergeCoreRecordsNewestFirst([skeletalNewest, fullOlder]);
ok(merged.astrologicalResult?.western?.moonSign === 'Cancer', 'older moonSign survives a skeletal newer record');
ok(merged.astrologicalResult?.western?.risingSign === 'Leo', 'older risingSign survives');
ok(merged.astrologicalResult?.numerology?.lifePathNumber === 7, 'older numerology.lifePath survives (Life Path renders)');
ok(merged.personalityResult?.big5Profile?.openness === 82, 'older big5Profile numbers survive an empty {} in the newer record');
ok(Object.keys(merged.personalityResult?.big5Profile ?? {}).length === 5, 'big5Profile has all 5 traits (no NaN)');
ok(merged.faceAnalysis?.expressions?.happy === 0.7, 'older expressions survive an empty {} in the newer record');
ok(merged.voiceMetadata?.mimeType === 'audio/webm', 'older voiceMetadata fields survive');
// Newer non-empty leaves still win:
const newerWins = mergeCoreRecordsNewestFirst([
  { astrologicalResult: { western: { sunSign: 'Leo' } } },   // newest
  { astrologicalResult: { western: { sunSign: 'Aries', moonSign: 'Cancer' } } }, // older
]);
ok(newerWins.astrologicalResult.western.sunSign === 'Leo', 'a newer NON-empty leaf still wins over older');
ok(newerWins.astrologicalResult.western.moonSign === 'Cancer', '...while older leaves absent from newer are preserved');

// --- mergeCoreOverEntry: DEEP, not shallow — a partial core section keeps entry gaps ---
const entrySections = {
  astrologicalResult: { western: { sunSign: 'Aries', moonSign: 'Cancer', risingSign: 'Leo' }, numerology: { lifePathNumber: 7 } },
  personalityResult: { mbtiType: 'INFP', big5Profile: { openness: 82 } },
};
const partialCore = { astrologicalResult: { western: { sunSign: 'Virgo' } } }; // core partial: only sun
const coreOverEntry = mergeCoreOverEntry(entrySections, partialCore)!;
ok(coreOverEntry.astrologicalResult.western.sunSign === 'Virgo', 'core wins where present (sunSign)');
ok(coreOverEntry.astrologicalResult.western.moonSign === 'Cancer', 'entry moon survives a partial core section (deep, not shallow replace)');
ok(coreOverEntry.astrologicalResult.numerology?.lifePathNumber === 7, 'entry numerology survives a partial core astrologicalResult');
ok(mergeCoreOverEntry({}, null) === null, 'no entry + no core -> null');

// deepOverlay sanity: empty object in `over` never erases a populated base
const ov = deepOverlay({ a: { x: 1, y: 2 } }, { a: {} });
ok(ov.a.x === 1 && ov.a.y === 2, 'deepOverlay: empty object in over preserves base');

if (fail) { console.error(`\nintakeMerge: ${pass} passed, ${fail} FAILED`); process.exit(1); }
console.log(`intakeMerge: ${pass} passed — skeletal newer records cannot mask older full data`);
