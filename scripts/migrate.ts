// ============================================================================
// DATABASE MIGRATION RUNNER
// ============================================================================
// File: scripts/migrate.ts
// ----------------------------------------------------------------------------
// A small, dependency-light runner for the .sql files in ./migrations.
//
// DESIGNED FOR A DRIFTED DATABASE.
//   This production DB was built up by hand over time — some tables/columns
//   exist that were never captured in a migration file, and some migration
//   files (e.g. 017) were never applied. There is therefore NO reliable
//   file<->schema correspondence, so this tool does NOT try to "bring the DB
//   up to date" by running everything pending. That would apply migrations you
//   never intended and could disrupt the live system.
//
//   Instead the primary command applies exactly ONE migration you name:
//
//     npm run migrate -- 018        # apply ONLY 018_waitlist_signups.sql
//     npm run migrate -- 018_waitlist_signups.sql   # (full name also works)
//     npm run migrate:status        # list files + which are recorded applied
//
//   For 018 that means: create the waitlist_signups table, nothing else.
//
// HOW `apply` WORKS
//   * You pass a number ("018") or a filename. The runner finds the single
//     matching file and runs only that file's statements. If your term matches
//     0 or >1 files it stops and shows you the choices — never guesses.
//   * `DELIMITER $$` directives (trigger/event migrations) are honoured like
//     the mysql CLI, so BEGIN…END bodies are not split on their inner ';'.
//   * After a successful apply it records the filename in a `schema_migrations`
//     bookkeeping table (created if absent) purely so `migrate:status` can show
//     what's been run. This record gates NOTHING and touches no other table —
//     drop `schema_migrations` any time and the tool still works.
//   * Write migrations idempotently (CREATE TABLE IF NOT EXISTS / DROP … IF
//     EXISTS) — then re-applying one is harmless.
//
// OPT-IN BATCH MODE (not the default; use only if you know the DB matches)
//   npm run migrate:pending        # apply every file not yet recorded applied
//   npm run migrate:baseline       # record already-applied files, run nothing
//
// CONNECTION
//   Uses the same env vars as db.ts (DB_HOST/DB_USER/DB_PASSWORD/DB_NAME),
//   loaded from .env via dotenv.
// ============================================================================

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// The .sql files live in <project-root>/migrations. `tsc` does NOT copy them
// into dist/, so we cannot resolve relative to __dirname alone — the compiled
// runner sits at dist/scripts/migrate.js while the migrations stay at the
// source root. Try the candidates that cover both run modes and pick the first
// that actually exists:
//   * process.cwd()/migrations       — npm scripts always run at the pkg root
//   * __dirname/../migrations         — ts-node (scripts/ -> root/migrations)
//   * __dirname/../../migrations      — compiled (dist/scripts/ -> root)
function resolveMigrationsDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(__dirname, '..', 'migrations'),
    path.resolve(__dirname, '..', '..', 'migrations'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch {
      /* keep trying */
    }
  }
  return candidates[0];
}

const MIGRATIONS_DIR = resolveMigrationsDir();

type Command = 'apply' | 'up' | 'status' | 'baseline';

// ---------------------------------------------------------------------------
// SQL splitting — honours DELIMITER directives the way the mysql client does.
// ---------------------------------------------------------------------------
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let delimiter = ';';
  let buffer = '';

  const lines = sql.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    // A `DELIMITER x` line changes the terminator and is not itself SQL.
    const delimMatch = trimmed.match(/^DELIMITER\s+(\S+)\s*$/i);
    if (delimMatch) {
      // Flush anything buffered under the previous delimiter first.
      if (buffer.trim()) {
        statements.push(buffer.trim());
        buffer = '';
      }
      delimiter = delimMatch[1];
      continue;
    }

    buffer += rawLine + '\n';

    // If this line ends the current statement, cut it here.
    if (trimmed.endsWith(delimiter)) {
      let stmt = buffer.trim();
      // Strip the trailing delimiter token.
      stmt = stmt.slice(0, stmt.length - delimiter.length).trim();
      if (stmt) statements.push(stmt);
      buffer = '';
    }
  }

  if (buffer.trim()) statements.push(buffer.trim());

  // Drop chunks that are only comments / whitespace — they would error.
  return statements.filter((s) => {
    const withoutLineComments = s
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    return withoutLineComments.length > 0;
  });
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function listMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

async function ensureLedger(conn: mysql.Connection): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    VARCHAR(255) NOT NULL,
      checksum    CHAR(64)     NOT NULL,
      applied_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
}

async function appliedSet(conn: mysql.Connection): Promise<Set<string>> {
  const [rows] = await conn.query<any[]>('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename as string));
}

async function tableExists(conn: mysql.Connection, table: string): Promise<boolean> {
  const [rows] = await conn.query<any[]>(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [table]
  );
  return rows.length > 0;
}

function makeConnection(): Promise<mysql.Connection> {
  const required = ['DB_HOST', 'DB_USER', 'DB_NAME'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing DB env var(s): ${missing.join(', ')}. Set them in .env (see db.ts).`
    );
  }
  return mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: false,
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function cmdStatus(conn: mysql.Connection): Promise<void> {
  await ensureLedger(conn);
  const applied = await appliedSet(conn);
  const files = listMigrationFiles();

  console.log(`\nMigrations directory: ${MIGRATIONS_DIR}`);
  console.log(`Total files: ${files.length} | Applied: ${applied.size} | Pending: ${
    files.filter((f) => !applied.has(f)).length
  }\n`);

  for (const f of files) {
    console.log(`  ${applied.has(f) ? '[applied]' : '[PENDING]'}  ${f}`);
  }
  console.log('');
}

// Extract the table names a migration CREATEs, so baseline can tell an
// already-applied historical migration (its tables exist) from a brand-new one
// that merely happens to ship alongside the runner (its tables do not yet
// exist and must actually run).
function createdTables(sql: string): string[] {
  const names: string[] = [];
  const rx = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_]+)`?/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(sql)) !== null) names.push(m[1]);
  return names;
}

async function cmdBaseline(conn: mysql.Connection): Promise<void> {
  await ensureLedger(conn);
  const applied = await appliedSet(conn);
  const files = listMigrationFiles();

  if (files.length === 0) {
    console.warn(
      `\nWARNING: no .sql files found in ${MIGRATIONS_DIR}. Nothing to ` +
      `baseline. Run this from the project root (where the migrations/ ` +
      `directory lives).\n`
    );
    return;
  }

  let marked = 0;
  const skipped: string[] = [];

  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');

    // If this file creates tables and ANY of them is missing, it has NOT been
    // applied yet — leave it pending so `npm run migrate` actually runs it.
    // Files with no CREATE TABLE (pure ALTER / trigger / event) are assumed to
    // be pre-existing history and are recorded. A genuinely new alter-only
    // migration is the rare case the operator should apply/verify by hand.
    const tables = createdTables(sql);
    if (tables.length > 0) {
      const existence = await Promise.all(tables.map((t) => tableExists(conn, t)));
      if (existence.some((exists) => !exists)) {
        skipped.push(f);
        continue;
      }
    }

    await conn.query(
      'INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)',
      [f, sha256(sql)]
    );
    marked++;
  }

  console.log(
    `\nBaseline complete: recorded ${marked} already-applied file(s) ` +
    `(no SQL executed).`
  );
  if (skipped.length) {
    console.log(
      `Left pending (tables not present yet — will run on 'npm run migrate'):`
    );
    for (const f of skipped) console.log(`  • ${f}`);
  }
  console.log('');
}

// Apply exactly one file's statements and record it. Returns true on success.
async function applyFile(conn: mysql.Connection, filename: string): Promise<boolean> {
  const full = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(full, 'utf8');
  const statements = splitStatements(sql);

  process.stdout.write(`  → ${filename} (${statements.length} statement(s)) ... `);
  try {
    for (const stmt of statements) {
      await conn.query(stmt);
    }
    // Bookkeeping only — records that this file ran. Gates nothing.
    await conn.query(
      `INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE checksum = VALUES(checksum), applied_at = CURRENT_TIMESTAMP`,
      [filename, sha256(sql)]
    );
    console.log('ok');
    return true;
  } catch (err) {
    console.log('FAILED');
    console.error(`\nError applying ${filename}:\n${(err as Error).message}\n`);
    console.error(
      '(MySQL DDL auto-commits, so statements before the failure may already ' +
      'be applied. Write migrations idempotently — IF NOT EXISTS / DROP IF ' +
      'EXISTS — then it is safe to fix and re-run.)\n'
    );
    return false;
  }
}

// Resolve a user-supplied term ("018" or a filename) to a single migration
// file. Returns { file } on a unique match, or { candidates } to disambiguate.
function resolveTarget(target: string): { file?: string; candidates: string[] } {
  const files = listMigrationFiles();
  const norm = target.trim().replace(/\.sql$/i, '');

  const exact = files.filter((f) => f === target || f.replace(/\.sql$/i, '') === norm);
  if (exact.length === 1) return { file: exact[0], candidates: exact };

  // Prefix match on a clean boundary: "018" -> "018_...", not "0180...".
  const prefixed = files.filter((f) => f.replace(/\.sql$/i, '').startsWith(norm + '_'));
  const matches = exact.length ? exact : prefixed;
  return { file: matches.length === 1 ? matches[0] : undefined, candidates: matches };
}

// Validate an apply target against the filesystem — NO database needed, so a
// typo fails instantly without opening a connection. Returns the resolved
// filename, or null after printing the problem and setting a failing exit code.
function resolveApplyTargetOrReport(target: string | undefined): string | null {
  const files = listMigrationFiles();
  if (files.length === 0) {
    console.warn(
      `\nWARNING: no .sql files found in ${MIGRATIONS_DIR}. Run from the ` +
      `project root (where the migrations/ directory lives).\n`
    );
    process.exitCode = 1;
    return null;
  }

  if (!target) {
    console.error(
      `\nUsage: npm run migrate -- <number|filename>\n` +
      `  e.g.  npm run migrate -- 018\n\nAvailable migrations:\n` +
      files.map((f) => `  • ${f}`).join('\n') + '\n'
    );
    process.exitCode = 1;
    return null;
  }

  const { file, candidates } = resolveTarget(target);
  if (!file) {
    if (candidates.length === 0) {
      console.error(`\nNo migration matches "${target}". Available:\n` +
        files.map((f) => `  • ${f}`).join('\n') + '\n');
    } else {
      console.error(`\n"${target}" is ambiguous — matches:\n` +
        candidates.map((f) => `  • ${f}`).join('\n') +
        `\n\nBe more specific (e.g. the full filename).\n`);
    }
    process.exitCode = 1;
    return null;
  }
  return file;
}

// ----------------------------------------------------------------------------
// PRIMARY COMMAND: apply ONE already-resolved migration file and nothing else.
// ----------------------------------------------------------------------------
async function cmdApply(conn: mysql.Connection, file: string): Promise<void> {
  await ensureLedger(conn);
  console.log(`\nApplying a single migration: ${file}\n`);
  const ok = await applyFile(conn, file);
  if (ok) console.log(`\nDone. ${file} applied.\n`);
  else process.exitCode = 1;
}

// ----------------------------------------------------------------------------
// OPT-IN batch mode. Not the default — only sensible when the DB genuinely
// matches the migration files. On a drifted DB, prefer `apply`.
// ----------------------------------------------------------------------------
async function cmdUp(conn: mysql.Connection): Promise<void> {
  await ensureLedger(conn);
  const applied = await appliedSet(conn);
  const files = listMigrationFiles();

  if (files.length === 0) {
    console.warn(
      `\nWARNING: no .sql files found in ${MIGRATIONS_DIR}. Run from the ` +
      `project root (where the migrations/ directory lives).\n`
    );
    return;
  }

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log('\nNothing pending — every file is recorded as applied.\n');
    return;
  }

  console.log(
    `\nBatch mode will apply ${pending.length} file(s) NOT yet recorded ` +
    `applied:\n` + pending.map((f) => `  • ${f}`).join('\n') +
    `\n\nOn a drifted database this may run migrations you did not intend. ` +
    `If that is not what you want, Ctrl-C now and use ` +
    `\`npm run migrate -- <number>\` instead.\n`
  );

  for (const f of pending) {
    const ok = await applyFile(conn, f);
    if (!ok) {
      console.error('Stopped on first failure.\n');
      process.exitCode = 1;
      return;
    }
  }

  console.log('\nAll pending migrations applied.\n');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const raw = (process.argv[2] || '').toLowerCase();

  let command: Command;
  let target: string | undefined;
  if (raw === 'status') {
    command = 'status';
  } else if (raw === 'baseline') {
    command = 'baseline';
  } else if (raw === 'up' || raw === 'pending') {
    command = 'up';
  } else if (raw === 'apply') {
    command = 'apply';
    target = process.argv[3]; // preserve original case
  } else {
    // Bare invocation: treat the first arg (if any) as an apply target, so
    // `node migrate.js 018` and `npm run migrate -- 018` both work.
    command = 'apply';
    target = process.argv[2];
  }

  // Validate an apply target BEFORE touching the database, so a typo or a
  // wrong directory fails immediately without needing a live connection.
  let fileToApply: string | null = null;
  if (command === 'apply') {
    fileToApply = resolveApplyTargetOrReport(target);
    if (!fileToApply) return;
  }

  let conn: mysql.Connection | undefined;
  try {
    conn = await makeConnection();
    if (command === 'status') await cmdStatus(conn);
    else if (command === 'baseline') await cmdBaseline(conn);
    else if (command === 'up') await cmdUp(conn);
    else await cmdApply(conn, fileToApply as string);
  } catch (err) {
    console.error(`\nMigration runner error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end();
  }
}

void main();
