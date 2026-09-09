// tests/intakeFreshness.test.ts
// Proof for the shared freshness predicate (utils/intakeFreshness.isDataChangedSince),
// which backs BOTH the Groups "outdated snapshot" prompt and the personal-analysis
// "regenerate" hint. Pins the rule and the two false-alarm directions.
//
// Run: ts-node tests/intakeFreshness.test.ts

import { isDataChangedSince } from '../utils/intakeFreshness';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } };

const GEN = new Date('2025-01-01T00:00:00Z');       // e.g. analysis generated / data shared
const CHANGED_LATER = new Date('2025-06-01T00:00:00Z');
const CHANGED_EARLIER = new Date('2024-06-01T00:00:00Z');

// Core rule: data changed strictly AFTER the reference -> stale.
ok(isDataChangedSince(CHANGED_LATER, GEN) === true, 'intake changed after reference -> outdated (prompt refresh)');
ok(isDataChangedSince(CHANGED_EARLIER, GEN) === false, 'intake older than reference -> current');
ok(isDataChangedSince(GEN, GEN) === false, 'equal timestamps -> current (regenerate/re-share clears it)');

// No false alarms.
ok(isDataChangedSince(CHANGED_LATER, null) === false, 'no reference (never generated/shared) -> not outdated');
ok(isDataChangedSince(null, GEN) === false, 'unknown intake-change time -> not outdated');
ok(isDataChangedSince(null, null) === false, 'nothing known -> not outdated');

// Second-level boundary.
ok(isDataChangedSince(new Date(GEN.getTime() + 1000), GEN) === true, 'change 1s after reference -> outdated');
ok(isDataChangedSince(new Date(GEN.getTime() - 1000), GEN) === false, 'change 1s before reference -> current');

if (fail) { console.error(`\nintakeFreshness: ${pass} passed, ${fail} FAILED`); process.exit(1); }
console.log(`intakeFreshness: ${pass} passed — shared "data changed since" predicate holds for groups + analysis`);
