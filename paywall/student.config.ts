// ============================================================================
// STUDENT ACCESS CONFIG (self-contained — does NOT touch paywall.config.ts)
// ============================================================================
// File: paywall/student.config.ts
//
// Deliberately standalone so the student program can be tuned / disabled via
// environment without editing the core paywall parser. Read once at startup
// (values are process.env snapshots); the domain allowlist itself lives in the
// DB (accredited_domains), NOT here.
//
// ENV (all optional; safe defaults shown):
//   STUDENT_ACCESS_ENABLED           'true'                (master switch)
//   STUDENT_ALLOWLIST_MODE           'allowlist'           allowlist|suffix_edu|hybrid
//   STUDENT_GRANT_MONTHS             '12'                  comp length before re-verify
//   STUDENT_MIN_AGE                  '18'                  age gate (attestation)
//   STUDENT_TOKEN_EXPIRY_HOURS       '24'                  campus-email link TTL
//   STUDENT_RESEND_COOLDOWN_SECONDS  '60'                  per-user resend cooldown
//   STUDENT_MAX_ACTIVE_TOKENS        '5'                   per-user pending token cap
//   STUDENT_MAX_PER_DOMAIN_PER_DAY   '200'                 per-domain daily request cap
// ============================================================================

import type { AllowlistMode } from '../services/studentDomainService';

export interface StudentConfig {
  enabled: boolean;
  mode: AllowlistMode;
  grantMonths: number;
  minAge: number;
  tokenExpiryHours: number;
  resendCooldownSeconds: number;
  maxActiveTokens: number;
  maxPerDomainPerDay: number;
}

function boolEnv(key: string, dflt: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return dflt;
  return v.toLowerCase() === 'true' || v === '1';
}

function intEnv(key: string, dflt: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined) return dflt;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function modeEnv(): AllowlistMode {
  const v = (process.env.STUDENT_ALLOWLIST_MODE || 'allowlist').toLowerCase();
  if (v === 'suffix_edu' || v === 'hybrid') return v;
  return 'allowlist';
}

export function loadStudentConfig(): StudentConfig {
  return {
    enabled: boolEnv('STUDENT_ACCESS_ENABLED', true),
    mode: modeEnv(),
    grantMonths: intEnv('STUDENT_GRANT_MONTHS', 12, 1, 60),
    minAge: intEnv('STUDENT_MIN_AGE', 18, 13, 100),
    tokenExpiryHours: intEnv('STUDENT_TOKEN_EXPIRY_HOURS', 24, 1, 168),
    resendCooldownSeconds: intEnv('STUDENT_RESEND_COOLDOWN_SECONDS', 60, 10, 3600),
    maxActiveTokens: intEnv('STUDENT_MAX_ACTIVE_TOKENS', 5, 1, 20),
    maxPerDomainPerDay: intEnv('STUDENT_MAX_PER_DOMAIN_PER_DAY', 200, 10, 100000),
  };
}

/** Add N whole months to a date (clamps day-of-month overflow, e.g. Jan 31 + 1mo). */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const targetMonth = d.getMonth() + months;
  const result = new Date(d.getTime());
  result.setMonth(targetMonth);
  // Handle overflow (e.g. Jan 31 -> Mar 3): pin to last day of intended month.
  if (result.getDate() !== d.getDate()) {
    result.setDate(0);
  }
  return result;
}
