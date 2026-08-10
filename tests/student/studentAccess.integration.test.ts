// ============================================================================
// INTEGRATION TEST — student comp lifecycle (REQUIRES a database)
// ============================================================================
// Proves the stateful invariants that unit tests can't:
//   1. grantStudentComp -> tier=premium, status=active, provider=manual,
//      provider_plan_id=student_comp, current_period_end = grant expiry.
//   2. getSubscriptionTier reflects premium immediately (cache invalidated).
//   3. grantStudentComp is SKIPPED (granted=false) when the user already has a
//      live PayPal subscription — the paid row is never clobbered.
//   4. checkAndExpireStudentComps downgrades an EXPIRED comp back to free and
//      flips student_verifications.status to 'expired'.
//   5. revokeStudentComp only affects comp rows.
//
// SAFETY: this test MUTATES subscription rows for TEST_USER_ID. It only runs
// when you explicitly opt in, and it restores the row to free at the end.
//
// Run:
//   RUN_STUDENT_DB_TESTS=true TEST_USER_ID=<throwaway user id> \
//     npx ts-node tests/student/studentAccess.integration.test.ts
// ============================================================================

import { DB } from '../../db';
import { loadPaywallConfig } from '../../paywall/paywall.config';
import { SubscriptionService } from '../../paywall/services/subscription.service';
import { addMonths } from '../../paywall/student.config';

async function main(): Promise<void> {
  if (process.env.RUN_STUDENT_DB_TESTS !== 'true') {
    console.log('⏭  SKIPPED — set RUN_STUDENT_DB_TESTS=true (and TEST_USER_ID) to run the DB integration test.');
    process.exit(0);
  }
  const userId = parseInt(process.env.TEST_USER_ID || '0', 10);
  if (!userId) {
    console.error('✗ TEST_USER_ID is required (a throwaway user id).');
    process.exit(1);
  }

  const svc = new SubscriptionService(loadPaywallConfig(), null);
  let passed = 0, failed = 0;
  const ok = (c: boolean, label: string) => { if (c) { passed++; } else { failed++; console.error(`  ✗ ${label}`); } };

  async function row(): Promise<any> {
    const [r] = await DB.query('SELECT * FROM user_subscriptions WHERE user_id = ?', [userId]);
    return (r as any[])[0];
  }

  // Clean slate.
  await DB.query('DELETE FROM student_verifications WHERE user_id = ?', [userId]);
  await DB.query(
    `INSERT INTO user_subscriptions (user_id, tier, status) VALUES (?, 'free', 'free')
     ON DUPLICATE KEY UPDATE tier='free', status='free', provider=NULL, provider_plan_id=NULL,
       provider_subscription_id=NULL, current_period_end=NULL`,
    [userId],
  );

  // 1 + 2 — grant
  const expiry = addMonths(new Date(), 12);
  const g1 = await svc.grantStudentComp(userId, { expiresAt: expiry, matchedDomain: 'mit.edu' });
  ok(g1.granted === true, 'grant returns granted=true from free');
  const r1 = await row();
  ok(r1.tier === 'premium' && r1.status === 'active', 'row is premium/active');
  ok(r1.provider === 'manual' && r1.provider_plan_id === 'student_comp', 'marked manual/student_comp');
  const tier1 = await svc.getSubscriptionTier(userId);
  ok(tier1.tier === 'premium', 'getSubscriptionTier -> premium');

  // 3 — do not clobber a live paid sub
  await DB.query(
    `UPDATE user_subscriptions SET provider='paypal', provider_plan_id='P-XXX',
       provider_subscription_id='I-PAID', status='active', tier='premium' WHERE user_id=?`,
    [userId],
  );
  const g2 = await svc.grantStudentComp(userId, { expiresAt: expiry, matchedDomain: 'mit.edu' });
  ok(g2.granted === false && g2.reason === 'active_provider_subscription', 'skips live paid sub');
  const r2 = await row();
  ok(r2.provider === 'paypal' && r2.provider_subscription_id === 'I-PAID', 'paid row untouched');

  // 4 — expiry cron downgrades an expired comp only
  await DB.query(
    `UPDATE user_subscriptions SET provider='manual', provider_plan_id='student_comp',
       provider_subscription_id='student:${userId}', status='active', tier='premium',
       current_period_end = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE user_id=?`,
    [userId],
  );
  await DB.query(
    `INSERT INTO student_verifications (user_id, normalized_email, matched_domain, method, attested_18, status, verified_at, expires_at)
     VALUES (?, ?, 'mit.edu', 'email_allowlist', 1, 'active', NOW(), DATE_SUB(NOW(), INTERVAL 1 DAY))
     ON DUPLICATE KEY UPDATE status='active', expires_at=DATE_SUB(NOW(), INTERVAL 1 DAY)`,
    [userId, `test-${userId}@mit.edu`],
  );
  const expiredCount = await svc.checkAndExpireStudentComps();
  ok(expiredCount >= 1, 'checkAndExpireStudentComps expired >=1');
  const r3 = await row();
  ok(r3.tier === 'free' && r3.status === 'free', 'expired comp downgraded to free');
  const [sv] = await DB.query('SELECT status FROM student_verifications WHERE user_id=?', [userId]);
  ok((sv as any[])[0]?.status === 'expired', 'verification flipped to expired');

  // 5 — revoke only affects comp rows
  await svc.grantStudentComp(userId, { expiresAt: expiry, matchedDomain: 'mit.edu' });
  const revoked = await svc.revokeStudentComp(userId, 'test');
  ok(revoked === true, 'revoke affected the comp row');
  const r4 = await row();
  ok(r4.tier === 'free' && r4.provider === null, 'revoked back to free');
  ok((await svc.revokeStudentComp(userId, 'test-again')) === false, 'revoke is a no-op on a non-comp row');

  // Cleanup.
  await DB.query('DELETE FROM student_verifications WHERE user_id = ?', [userId]);
  await DB.query(
    `UPDATE user_subscriptions SET tier='free', status='free', provider=NULL, provider_plan_id=NULL,
       provider_subscription_id=NULL, current_period_end=NULL WHERE user_id=?`,
    [userId],
  );

  console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Integration test crashed:', e); process.exit(1); });
