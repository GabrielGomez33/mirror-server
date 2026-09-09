// tests/securityInvariants.test.ts
// ============================================================================
// SECURITY REVIEW, AS A BLOCKING GATE.
// ----------------------------------------------------------------------------
// The Phase-6 server security review came back clean. A one-time clean review
// rots the moment someone edits the code — so this encodes each finding as an
// executable invariant that runs in CI (npm run test:ci, which the pipeline
// blocks on). A regression that reintroduces one of these holes fails the build
// instead of shipping. This is static/source-level assertion (fast, no DB, no
// network) — it proves the guardrails are PRESENT, complementing the behavioural
// unit tests (intakeAuthGuards, userContext, credentialPolicy) that prove they
// WORK.
//
// Run: ts-node tests/securityInvariants.test.ts
// ============================================================================

import fs from 'fs';
import path from 'path';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } };

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// --- 1. IDOR: /store always writes to the authenticated caller ---------------
// The historical hole was trusting req.body.userId. The handler must derive the
// target from req.user.id and must NOT pass a body userId into the storage call.
{
  const src = read('controllers/intakeController.ts');
  const handlerStart = src.indexOf('export const storeIntakeDataHandler');
  const handler = src.slice(handlerStart, handlerStart + 3000);
  ok(handlerStart > 0, 'storeIntakeDataHandler exists');
  ok(/const\s+authUserId\s*=\s*Number\(req\.user\?\.id\)/.test(handler),
    '/store derives target user from req.user.id (not the body)');
  ok(/storeIntakeData\(\s*uidStr/.test(handler),
    '/store passes the auth-derived uidStr to storeIntakeData');
  // Guard against a regression that resurrects body-userId as the write target.
  ok(!/storeIntakeData\(\s*(String\()?req\.body/.test(handler),
    '/store never passes req.body userId into storeIntakeData');
}

// --- 2. Simulation teardown safety stop --------------------------------------
// Destructive sim teardown must re-prove the user is in the reserved namespace,
// straight from the DB, immediately before deleting — never trust the caller.
{
  const src = read('controllers/intakeSimulationController.ts');
  ok(/function teardownSimUser/.test(src), 'teardownSimUser exists');
  ok(/looksLikeSimUser\(row\.username,\s*row\.email\)/.test(src),
    'teardown re-checks sim namespace from a fresh DB read');
  ok(/This is a safety stop\./.test(src),
    'teardown throws a safety-stop error for non-sim users');
  ok(/not a simulation user \(safety stop\)/.test(src),
    'sim password reset / delete is guarded by a safety stop too');
  ok(/startsWith\(SIM_USERNAME_PREFIX\)\s*&&\s*e\.endsWith/.test(src),
    'sim identity requires BOTH the reserved username prefix AND the reserved email domain');
}

// --- 3. Auth: context-unavailable is 503, never a false 401/all-false --------
{
  const auth = read('controllers/authController.ts');
  ok(/CONTEXT_UNAVAILABLE/.test(auth),
    'auth surfaces CONTEXT_UNAVAILABLE (503) instead of fabricating an all-false context');
  ok(/UserContextUnavailableError/.test(auth),
    'auth imports/handles UserContextUnavailableError');
  const uctx = read('utils/userContext.ts');
  ok(/class UserContextUnavailableError/.test(uctx),
    'loadUserContext throws on a core-read failure rather than returning all-false');
}

// --- 4. TLS / proxy hardening: no verification bypass anywhere in source -----
// The proxy/TLS setup must never be disabled. Scan all first-party .ts (not
// node_modules, not dist, not this test) for the known bypass patterns, AFTER
// stripping comments (so a comment that merely NAMES the pattern is not a false
// positive). The only sanctioned way to relax TLS is loopback-gated — i.e.
// `rejectUnauthorized: !isLoopback(...)` — which never matches a `false` literal.
{
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const bad = [
    /rejectUnauthorized\s*[:=]\s*false/,
    /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/,
    /delete\s+process\.env\.HTTPS_PROXY/,
    /process\.env\.HTTPS_PROXY\s*=\s*['"]{2}/,
  ];
  const offenders: string[] = [];
  const skip = new Set(['node_modules', 'dist', '.git']);
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) { if (!skip.has(ent.name)) walk(path.join(dir, ent.name)); continue; }
      if (!ent.name.endsWith('.ts')) continue;
      const full = path.join(dir, ent.name);
      if (full.endsWith('tests/securityInvariants.test.ts')) continue;
      const txt = stripComments(fs.readFileSync(full, 'utf8'));
      if (bad.some((re) => re.test(txt))) offenders.push(path.relative(ROOT, full));
    }
  };
  walk(ROOT);
  ok(offenders.length === 0, `no TLS/proxy bypass in source (offenders: ${offenders.join(', ') || 'none'})`);

  // Positive: the two sanctioned relaxations are loopback-gated, not blanket.
  ok(/rejectUnauthorized\s*=\s*!isLoopback\(/.test(read('controllers/intakeSimulationController.ts')),
    'sim self-HTTP relaxes TLS only for loopback (rejectUnauthorized = !isLoopback)');
  ok(/rejectUnauthorized\s*:\s*!isLoopbackWsUrl\(/.test(read('services/DinaWebSocketClient.ts')),
    'DINA WS relaxes TLS only for loopback (rejectUnauthorized: !isLoopbackWsUrl)');
}

if (fail) { console.error(`\nsecurityInvariants: ${pass} passed, ${fail} FAILED`); process.exit(1); }
console.log(`securityInvariants: ${pass} passed — server security-review invariants hold`);
