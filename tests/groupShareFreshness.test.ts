// tests/groupShareFreshness.test.ts
// Proof for the Groups snapshot FRESHNESS rule (services/groupShareFreshness).
//
// The invariant that protects users: a group's shared snapshot is "outdated"
// EXACTLY when the user's assessment data changed AFTER they last shared it —
// so a retake surfaces a re-share prompt, but an un-shared group never nags and
// a just-re-shared group reads current. This also guards the two silent-bug
// directions: (a) a null share must NOT be reported outdated (nothing shared),
// (b) an equal timestamp must read current (a fresh re-share deterministically
// clears the flag).
//
// Run: ts-node tests/groupShareFreshness.test.ts

import { isShareOutdated } from '../utils/groupShareFreshness';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } };

const T0 = new Date('2025-01-01T00:00:00Z');
const T1 = new Date('2025-06-01T00:00:00Z'); // later

// --- Core rule: data changed AFTER the share -> outdated. --------------------
ok(isShareOutdated(T1, T0) === true, 'intake changed after share -> outdated (prompt to re-share)');
ok(isShareOutdated(T0, T1) === false, 'intake older than share -> current');
ok(isShareOutdated(T0, T0) === false, 'equal timestamps -> current (fresh re-share clears the flag)');

// --- Nothing shared: never "outdated" (UI shows Share, not Update). ----------
ok(isShareOutdated(T1, null) === false, 'no share -> not outdated (nothing to be stale)');
ok(isShareOutdated(null, null) === false, 'no intake + no share -> not outdated');

// --- No known intake-change time: cannot claim staleness. --------------------
ok(isShareOutdated(null, T0) === false, 'unknown intake-change time -> not outdated (no false alarm)');

// --- One-second boundary: strictly-newer change is outdated. -----------------
const justAfter = new Date(T0.getTime() + 1000);
ok(isShareOutdated(justAfter, T0) === true, 'change 1s after share -> outdated');
const justBefore = new Date(T0.getTime() - 1000);
ok(isShareOutdated(justBefore, T0) === false, 'change 1s before share -> current');

if (fail) { console.error(`\ngroupShareFreshness: ${pass} passed, ${fail} FAILED`); process.exit(1); }
console.log(`groupShareFreshness: ${pass} passed — a retake correctly flags shared groups as outdated`);
