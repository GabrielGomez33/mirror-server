// ============================================================================
// credentialPolicy — PURE registration/login input rules (single source of truth)
// ============================================================================
// Extracted from authController so the register/login credential rules are
// unit-testable in isolation (no DB, no bcrypt, no HTTP). The controller imports
// these; there is one definition of each rule.
//
// Mobile keyboards (especially iOS) silently substitute "smart" Unicode
// characters as the user types: ASCII ' becomes ’, " becomes “ ”, - becomes
// – or —, ... becomes …. bcrypt cares about the exact byte sequence — a password
// typed as `Ab1!cd-ef` on iOS would hash differently than on desktop and the next
// login would fail. We normalise these out on every write/check path before the
// value reaches bcrypt or the policy regex. Username/email have interior
// whitespace stripped (a trailing space iOS autocorrect adds to an email is a
// silent registration killer otherwise).
//
// NOTE: the client validation in
// client/src/components/intake/RegistrationStep.tsx must keep the SAME password
// policy — see passwordMeetsPolicy below.
// ============================================================================

const SMART_QUOTE_SINGLE_RE = /[‘’‚‛]/g;
const SMART_QUOTE_DOUBLE_RE = /[“”„‟]/g;
const SMART_DASH_RE          = /[–—―−]/g;
const HORIZONTAL_ELLIPSIS_RE = /…/g;

export function normalisePassword(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(SMART_QUOTE_SINGLE_RE, "'")
    .replace(SMART_QUOTE_DOUBLE_RE, '"')
    .replace(SMART_DASH_RE, '-')
    .replace(HORIZONTAL_ELLIPSIS_RE, '...');
}

export function normaliseUsername(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Strip ALL internal whitespace — usernames have never been allowed to contain
  // spaces and iOS's auto-period-after-double-space can sneak one in.
  return raw.replace(/\s+/g, '').slice(0, 64);
}

export function normaliseEmail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Trim, drop interior whitespace (autocorrect dust), bound the length. We do
  // NOT lower-case — the SQL collation handles case-insensitivity and preserving
  // the user's chosen case is more honest.
  return raw.trim().replace(/\s+/g, '').slice(0, 254);
}

// ---- Password policy --------------------------------------------------------
// 8–128 chars; at least one lowercase, uppercase, digit, AND one
// non-alphanumeric, non-whitespace byte. ANY special char is accepted (the old
// narrow set rejected iOS Suggested Strong Passwords, `,`/`.`, `_`, `#`, etc.).
export const REGISTRATION_PASSWORD_MIN = 8;
export const REGISTRATION_PASSWORD_MAX = 128;

export function passwordMeetsPolicy(pw: string): boolean {
  if (typeof pw !== 'string') return false;
  if (pw.length < REGISTRATION_PASSWORD_MIN) return false;
  if (pw.length > REGISTRATION_PASSWORD_MAX) return false;
  if (!/[a-z]/.test(pw)) return false;
  if (!/[A-Z]/.test(pw)) return false;
  if (!/\d/.test(pw)) return false;
  if (!/[^A-Za-z0-9\s]/.test(pw)) return false;
  return true;
}

// RFC-5322-lite email regex: rejects obvious garbage without false negatives on
// real addresses; the verification click is the authoritative check.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return typeof email === 'string' && EMAIL_RE.test(email);
}
