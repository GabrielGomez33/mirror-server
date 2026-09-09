// scripts/deleteSkeletalIntakes.ts
// ============================================================================
// SAFE, DRY-RUN-FIRST removal of the 5 SKELETAL simulation intake records that
// were written against production user 48 while testing single-section /store
// submissions. These thin records (astrologicalResult:{western:{sunSign}},
// empty big5Profile, empty faceAnalysis.expressions, voiceMetadata:{duration:8})
// are the cosmetic residue the read-model fix already merges around — this
// script removes them at the source so `list/48` shows only the 3 real records.
//
// WHY A SCRIPT, NOT AN ENDPOINT: there is deliberately NO per-record delete API
// (the only account delete path is the full-account purge in userController).
// Deleting individual historical records is an operator action, run once, with
// eyes on it — so it lives here, gated behind an explicit --apply and a content
// safety check, never wired into a route.
//
// SAFETY LAYERS (all must pass before a single byte is deleted):
//   1. Allow-list:  only the 5 hard-coded TARGET ids may ever be touched.
//   2. Deny-list:   the 3 KEEP ids can NEVER be a target (assertion at boot).
//   3. Content gate: each target is decrypted and must look SKELETAL. If any
//                    target carries rich data (full big5, moon/rising, numerology,
//                    expressions, iq score, answer arrays) the WHOLE run aborts
//                    and nothing is deleted — a wrong id can't nuke real data.
//   4. Backup:      every targeted metadata row (JSON) and every raw tier3 file
//                   (uploads + meta) is copied to a timestamped backup dir first.
//   5. Dry-run default: prints the plan and stops. Deletes only with --apply.
//   6. Post-verify: after --apply, re-lists and asserts the 5 are gone and the
//                   3 KEEP records remain, exiting non-zero if not.
//
// USAGE (run on the box that has the prod .env + MIRRORUSERSTORAGE mounted):
//   npx ts-node scripts/deleteSkeletalIntakes.ts            # dry run (default)
//   npx ts-node scripts/deleteSkeletalIntakes.ts --apply    # actually delete
//   BACKUP_DIR=/some/path npx ts-node scripts/deleteSkeletalIntakes.ts --apply
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { DB } from '../db';
import { IntakeDataManager } from '../controllers/intakeController';
import { deleteFromTier } from '../controllers/directoryController';
import { userStorageRoot } from '../utils/storagePaths';

dotenv.config();

// --- The exact, audited target set (see conversation record 2026-09) ----------
const USER_ID = process.env.SKELETAL_USER_ID || '48';

// The 5 skeletal sim records to remove (all submitted 2026-08-25).
const TARGET_INTAKE_IDS: readonly string[] = [
  '1a127489-46ad-4f34-9baa-ad39382b1a3b',
  'c862cd43-8bf3-4fc5-b063-d1e88a91af48',
  '135bdc7c-56ba-4cfc-b4f8-4a9d6233f191',
  '2993f7bf-b9d3-4208-843a-8a44778861e7',
  'be09f0fd-e49b-4c65-bb32-cbd836788bb9',
];

// The 3 COMPLETE records that MUST survive (Sept 2025). Hard deny-list.
const KEEP_INTAKE_IDS: readonly string[] = [
  'ade7091b',
  '3348c91a',
  'e3fafc49',
];

const APPLY = process.argv.includes('--apply');
const TIER = 'tier3' as const;

// Boot assertion: the target and keep sets must be disjoint. If a KEEP id ever
// appears in the target list this is a programming error — refuse to run.
for (const t of TARGET_INTAKE_IDS) {
  if (KEEP_INTAKE_IDS.some((k) => t.startsWith(k))) {
    console.error(`FATAL: target ${t} collides with a KEEP id — refusing to run.`);
    process.exit(2);
  }
}

const ctx = {
  userId: Number(USER_ID),
  accessedBy: Number(USER_ID),
  reason: 'operator_skeletal_sim_record_cleanup',
};

/**
 * Richness probe. Returns the list of "rich" signals found in a decrypted
 * record. A skeletal record returns []. If a TARGET record returns anything,
 * we abort the whole run — the id set must be wrong.
 */
function richSignals(rec: Record<string, any> | undefined | null): string[] {
  const hits: string[] = [];
  if (!rec) return hits;
  const astro = rec.astrologicalResult || {};
  const western = astro.western || {};
  if (western.moonSign) hits.push('astrology.moonSign');
  if (western.risingSign) hits.push('astrology.risingSign');
  if (astro.numerology && Object.keys(astro.numerology).length) hits.push('astrology.numerology');
  if (astro.chinese && Object.keys(astro.chinese).length) hits.push('astrology.chinese');
  const big5 = rec.personalityResult?.big5Profile || {};
  const big5Numeric = Object.values(big5).filter((v) => typeof v === 'number');
  if (big5Numeric.length >= 3) hits.push(`big5Profile(${big5Numeric.length} traits)`);
  const expr = rec.faceAnalysis?.expressions || {};
  if (Object.keys(expr).length) hits.push('faceAnalysis.expressions');
  if (rec.iqResults && (rec.iqResults.score != null || rec.iqResults.iq != null)) hits.push('iqResults.score');
  if (Array.isArray(rec.iqAnswers) && rec.iqAnswers.length) hits.push(`iqAnswers(${rec.iqAnswers.length})`);
  if (Array.isArray(rec.personalityAnswers) && rec.personalityAnswers.length) {
    hits.push(`personalityAnswers(${rec.personalityAnswers.length})`);
  }
  return hits;
}

async function main() {
  const storageRoot = userStorageRoot();
  const backupDir =
    process.env.BACKUP_DIR ||
    path.join(storageRoot, USER_ID, `_backup_skeletal_${new Date().toISOString().replace(/[:.]/g, '-')}`);

  console.log('='.repeat(74));
  console.log(`Skeletal intake cleanup — user ${USER_ID}`);
  console.log(`Mode:        ${APPLY ? 'APPLY (will delete)' : 'DRY RUN (no changes)'}`);
  console.log(`Storage root: ${storageRoot}`);
  console.log(`Backup dir:  ${backupDir}`);
  console.log('='.repeat(74));

  // 1. List all current records for the user (source of truth).
  const all = await IntakeDataManager.listUserIntakes(USER_ID);
  console.log(`\nFound ${all.length} intake_metadata rows for user ${USER_ID}:`);
  for (const m of all) {
    const isTarget = TARGET_INTAKE_IDS.includes(m.intakeId);
    const isKeep = KEEP_INTAKE_IDS.some((k) => m.intakeId.startsWith(k));
    const tag = isTarget ? 'TARGET(delete)' : isKeep ? 'KEEP' : 'other';
    console.log(`  - ${m.intakeId}  ${new Date(m.submissionDate).toISOString()}  [${tag}]`);
  }

  // 2. Resolve which targets actually exist right now.
  const present = all.filter((m) => TARGET_INTAKE_IDS.includes(m.intakeId));
  const missing = TARGET_INTAKE_IDS.filter((id) => !all.some((m) => m.intakeId === id));
  if (missing.length) {
    console.log(`\nNote: ${missing.length} target id(s) already absent (nothing to do for them):`);
    missing.forEach((id) => console.log(`  - ${id}`));
  }
  if (present.length === 0) {
    console.log('\nNo target records present. Nothing to delete. Exiting cleanly.');
    return;
  }

  // 3. CONTENT GATE — decrypt each target and prove it is skeletal.
  console.log(`\nVerifying ${present.length} target record(s) are skeletal (content gate)...`);
  const plan: Array<{ meta: (typeof present)[number]; files: string[] }> = [];
  let abort = false;
  for (const m of present) {
    let rec: Record<string, any> | undefined;
    try {
      const r = await IntakeDataManager.retrieveIntakeData(USER_ID, m.intakeId, ctx, false);
      rec = r?.intakeData as Record<string, any> | undefined;
    } catch (e) {
      console.error(`  ${m.intakeId}: retrieve FAILED — ${(e as Error).message}. Aborting to be safe.`);
      abort = true;
      continue;
    }
    const signals = richSignals(rec);
    const cs = m.componentStructure || {};
    const files = [cs.mainFile, cs.faceAnalysisFile, cs.voiceMetadataFile, cs.iqDataFile, cs.personalityDataFile, cs.astrologicalDataFile]
      .filter((f): f is string => typeof f === 'string' && f.length > 0);
    if (signals.length) {
      console.error(`  ${m.intakeId}: RICH DATA present [${signals.join(', ')}] — NOT skeletal. Aborting whole run.`);
      abort = true;
    } else {
      console.log(`  ${m.intakeId}: skeletal ✓  (${files.length} tier3 files)`);
      plan.push({ meta: m, files });
    }
  }
  if (abort) {
    console.error('\nABORTED — a target did not pass the skeletal content gate. Nothing was deleted.');
    process.exit(3);
  }

  // 4. BACKUP — metadata rows + raw tier3 files, before any deletion.
  await fs.mkdir(backupDir, { recursive: true });
  const rowsBackup: any[] = [];
  for (const { meta, files } of plan) {
    const [rows] = await DB.query('SELECT * FROM intake_metadata WHERE user_id = ? AND intake_id = ?', [USER_ID, meta.intakeId]);
    rowsBackup.push(...(rows as any[]));
    for (const f of files) {
      for (const sub of ['uploads', 'meta'] as const) {
        const srcName = sub === 'meta' ? `${f}.json` : f;
        const src = path.join(storageRoot, USER_ID, TIER, sub, srcName);
        const dst = path.join(backupDir, `${meta.intakeId}__${sub}__${srcName}`);
        try {
          await fs.copyFile(src, dst);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          // absent file is fine — nothing to back up
        }
      }
    }
  }
  await fs.writeFile(path.join(backupDir, 'intake_metadata_rows.json'), JSON.stringify(rowsBackup, null, 2));
  console.log(`\nBackup written: ${rowsBackup.length} metadata row(s) + raw tier3 files -> ${backupDir}`);

  if (!APPLY) {
    console.log('\nDRY RUN complete. Would delete:');
    for (const { meta, files } of plan) {
      console.log(`  - ${meta.intakeId}: ${files.length} tier3 files + 1 metadata row`);
    }
    console.log('\nRe-run with --apply to perform the deletion.');
    return;
  }

  // 5. DELETE — tier3 files (secure-delete), then the metadata row.
  console.log('\nApplying deletions...');
  for (const { meta, files } of plan) {
    for (const f of files) {
      try {
        await deleteFromTier(USER_ID, TIER, f, ctx);
      } catch (e) {
        console.warn(`  ${meta.intakeId}: file ${f} delete warning — ${(e as Error).message}`);
      }
    }
    const [res]: any = await DB.query('DELETE FROM intake_metadata WHERE user_id = ? AND intake_id = ?', [USER_ID, meta.intakeId]);
    console.log(`  ${meta.intakeId}: files removed, metadata rows deleted = ${res.affectedRows}`);
  }

  // 6. POST-VERIFY — the 5 gone, the 3 KEEP present.
  const after = await IntakeDataManager.listUserIntakes(USER_ID);
  const stillTargets = after.filter((m) => TARGET_INTAKE_IDS.includes(m.intakeId));
  const keepPresent = KEEP_INTAKE_IDS.filter((k) => after.some((m) => m.intakeId.startsWith(k)));
  console.log(`\nPost-delete: ${after.length} records remain.`);
  console.log(`  targets still present: ${stillTargets.length} (expected 0)`);
  console.log(`  KEEP records present:  ${keepPresent.length}/${KEEP_INTAKE_IDS.length} [${keepPresent.join(', ')}]`);
  if (stillTargets.length !== 0) {
    console.error('VERIFY FAILED: some target records still present.');
    process.exit(4);
  }
  if (keepPresent.length !== KEEP_INTAKE_IDS.length) {
    console.error('VERIFY FAILED: a KEEP record is missing — restore from backup immediately.');
    process.exit(5);
  }
  console.log('\nDone. 5 skeletal records removed; 3 complete records intact.');
}

main()
  .then(() => DB.end())
  .catch(async (e) => {
    console.error('FATAL:', e);
    try { await DB.end(); } catch { /* ignore */ }
    process.exit(1);
  });
