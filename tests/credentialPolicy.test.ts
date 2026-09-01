// ============================================================================
// UNIT TESTS — registration/login credential rules (pure; no DB/bcrypt/HTTP)
// ============================================================================
// Run:  npx ts-node tests/credentialPolicy.test.ts
// Exit 0 = all passed, 1 = at least one failed.
//
// Proves the login/register input contract: iOS "smart character" normalisation
// (the silent login-failure class), username/email whitespace hygiene, the
// password policy, and the email shape check.
// ============================================================================

import {
  normalisePassword,
  normaliseUsername,
  normaliseEmail,
  passwordMeetsPolicy,
  isValidEmail,
  REGISTRATION_PASSWORD_MIN,
  REGISTRATION_PASSWORD_MAX,
} from '../utils/credentialPolicy';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function group(name: string): void { console.log(`\n• ${name}`); }

// ---------------------------------------------------------------------------
group('normalisePassword — iOS smart chars folded to ASCII (bcrypt byte-safety)');
ok(normalisePassword('Ab1!cd–ef') === 'Ab1!cd-ef', 'en-dash – -> hyphen');
ok(normalisePassword('Ab1!cd—ef') === 'Ab1!cd-ef', 'em-dash — -> hyphen');
ok(normalisePassword('it’s-A-1') === "it's-A-1", 'smart single quote -> ASCII apostrophe');
ok(normalisePassword('say“hi”1A-') === 'say"hi"1A-', 'smart double quotes -> ASCII');
ok(normalisePassword('a…1A-x') === 'a...1A-x', 'horizontal ellipsis -> three dots');
ok(normalisePassword('PlainAscii1!') === 'PlainAscii1!', 'plain ASCII unchanged (idempotent)');
ok(normalisePassword(12345 as unknown) === '', 'non-string -> empty string');
ok(normalisePassword(undefined as unknown) === '', 'undefined -> empty string');

// ---------------------------------------------------------------------------
group('normaliseUsername — strip all whitespace, cap 64');
ok(normaliseUsername('  my user ') === 'myuser', 'interior + edge whitespace stripped');
ok(normaliseUsername('a'.repeat(100)).length === 64, 'capped at 64 chars');
ok(normaliseUsername(null as unknown) === '', 'non-string -> empty');

// ---------------------------------------------------------------------------
group('normaliseEmail — trim, strip interior whitespace, cap 254, keep case');
ok(normaliseEmail(' You@Gmail.com ') === 'You@Gmail.com', 'trim + preserve case (no lower-casing)');
ok(normaliseEmail('a b@c.com') === 'ab@c.com', 'interior whitespace removed');
ok(normaliseEmail('x'.repeat(300) + '@a.com').length === 254, 'capped at 254');
ok(normaliseEmail(42 as unknown) === '', 'non-string -> empty');

// ---------------------------------------------------------------------------
group('passwordMeetsPolicy — length + 4 character classes');
ok(passwordMeetsPolicy('Ab1!cdef') === true, 'valid 8-char with all classes');
ok(passwordMeetsPolicy('Ab1!cd') === false, `too short (< ${REGISTRATION_PASSWORD_MIN})`);
ok(passwordMeetsPolicy('A1!' + 'a'.repeat(REGISTRATION_PASSWORD_MAX)) === false, `too long (> ${REGISTRATION_PASSWORD_MAX})`);
ok(passwordMeetsPolicy('ab1!cdef') === false, 'missing uppercase');
ok(passwordMeetsPolicy('AB1!CDEF') === false, 'missing lowercase');
ok(passwordMeetsPolicy('Abc!defg') === false, 'missing digit');
ok(passwordMeetsPolicy('Abc1defg') === false, 'missing special char');
ok(passwordMeetsPolicy('Passw0rd-') === true, 'hyphen counts as special (iOS Suggested Strong)');
ok(passwordMeetsPolicy('Passw0rd_') === true, 'underscore counts as special');
ok(passwordMeetsPolicy('Passw0rd,') === true, 'comma counts as special');
ok(passwordMeetsPolicy('Passw0rd ') === false, 'whitespace does NOT count as the special char');
ok(passwordMeetsPolicy(12345678 as unknown as string) === false, 'non-string -> false');

// ---------------------------------------------------------------------------
group('normalise + policy together — an iOS-typed password still passes');
{
  const typed = 'MyPass–1';           // iOS turned the hyphen into an en-dash
  ok(passwordMeetsPolicy(typed) === true, 'raw en-dash password happens to pass class checks');
  ok(passwordMeetsPolicy(normalisePassword(typed)) === true, 'normalised form also passes (and is what bcrypt sees)');
  ok(normalisePassword(typed) === 'MyPass-1', 'normalised to the ASCII the user intended');
}

// ---------------------------------------------------------------------------
group('email shape');
ok(isValidEmail('a@b.co') === true, 'simple valid email');
ok(isValidEmail('first.last@sub.domain.io') === true, 'dotted local + subdomain');
ok(isValidEmail('nope') === false, 'no @ -> invalid');
ok(isValidEmail('a@b') === false, 'no TLD dot -> invalid');
ok(isValidEmail('a b@c.com') === false, 'space -> invalid');
ok(isValidEmail('' ) === false, 'empty -> invalid');

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '✓' : '✗'} credentialPolicy: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
