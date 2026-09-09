// scripts/deleteSkeletalIntakes.ts
// ============================================================================
// SAFE, DRY-RUN-FIRST removal of the 5 SKELETAL simulation intake records that
// were written against production user 48 while testing single-section /store
// submissions. These thin records carry ONLY a `main` + `voice_meta` component
// file (no personality/astrology/iq/face), whereas every real record carries
// the full component set — see the audited `ls` of user 48's tier3/uploads.
//
// RUNS AS THE SERVICE ACCOUNT (mirror_app) — no sudo, no root, no file reads:
//   * The skeletal files are root-owned (written by the root-run app), so a
//     non-root account CANNOT read/decrypt them. But deleting/MOVING a file on
//     Unix depends on the DIRECTORY's permissions, not the file's — and
//     tier3/uploads + tier3/meta are mirror_app-owned (mode 750, no sticky bit).
//     So mirror_app can move these files out even though it can't read them.
//   * We therefore DO NOT decrypt to verify: the skeletal signature is proven
//     from DB metadata (component_structure) alone, which is stronger and needs
//     no file access.
//   * "Backup" = MOVE the files into a backup dir (rename, same filesystem):
//     the encrypted bytes are preserved intact and the operation is reversible,
//     all via directory permissions only.
//
// WHY A SCRIPT, NOT AN ENDPOINT: there is deliberately NO per-record delete API.
// Deleting individual historical records is a one-off operator action; it lives
// here, gated behind an explicit --apply and a metadata signature check.
//
// SAFETY LAYERS (all must pass before anything is moved/deleted):
//   1. Allow-list:  only the 5 hard-coded TARGET ids may ever be touched.
//   2. Deny-list:   the 3 KEEP ids can NEVER be a target (assertion at boot).
//   3. Metadata gate: each target must reference ONLY main/voice_meta component
//                     files. If ANY target references a personality/astrology/
//                     iq/face file, the WHOLE run aborts — a wrong id cannot
//                     move a real record.
//   4. Move-not-destroy: files are renamed into a backup dir (recoverable),
//                        not shredded; the metadata rows are dumped to JSON too.
//   5. Dry-run default: prints the plan and stops. Acts only with --apply.
//   6. Post-verify: after --apply, re-reads intake_metadata and asserts the 5
//                   are gone and the 3 KEEP rows remain (non-zero exit if not).
//
// USAGE (run as mirror_app, from /var/www/mirror-server so .env is found):
//   npx ts-node scripts/deleteSkeletalIntakes.ts            # dry run (default)
//   npx ts-node scripts/deleteSkeletalIntakes.ts --apply    # move + delete rows
//   BACKUP_DIR=/some/writable/path npx ts-node scripts/deleteSkeletalIntakes.ts --apply
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { DB } from '../db';
import { userStorageRoot } from '../utils/storagePaths';

dotenv.config();

const USER_ID = process.env.SKELETAL_USER_ID || '48';
const TIER = 'tier3';

// The 5 skeletal sim records to remove (all submitted 2026-08-25).
const TARGET_INTAKE_IDS: readonly string[] = [
  '1a127489-46ad-4f34-9baa-ad39382b1a3b',
  'c862cd43-8bf3-4fc5-b063-d1e88a91af48',
  '135bdc7c-56ba-4cfc-b4f8-4a9d6233f191',
  '2993f7bf-b9d3-4208-843a-8a44778861e7',
  'be09f0fd-e49b-4c65-bb32-cbd836788bb9',
];

// The 3 COMPLETE records that MUST survive (Sept 2025). Hard deny-list.
const KEEP_INTAKE_IDS: readonly string[] = ['ade7091b', '3348c91a', 'e3fafc49'];

const APPLY = process.argv.includes('--apply');

// Boot assertion: target and keep sets must be disjoint.
for (const t of TARGET_INTAKE_IDS) {
  if (KEEP_INTAKE_IDS.some((k) => t.startsWith(k))) {
    console.error(`FATAL: target ${t} collides with a KEEP id — refusing to run.`);
    process.exit(2);
  }
}

interface MetaRow {
  intakeId: string;
  submissionDate: string;
  componentStructure: Record<string, any>;
}

/** Coerce a MySQL JSON column (object already, or a JSON string) to an object. */
function asObject(v: unknown): Record<string, any> {
  if (v && typeof v === 'object') return v as Record<string, any>;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return {};
}

async function listRows(): Promise<MetaRow[]> {
  const [rows] = await DB.query(
    `SELECT intake_id, submission_date, component_structure
       FROM intake_metadata WHERE user_id = ? ORDER BY submission_date DESC`,
    [String(USER_ID)]
  );
  return (rows as any[]).map((r) => ({
    intakeId: r.intake_id,
    submissionDate: r.submission_date,
    componentStructure: asObject(r.component_structure),
  }));
}

// The four "rich" component files that a REAL record has and a skeletal one lacks.
function richComponentFiles(cs: Record<string, any>): string[] {
  return [cs.personalityDataFile, cs.astrologicalDataFile, cs.iqDataFile, cs.faceAnalysisFile]
    .filter((f): f is string => typeof f === 'string' && f.length > 0);
}

// Every component file a record references (what we move to backup).
function allComponentFiles(cs: Record<string, any>): string[] {
  return [cs.mainFile, cs.voiceMetadataFile, cs.iqDataFile, cs.personalityDataFile, cs.astrologicalDataFile, cs.faceAnalysisFile]
    .filter((f): f is string => typeof f === 'string' && f.length > 0);
}

async function moveIfExists(src: string, dst: string): Promise<boolean> {
  try {
    await fs.rename(src, dst);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; // nothing to move
    throw e; // EACCES on the DIRECTORY, EXDEV, etc. — surface it
  }
}

async function main() {
  const storageRoot = userStorageRoot();
  const userDir = path.join(storageRoot, USER_ID);
  const uploadsDir = path.join(userDir, TIER, 'uploads');
  const metaDir = path.join(userDir, TIER, 'meta');
  const backupDir = process.env.BACKUP_DIR ||
    path.join(userDir, TIER, `_backup_skeletal_${new Date().toISOString().replace(/[:.]/g, '-')}`);

  console.log('='.repeat(74));
  console.log(`Skeletal intake cleanup — user ${USER_ID}`);
  console.log(`Mode:         ${APPLY ? 'APPLY (moves files + deletes rows)' : 'DRY RUN (no changes)'}`);
  console.log(`Storage root: ${storageRoot}`);
  console.log(`Backup dir:   ${backupDir}`);
  console.log('='.repeat(74));

  const all = await listRows();
  console.log(`\nFound ${all.length} intake_metadata rows for user ${USER_ID}:`);
  for (const m of all) {
    const isTarget = TARGET_INTAKE_IDS.includes(m.intakeId);
    const isKeep = KEEP_INTAKE_IDS.some((k) => m.intakeId.startsWith(k));
    const tag = isTarget ? 'TARGET(delete)' : isKeep ? 'KEEP' : 'other';
    console.log(`  - ${m.intakeId}  ${new Date(m.submissionDate).toISOString()}  [${tag}]`);
  }

  const present = all.filter((m) => TARGET_INTAKE_IDS.includes(m.intakeId));
  const missing = TARGET_INTAKE_IDS.filter((id) => !all.some((m) => m.intakeId === id));
  if (missing.length) {
    console.log(`\nNote: ${missing.length} target id(s) already absent:`);
    missing.forEach((id) => console.log(`  - ${id}`));
  }
  if (present.length === 0) {
    console.log('\nNo target records present. Nothing to delete. Exiting cleanly.');
    return;
  }

  // --- METADATA GATE: every target must be skeletal (no rich component files) ---
  console.log(`\nVerifying ${present.length} target record(s) are skeletal (metadata gate — no file reads)...`);
  const plan: Array<{ meta: MetaRow; files: string[] }> = [];
  let abort = false;
  for (const m of present) {
    const rich = richComponentFiles(m.componentStructure);
    const files = allComponentFiles(m.componentStructure);
    if (rich.length > 0) {
      console.error(`  ${m.intakeId}: RICH component file(s) present [${rich.join(', ')}] — NOT skeletal. Aborting whole run.`);
      abort = true;
    } else {
      console.log(`  ${m.intakeId}: skeletal ✓  (component files: ${files.join(', ') || 'none'})`);
      plan.push({ meta: m, files });
    }
  }
  if (abort) {
    console.error('\nABORTED — a target did not pass the skeletal metadata gate. Nothing was moved or deleted.');
    process.exit(3);
  }

  if (!APPLY) {
    console.log('\nDRY RUN complete. Would, for each target: move its component files (uploads + meta)');
    console.log(`into ${backupDir} and delete its intake_metadata row.`);
    for (const { meta, files } of plan) {
      console.log(`  - ${meta.intakeId}: ${files.length} file(s) + 1 metadata row`);
    }
    console.log('\nRe-run with --apply to perform the move + row deletion.');
    return;
  }

  // --- APPLY: back up the metadata rows, MOVE files to backup, delete rows ---
  await fs.mkdir(backupDir, { recursive: true });
  const rowsBackup: any[] = [];
  for (const { meta } of plan) {
    const [rows] = await DB.query('SELECT * FROM intake_metadata WHERE user_id = ? AND intake_id = ?', [USER_ID, meta.intakeId]);
    rowsBackup.push(...(rows as any[]));
  }
  await fs.writeFile(path.join(backupDir, 'intake_metadata_rows.json'), JSON.stringify(rowsBackup, null, 2));
  console.log(`\nWrote ${rowsBackup.length} metadata row(s) to ${path.join(backupDir, 'intake_metadata_rows.json')}`);

  console.log('\nMoving files to backup + deleting rows...');
  for (const { meta, files } of plan) {
    let moved = 0;
    for (const f of files) {
      if (await moveIfExists(path.join(uploadsDir, f), path.join(backupDir, `${meta.intakeId}__uploads__${f}`))) moved++;
      await moveIfExists(path.join(metaDir, `${f}.json`), path.join(backupDir, `${meta.intakeId}__meta__${f}.json`));
    }
    const [res]: any = await DB.query('DELETE FROM intake_metadata WHERE user_id = ? AND intake_id = ?', [USER_ID, meta.intakeId]);
    console.log(`  ${meta.intakeId}: ${moved} upload file(s) moved, metadata rows deleted = ${res.affectedRows}`);
  }

  // --- POST-VERIFY ---
  const after = await listRows();
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
  console.log(`\nDone. 5 skeletal records removed; 3 complete records intact. Backup: ${backupDir}`);
  console.log('Once you confirm user 48 renders correctly, the backup dir can be removed.');
}

main()
  .then(() => DB.end())
  .catch(async (e) => {
    console.error('FATAL:', e);
    try { await DB.end(); } catch { /* ignore */ }
    process.exit(1);
  });
