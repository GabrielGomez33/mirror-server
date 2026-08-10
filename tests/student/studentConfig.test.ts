// ============================================================================
// UNIT TESTS — student.config (pure: addMonths + env clamping)
// ============================================================================
// Run: npx ts-node tests/student/studentConfig.test.ts
//   or: node --experimental-strip-types tests/student/studentConfig.test.ts
//
// Proves:
//   1. addMonths handles month-length overflow (Jan 31 + 1mo != Mar 3).
//   2. addMonths handles year rollover and leap years.
//   3. loadStudentConfig clamps out-of-range env into safe bounds and
//      falls back to defaults on garbage.
// ============================================================================

import { addMonths, loadStudentConfig } from '../../paywall/student.config';

let passed = 0, failed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else { failed++; console.error(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`); }
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

console.log('addMonths');
eq(iso(addMonths(new Date('2026-01-31T00:00:00Z'), 1)), '2026-02-28', 'Jan 31 + 1mo -> Feb 28 (clamped, not Mar)');
eq(iso(addMonths(new Date('2024-01-31T00:00:00Z'), 1)), '2024-02-29', 'leap year: Jan 31 + 1mo -> Feb 29');
eq(iso(addMonths(new Date('2026-08-10T00:00:00Z'), 12)), '2027-08-10', '12mo -> same day next year');
eq(iso(addMonths(new Date('2026-11-15T00:00:00Z'), 2)), '2027-01-15', 'year rollover');
eq(iso(addMonths(new Date('2026-03-15T00:00:00Z'), 12)), '2027-03-15', 'standard 12-month grant');

console.log('loadStudentConfig env clamping');
const saved = { ...process.env };
try {
  process.env.STUDENT_GRANT_MONTHS = '9999';   // above max 60
  process.env.STUDENT_MIN_AGE = '5';            // below min 13
  process.env.STUDENT_ALLOWLIST_MODE = 'nonsense';
  process.env.STUDENT_ACCESS_ENABLED = 'false';
  process.env.STUDENT_MAX_ACTIVE_TOKENS = 'notanumber';
  const c = loadStudentConfig();
  eq(c.grantMonths, 60, 'grantMonths clamped to max 60');
  eq(c.minAge, 13, 'minAge clamped to min 13');
  eq(c.mode, 'allowlist', 'invalid mode -> allowlist default');
  eq(c.enabled, false, 'enabled=false honored');
  eq(c.maxActiveTokens, 5, 'garbage int -> default 5');
} finally {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
