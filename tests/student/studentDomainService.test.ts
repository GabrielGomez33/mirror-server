// ============================================================================
// UNIT TESTS — studentDomainService (pure logic; no database required)
// ============================================================================
// Run (project CI):        npx ts-node tests/student/studentDomainService.test.ts
// Run (no deps, Node 22+): node --experimental-strip-types tests/student/studentDomainService.test.ts
// Exit code 0 = all passed, 1 = at least one failed.
//
// These prove the security claims made in student-access/README.md:
//   1. Canonicalization strips "+tag" and lowercases  -> one identity per inbox.
//   2. Dot-boundary allowlist match: 'evilharvard.edu' NEVER matches 'harvard.edu';
//      real sub-domains ('g.harvard.edu') DO match.
//   3. Look-alike TLDs ('harvard.edu.co') are rejected in allowlist AND suffix mode.
//   4. Age attestation is a hard gate (must be strict boolean true).
//   5. Malformed / injection-shaped inputs never parse.
//   6. Denylist overrides an otherwise-accredited domain.
// ============================================================================

import {
  parseEmail,
  matchAllowlist,
  isEduSuffix,
  checkEligibility,
} from '../../services/studentDomainService';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`);
  }
}

function ok(cond: boolean, label: string): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${label}`); }
}

const ALLOW = ['harvard.edu', 'mit.edu', 'ox.ac.uk', 'utexas.edu'];

// ---------------------------------------------------------------------------
console.log('parseEmail: canonicalization');
// ---------------------------------------------------------------------------
eq(parseEmail('A.Student+spring2026@Sub.Harvard.EDU')?.normalized, 'a.student@sub.harvard.edu', 'lowercase + strip +tag');
eq(parseEmail('me+1@mit.edu')?.normalized, 'me@mit.edu', 'plus-tag #1 stripped');
eq(parseEmail('me+2@mit.edu')?.normalized, 'me@mit.edu', 'plus-tag #2 collapses to same identity');
eq(parseEmail('  jane@mit.edu  ')?.normalized, 'jane@mit.edu', 'outer trim');
eq(parseEmail('jane@mit.edu')?.domain, 'mit.edu', 'domain extracted');

// ---------------------------------------------------------------------------
console.log('parseEmail: rejects malformed / injection-shaped');
// ---------------------------------------------------------------------------
for (const bad of [
  '', '   ', 'nope', 'a@b', 'a@@b.edu', '@mit.edu', 'a@.edu', 'a@mit..edu',
  'a b@mit.edu', 'a@mit.edu extra', 'a@-mit.edu', 'a@mit-.edu', 'a@mit.e',
  "a'; DROP TABLE users;--@mit.edu", 'a@mit\n.edu', 'two@a.edu@b.edu',
  'x'.repeat(65) + '@mit.edu',
]) {
  ok(parseEmail(bad) === null, `reject ${JSON.stringify(bad)}`);
}
// @ts-expect-error — prove non-string is handled at runtime
ok(parseEmail(null) === null, 'reject null');

// ---------------------------------------------------------------------------
console.log('matchAllowlist: dot-boundary safety');
// ---------------------------------------------------------------------------
eq(matchAllowlist('harvard.edu', ALLOW), 'harvard.edu', 'exact match');
eq(matchAllowlist('g.harvard.edu', ALLOW), 'harvard.edu', 'real sub-domain matches');
eq(matchAllowlist('mail.eecs.mit.edu', ALLOW), 'mit.edu', 'deep sub-domain matches');
eq(matchAllowlist('evilharvard.edu', ALLOW), null, 'prefix look-alike does NOT match');
eq(matchAllowlist('harvard.edu.co', ALLOW), null, 'suffix look-alike does NOT match');
eq(matchAllowlist('harvardxedu', ALLOW), null, 'missing dot does NOT match');
eq(matchAllowlist('student@harvard.edu', ALLOW), null, 'raw email is not a domain');
eq(matchAllowlist('someone.ox.ac.uk', ALLOW), 'ox.ac.uk', 'multi-label public-suffix institution matches');

// ---------------------------------------------------------------------------
console.log('isEduSuffix');
// ---------------------------------------------------------------------------
ok(isEduSuffix('mit.edu'), '.edu is suffix');
ok(isEduSuffix('g.mit.edu'), 'sub.edu is suffix');
ok(!isEduSuffix('mit.edu.co'), 'edu.co is NOT .edu');
ok(!isEduSuffix('notedu'), 'notedu is NOT .edu');

// ---------------------------------------------------------------------------
console.log('checkEligibility: end-to-end decisions');
// ---------------------------------------------------------------------------
const base = { allowlist: ALLOW, denylist: ['scam.edu', 'k12.ca.us'], mode: 'allowlist' as const };

eq(checkEligibility({ email: 'jane+x@g.harvard.edu', attest18: true, ...base }).code, 'OK', 'accredited + 18 + no plus abuse -> OK');
eq(checkEligibility({ email: 'jane@g.harvard.edu', attest18: false, ...base }).code, 'AGE_NOT_ATTESTED', 'accredited but not 18 -> reject');
// @ts-expect-error prove non-boolean truthy value does NOT satisfy the age gate
eq(checkEligibility({ email: 'jane@mit.edu', attest18: 'yes', ...base }).code, 'AGE_NOT_ATTESTED', 'truthy non-true does not pass age gate');
eq(checkEligibility({ email: 'jane@evilharvard.edu', attest18: true, ...base }).code, 'NOT_ACCREDITED', 'look-alike -> not accredited');
eq(checkEligibility({ email: 'garbage', attest18: true, ...base }).code, 'INVALID_EMAIL', 'garbage -> invalid');
eq(checkEligibility({ email: 'kid@k12.ca.us', attest18: true, ...base }).code, 'BLOCKED_DOMAIN', 'denylisted K-12 -> blocked');
eq(checkEligibility({ email: 'x@scam.edu', attest18: true, ...base }).code, 'BLOCKED_DOMAIN', 'denylist overrides');

// suffix_edu mode (opt-in, weaker) still rejects look-alike TLDs and honors denylist
eq(checkEligibility({ email: 'a@anywhere.edu', attest18: true, allowlist: [], mode: 'suffix_edu' }).code, 'OK', 'suffix mode: any .edu OK');
eq(checkEligibility({ email: 'a@anywhere.edu.co', attest18: true, allowlist: [], mode: 'suffix_edu' }).code, 'NOT_ACCREDITED', 'suffix mode: .edu.co rejected');
eq(checkEligibility({ email: 'a@scam.edu', attest18: true, allowlist: [], denylist: ['scam.edu'], mode: 'suffix_edu' }).code, 'BLOCKED_DOMAIN', 'suffix mode still honors denylist');

// hybrid mode: allowlist OR .edu
eq(checkEligibility({ email: 'a@ox.ac.uk', attest18: true, allowlist: ALLOW, mode: 'hybrid' }).code, 'OK', 'hybrid: intl allowlisted OK');
eq(checkEligibility({ email: 'a@random.edu', attest18: true, allowlist: ALLOW, mode: 'hybrid' }).code, 'OK', 'hybrid: .edu fallback OK');
eq(checkEligibility({ email: 'a@random.org', attest18: true, allowlist: ALLOW, mode: 'hybrid' }).code, 'NOT_ACCREDITED', 'hybrid: non-edu non-allowlist rejected');

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
