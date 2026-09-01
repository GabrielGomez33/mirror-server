// tests/coreDraftStorage.int.test.ts
// ----------------------------------------------------------------------------
// INTEGRATION proof for the DB-backed Core-draft STORAGE path + the data-
// integrity invariant, run against a REAL MySQL (the CI service, or a local DB
// you opt into). The pure content-safety of drafts is already proven in
// coreDraft.test.ts; this test proves the parts that only MySQL can enforce:
//
//   1. round-trip           saveStepDraft -> getStepDraft (answers persist,
//                           smuggled media is stripped on the way IN, status
//                           becomes in_progress)
//   2. erase                resetStepDraft deletes the row -> not_started
//   3. INVARIANT (security) neither a re-save NOR an erase can downgrade a
//                           COMPLETED step (the ON DUPLICATE IF-guard and the
//                           DELETE ... WHERE status <> 'completed' guard)
//   4. size cap             an oversized (non-media) draft is rejected (413)
//   5. derivation           completing all five steps flips users.intake_completed
//
// SAFETY (double-checked, per the enterprise mandate):
//   * Runs ONLY when INTEGRATION_DB=1 is set (the CI job sets it). A DB-less
//     local `npm run test:ci` never invokes this, and `npm run test:db` without
//     the flag SKIPS rather than touching any database.
//   * The code under test uses the real table names (users, core_intake_progress),
//     so this test performs DDL against DB_NAME. It therefore REFUSES to run
//     unless DB_NAME looks like a throwaway test DB (/test|ci/i) — it can never
//     drop/rewrite tables in a prod/staging database by mistake.
//   * If INTEGRATION_DB=1 but the DB is unreachable, it THROWS (a false-green
//     silent skip in CI is not acceptable).
// ----------------------------------------------------------------------------

import { DB } from '../db';
import {
  saveStepDraft,
  getStepDraft,
  resetStepDraft,
  completeStep,
  getProgress,
  CORE_STEPS,
  MAX_DRAFT_BYTES,
  DraftTooLargeError,
} from '../services/intakeCompletion';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } };

async function createSchema(): Promise<void> {
  // Child first (FK), then parent, for a clean idempotent re-run.
  await DB.query('DROP TABLE IF EXISTS core_intake_progress');
  await DB.query('DROP TABLE IF EXISTS users');
  await DB.query(`
    CREATE TABLE users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      intake_completed TINYINT(1) NOT NULL DEFAULT 0,
      initial_intake_completed TINYINT(1) NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // Verbatim shape from migration 022 (the table under test).
  await DB.query(`
    CREATE TABLE core_intake_progress (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      user_id       INT NOT NULL,
      step_key      ENUM('visual','vocal','iq','astrology','personality') NOT NULL,
      status        ENUM('not_started','in_progress','completed') NOT NULL DEFAULT 'not_started',
      draft_state   JSON NULL,
      completed_at  TIMESTAMP NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE INDEX idx_user_step (user_id, step_key),
      INDEX idx_user_status (user_id, status),
      CONSTRAINT fk_core_progress_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function seedUser(): Promise<number> {
  const [r] = await DB.query('INSERT INTO users (intake_completed) VALUES (0)');
  return (r as { insertId: number }).insertId;
}

async function userIntakeCompleted(userId: number): Promise<number> {
  const [rows] = await DB.query('SELECT intake_completed FROM users WHERE id = ?', [userId]);
  return Number((rows as any[])[0]?.intake_completed);
}

async function main() {
  if (!process.env.INTEGRATION_DB) {
    console.log('SKIP: coreDraftStorage integration test (set INTEGRATION_DB=1 + a test DB to run)');
    return;
  }
  const dbName = process.env.DB_NAME || '';
  if (!process.env.DB_HOST || !dbName) {
    throw new Error('INTEGRATION_DB=1 but DB_HOST/DB_NAME are not configured — refusing to false-green.');
  }
  if (!/test|ci/i.test(dbName)) {
    throw new Error(`Refusing to run destructive integration DDL against DB_NAME="${dbName}" (name must match /test|ci/i).`);
  }

  await createSchema();
  const userId = await seedUser();

  // --- 1. round-trip: answers persist, smuggled media stripped, in_progress ---
  await saveStepDraft(userId, 'iq', {
    currentQuestionIndex: 7,
    userAnswers: { q1: 'a', q2: 'b' },
    showResult: false,
    photoDataUrl: 'data:image/png;base64,AAAA',        // media-named -> dropped
    note: 'data:application/octet-stream;base64,BBBB', // data: URL value -> null
  });
  {
    const d = await getStepDraft(userId, 'iq');
    ok(d.status === 'in_progress', 'save -> status in_progress');
    const ds = d.draftState as any;
    ok(ds?.currentQuestionIndex === 7, 'round-trip: currentQuestionIndex persisted');
    ok(ds?.userAnswers?.q1 === 'a' && ds?.userAnswers?.q2 === 'b', 'round-trip: userAnswers persisted');
    ok(!('photoDataUrl' in (ds ?? {})), 'SECURITY: media-named key stripped on store');
    ok(ds?.note === null, 'SECURITY: data: URL value nulled on store');
  }

  // --- 2. upsert: a second save updates the same row, still in_progress -------
  await saveStepDraft(userId, 'iq', { currentQuestionIndex: 12, userAnswers: { q1: 'a', q2: 'b', q3: 'c' } });
  {
    const d = await getStepDraft(userId, 'iq');
    ok((d.draftState as any)?.currentQuestionIndex === 12, 'upsert: draft updated in place');
    ok(d.status === 'in_progress', 'upsert: still in_progress');
    const [rows] = await DB.query('SELECT COUNT(*) AS n FROM core_intake_progress WHERE user_id = ? AND step_key = ?', [userId, 'iq']);
    ok(Number((rows as any[])[0].n) === 1, 'upsert: exactly one row per (user, step)');
  }

  // --- 3. erase: reset deletes the row -> not_started -------------------------
  {
    const reset = await resetStepDraft(userId, 'iq');
    ok(reset === true, 'erase: reset reports true when an in-progress draft existed');
    const d = await getStepDraft(userId, 'iq');
    ok(d.status === 'not_started', 'erase: step is not_started after reset');
    ok(d.draftState === null, 'erase: draft is gone after reset');
    ok(d.erased === true, 'erase: leaves a cross-device TOMBSTONE (erased=true), not a deleted row');
    const again = await resetStepDraft(userId, 'iq');
    ok(again === false, 'erase: reset reports false when nothing to erase (already a tombstone)');
    // A fresh save anywhere clears the tombstone (erased -> false, back in_progress).
    await saveStepDraft(userId, 'iq', { currentQuestionIndex: 1, userAnswers: { q1: 'a' } });
    const resumed = await getStepDraft(userId, 'iq');
    ok(resumed.status === 'in_progress' && resumed.erased === false, 'a new save clears the tombstone');
    // Re-erase to restore not_started for the completed-guard block below.
    await resetStepDraft(userId, 'iq');
  }

  // --- 4/5. INVARIANT: a completed step can NEVER be downgraded ---------------
  await completeStep(userId, 'iq');
  {
    const d = await getStepDraft(userId, 'iq');
    ok(d.status === 'completed', 'complete: step is completed');

    // re-save must NOT downgrade completed -> in_progress (the ON DUPLICATE guard)
    await saveStepDraft(userId, 'iq', { currentQuestionIndex: 3, userAnswers: { q1: 'x' } });
    const afterSave = await getStepDraft(userId, 'iq');
    ok(afterSave.status === 'completed', 'INVARIANT: re-save does NOT downgrade a completed step');

    // erase must NOT delete/downgrade completed (the DELETE WHERE-guard)
    const reset = await resetStepDraft(userId, 'iq');
    ok(reset === false, 'INVARIANT: erase reports false (no-op) on a completed step');
    const afterErase = await getStepDraft(userId, 'iq');
    ok(afterErase.status === 'completed', 'INVARIANT: erase does NOT downgrade a completed step');
  }

  // --- 6. size cap: an oversized (non-media) draft is rejected ----------------
  {
    // Many sub-8000-char plain strings survive sanitize, so the serialized JSON
    // exceeds MAX_DRAFT_BYTES and must throw (would map to HTTP 413).
    const big: Record<string, string> = {};
    const chunk = 'x'.repeat(7000);
    for (let i = 0; i < 20; i++) big['k' + i] = chunk; // ~140KB > 100KB cap
    let threw = false;
    try {
      await saveStepDraft(userId, 'personality', { answers: big });
    } catch (e) {
      threw = e instanceof DraftTooLargeError;
    }
    ok(threw, 'size cap: oversized draft throws DraftTooLargeError');
    ok(Buffer.byteLength(JSON.stringify(big)) > MAX_DRAFT_BYTES, 'size cap: fixture actually exceeds MAX_DRAFT_BYTES');
    const d = await getStepDraft(userId, 'personality');
    ok(d.status === 'not_started', 'size cap: rejected draft did not create a row');
  }

  // --- 7. derivation: completing all five steps flips intake_completed --------
  {
    ok(await userIntakeCompleted(userId) === 0, 'derivation: not complete with only iq done');
    for (const s of CORE_STEPS) await completeStep(userId, s);
    const prog = await getProgress(userId);
    ok(prog.every((p) => p.status === 'completed'), 'derivation: all five steps completed');
    ok(await userIntakeCompleted(userId) === 1, 'derivation: intake_completed re-derived to 1');
  }

  // Cleanup the throwaway schema (child first for the FK).
  await DB.query('DROP TABLE IF EXISTS core_intake_progress');
  await DB.query('DROP TABLE IF EXISTS users');
}

main()
  .then(() => {
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: coreDraftStorage(int) ${pass} passed, ${fail} failed`);
    return DB.end().then(() => { if (fail) process.exit(1); });
  })
  .catch(async (err) => {
    console.error('coreDraftStorage(int) ERROR:', err);
    try { await DB.end(); } catch { /* noop */ }
    process.exit(1);
  });
