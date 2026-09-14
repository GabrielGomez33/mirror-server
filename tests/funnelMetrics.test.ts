// tests/funnelMetrics.test.ts
// Proof for the traffic-analytics funnel math (utils/funnelMetrics). Pure, no DB.
// Locks the invariants the operator dashboard relies on: the reached-funnel is
// monotonic non-increasing, drop-off/conversion arithmetic is correct and
// division-by-zero-safe, milestones map to the right stages, and the "biggest
// drop" is the step that loses the most sessions.
// Run: ts-node tests/funnelMetrics.test.ts

import {
  buildReachedFunnel,
  computeFunnelMetrics,
  ratePct,
  type ReachedRow,
} from '../utils/funnelMetrics';
import { FUNNEL_STAGES } from '../utils/conversionFunnel';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } };
const reach = (stageReach: ReturnType<typeof buildReachedFunnel>, stage: string) =>
  stageReach.find((s) => s.stage === stage)!.sessionsReaching;

// --- ratePct: safe division, 1-decimal rounding ---
ok(ratePct(5, 175) === 2.9, 'ratePct rounds 5/175 -> 2.9');
ok(ratePct(1, 3) === 33.3, 'ratePct rounds 1/3 -> 33.3');
ok(ratePct(0, 0) === null, 'ratePct 0/0 -> null (no NaN)');
ok(ratePct(5, 0) === null, 'ratePct x/0 -> null');
ok(ratePct(3, 3) === 100, 'ratePct 3/3 -> 100');

// Per-session furthest-stage counts (1-based FIELD positions):
//   100 stopped at landing (pos1), 50 at signup_completed (pos3),
//   20 at entry_first_value (pos5), 5 at premium_activated (pos11).
const rows: ReachedRow[] = [
  { reached: 1, sessions: 100 },
  { reached: 3, sessions: 50 },
  { reached: 5, sessions: 20 },
  { reached: 11, sessions: 5 },
];
const sr = buildReachedFunnel(rows);

// --- monotonic funnel ---
ok(sr.length === FUNNEL_STAGES.length, 'one row per funnel stage');
let monotonic = true;
for (let i = 1; i < sr.length; i++) if (sr[i].sessionsReaching > sr[i - 1].sessionsReaching) monotonic = false;
ok(monotonic, 'reached-funnel is monotonic non-increasing');
ok(reach(sr, 'landing_view') === 175, 'landing reaching = 175 (all sessions)');
ok(reach(sr, 'signup_completed') === 75, 'signup_completed reaching = 75 (50+20+5)');
ok(reach(sr, 'entry_first_value') === 25, 'entry_first_value reaching = 25 (20+5)');
ok(reach(sr, 'premium_activated') === 5, 'premium_activated reaching = 5');
ok(reach(sr, 'signup_view') === 75, 'a skipped-but-passed-through stage still counts (signup_view = 75)');

const m = computeFunnelMetrics(sr);

// --- entry + overall ---
ok(m.entrySessions === 175, 'entrySessions = 175');
ok(m.overallConversionPct === ratePct(5, 175), 'overall conversion = premium/landing = 2.9%');

// --- step metrics ---
const step = (stage: string) => m.steps.find((s) => s.stage === stage)!;
ok(step('landing_view').stepConversionPct === null, 'first stage has no step-conversion');
ok(step('landing_view').cumulativeConversionPct === 100, 'first stage cumulative = 100%');
ok(step('signup_view').sessionsLostFromPrev === 100, 'landing→signup_view loses 100 sessions');
ok(step('signup_view').stepDropoffPct === ratePct(100, 175), 'landing→signup_view drop-off % correct');
ok(step('premium_activated').cumulativeConversionPct === ratePct(5, 175), 'premium cumulative vs entry correct');

// --- milestones map to the right stages + rates ---
const mil = (k: string) => m.milestones.find((x) => x.key === k)!;
ok(mil('landing_to_signup').ratePct === ratePct(75, 175), 'landing→signup milestone = 75/175');
ok(mil('signup_to_aha').ratePct === ratePct(25, 75), 'signup→aha milestone = 25/75');
ok(mil('aha_to_core').ratePct === ratePct(5, 25), 'aha→core milestone = 5/25');
ok(mil('core_to_premium').ratePct === 100, 'core→premium milestone = 5/5 = 100%');

// --- biggest drop = the step losing the most sessions ---
ok(!!m.biggestDrop, 'a biggest drop is identified');
ok(m.biggestDrop!.fromStage === 'landing_view' && m.biggestDrop!.toStage === 'signup_view',
   'biggest drop is landing_view → signup_view');
ok(m.biggestDrop!.sessionsLost === 100, 'biggest drop lost 100 sessions');

// --- empty input: no crash, all null/zero ---
const empty = computeFunnelMetrics(buildReachedFunnel([]));
ok(empty.entrySessions === 0, 'empty funnel entrySessions = 0');
ok(empty.overallConversionPct === null, 'empty funnel overall conversion = null');
ok(empty.biggestDrop === null, 'empty funnel has no biggest drop');
ok(empty.steps.length === FUNNEL_STAGES.length, 'empty funnel still lists every stage');

if (fail) { console.error(`\nfunnelMetrics: ${pass} passed, ${fail} FAILED`); process.exit(1); }
console.log(`funnelMetrics: ${pass} passed — drop-off/conversion math + biggest-drop are correct and safe`);
