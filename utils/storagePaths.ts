// ============================================================================
// storagePaths — the SINGLE source of truth for on-disk storage roots.
// ============================================================================
// Why this exists: user directories and per-user encryption keys must resolve
// to the SAME root everywhere. Before this module, key GENERATION derived its
// base from `MIRRORSTORAGE + '/users'` while key LOADING (DirectoryController)
// used `MIRRORUSERSTORAGE`. In production those two happen to be equal, so the
// divergence was invisible; in any environment that set them independently the
// two split apart and every registration failed at first key load
// (ENOENT aes_key.bin). Centralising the resolution here makes that class of
// bug structurally impossible and unit-testable.
//
// Rule: anything that reads or writes user data (directories, keys, uploads)
// MUST resolve its root through `userStorageRoot()` — never by hand-joining
// MIRRORSTORAGE. System-wide (non-user) storage uses `systemStorageRoot()`.
// ============================================================================

import path from 'path';

/**
 * Canonical root for per-user data (directory tree + encryption keys).
 * Backed by MIRRORUSERSTORAGE. Throws if unset — the server cannot safely
 * store user data without it, so fail loudly at first use rather than write to
 * an unexpected location.
 */
export function userStorageRoot(): string {
  const root = process.env.MIRRORUSERSTORAGE;
  if (!root || !root.trim()) {
    throw new Error('MIRRORUSERSTORAGE is not set — user storage root is required');
  }
  return path.join(root); // normalise (collapse trailing slash / redundant segments)
}

/**
 * Canonical root for system-wide (non-user) storage. Backed by MIRRORSTORAGE.
 * Kept separate from userStorageRoot so the two can never be conflated again.
 */
export function systemStorageRoot(): string {
  const root = process.env.MIRRORSTORAGE;
  if (!root || !root.trim()) {
    throw new Error('MIRRORSTORAGE is not set — system storage root is required');
  }
  return path.join(root);
}

/**
 * The tier-1 key directory for a user, under the given root (defaults to the
 * canonical user root). This is the ONE definition of the key-dir layout; both
 * key generation and key loading compose their paths from here so they can
 * never point at different directories.
 */
export function userKeyDir(userId: string | number, root: string = userStorageRoot()): string {
  return path.join(root, String(userId), 'tier1', 'keys');
}
