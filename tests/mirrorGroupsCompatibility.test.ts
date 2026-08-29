// ============================================================================
// UNIT TESTS — MirrorGroups compatibility (CompatibilityCalculator)
// ============================================================================
// Run:  npx ts-node tests/mirrorGroupsCompatibility.test.ts
// Exit 0 = all passed, 1 = at least one failed.
//
// Exercises the REAL pairwise engine end-to-end (calculateMatrix) plus the pure
// public helpers. Proves the invariants a compatibility matrix must always hold,
// that the score MEANS something (aligned members > opposed members), that
// missing/partial member data never crashes and stays in range, and the edge
// cases (single member, empty group).
// ============================================================================

import { compatibilityCalculator as calc } from '../analyzers/CompatibilityCalculator';
import type { MemberData, CompatibilityMatrix } from '../analyzers/GroupAnalyzer';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function group(name: string): void { console.log(`\n• ${name}`); }
const inRange = (x: number) => typeof x === 'number' && x >= 0 && x <= 1;

// Fixture builder — a member whose scored fields we control.
function member(
  userId: string,
  opts: {
    embedding?: number[];
    comm?: string;
    conflict?: string;
    energy?: number;
  } = {},
): MemberData {
  return {
    userId,
    personality: {
      embedding: opts.embedding ?? [0.5, 0.5, 0.5],
      traits: { openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 50, neuroticism: 50 },
      communicationStyle: opts.comm ?? 'direct',
      conflictResolutionStyle: opts.conflict ?? 'collaborating',
    },
    behavioral: { tendencies: [], socialEnergy: opts.energy ?? 0.5, empathyLevel: 0.5 },
    sharedAt: new Date(),
    dataTypes: ['personality', 'behavioral'],
  };
}

function matrixInvariants(m: CompatibilityMatrix, n: number, label: string): void {
  ok(m.matrix.length === n, `${label}: ${n}x? row count`);
  ok(m.matrix.every((row) => row.length === n), `${label}: every row length ${n}`);
  for (let i = 0; i < n; i++) {
    ok(m.matrix[i][i] === 1.0, `${label}: diagonal[${i}] === 1.0 (perfect self-compat)`);
    for (let j = 0; j < n; j++) {
      ok(inRange(m.matrix[i][j]), `${label}: cell[${i}][${j}] in [0,1]`);
      ok(Math.abs(m.matrix[i][j] - m.matrix[j][i]) < 1e-9, `${label}: symmetric [${i}][${j}]`);
    }
  }
  ok(inRange(m.averageCompatibility), `${label}: averageCompatibility in [0,1]`);
  ok(m.memberIds.length === n, `${label}: memberIds length ${n}`);
}

(async () => {
  // -------------------------------------------------------------------------
  group('calculateMatrix — structural invariants (2 members)');
  const two = await calc.calculateMatrix([member('userA01'), member('userB02')]);
  matrixInvariants(two, 2, '2-member');

  // -------------------------------------------------------------------------
  group('calculateMatrix — score is meaningful (aligned pair > opposed pair)');
  const aligned = await calc.calculateMatrix([
    member('aligned01', { embedding: [1, 0, 0], comm: 'direct', conflict: 'collaborating', energy: 0.5 }),
    member('aligned02', { embedding: [1, 0, 0], comm: 'direct', conflict: 'collaborating', energy: 0.5 }),
  ]);
  const opposed = await calc.calculateMatrix([
    member('opposed01', { embedding: [1, 0, 0], comm: 'analytical', conflict: 'avoiding', energy: 0.05 }),
    member('opposed02', { embedding: [0, 1, 0], comm: 'indirect', conflict: 'avoiding', energy: 0.95 }),
  ]);
  const alignedScore = aligned.matrix[0][1];
  const opposedScore = opposed.matrix[0][1];
  ok(alignedScore > opposedScore, `aligned (${alignedScore.toFixed(3)}) > opposed (${opposedScore.toFixed(3)})`);
  ok(alignedScore > 0.7, `aligned pair scores high (${alignedScore.toFixed(3)} > 0.7)`);
  ok(opposedScore < 0.5, `opposed pair scores low (${opposedScore.toFixed(3)} < 0.5)`);

  // -------------------------------------------------------------------------
  group('calculateMatrix — missing/partial data never crashes, stays in range');
  const sparse = await calc.calculateMatrix([
    { userId: 'sparse01', sharedAt: new Date(), dataTypes: [] },      // no personality/behavioral
    { userId: 'sparse02', sharedAt: new Date(), dataTypes: [] },
  ]);
  matrixInvariants(sparse, 2, 'sparse');
  ok(sparse.matrix[0][1] > 0, 'sparse pair still yields a positive neutral-ish score (no NaN/0-crash)');

  // -------------------------------------------------------------------------
  group('calculateMatrix — edge cases (single member, empty group)');
  const one = await calc.calculateMatrix([member('solo0001')]);
  ok(one.matrix.length === 1 && one.matrix[0][0] === 1.0, 'single member -> [[1.0]]');
  ok(one.averageCompatibility === 0, 'single member -> averageCompatibility 0 (no pairs)');
  const none = await calc.calculateMatrix([]);
  ok(none.matrix.length === 0 && none.memberIds.length === 0, 'empty group -> empty matrix');
  ok(none.averageCompatibility === 0, 'empty group -> averageCompatibility 0');

  // -------------------------------------------------------------------------
  group('calculateMatrix — larger group symmetry (3 members)');
  const three = await calc.calculateMatrix([member('mA000001'), member('mB000002'), member('mC000003')]);
  matrixInvariants(three, 3, '3-member');

  // -------------------------------------------------------------------------
  group('getCompatibilityInterpretation — score bands');
  ok(calc.getCompatibilityInterpretation(0.85) === 'High compatibility', '>=0.8 -> High');
  ok(calc.getCompatibilityInterpretation(0.65) === 'Moderate compatibility', '>=0.6 -> Moderate');
  ok(calc.getCompatibilityInterpretation(0.45) === 'Needs attention', '>=0.4 -> Needs attention');
  ok(calc.getCompatibilityInterpretation(0.2) === 'High friction risk', '<0.4 -> High friction');
  ok(calc.getCompatibilityInterpretation(0.8) === 'High compatibility', 'boundary 0.8 inclusive');

  // -------------------------------------------------------------------------
  group('calculateGroupCohesion — bounded, and low-variance beats high-variance');
  ok(calc.calculateGroupCohesion(two) >= 0 && calc.calculateGroupCohesion(two) <= 1, 'cohesion of a real matrix in [0,1]');
  // Empty pairwiseDetails -> 0
  const emptyCohesion = calc.calculateGroupCohesion({
    matrix: [], memberIds: [], pairwiseDetails: new Map(), averageCompatibility: 0,
    visualization: { heatmapData: [], clusterGroups: [] },
  } as unknown as CompatibilityMatrix);
  ok(emptyCohesion === 0, 'no pairs -> cohesion 0');
  // Same average, different variance: tight cluster should be >= spread cluster
  const mk = (scores: number[]): CompatibilityMatrix => ({
    matrix: [], memberIds: [],
    pairwiseDetails: new Map(scores.map((s, i) => [`p${i}`, { score: s } as any])),
    averageCompatibility: scores.reduce((a, b) => a + b, 0) / scores.length,
    visualization: { heatmapData: [], clusterGroups: [] },
  } as unknown as CompatibilityMatrix);
  const tight = calc.calculateGroupCohesion(mk([0.7, 0.7, 0.7]));
  const spread = calc.calculateGroupCohesion(mk([0.4, 0.7, 1.0])); // same avg 0.7, higher variance
  ok(tight > spread, `tight cluster cohesion (${tight.toFixed(3)}) > spread (${spread.toFixed(3)})`);

  // -------------------------------------------------------------------------
  console.log(`\n${failed === 0 ? '✓' : '✗'} mirrorGroupsCompatibility: ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
