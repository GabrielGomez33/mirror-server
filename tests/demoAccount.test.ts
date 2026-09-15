// tests/demoAccount.test.ts
// Proof for the security-critical invariants of the demo/trial provisioner.
// Pure (no DB, no HTTP): exercises utils/demoIdentity + utils/passwordGen, the
// two building blocks that decide (a) that a demo account can NEVER be mistaken
// for a disposable sim user the orphan sweeper would delete, and (b) that the
// revoke path refuses anything not registered as a demo account. If either of
// these regresses, the sim teardown could reach a real trial account, or a
// caller could hand revoke an arbitrary user id — so they are locked here.
// Run: ts-node tests/demoAccount.test.ts

import {
  newDemoIdentity,
  isSimNamespace,
  assertRevocable,
  DEMO_USERNAME_PREFIX,
  DEMO_EMAIL_DOMAIN,
} from '../utils/demoIdentity';
import { strongRandomPassword } from '../utils/passwordGen';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } };

// --- identity shape: demo_<8hex> + demo+<8hex>@<domain> ---
const id = newDemoIdentity();
ok(/^demo_[0-9a-f]{8}$/.test(id.username), `username is demo_<8hex> (got ${id.username})`);
ok(new RegExp(`^demo\\+[0-9a-f]{8}@${DEMO_EMAIL_DOMAIN.replace(/\./g, '\\.')}$`).test(id.email),
   `email is demo+<8hex>@${DEMO_EMAIL_DOMAIN} (got ${id.email})`);
ok(id.username.startsWith(DEMO_USERNAME_PREFIX), 'username carries the demo prefix');
// username id and email id are the same token (same random draw).
ok(id.username.slice(DEMO_USERNAME_PREFIX.length) === id.email.slice('demo+'.length, 'demo+'.length + 8),
   'username token matches email token');

// --- collision resistance: distinct draws differ ---
const ids = new Set<string>();
for (let i = 0; i < 500; i++) ids.add(newDemoIdentity().username);
ok(ids.size === 500, `500 identities are all distinct (got ${ids.size})`);

// --- namespace isolation: a demo identity is NEVER in the sim namespace ---
ok(isSimNamespace('__sim_abcd1234', 'x@simulation.mirror.invalid') === true,
   'sim identity IS recognized as sim namespace (guard is live)');
ok(isSimNamespace(id.username, id.email) === false,
   'demo identity is NOT in the sim namespace (sweeper can never match it)');
// A demo username with a real-domain email must not be swept even if crafted oddly.
ok(isSimNamespace('demo_00000000', 'demo+00000000@trymirror.world') === false,
   'demo username + real-domain email is outside sim namespace');
// Both halves are required: prefix alone or invalid-domain alone is not a sim match.
ok(isSimNamespace('__sim_x', 'demo@trymirror.world') === false,
   'sim prefix + real domain is NOT a full sim match');
ok(isSimNamespace('demo_x', 'x@simulation.mirror.invalid') === false,
   'demo prefix + invalid domain is NOT a full sim match');
ok(isSimNamespace(null, undefined) === false, 'null/undefined identity is not a sim match (no crash)');
// Case-insensitive on the email domain.
ok(isSimNamespace('__sim_x', 'X@SIMULATION.MIRROR.INVALID') === true,
   'sim email domain match is case-insensitive');

// --- revoke guard: only a registered demo user may be revoked ---
let threw = false;
try { assertRevocable(false); } catch { threw = true; }
ok(threw, 'assertRevocable(false) throws (refuses a non-demo user id)');
let ok2 = true;
try { assertRevocable(true); } catch { ok2 = false; }
ok(ok2, 'assertRevocable(true) passes (a registered demo user may be revoked)');

// --- password policy: length 8–128, >=1 upper/lower/digit/special, no ambiguous chars ---
for (let i = 0; i < 200; i++) {
  const pw = strongRandomPassword();
  const good =
    pw.length >= 8 && pw.length <= 128 &&
    /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw) &&
    /[!@#$%^&*()\-_=+]/.test(pw) &&
    !/[0O1lI]/.test(pw); // ambiguous chars excluded for human-readable creds
  if (!good) { ok(false, `password fails policy: ${pw}`); break; }
  if (i === 199) ok(true, '200 generated passwords all satisfy the registration policy + readability');
}
// Distinct draws (not a constant).
ok(strongRandomPassword() !== strongRandomPassword(), 'two generated passwords differ');

if (fail) { console.error(`\ndemoAccount: ${pass} passed, ${fail} FAILED`); process.exit(1); }
console.log(`demoAccount: ${pass} passed — demo identity is sweeper-safe, revoke is guarded, passwords are policy-correct`);
