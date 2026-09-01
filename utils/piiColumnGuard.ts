// utils/piiColumnGuard.ts
// ----------------------------------------------------------------------------
// PURE, I/O-free guard that flags column names which LOOK like personal data.
// One concern, unit-tested in isolation. It exists so "the conversion_events
// table contains no PII" is a single, testable definition reused by both the
// live compliance record (services/complianceRecord) and the CI schema-guard
// test (tests/conversionStorage.int.test.ts) — that test FAILS if the anonymous
// funnel table ever grows an identity/contact/precise-location column.
//
// Tokenization matters: we split a column name into tokens (on non-alphanumerics
// AND camelCase) so bare tokens like "ip"/"user" match "ip_truncated"/"user_id"
// but NOT unrelated words, and we keep a short list of unambiguous substrings
// (email, password, birth, …). Deliberately conservative: it may over-flag on
// other tables, which is the safe direction for a compliance guard.
// ----------------------------------------------------------------------------

// Unambiguous — match anywhere in the (lowercased) column name.
const STRONG_SUBSTRINGS = [
  'email', 'password', 'passwd', 'ssn', 'birth', 'phone',
  'firstname', 'lastname', 'fullname', 'username', 'displayname', 'ipaddress',
];

// Match only as a WHOLE token, so "ip" flags "ip_addr" but not "recipient",
// and "name" flags "user_name" but not, say, "surname_free_column".
const TOKEN_TERMS = new Set([
  'user', 'name', 'ip', 'address', 'addr', 'dob', 'mail', 'mobile',
  'lat', 'lng', 'lon', 'latitude', 'longitude', 'geo',
]);

/** Split a column name into lowercase tokens (snake_case + camelCase aware). */
export function tokenizeColumnName(name: string): string[] {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // camelCase -> camel_Case
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** True if a column name looks like personal data (see module header). */
export function isPiiColumnName(name: string): boolean {
  const lower = String(name).toLowerCase();
  if (STRONG_SUBSTRINGS.some((s) => lower.includes(s))) return true;
  const tokens = tokenizeColumnName(name);
  return tokens.some((t) => TOKEN_TERMS.has(t));
}

/** The subset of `names` that look like PII (empty = clean). */
export function findPiiColumns(names: string[]): string[] {
  return names.filter(isPiiColumnName);
}
