// ============================================================================
// UNIT TESTS — audienceResolver (pure logic; no database required)
// ============================================================================
// Run:  npx ts-node tests/audienceResolver.test.ts
// Exit code 0 = all passed, 1 = at least one failed.
//
// These prove the claims made about the resolver:
//   1. Source dispatch defaults to 'users' and only 'waitlist' opts out.
//   2. The users WHERE builder is behaviour-preserved (byte-identical output
//      to the original emailBroadcastService.buildAudienceWhere logic).
//   3. The waitlist WHERE builder filters on its OWN columns and validates the
//      status list against an allow-list.
//   4. NO user-supplied value is ever concatenated into SQL — every dynamic
//      value is a bound parameter (injection surface = 0).
//   5. The recipient INSERTs use INSERT IGNORE against the correct table with
//      the correct idempotency columns per source.
// ============================================================================

import {
  resolveSource,
  consentLineFor,
  buildUsersWhere,
  buildWaitlistWhere,
  buildRecipientInsert,
  SUBSCRIBABLE_WAITLIST_STATUSES,
  AudienceFilter,
} from '../services/audienceResolver';

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`  ✗ FAIL: ${msg}\n      expected: ${e}\n      actual:   ${a}`); }
}
function group(name: string): void { console.log(`\n• ${name}`); }

// ---------------------------------------------------------------------------
group('resolveSource — defaults to users, only "waitlist" opts out');
eq(resolveSource(undefined), 'users', 'undefined -> users');
eq(resolveSource(null as any), 'users', 'null -> users');
eq(resolveSource({ mode: 'all' } as AudienceFilter), 'users', 'no source -> users');
eq(resolveSource({ mode: 'all', source: 'users' } as AudienceFilter), 'users', 'users -> users');
eq(resolveSource({ mode: 'all', source: 'waitlist' } as AudienceFilter), 'waitlist', 'waitlist -> waitlist');
eq(resolveSource({ mode: 'all', source: 'bogus' as any } as AudienceFilter), 'users', 'unknown -> users (fail safe)');

// ---------------------------------------------------------------------------
group('consentLineFor — accurate per audience (CAN-SPAM)');
ok(/Mirror account/.test(consentLineFor('users')), 'users mentions account');
ok(/waitlist/i.test(consentLineFor('waitlist')), 'waitlist mentions waitlist');
ok(consentLineFor('users') !== consentLineFor('waitlist'), 'lines differ');

// ---------------------------------------------------------------------------
group('buildUsersWhere — behaviour preserved (byte-identical to original)');
eq(
  buildUsersWhere({ mode: 'all' }),
  { where: "u.email IS NOT NULL AND u.email <> '' AND u.email_verified = 1 AND (u.account_locked = 0 OR u.account_locked IS NULL)", params: [] },
  'mode=all defaults (verified + not locked)',
);
eq(
  buildUsersWhere({ mode: 'specific', userIds: [1, 2, 3] }),
  { where: "u.email IS NOT NULL AND u.email <> '' AND u.id IN (?) AND u.email_verified = 1 AND (u.account_locked = 0 OR u.account_locked IS NULL)", params: [[1, 2, 3]] },
  'mode=specific with ids',
);
eq(
  buildUsersWhere({ mode: 'specific', userIds: [] }),
  { where: "u.email IS NOT NULL AND u.email <> '' AND 1 = 0 AND u.email_verified = 1 AND (u.account_locked = 0 OR u.account_locked IS NULL)", params: [] },
  'mode=specific empty ids -> matches nothing (1 = 0)',
);
eq(
  buildUsersWhere({ mode: 'all', verifiedOnly: false, excludeLocked: false, intakeCompleted: true, role: 'admin', registeredAfter: '2025-01-01' }),
  { where: "u.email IS NOT NULL AND u.email <> '' AND u.intake_completed = ? AND u.role = ? AND u.created_at >= ?", params: [1, 'admin', '2025-01-01'] },
  'flags off + intake/role/date on',
);
// Non-integer ids must be dropped (defensive against junk input).
eq(
  buildUsersWhere({ mode: 'specific', userIds: [1, 2.5 as any, '3' as any, NaN as any] }),
  { where: "u.email IS NOT NULL AND u.email <> '' AND u.id IN (?) AND u.email_verified = 1 AND (u.account_locked = 0 OR u.account_locked IS NULL)", params: [[1]] },
  'non-integer ids filtered out',
);

// ---------------------------------------------------------------------------
group('buildWaitlistWhere — own columns + status allow-list');
eq(
  buildWaitlistWhere({ mode: 'all', source: 'waitlist' }),
  { where: "w.email IS NOT NULL AND w.email <> '' AND w.status IN (?)", params: [[...SUBSCRIBABLE_WAITLIST_STATUSES]] },
  'default subscribable statuses',
);
eq(
  buildWaitlistWhere({ mode: 'all', source: 'waitlist', waitlistStatuses: ['invited'] }),
  { where: "w.email IS NOT NULL AND w.email <> '' AND w.status IN (?)", params: [['invited']] },
  'explicit valid status',
);
eq(
  buildWaitlistWhere({ mode: 'all', source: 'waitlist', waitlistStatuses: ['invited', 'bogus'] }),
  { where: "w.email IS NOT NULL AND w.email <> '' AND w.status IN (?)", params: [['invited']] },
  'invalid status dropped, valid kept',
);
eq(
  buildWaitlistWhere({ mode: 'all', source: 'waitlist', waitlistStatuses: ['bogus'] }),
  { where: "w.email IS NOT NULL AND w.email <> '' AND w.status IN (?)", params: [[...SUBSCRIBABLE_WAITLIST_STATUSES]] },
  'all invalid -> fall back to subscribable',
);
eq(
  buildWaitlistWhere({ mode: 'all', source: 'waitlist', waitlistSource: 'landing', registeredBefore: '2026-01-01' }),
  { where: "w.email IS NOT NULL AND w.email <> '' AND w.status IN (?) AND w.source = ? AND w.created_at < ?", params: [[...SUBSCRIBABLE_WAITLIST_STATUSES], 'landing', '2026-01-01'] },
  'source + date filters',
);

// ---------------------------------------------------------------------------
group('SQL injection — dynamic values are ALWAYS bound params, never inlined');
{
  const evilRole = "x'; DROP TABLE users; --";
  const r = buildUsersWhere({ mode: 'all', role: evilRole });
  ok(!/DROP/i.test(r.where), 'users.where contains no injected SQL');
  ok(r.where.includes('u.role = ?'), 'role uses a bound placeholder');
  ok(r.params.includes(evilRole), 'evil role carried safely as a parameter');
}
{
  const evilSource = "'; DROP TABLE waitlist_signups; --";
  const r = buildWaitlistWhere({ mode: 'all', source: 'waitlist', waitlistSource: evilSource });
  ok(!/DROP/i.test(r.where), 'waitlist.where contains no injected SQL');
  ok(r.where.includes('w.source = ?'), 'waitlistSource uses a bound placeholder');
  ok(r.params.includes(evilSource), 'evil source carried safely as a parameter');
}
{
  const r = buildWaitlistWhere({ mode: 'all', source: 'waitlist', waitlistStatuses: ["'; DROP TABLE x; --"] });
  const statuses = r.params[0] as string[];
  ok(!statuses.some(s => /DROP/i.test(s)), 'malicious status never reaches params (allow-list dropped it)');
}

// ---------------------------------------------------------------------------
group('buildRecipientInsert — INSERT IGNORE, correct table + idempotency cols');
{
  const u = buildRecipientInsert(42, { mode: 'all' });
  ok(u.sql.includes('INSERT IGNORE INTO email_campaign_recipients'), 'users: INSERT IGNORE');
  ok(u.sql.includes("'user'"), 'users: source discriminator');
  ok(/FROM users u/.test(u.sql), 'users: reads from users');
  ok(!/waitlist_signups/.test(u.sql), 'users: does NOT touch waitlist table');
  ok(u.params[0] === 42, 'users: campaignId is first bound param');
}
{
  const w = buildRecipientInsert(42, { mode: 'all', source: 'waitlist' });
  ok(w.sql.includes('INSERT IGNORE INTO email_campaign_recipients'), 'waitlist: INSERT IGNORE');
  ok(w.sql.includes("'waitlist'"), 'waitlist: source discriminator');
  ok(/FROM waitlist_signups w/.test(w.sql), 'waitlist: reads from waitlist_signups');
  ok(w.sql.includes('waitlist_id'), 'waitlist: populates waitlist_id (idempotency key col)');
  ok(w.sql.includes('w.id'), 'waitlist: maps waitlist row id');
  ok(!/FROM users/.test(w.sql), 'waitlist: does NOT touch users table');
  ok(w.params[0] === 42, 'waitlist: campaignId is first bound param');
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(52)}`);
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(52));
process.exit(failed === 0 ? 0 : 1);
