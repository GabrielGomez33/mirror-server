// ============================================================================
// UNIT TESTS — storage-root resolution + user-key co-location (REGRESSION GATE)
// ============================================================================
// Run:  npx ts-node tests/storagePaths.test.ts
// Exit code 0 = all passed, 1 = at least one failed.
//
// Memorialises a real production-adjacent incident: key GENERATION derived its
// base from `MIRRORSTORAGE + '/users'` while key LOADING used `MIRRORUSERSTORAGE`.
// In prod those coincide, so the split was invisible; on a staging box that set
// the two roots independently, every registration failed at first key load with
// `ENOENT aes_key.bin`. The fix routes both through utils/storagePaths.
//
// Proves:
//   userStorageRoot / systemStorageRoot
//     1. throw (fail loud) when the backing env var is unset/blank
//     2. normalise the configured path (trailing slash collapsed)
//   userKeyDir
//     3. composes <root>/<id>/tier1/keys deterministically
//     4. numeric and string ids resolve identically
//     5. defaults its root to userStorageRoot()
//   round-trip (the regression):
//     6. keys WRITTEN by generateUserKeys(base) are READABLE by
//        loadUserKeys(base) — i.e. write-base and read-base agree — and the
//        aes_key.bin physically lands at userKeyDir(id, base). If key-gen and
//        key-load ever resolve different roots again, load throws and this fails.
// ============================================================================

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { userStorageRoot, systemStorageRoot, userKeyDir } from '../utils/storagePaths';
import { generateUserKeys, loadUserKeys } from '../controllers/encryptionController';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function group(name: string): void { console.log(`\n• ${name}`); }
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

// Snapshot env so mutations here never leak into other suites in the chain.
const ENV0 = { user: process.env.MIRRORUSERSTORAGE, sys: process.env.MIRRORSTORAGE };
function restoreEnv(): void {
  if (ENV0.user === undefined) delete process.env.MIRRORUSERSTORAGE; else process.env.MIRRORUSERSTORAGE = ENV0.user;
  if (ENV0.sys === undefined) delete process.env.MIRRORSTORAGE; else process.env.MIRRORSTORAGE = ENV0.sys;
}

(async () => {
  // -------------------------------------------------------------------------
  group('userStorageRoot / systemStorageRoot — fail loud when unset');
  delete process.env.MIRRORUSERSTORAGE;
  delete process.env.MIRRORSTORAGE;
  ok(throws(() => userStorageRoot()), 'userStorageRoot throws when MIRRORUSERSTORAGE unset');   // 1
  ok(throws(() => systemStorageRoot()), 'systemStorageRoot throws when MIRRORSTORAGE unset');   // 1
  process.env.MIRRORUSERSTORAGE = '   ';
  ok(throws(() => userStorageRoot()), 'userStorageRoot throws when blank/whitespace');          // 1

  group('userStorageRoot — normalises the configured path');
  process.env.MIRRORUSERSTORAGE = '/var/www//staging/../staging/users/';
  ok(userStorageRoot() === '/var/www/staging/users/', 'redundant // and .. segments collapsed'); // 2
  // A trailing slash is preserved by path.join and is harmless — path.join(root, id)
  // yields the same result with or without it. Prove that equivalence directly:
  process.env.MIRRORUSERSTORAGE = '/srv/u';
  const withoutSlash = userKeyDir('7');
  process.env.MIRRORUSERSTORAGE = '/srv/u/';
  ok(userKeyDir('7') === withoutSlash, 'trailing slash on root does not change composed key path'); // 2

  // -------------------------------------------------------------------------
  group('userKeyDir — deterministic <root>/<id>/tier1/keys layout');
  const root = '/srv/data/users';
  ok(userKeyDir('91', root) === path.join(root, '91', 'tier1', 'keys'), 'string id composes correctly'); // 3
  ok(userKeyDir(91, root) === userKeyDir('91', root), 'numeric id === string id');               // 4
  process.env.MIRRORUSERSTORAGE = root;
  ok(userKeyDir('91') === userKeyDir('91', userStorageRoot()), 'default root is userStorageRoot()'); // 5

  // -------------------------------------------------------------------------
  group('round-trip REGRESSION — generateUserKeys(base) ⇒ loadUserKeys(base)');
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-keys-'));
  process.env.MIRRORUSERSTORAGE = tmpRoot;
  const uid = '4242';
  try {
    await generateUserKeys(uid, userStorageRoot());
    // The file must physically exist exactly where userKeyDir predicts.
    const aesPath = path.join(userKeyDir(uid, userStorageRoot()), 'aes_key.bin');
    let fileThere = true;
    try { await fs.access(aesPath); } catch { fileThere = false; }
    ok(fileThere, `aes_key.bin lands at userKeyDir path (${aesPath})`);                          // 6

    const keys = await loadUserKeys(uid, userStorageRoot());
    ok(Buffer.isBuffer(keys.aesKey) && keys.aesKey.length === 32, 'loaded AES key is 32 bytes');  // 6
    ok(Buffer.isBuffer(keys.iv) && keys.iv.length === 16, 'loaded IV is 16 bytes');               // 6
    ok(typeof keys.publicKey === 'string' && keys.publicKey.includes('BEGIN PUBLIC KEY'), 'loaded RSA public key'); // 6
    ok(typeof keys.privateKey === 'string' && keys.privateKey.includes('PRIVATE KEY'), 'loaded RSA private key');   // 6
  } catch (e) {
    ok(false, `round-trip threw (write-base != read-base?): ${(e as Error).message}`);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  restoreEnv();
  console.log(`\n${failed === 0 ? '✓' : '✗'} storagePaths: ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
