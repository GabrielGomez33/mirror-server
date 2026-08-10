// ============================================================================
// STUDENT DOMAIN / ELIGIBILITY SERVICE  (pure logic — NO database, NO I/O)
// ============================================================================
// File: services/studentDomainService.ts
//
// This module answers ONE question with zero side effects:
//   "Given a submitted campus email + an 18+ attestation, is this address
//    eligible for the student comp, and what is its canonical form?"
//
// It is deliberately pure so it can be exhaustively unit-tested (see
// tests/student/studentDomainService.test.ts) and reasoned about in isolation.
// All stateful concerns (tokens, rate limits, DB uniqueness, the actual grant)
// live in the controller/service layers that CALL this module.
//
// SECURITY POSTURE (why each rule exists):
//   - We NEVER trust `email.endsWith('.edu')` as sufficient. Default mode is an
//     exact accredited-domain allowlist with a dot-boundary match so that
//     `notharvard.edu` can never satisfy `harvard.edu`.
//   - We canonicalize before any uniqueness decision: lowercase + strip the
//     "+tag" sub-address so `me+1@x.edu` and `me+2@x.edu` collapse to one
//     identity. (We do NOT fold dots in the local-part — only Gmail treats
//     dots as insignificant; universities may not, so folding them would be
//     both wrong and a potential account-collision.)
//   - Age attestation is a hard gate: the product performs psychological /
//     IQ analysis, so an unattested or negative 18+ answer is a REJECT, never
//     a silent pass.
// ============================================================================

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type AllowlistMode = 'allowlist' | 'suffix_edu' | 'hybrid';

export interface NormalizedEmail {
  /** The exact string the user submitted (after an outer trim only). */
  raw: string;
  /** Canonical form used for storage + uniqueness: lowercase, +tag stripped. */
  normalized: string;
  /** Local part AFTER +tag stripping, lowercased. */
  localPart: string;
  /** Domain, lowercased. */
  domain: string;
}

export type EligibilityCode =
  | 'OK'
  | 'INVALID_EMAIL'
  | 'BLOCKED_DOMAIN'
  | 'NOT_ACCREDITED'
  | 'AGE_NOT_ATTESTED';

export interface EligibilityInput {
  email: string;
  /** Must be strictly boolean true to pass the age gate. */
  attest18: boolean;
  /** Exact institution domains, lowercased (e.g. 'mit.edu', 'ox.ac.uk'). */
  allowlist: readonly string[];
  /** Domains explicitly refused (disposable resellers, known K-12, etc.). */
  denylist?: readonly string[];
  /** allowlist (default, recommended) | suffix_edu | hybrid. */
  mode: AllowlistMode;
}

export interface EligibilityResult {
  ok: boolean;
  code: EligibilityCode;
  /** Human-readable, safe to surface to the client. */
  reason: string;
  /** Present whenever the email parsed, even if later rejected. */
  email?: NormalizedEmail;
  /** The allowlist/suffix entry that matched, when accredited. */
  matchedDomain?: string;
}

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const MAX_EMAIL_LENGTH = 254; // RFC 5321 path limit
const MAX_LOCAL_LENGTH = 64;  // RFC 5321 local-part limit
const MAX_DOMAIN_LENGTH = 253;

// A single DNS label: 1-63 chars, alnum, internal hyphens allowed.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Local part after +tag stripping. Conservative but covers real campus emails.
const LOCAL_PART = /^[a-z0-9]+(?:[._%'+-][a-z0-9]+)*$/;

// ----------------------------------------------------------------------------
// Email parsing / normalization
// ----------------------------------------------------------------------------

/**
 * Parse and canonicalize an email address.
 * Returns null if the address is syntactically invalid for our purposes.
 *
 * Canonicalization: outer trim -> lowercase -> strip the first "+..." tag from
 * the local part. The domain is validated label-by-label with a strict TLD.
 */
export function parseEmail(raw: string): NormalizedEmail | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_EMAIL_LENGTH) return null;
  if (/\s/.test(trimmed)) return null; // no internal whitespace

  const lower = trimmed.toLowerCase();

  // Exactly one '@'.
  const atCount = (lower.match(/@/g) || []).length;
  if (atCount !== 1) return null;

  const at = lower.indexOf('@');
  const rawLocal = lower.slice(0, at);
  const domain = lower.slice(at + 1);

  if (!rawLocal || !domain) return null;
  if (domain.length > MAX_DOMAIN_LENGTH) return null;

  // Strip the first "+tag" sub-address: "me+anything" -> "me".
  const plusIdx = rawLocal.indexOf('+');
  const localPart = plusIdx === -1 ? rawLocal : rawLocal.slice(0, plusIdx);

  if (!localPart || localPart.length > MAX_LOCAL_LENGTH) return null;
  if (!LOCAL_PART.test(localPart)) return null;

  // Validate the domain: >=2 labels, strict labels, alphabetic TLD >=2.
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!LABEL.test(label)) return null;
  }
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld)) return null;

  return {
    raw: trimmed,
    normalized: `${localPart}@${domain}`,
    localPart,
    domain,
  };
}

// ----------------------------------------------------------------------------
// Domain matching
// ----------------------------------------------------------------------------

/**
 * Does `domain` belong to an allowlisted institution?
 * Matches the exact domain OR any sub-domain, using a DOT BOUNDARY so that
 * 'evilharvard.edu' can never match the allowlist entry 'harvard.edu', while
 * 'g.harvard.edu' (a real campus sub-domain) does.
 *
 * Returns the matched allowlist entry, or null.
 */
export function matchAllowlist(domain: string, allowlist: readonly string[]): string | null {
  if (!domain) return null;
  let best: string | null = null;
  for (const entryRaw of allowlist) {
    const entry = (entryRaw || '').trim().toLowerCase();
    if (!entry) continue;
    if (domain === entry || domain.endsWith(`.${entry}`)) {
      // Prefer the most specific (longest) matching entry.
      if (best === null || entry.length > best.length) best = entry;
    }
  }
  return best;
}

/**
 * suffix_edu mode helper: true for '*.edu' (dot-boundary), NOT for a bare 'edu'
 * and NOT for 'x.edu.co' style look-alikes (those have TLD 'co', so the check
 * `endsWith('.edu')` on the full domain already excludes them).
 *
 * NOTE: this is intentionally weak and is NOT the default. See README security
 * section — suffix mode is provided only for explicit, eyes-open opt-in.
 */
export function isEduSuffix(domain: string): boolean {
  return domain.endsWith('.edu');
}

// ----------------------------------------------------------------------------
// Full eligibility decision
// ----------------------------------------------------------------------------

export function checkEligibility(input: EligibilityInput): EligibilityResult {
  const email = parseEmail(input.email);
  if (!email) {
    return { ok: false, code: 'INVALID_EMAIL', reason: 'Enter a valid school email address.' };
  }

  // Explicit denylist wins over everything (disposable resellers, K-12, etc.).
  if (input.denylist && input.denylist.length > 0) {
    const blocked = matchAllowlist(email.domain, input.denylist);
    if (blocked) {
      return {
        ok: false,
        code: 'BLOCKED_DOMAIN',
        reason: 'This email domain is not eligible for student access.',
        email,
        matchedDomain: blocked,
      };
    }
  }

  // Accreditation check per mode.
  let matched: string | null = null;
  if (input.mode === 'allowlist') {
    matched = matchAllowlist(email.domain, input.allowlist);
  } else if (input.mode === 'suffix_edu') {
    matched = isEduSuffix(email.domain) ? email.domain : null;
  } else {
    // hybrid: allowlist first, then fall back to the .edu suffix.
    matched = matchAllowlist(email.domain, input.allowlist)
      || (isEduSuffix(email.domain) ? email.domain : null);
  }

  if (!matched) {
    return {
      ok: false,
      code: 'NOT_ACCREDITED',
      reason: 'We could not confirm this domain belongs to a participating school. If your school should be included, let us know.',
      email,
    };
  }

  // Age gate is LAST so we only ever ask it of an otherwise-eligible address,
  // but it is still a hard requirement to pass.
  if (input.attest18 !== true) {
    return {
      ok: false,
      code: 'AGE_NOT_ATTESTED',
      reason: 'You must confirm you are 18 or older to claim student access.',
      email,
      matchedDomain: matched,
    };
  }

  return { ok: true, code: 'OK', reason: 'Eligible.', email, matchedDomain: matched };
}
