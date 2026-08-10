// ============================================================================
// STUDENT PIPELINE TEST HARNESS (operator tool — run in your own env)
// ============================================================================
// Exercises the real student-access pipeline end to end against your DB +
// email provider. Designed so you can test with YOUR OWN email address.
//
//   npx ts-node scripts/testStudentPipeline.ts <command> [args]
//
// Commands:
//   run <userId> <email> [--auto]
//        Full flow for <email> granted to account <userId>:
//        1. temporarily allowlists the email's domain (tagged as a test row),
//        2. checks eligibility, issues a single-use token,
//        3. sends the REAL verification email to <email> (check your inbox),
//        4. prints the /students/verify?token=… URL,
//        5. with --auto: immediately completes verification at the service
//           level (grantStudentComp) and asserts the account is now premium.
//        Without --auto, click the emailed link to complete the REAL HTTP flow.
//   status  <userId>          Show subscription + student_verification state.
//   cleanup <userId> <email>  Reset the account to free and remove the test
//                             domain + tokens + verification row.
//
// SAFETY
//   * Requires STUDENT_PIPELINE_TEST_CONFIRM=IUNDERSTAND in the env.
//   * The temp domain row is tagged note='__pipeline_test__'; unseed only ever
//     deletes rows with that tag.
//   * ⚠️ If you test with a gmail.com address you are briefly allowlisting
//     gmail.com — RUN THIS ON STAGING, and always run `cleanup` after. Prefer a
//     throwaway account for <userId>.
// ============================================================================

import crypto from 'crypto';
import { DB } from '../db';
import { emailService } from '../services/emailService';
import { loadPaywallConfig } from '../paywall/paywall.config';
import { SubscriptionService } from '../paywall/services/subscription.service';
import { loadStudentConfig, addMonths } from '../paywall/student.config';
import { checkEligibility } from '../services/studentDomainService';

const TEST_TAG = '__pipeline_test__';

function domainOf(email: string): string {
  return email.trim().toLowerCase().split('@')[1] || '';
}

async function seedDomain(domain: string): Promise<void> {
  await DB.query(
    `INSERT INTO accredited_domains (domain, institution_name, country, status, notes)
     VALUES (?, 'Pipeline test', 'US', 'active', ?)
     ON DUPLICATE KEY UPDATE status='active', notes=?`,
    [domain, TEST_TAG, TEST_TAG],
  );
  console.log(`  seeded test domain: ${domain}`);
}

async function unseedDomain(domain: string): Promise<void> {
  const [r] = await DB.query(
    'DELETE FROM accredited_domains WHERE domain = ? AND notes = ?',
    [domain, TEST_TAG],
  );
  console.log(`  removed test domain rows: ${(r as any).affectedRows || 0}`);
}

async function subLine(svc: SubscriptionService, userId: number): Promise<string> {
  const { tier, status } = await svc.getSubscriptionTier(userId);
  return `tier=${tier} status=${status}`;
}

async function main(): Promise<void> {
  if (process.env.STUDENT_PIPELINE_TEST_CONFIRM !== 'IUNDERSTAND') {
    console.error('Refusing to run. Set STUDENT_PIPELINE_TEST_CONFIRM=IUNDERSTAND (and use staging).');
    process.exit(2);
  }

  const [, , cmd, a1, a2, ...rest] = process.argv;
  const svc = new SubscriptionService(loadPaywallConfig(), null);
  const studentCfg = loadStudentConfig();

  if (cmd === 'status') {
    const userId = parseInt(a1 || '0', 10);
    console.log('subscription:', await subLine(svc, userId));
    const [rows] = await DB.query('SELECT * FROM student_verifications WHERE user_id = ?', [userId]);
    console.log('student_verifications:', (rows as any[])[0] || null);
    process.exit(0);
  }

  if (cmd === 'cleanup') {
    const userId = parseInt(a1 || '0', 10);
    const email = a2 || '';
    await svc.revokeStudentComp(userId, 'pipeline test cleanup');
    await DB.query('DELETE FROM student_verifications WHERE user_id = ?', [userId]);
    await DB.query('DELETE FROM student_verification_tokens WHERE user_id = ?', [userId]);
    if (email) await unseedDomain(domainOf(email));
    console.log('cleanup done. subscription now:', await subLine(svc, userId));
    process.exit(0);
  }

  if (cmd === 'run') {
    const userId = parseInt(a1 || '0', 10);
    const email = (a2 || '').trim();
    const auto = rest.includes('--auto');
    if (!userId || !email) {
      console.error('usage: run <userId> <email> [--auto]');
      process.exit(2);
    }

    console.log(`\n== Student pipeline test ==`);
    console.log(`user=${userId} email=${email} mode=${studentCfg.mode} auto=${auto}`);
    console.log(`before: ${await subLine(svc, userId)}`);

    // 1. Temporarily allowlist the email's domain.
    await seedDomain(domainOf(email));

    // 2. Eligibility (18+ asserted true for the test).
    const [dRows] = await DB.query(
      'SELECT domain, status FROM accredited_domains WHERE status IN (?, ?)', ['active', 'blocked'],
    );
    const allow: string[] = [], deny: string[] = [];
    for (const r of dRows as any[]) (r.status === 'blocked' ? deny : allow).push(String(r.domain).toLowerCase());
    const elig = checkEligibility({ email, attest18: true, allowlist: allow, denylist: deny, mode: studentCfg.mode });
    console.log(`  eligibility: ${elig.code} (${elig.matchedDomain || '-'})`);
    if (!elig.ok || !elig.email || !elig.matchedDomain) {
      console.error('  eligibility failed — aborting.');
      process.exit(1);
    }

    // 3. Issue a real single-use token + send the real email.
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + studentCfg.tokenExpiryHours * 3600 * 1000);
    await DB.query(
      `INSERT INTO student_verification_tokens (user_id, normalized_email, matched_domain, attested_18, token, expires_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [userId, elig.email.normalized, elig.matchedDomain, token, expiresAt],
    );
    const appUrl = process.env.APP_URL || 'https://www.theundergroundrailroad.world/Mirror';
    const verifyUrl = `${appUrl}/students/verify?token=${token}`;
    const sent = await emailService.sendTemplate(email, 'student_verification', {
      verificationUrl: verifyUrl,
      expiresInHours: String(studentCfg.tokenExpiryHours),
    });
    console.log(`  email sent: ${sent.success}${sent.error ? ' (' + sent.error + ')' : ''}`);
    console.log(`  verify URL: ${verifyUrl}`);

    // 4. Complete verification.
    if (auto) {
      const grantExpiry = addMonths(new Date(), studentCfg.grantMonths);
      await DB.query(
        `INSERT INTO student_verifications (user_id, normalized_email, matched_domain, method, attested_18, status, verified_at, expires_at)
         VALUES (?, ?, ?, 'email_allowlist', 1, 'active', NOW(), ?)
         ON DUPLICATE KEY UPDATE normalized_email=VALUES(normalized_email), matched_domain=VALUES(matched_domain),
           status='active', verified_at=NOW(), expires_at=VALUES(expires_at), revoked_reason=NULL`,
        [userId, elig.email.normalized, elig.matchedDomain, grantExpiry],
      );
      await DB.query('UPDATE student_verification_tokens SET used_at = NOW() WHERE token = ?', [token]);
      const grant = await svc.grantStudentComp(userId, { expiresAt: grantExpiry, matchedDomain: elig.matchedDomain });
      const after = await subLine(svc, userId);
      const pass = after.includes('tier=premium') && grant.granted;
      console.log(`  grant: ${JSON.stringify(grant)}`);
      console.log(`after:  ${after}`);
      console.log(pass ? '\n✓ PASS — account is premium via student comp' : '\n✗ FAIL — expected premium');
      console.log('Run `cleanup` when done to reset the account and remove the test domain.');
      process.exit(pass ? 0 : 1);
    }

    console.log('\nNow click the emailed link to complete the REAL HTTP + frontend flow.');
    console.log('Then check: npx ts-node scripts/testStudentPipeline.ts status ' + userId);
    console.log('And finally: npx ts-node scripts/testStudentPipeline.ts cleanup ' + userId + ' ' + email);
    process.exit(0);
  }

  console.error('Unknown command. Use: run | status | cleanup');
  process.exit(2);
}

main().catch((e) => { console.error('crashed:', e); process.exit(1); });
