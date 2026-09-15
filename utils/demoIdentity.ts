// utils/demoIdentity.ts
// ----------------------------------------------------------------------------
// PURE identity + namespace logic for demo/trial accounts. No DB, no HTTP — so
// the security-critical invariants (namespace isolation from the sim sweeper,
// the revoke guard's decision) are unit-testable in isolation.
//
// Demo accounts deliberately live OUTSIDE the intake-simulation namespace
// (`__sim_` username + `*.invalid` email). That is what guarantees the sim's
// orphan sweeper / teardown guard can never match — and never delete — a real
// demo account. isSimNamespace() mirrors the sim's own guard so a test can
// assert a demo identity is never mistaken for a sim user.
// ----------------------------------------------------------------------------

import crypto from 'node:crypto';

export const DEMO_USERNAME_PREFIX = 'demo_';
export const DEMO_EMAIL_DOMAIN = (process.env.MIRROR_DEMO_EMAIL_DOMAIN || 'trymirror.world')
  .replace(/^@/, '')
  .toLowerCase();

// The sim's reserved namespace (kept in sync with intakeSimulationController).
const SIM_USERNAME_PREFIX = '__sim_';
const SIM_EMAIL_DOMAIN = (process.env.MIRROR_SIM_EMAIL_DOMAIN || 'simulation.mirror.invalid')
  .replace(/^@/, '')
  .toLowerCase();

/** A fresh, collision-resistant demo identity: `demo_<8hex>` + `demo+<8hex>@<domain>`. */
export function newDemoIdentity(): { username: string; email: string } {
  const id = crypto.randomBytes(4).toString('hex'); // 8 hex chars
  return { username: `${DEMO_USERNAME_PREFIX}${id}`, email: `demo+${id}@${DEMO_EMAIL_DOMAIN}` };
}

/** True iff this identity is in the sim's reserved namespace (would be sweepable). */
export function isSimNamespace(username: string | null | undefined, email: string | null | undefined): boolean {
  const u = String(username || '');
  const e = String(email || '').toLowerCase();
  return u.startsWith(SIM_USERNAME_PREFIX) && e.endsWith('@' + SIM_EMAIL_DOMAIN);
}

/** Guard decision for revoke: a demo delete may proceed ONLY for a registered demo user. */
export function assertRevocable(isRegisteredDemo: boolean): void {
  if (!isRegisteredDemo) throw new Error('refused: user is not a registered demo account');
}

/**
 * Conservative recipient-email validity check for the optional "email the
 * credentials to this person" feature. Intentionally strict-but-simple: a
 * single address, one @, non-empty local + domain, a dotted TLD, no spaces,
 * length-bounded. Rejects lists, display-name forms and obvious junk so we
 * never hand the provider (or our logs) a malformed recipient. Returns the
 * trimmed address when valid, else null.
 */
export function normalizeRecipientEmail(input: string | null | undefined): string | null {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 254) return null;
  if (/\s/.test(raw)) return null; // no spaces, no comma-separated lists
  // local@domain.tld — one @, a dotted domain, no angle brackets/quotes.
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>".]+$/.test(raw)) return null;
  return raw;
}
