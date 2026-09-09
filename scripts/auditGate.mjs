// scripts/auditGate.mjs
// ============================================================================
// DEPENDENCY SECURITY GATE (blocking) — the dependency half of the security
// review, wired into CI. Complements tests/securityInvariants.test.ts (the code
// half). Plain Node so it runs in CI with no ts-node/build step.
//
// POLICY: fail the build on ANY high/critical advisory that is NOT explicitly
// acknowledged in .security-audit-allowlist.json. Each allowlist entry carries a
// reason, a reviewer, and an EXPIRY — once past its expiry it is treated as a
// fresh offender, so acknowledged-but-unfixed debt resurfaces instead of rotting
// silently. A brand-new high/critical advisory (a dependency we have never
// triaged) fails immediately. This is the enterprise "audit with reviewed
// exceptions" pattern: known transitive debt is tracked, regressions are blocked.
//
// USAGE:
//   node scripts/auditGate.mjs            # audit all deps (server default)
//   node scripts/auditGate.mjs --omit-dev # audit production deps only (SPA)
// ============================================================================

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OMIT_DEV = process.argv.includes('--omit-dev');
const ALLOWLIST_PATH = path.join(ROOT, '.security-audit-allowlist.json');

function runAudit() {
  const cmd = `npm audit --json${OMIT_DEV ? ' --omit=dev' : ''}`;
  try {
    return JSON.parse(execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (e) {
    // npm audit exits non-zero when it finds anything — the JSON is still on stdout.
    if (e.stdout) { try { return JSON.parse(e.stdout); } catch { /* fallthrough */ } }
    console.error('auditGate: could not run/parse `npm audit --json`:', e.message);
    process.exit(2);
  }
}

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return { advisories: {} };
  try { return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8')); }
  catch (e) { console.error('auditGate: allowlist is not valid JSON:', e.message); process.exit(2); }
}

const audit = runAudit();
const allow = loadAllowlist().advisories || {};
const today = new Date().toISOString().slice(0, 10);

// Collect every distinct high/critical advisory (by numeric source id).
const found = new Map(); // id -> {pkg, severity, title, url}
for (const [pkg, v] of Object.entries(audit.vulnerabilities || {})) {
  if (!['high', 'critical'].includes(v.severity)) continue;
  for (const via of v.via || []) {
    if (typeof via === 'object' && via.source && ['high', 'critical'].includes(via.severity)) {
      found.set(String(via.source), { pkg, severity: via.severity, title: via.title, url: via.url });
    }
  }
}

const offenders = [];   // new/unlisted OR expired
const acknowledged = []; // valid allowlist entries
for (const [id, info] of found) {
  const entry = allow[id];
  if (!entry) { offenders.push({ id, ...info, why: 'NOT allow-listed (new advisory)' }); continue; }
  if (entry.expires && entry.expires < today) {
    offenders.push({ id, ...info, why: `allowlist entry EXPIRED ${entry.expires}` });
    continue;
  }
  acknowledged.push({ id, ...info, expires: entry.expires, reason: entry.reason });
}

console.log('='.repeat(74));
console.log(`Dependency security gate — ${OMIT_DEV ? 'production deps only' : 'all deps'}`);
const m = (audit.metadata && audit.metadata.vulnerabilities) || {};
console.log(`npm audit totals: high=${m.high || 0} critical=${m.critical || 0} (moderate=${m.moderate || 0} low=${m.low || 0})`);
console.log('='.repeat(74));

if (acknowledged.length) {
  console.log(`\nAcknowledged (allow-listed, not yet expired) — ${acknowledged.length}:`);
  for (const a of acknowledged) console.log(`  ✓ ${a.id} ${a.severity.padEnd(8)} ${a.pkg} — expires ${a.expires || 'never'} — ${a.reason || ''}`);
}

if (offenders.length) {
  console.error(`\nBLOCKING — ${offenders.length} high/critical advisory(ies) not covered by a valid allowlist entry:`);
  for (const o of offenders) console.error(`  ✗ ${o.id} ${o.severity.padEnd(8)} ${o.pkg} — ${o.why}\n      ${o.title || ''}\n      ${o.url || ''}`);
  console.error(`\nTo resolve: upgrade the dependency, OR (if unfixable now) add a reviewed entry to`);
  console.error(`  ${path.relative(ROOT, ALLOWLIST_PATH)}  with { reason, reviewedBy, expires }.`);
  process.exit(1);
}

console.log('\nSecurity gate PASSED — no un-triaged high/critical advisories.');
