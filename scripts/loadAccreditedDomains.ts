// ============================================================================
// BULK LOADER — accredited_domains
// ============================================================================
// Load the FULL authoritative allowlist (thousands of institutions) into
// accredited_domains, from either:
//
//   * a JSON file in the widely-used "Hipo university-domains-list" format
//     (array of { name, alpha_two_code, country, domains: [...] }), or
//   * a simple text file, one entry per line:  domain,Institution Name
//
// A good free source for the JSON:
//   https://github.com/Hipo/university-domains-list
//   (world_universities_and_domains.json)
//
// Usage:
//   # dry run (counts only, writes nothing) — ALWAYS do this first:
//   npx ts-node scripts/loadAccreditedDomains.ts <file> [countryCode=US]
//   # actually write:
//   npx ts-node scripts/loadAccreditedDomains.ts <file> US --apply
//
// Safety:
//   * Dry run unless --apply is passed.
//   * Upsert only refreshes institution_name; it NEVER flips a domain that you
//     have manually set to status='blocked' back to active.
//   * Skips syntactically implausible domains.
// ============================================================================

import fs from 'fs';
import path from 'path';
import { DB } from '../db';

interface DomainRow {
  domain: string;
  name: string;
  country: string;
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function normalizeDomain(raw: string): string | null {
  const d = (raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d || d.length > 253 || !DOMAIN_RE.test(d)) return null;
  return d;
}

function parseHipoJson(text: string, country: string): DomainRow[] {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('Expected a JSON array (Hipo format).');
  const out: DomainRow[] = [];
  for (const e of arr) {
    if (country && e.alpha_two_code && String(e.alpha_two_code).toUpperCase() !== country) continue;
    const name = String(e.name || '').slice(0, 255);
    for (const dom of e.domains || []) {
      const d = normalizeDomain(dom);
      if (d) out.push({ domain: d, name, country: country || 'US' });
    }
  }
  return out;
}

function parseLines(text: string, country: string): DomainRow[] {
  const out: DomainRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const comma = trimmed.indexOf(',');
    const rawDomain = comma === -1 ? trimmed : trimmed.slice(0, comma);
    const name = comma === -1 ? '' : trimmed.slice(comma + 1).trim().replace(/^"|"$/g, '').slice(0, 255);
    const d = normalizeDomain(rawDomain);
    if (d) out.push({ domain: d, name, country: country || 'US' });
  }
  return out;
}

function dedupe(rows: DomainRow[]): DomainRow[] {
  const seen = new Map<string, DomainRow>();
  for (const r of rows) if (!seen.has(r.domain)) seen.set(r.domain, r);
  return [...seen.values()];
}

async function upsertBatch(rows: DomainRow[]): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "(?, ?, ?, 'active')").join(', ');
    const params: (string)[] = [];
    for (const r of chunk) params.push(r.domain, r.name, r.country);
    // Refresh the display name; leave status untouched so manual 'blocked' rows stay blocked.
    await DB.query(
      `INSERT INTO accredited_domains (domain, institution_name, country, status)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE institution_name = VALUES(institution_name)`,
      params,
    );
    process.stdout.write(`  upserted ${Math.min(i + CHUNK, rows.length)}/${rows.length}\r`);
  }
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  const [, , file, countryArg, ...flags] = process.argv;
  if (!file) {
    console.error('usage: loadAccreditedDomains.ts <file.json|file.txt> [countryCode=US] [--apply]');
    process.exit(2);
  }
  const country = (countryArg && !countryArg.startsWith('--') ? countryArg : 'US').toUpperCase();
  const apply = flags.includes('--apply') || countryArg === '--apply';

  const full = path.resolve(file);
  const text = fs.readFileSync(full, 'utf8');
  const raw = full.toLowerCase().endsWith('.json') ? parseHipoJson(text, country) : parseLines(text, country);
  const rows = dedupe(raw);

  console.log(`Parsed ${raw.length} domain(s), ${rows.length} unique for country=${country}.`);
  console.log('Sample:', rows.slice(0, 5).map((r) => r.domain).join(', '));

  if (!apply) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to load ${rows.length} domains.`);
    process.exit(0);
  }

  console.log(`\nWriting ${rows.length} domains...`);
  await upsertBatch(rows);

  const [c] = await DB.query("SELECT COUNT(*) AS n FROM accredited_domains WHERE status='active'");
  console.log(`Done. accredited_domains active total: ${(c as any[])[0].n}`);
  process.exit(0);
}

main().catch((e) => { console.error('load failed:', e); process.exit(1); });
