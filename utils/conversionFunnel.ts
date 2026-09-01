// utils/conversionFunnel.ts
// ----------------------------------------------------------------------------
// PURE, I/O-free logic for anonymous conversion-funnel instrumentation. No DB,
// no HTTP — unit-tested in isolation (tests/conversionFunnel.test.ts).
//
// This module is the single source of truth for:
//   * FUNNEL_STAGES — the closed vocabulary of funnel stage keys (client + server
//     agree on exactly these; anything else is rejected, never stored).
//   * sanitizeConversionEvent — the PII firewall. It builds a BRAND-NEW object
//     containing ONLY allowlisted, length-bounded, character-restricted fields.
//     Any other property a client sends (email, userId, ip, birthDate, …) is
//     structurally dropped because it is never copied across. This is what makes
//     "no PII in conversion_events" a guarantee rather than a hope.
//
// The funnel is ANONYMOUS + AGGREGATE: an event carries a stage, an ephemeral
// random session token, coarse UTM attribution, and a coarse surface — nothing
// that identifies a person. See migrations/023 + docs/COMPLIANCE.md.
// ----------------------------------------------------------------------------

// Ordered acquisition funnel. Order matters for aggregation (stage N→N+1 drop-off).
export const FUNNEL_STAGES = [
  'landing_view',       // 0  marketing landing page seen
  'signup_view',        // 1  registration form seen
  'signup_completed',   // 2  account created  (highest-value signal)
  'entry_started',      // 3  Entry intake begun
  'entry_first_value',  // 4  Entry result shown — the "aha" (highest-value signal)
  'dashboard_view',     // 5  first dashboard view
  'mymirror_view',      // 6  MyMirror self-reflection surface seen
  'core_started',       // 7  deep Core intake begun (enrichment)
  'core_completed',     // 8  deep Core intake finished
  'premium_view',       // 9  premium/upgrade wall seen
  'premium_activated',  // 10 premium purchase activated
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

const STAGE_SET: ReadonlySet<string> = new Set(FUNNEL_STAGES);

/** Ordinal position of a stage in the funnel (−1 if unknown). */
export function funnelStageOrder(stage: string): number {
  return FUNNEL_STAGES.indexOf(stage as FunnelStage);
}

/** Type guard: is `x` one of the closed funnel-stage keys? */
export function isFunnelStage(x: unknown): x is FunnelStage {
  return typeof x === 'string' && STAGE_SET.has(x);
}

// Coarse, non-identifying client surface.
const SURFACES: ReadonlySet<string> = new Set(['web', 'pwa']);

// Length caps (defense against row bloat). Deliberately small.
const MAX_UTM = 96;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// UTM values are campaign tags, never PII — but bound + restrict them anyway so
// a hostile client can't smuggle a long/odd string. Allow a conservative slug
// charset; drop anything else to null.
function cleanUtm(value: unknown, max = 64): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim().slice(0, Math.min(max, MAX_UTM));
  if (!s) return null;
  const cleaned = s.replace(/[^a-zA-Z0-9_.\- ]/g, '');
  return cleaned.length ? cleaned : null;
}

function cleanSessionToken(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
}

function cleanSurface(value: unknown): string | null {
  return typeof value === 'string' && SURFACES.has(value) ? value : null;
}

/** The safe, storable shape — ONLY these fields ever reach the database. */
export interface CleanConversionEvent {
  stage: FunnelStage;
  sessionToken: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  surface: string | null;
}

/**
 * Normalize an untrusted ingest body to a safe event, or null if the stage is
 * not an allowlisted funnel stage (the one hard requirement). CRITICAL: the
 * result is a freshly-built object — no field from `raw` is passed through
 * except the six explicitly allowlisted, sanitized values, so no PII or unknown
 * key can ever be persisted, regardless of what the client sends.
 */
export function sanitizeConversionEvent(raw: unknown): CleanConversionEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isFunnelStage(r.stage)) return null;
  return {
    stage: r.stage,
    sessionToken: cleanSessionToken(r.sessionToken),
    utmSource: cleanUtm(r.utmSource, 64),
    utmMedium: cleanUtm(r.utmMedium, 64),
    utmCampaign: cleanUtm(r.utmCampaign, 96),
    surface: cleanSurface(r.surface),
  };
}
