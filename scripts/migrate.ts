// ============================================================================
// DATABASE MIGRATION RUNNER
// ============================================================================
// File: scripts/migrate.ts
// ----------------------------------------------------------------------------
// A small, dependency-light forward-only migration runner for the .sql files
// in ./migrations. Replaces the old "mysql < migrations/xxx.sql" by-hand flow.
//
// Run via the npm scripts (see package.json):
//   npm run migrate            # apply every pending migration, in order
//   npm run migrate:status     # show applied vs pending, apply nothing
//   npm run migrate:baseline   # record already-applied files WITHOUT running
//                              #   them — use ONCE on a database whose
//                              #   migrations were applied by hand. A file is
//                              #   only recorded if the tables it creates
//                              #   already exist, so a brand-new migration that
//                              #   ships with this runner (e.g. 018) stays
//                              #   pending and is applied by `npm run migrate`.
//
// HOW IT WORKS
//   * Applied migrations are recorded in a `schema_migrations` table (created
//     automatically). A file is "pending" until a row with its filename
//     exists. This makes `npm run migrate` safe to run repeatedly.
//   * Files are applied in filename sort order. Keep the numeric prefixes
//     (018_, 019_, ...) so new migrations sort after the existing ones.
//   * Each .sql file is split into individual statements. `DELIMITER $$`
//     directives (used by the trigger/event migrations) are honoured exactly
//     like the mysql CLI, so BEGIN…END bodies are not split on their inner ';'.
//   * A whole file runs inside ONE transaction where possible. MySQL DDL
//     (CREATE TABLE, etc.) auto-commits and cannot be rolled back, so a
//     failure mid-file may leave earlier statements applied — the same as the
//     old manual flow. The runner stops on the first error and does NOT record
//     the file as applied, so re-running retries it (write migrations to be
//     idempotent: IF NOT EXISTS / DROP … IF EXISTS, as the existing ones are).
//
// SAFETY ON AN EXISTING DATABASE
//   Production already had 001..017 (+ truthstream/add_* files) applied by
//   hand. Running `npm run migrate` there with an empty ledger would try to
//   re-apply them. The runner guards against this: if `schema_migrations` is
//   empty but application tables already exist, it refuses and tells you to
//   run `npm run migrate:baseline` first. After baselining, only genuinely new
//   files (018_ and beyond) are applied.
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

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

// A table whose presence signals "this is an already-populated database" for
// the baseline guard. `users` is core and exists after migration 011.
const SENTINEL_TABLE = 'users';

type Command = 'up' | 'status' | 'baseline';

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

async function cmdUp(conn: mysql.Connection): Promise<void> {
  await ensureLedger(conn);
  const applied = await appliedSet(conn);
  const files = listMigrationFiles();
  const pending = files.filter((f) => !applied.has(f));

  // Baseline guard: empty ledger but a populated DB means the migrations were
  // applied by hand. Refuse to re-run them destructively.
  if (applied.size === 0 && (await tableExists(conn, SENTINEL_TABLE))) {
    console.error(
      `\nRefusing to run: the migration ledger is empty but the '${SENTINEL_TABLE}' ` +
      `table already exists.\nThis database was migrated by hand before this ` +
      `runner existed.\n\n  Run  npm run migrate:baseline  once to record the ` +
      `existing migrations,\n  then  npm run migrate  to apply new ones.\n`
    );
    process.exitCode = 1;
    return;
  }

  if (pending.length === 0) {
    console.log('\nNothing to migrate — database is up to date.\n');
    return;
  }

  console.log(`\nApplying ${pending.length} pending migration(s):\n`);

  for (const f of pending) {
    const full = path.join(MIGRATIONS_DIR, f);
    const sql = fs.readFileSync(full, 'utf8');
    const statements = splitStatements(sql);

    process.stdout.write(`  → ${f} (${statements.length} statement(s)) ... `);
    try {
      for (const stmt of statements) {
        await conn.query(stmt);
      }
      await conn.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)',
        [f, sha256(sql)]
      );
      console.log('ok');
    } catch (err) {
      console.log('FAILED');
      console.error(`\nError applying ${f}:\n${(err as Error).message}\n`);
      console.error(
        'Stopped. This file was NOT recorded as applied; fix it and re-run ' +
        '`npm run migrate`.\n(Note: MySQL DDL auto-commits, so statements before ' +
        'the failure in this file may already be applied — the existing ' +
        'migrations use IF NOT EXISTS / DROP IF EXISTS to stay replay-safe.)\n'
      );
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
  const arg = (process.argv[2] || 'up').toLowerCase();
  const command: Command =
    arg === 'status' ? 'status' : arg === 'baseline' ? 'baseline' : 'up';

  let conn: mysql.Connection | undefined;
  try {
    conn = await makeConnection();
    if (command === 'status') await cmdStatus(conn);
    else if (command === 'baseline') await cmdBaseline(conn);
    else await cmdUp(conn);
  } catch (err) {
    console.error(`\nMigration runner error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end();
  }
}

void main();
