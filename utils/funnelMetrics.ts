// utils/funnelMetrics.ts
// ----------------------------------------------------------------------------
// PURE funnel math for the traffic-analytics dashboard. No DB, no HTTP — takes
// aggregate session counts and derives the operator-facing metrics: a monotonic
// reached-funnel, per-step conversion / drop-off, cumulative conversion, named
// milestone rates, the single biggest drop ("the bump"), and overall conversion.
//
// Kept separate from services/conversionAnalytics (which does the SQL) so the
// arithmetic is unit-testable in isolation and identical regardless of source.
// The funnel is ANONYMOUS + AGGREGATE — these are counts of ephemeral session
// tokens, never people.
// ----------------------------------------------------------------------------

import { FUNNEL_STAGES, funnelStageOrder } from './conversionFunnel';

/** Sessions whose FURTHEST stage reached is exactly this 1-based position. */
export interface ReachedRow {
  reached: number; // 1-based FIELD() position (1..N); rows with 0 are dropped by the caller
  sessions: number;
}

/** Monotonic funnel: sessions that reached AT LEAST this stage. */
export interface StageReach {
  stage: string;
  order: number; // 0-based funnel order
  sessionsReaching: number;
}

export interface FunnelStepMetric {
  stage: string;
  order: number;
  sessionsReaching: number;
  sessionsLostFromPrev: number | null; // vs the previous stage (null at entry)
  stepConversionPct: number | null; // reaching[i] / reaching[i-1]
  stepDropoffPct: number | null; // 1 - stepConversion
  cumulativeConversionPct: number | null; // reaching[i] / reaching[0]
}

export interface MilestoneRate {
  key: string;
  label: string;
  fromStage: string;
  toStage: string;
  fromSessions: number;
  toSessions: number;
  ratePct: number | null;
}

export interface BiggestDrop {
  fromStage: string;
  toStage: string;
  sessionsLost: number;
  dropoffPct: number | null;
}

export interface FunnelMetrics {
  entrySessions: number; // sessions reaching the first stage (landing_view)
  steps: FunnelStepMetric[];
  milestones: MilestoneRate[];
  biggestDrop: BiggestDrop | null;
  overallConversionPct: number | null; // first stage -> last stage
}

/** Round to one decimal; null when the denominator is 0 (no division-by-zero, no NaN). */
export function ratePct(numerator: number, denominator: number): number | null {
  if (!denominator || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Build the monotonic reached-funnel from per-session "furthest stage" counts.
 * sessionsReaching[i] = sessions whose furthest stage is at or beyond stage i.
 * This is the correct basis for drop-off: a session that emitted stage 4 but not
 * stage 2 still counts as having reached stage 2 (it passed through), so the
 * funnel never rises as you go deeper.
 */
export function buildReachedFunnel(rows: ReachedRow[]): StageReach[] {
  // sessionsAtExactly[k] for k in 1..N (1-based position). Ignore reached<=0.
  const n = FUNNEL_STAGES.length;
  const atExactly = new Array<number>(n + 1).fill(0);
  for (const r of rows) {
    const k = Math.floor(Number(r.reached) || 0);
    if (k >= 1 && k <= n) atExactly[k] += Math.max(0, Number(r.sessions) || 0);
  }
  // sessionsReaching[i] (0-based) = sum of atExactly[k] for k >= i+1 (suffix sum).
  const reaching = new Array<number>(n).fill(0);
  let suffix = 0;
  for (let k = n; k >= 1; k--) {
    suffix += atExactly[k];
    reaching[k - 1] = suffix;
  }
  return FUNNEL_STAGES.map((stage, i) => ({ stage, order: i, sessionsReaching: reaching[i] }));
}

// The four milestones that matter most for this product's conversion story.
const MILESTONE_DEFS: Array<{ key: string; label: string; from: string; to: string }> = [
  { key: 'landing_to_signup', label: 'Landing → Signup', from: 'landing_view', to: 'signup_completed' },
  { key: 'signup_to_aha', label: 'Signup → First value (aha)', from: 'signup_completed', to: 'entry_first_value' },
  { key: 'aha_to_core', label: 'First value → Core complete', from: 'entry_first_value', to: 'core_completed' },
  { key: 'core_to_premium', label: 'Core complete → Premium', from: 'core_completed', to: 'premium_activated' },
];

/** Derive all operator-facing metrics from a monotonic reached-funnel. */
export function computeFunnelMetrics(stageReach: StageReach[]): FunnelMetrics {
  const byStage = new Map(stageReach.map((s) => [s.stage, s.sessionsReaching]));
  const reaching = (stage: string): number => byStage.get(stage) ?? 0;
  const entrySessions = stageReach[0]?.sessionsReaching ?? 0;

  const steps: FunnelStepMetric[] = stageReach.map((s, i) => {
    const prev = i > 0 ? stageReach[i - 1].sessionsReaching : null;
    const stepConversionPct = prev == null ? null : ratePct(s.sessionsReaching, prev);
    return {
      stage: s.stage,
      order: s.order,
      sessionsReaching: s.sessionsReaching,
      sessionsLostFromPrev: prev == null ? null : Math.max(0, prev - s.sessionsReaching),
      stepConversionPct,
      stepDropoffPct: stepConversionPct == null ? null : Math.round((100 - stepConversionPct) * 10) / 10,
      cumulativeConversionPct: i === 0 ? (entrySessions > 0 ? 100 : null) : ratePct(s.sessionsReaching, entrySessions),
    };
  });

  const milestones: MilestoneRate[] = MILESTONE_DEFS.map((m) => {
    const fromSessions = reaching(m.from);
    const toSessions = reaching(m.to);
    return {
      key: m.key,
      label: m.label,
      fromStage: m.from,
      toStage: m.to,
      fromSessions,
      toSessions,
      ratePct: ratePct(toSessions, fromSessions),
    };
  });

  // The bump: the consecutive step that loses the most sessions in absolute
  // terms (most actionable), considering only steps with upstream volume.
  let biggestDrop: BiggestDrop | null = null;
  for (let i = 1; i < stageReach.length; i++) {
    const prev = stageReach[i - 1].sessionsReaching;
    if (prev <= 0) continue;
    const lost = Math.max(0, prev - stageReach[i].sessionsReaching);
    if (!biggestDrop || lost > biggestDrop.sessionsLost) {
      biggestDrop = {
        fromStage: stageReach[i - 1].stage,
        toStage: stageReach[i].stage,
        sessionsLost: lost,
        dropoffPct: ratePct(prev - stageReach[i].sessionsReaching, prev),
      };
    }
  }

  const first = FUNNEL_STAGES[0];
  const last = FUNNEL_STAGES[FUNNEL_STAGES.length - 1];
  return {
    entrySessions,
    steps,
    milestones,
    biggestDrop,
    overallConversionPct: ratePct(reaching(last), reaching(first)),
  };
}

/** Guard used by the SQL layer: the closed stage vocabulary as an ordered list. */
export function orderedStages(): string[] {
  return [...FUNNEL_STAGES].sort((a, b) => funnelStageOrder(a) - funnelStageOrder(b));
}
