// ============================================================================
// UNIT TESTS — TruthStream local review quality scoring (pure; no LLM/DB/HTTP)
// ============================================================================
// Run:  npx ts-node tests/truthstreamScorer.test.ts
// Exit 0 = all passed, 1 = at least one failed.
//
// scoreReview() runs at submission time with no network call, so its output
// gates real reviewer reputation. Proves: completeness/ depth/ constructiveness
// math, the three sub-scores stay in [0,1], blank/█ answers don't count as
// filled, the time-adequacy boundary, keyword-driven constructiveness, and the
// no-questions / empty-review edge cases (no NaN, no divide-by-zero).
// ============================================================================

import { truthStreamReviewScorer as scorer } from '../services/TruthStreamReviewScorer';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function group(name: string): void { console.log(`\n• ${name}`); }
const inRange = (x: number) => typeof x === 'number' && !Number.isNaN(x) && x >= 0 && x <= 1;

// Fixture: a two-question section (one free_text, one scale).
const sections = [
  {
    id: 's1', title: 'Section 1', required: true,
    questions: [
      { id: 'q_text', type: 'free_text', text: 'Explain', config: {} },
      { id: 'q_scale', type: 'scale', text: 'Rate', config: {} },
    ],
  },
  {
    id: 's2', title: 'Section 2', required: false,
    questions: [
      { id: 'q_text2', type: 'category_explain', text: 'Explain more', config: {} },
    ],
  },
];

(async () => {
  // -------------------------------------------------------------------------
  group('empty review — zero everything, no NaN');
  const empty = scorer.scoreReview({}, sections, 0);
  ok(empty.completenessScore === 0, 'no responses -> completeness 0');
  ok(empty.depthScore === 0, 'no responses -> depth 0');
  ok(inRange(empty.qualityScore) && empty.qualityScore === 0, 'no responses -> quality 0');
  ok(empty.breakdown.timeAdequate === false, 'time 0 -> not adequate');
  ok(empty.breakdown.totalFields === 3, 'counts all 3 questions as total fields');
  ok(empty.breakdown.fieldsCompleted === 0, 'zero completed');

  // -------------------------------------------------------------------------
  group('completeness — blank strings and null-score objects do NOT count');
  const halfBlank = scorer.scoreReview({
    s1: { q_text: 'a real answer here', q_scale: '   ' },  // q_scale blank -> not filled
    s2: { q_text2: { score: null } },                       // null score -> not filled
  }, sections, 0);
  ok(halfBlank.breakdown.fieldsCompleted === 1, 'only the real answer counts (1/3)');
  ok(Math.abs(halfBlank.completenessScore - (1 / 3)) < 0.02, 'completeness ~= 1/3');

  // -------------------------------------------------------------------------
  group('time-adequacy boundary (>= 45s)');
  ok(scorer.scoreReview({}, sections, 44).breakdown.timeAdequate === false, '44s -> not adequate');
  ok(scorer.scoreReview({}, sections, 45).breakdown.timeAdequate === true, '45s -> adequate (inclusive)');

  // -------------------------------------------------------------------------
  group('constructiveness — criticism + tips + advice + length + time');
  const constructive = scorer.scoreReview({
    s1: {
      q_text: 'You have a real blind spot around deadlines and it is a growth area to improve.',
      q_scale: { score: 4 },
    },
    s2: { q_text2: 'I recommend you try to practice planning; consider a checklist and focus on it.' },
    free_form: {
      open_reflection:
        'You should try to improve here. I recommend you practice and consider focusing on this growth area; ' +
        'a small daily habit would help build the skill over time and address the blind spot.',
      self_tagged_tone: 'constructive',
    },
  }, sections, 120);
  ok(constructive.breakdown.hasCriticism === true, 'criticism keywords detected');
  ok(constructive.breakdown.hasTipsForOvercoming === true, 'tips keywords detected');
  ok(constructive.breakdown.hasAdvice === true, 'advice (>=2 keywords) detected');
  ok(constructive.breakdown.timeAdequate === true, '120s adequate');
  ok(constructive.completenessScore === 1, 'all fields filled -> completeness 1.0');
  ok(constructive.qualityScore > 0.6, `substantive constructive review scores high (${constructive.qualityScore})`);

  // -------------------------------------------------------------------------
  group('all three sub-scores stay in [0,1] across inputs');
  for (const r of [empty, halfBlank, constructive]) {
    ok(inRange(r.completenessScore), 'completeness in [0,1]');
    ok(inRange(r.depthScore), 'depth in [0,1]');
    ok(inRange(r.qualityScore), 'quality in [0,1]');
  }
  ok(constructive.qualityScore > empty.qualityScore, 'a real review out-scores an empty one');

  // -------------------------------------------------------------------------
  group('edge — a section with no questions never divides by zero');
  const noQ = scorer.scoreReview({}, [{ id: 'x', title: '', required: false, questions: [] }], 0);
  ok(noQ.completenessScore === 0 && noQ.breakdown.totalFields === 0, 'no questions -> completeness 0, total 0 (no NaN)');

  // -------------------------------------------------------------------------
  group('extractors — free-form text and self-tagged tone');
  ok(scorer.extractFreeFormText({ free_form: { open_reflection: 'hello' } }) === 'hello', 'reads open_reflection');
  ok(scorer.extractFreeFormText({}) === '', 'missing free_form -> empty string');
  ok(scorer.extractFreeFormText({ free_form: { open_reflection: 42 } }) === '', 'non-string reflection -> empty');
  ok(scorer.extractSelfTaggedTone({ free_form: { self_tagged_tone: 'harsh' } }) === 'harsh', 'reads self_tagged_tone');
  ok(scorer.extractSelfTaggedTone({}) === undefined, 'missing tone -> undefined');

  // -------------------------------------------------------------------------
  group('determinism — same input, same output');
  const a = scorer.scoreReview({ s1: { q_text: 'answer one two three four' } }, sections, 60);
  const b = scorer.scoreReview({ s1: { q_text: 'answer one two three four' } }, sections, 60);
  ok(JSON.stringify(a) === JSON.stringify(b), 'scoreReview is deterministic');

  // -------------------------------------------------------------------------
  console.log(`\n${failed === 0 ? '✓' : '✗'} truthstreamScorer: ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
