// tests/tierStorageConcurrency.test.ts
// Regression proof for the tiered-storage SIDECAR-METADATA RACE that dropped the
// faceAnalysis section from GET /intake/latest once mirror-server ran as a
// non-root service account (de-privilege surfaced a latent race).
//
// THE BUG: readFromTier() rewrites each file's `<name>.json` metadata sidecar on
// EVERY read (to stamp lastAccessed). /intake/latest issues TWO concurrent full
// reads of the same component files (resolveLatest ‖ getLatestIntakeData), so two
// readers raced on the same sidecar. writeMetadata() used a plain fs.writeFile
// (O_TRUNC then incremental write); a reader that opened the sidecar mid-write
// saw an empty/partial file and JSON.parse threw "Unexpected end of JSON input".
// readFromTier caught it and the whole read failed, so the FIRST component in
// iteration order (faceAnalysis) was silently dropped from the merged result.
//
// THE FIX: writeMetadata() now writes a unique temp file and rename()s it over
// the target (atomic on POSIX), so a concurrent reader always sees a COMPLETE
// file — old or new, never torn. The read-path lastAccessed touch is also
// best-effort, and readMetadata retries once. This test hammers a single tier
// file with many concurrent reads (each triggering a sidecar rewrite) plus
// interleaved writes, and asserts EVERY read returns the exact bytes and NONE
// throws. On the pre-fix code the parse-of-torn-file failure reproduces with very
// high probability at this concurrency; post-fix it is impossible by construction.
//
// tier1 is used deliberately: it is not encrypted (no key material) and needs no
// DB context, so the test is hermetic — it exercises the storage/metadata layer
// alone, which is where the race lived.
// Run: ts-node tests/tierStorageConcurrency.test.ts

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { DirectoryController as DirectoryControllerType } from '../controllers/directoryController';

// The module builds a default singleton at import time via userStorageRoot(),
// which requires MIRRORUSERSTORAGE. This test never uses that singleton (it
// instantiates its own controller on a temp basePath), so provide a throwaway
// default BEFORE requiring the module to keep the test hermetic. require (not a
// hoisted import) guarantees the env var is set first.
process.env.MIRRORUSERSTORAGE =
  process.env.MIRRORUSERSTORAGE || path.join(os.tmpdir(), 'tierstore-singleton-unused');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DirectoryController } = require('../controllers/directoryController') as {
  DirectoryController: new (basePath?: string) => DirectoryControllerType;
};

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } };

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'tierstore-'));
  const dc = new DirectoryController(base);
  const userId = 'sim_concurrency_user';
  const tier = 'tier1' as const;
  const filename = 'intake_data_face_probe.json';

  // A payload big enough that a torn read is clearly invalid JSON (not a lucky
  // whitespace boundary), matching a realistic faceAnalysis component file.
  const payloadObj = {
    intakeId: 'race-probe',
    component: 'faceAnalysis',
    data: {
      detection: { score: 0.99, box: { x: 8, y: 8, width: 96, height: 96 } },
      landmarks: { positions: Array.from({ length: 68 }, (_, i) => [i, i * 2]) },
      expressions: { neutral: 0.74, happy: 0.18, sad: 0.02, angry: 0.01, fearful: 0.01, disgusted: 0.01, surprised: 0.03 },
      filler: 'x'.repeat(6000),
    },
  };
  const payload = JSON.stringify(payloadObj);
  await dc.writeToTier(userId, tier, filename, payload);

  // --- 1. Many concurrent reads of the SAME file (each rewrites the sidecar). ---
  const ROUNDS = 60;
  const PARALLEL = 24;
  let readErrors = 0;
  let contentMismatches = 0;
  const errSamples: string[] = [];

  for (let r = 0; r < ROUNDS; r++) {
    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL }, () => dc.readFromTier(userId, tier, filename))
    );
    for (const res of results) {
      if (res.status === 'rejected') {
        readErrors++;
        if (errSamples.length < 3) errSamples.push(String((res.reason as Error)?.message || res.reason));
      } else if (res.value.toString('utf8') !== payload) {
        contentMismatches++;
      }
    }
  }
  ok(readErrors === 0, `no read threw under ${ROUNDS * PARALLEL} concurrent reads (saw ${readErrors}${errSamples.length ? `; e.g. "${errSamples[0]}"` : ''})`);
  ok(contentMismatches === 0, `every concurrent read returned the exact payload (mismatches=${contentMismatches})`);

  // --- 2. Reads of the existing file interleaved with concurrent STORES of NEW
  // unique files — the real production pattern (each intake store writes files
  // whose names embed a unique intakeId+timestamp, so a data filename is never
  // overwritten in place; only the sidecar is rewritten, on read). A store must
  // never disrupt an in-flight read, and vice versa. ---
  let mixedErrors = 0;
  const mixedSamples: string[] = [];
  for (let r = 0; r < 30; r++) {
    const ops: Promise<unknown>[] = [];
    // A concurrent store of a brand-new unique file (mkdir + atomic data write +
    // atomic sidecar write) alongside a burst of reads of the original file.
    ops.push(dc.writeToTier(userId, tier, `intake_data_face_${r}_${Date.now()}.json`, payload));
    for (let i = 0; i < 16; i++) ops.push(dc.readFromTier(userId, tier, filename));
    const results = await Promise.allSettled(ops);
    for (const res of results) {
      if (res.status === 'rejected') {
        mixedErrors++;
        if (mixedSamples.length < 3) mixedSamples.push(String((res.reason as Error)?.message || res.reason));
      }
    }
  }
  ok(mixedErrors === 0, `no op threw under concurrent reads + new-file stores (saw ${mixedErrors}${mixedSamples.length ? `; e.g. "${mixedSamples[0]}"` : ''})`);

  // --- 3. No stray temp files leaked from atomic writes. ---
  const metaDir = path.join(base, userId, tier, 'meta');
  const metaFiles = await fs.readdir(metaDir).catch(() => [] as string[]);
  const strays = metaFiles.filter((f) => f.includes('.tmp.'));
  ok(strays.length === 0, `no leftover .tmp metadata files after atomic writes (found ${strays.length})`);

  // --- 4. The sidecar is always parseable after the storm (final integrity). ---
  let finalParseOk = false;
  try {
    const metaRaw = await fs.readFile(path.join(metaDir, `${filename}.json`), 'utf8');
    const meta = JSON.parse(metaRaw);
    finalParseOk = meta && meta.filename === filename && typeof meta.checksum === 'string';
  } catch { finalParseOk = false; }
  ok(finalParseOk, 'sidecar metadata remains valid JSON with expected fields after the concurrency storm');

  await fs.rm(base, { recursive: true, force: true }).catch(() => {});

  if (fail) { console.error(`\ntierStorageConcurrency: ${pass} passed, ${fail} FAILED`); process.exit(1); }
  console.log(`tierStorageConcurrency: ${pass} passed — concurrent reads never tear the metadata sidecar (faceAnalysis drop fixed)`);
  // Importing the storage module transitively opens the shared DB pool, whose
  // open handles keep the event loop alive; this hermetic test never uses it, so
  // exit explicitly on success rather than hang.
  process.exit(0);
}

main().catch((e) => { console.error('tierStorageConcurrency: unexpected error', e); process.exit(1); });
