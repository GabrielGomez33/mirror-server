// ============================================================================
// EMAIL BROADCAST SERVICE
// ============================================================================
// File: services/emailBroadcastService.ts
// ----------------------------------------------------------------------------
// The campaign layer on top of the transactional EmailService. Owns:
//   - Structured content blocks -> safe HTML + plain-text rendering.
//   - The branded shell + CAN-SPAM/GDPR-compliant footer (physical address +
//     one-click unsubscribe).
//   - Stateless HMAC unsubscribe tokens.
//   - The suppression list (unsubscribe / bounce / complaint).
//   - Cursor-free, set-based audience resolution into email_campaign_recipients
//     (scales to large user tables; no in-memory user lists).
//   - Idempotent, resumable, rate-limited batch sending driven by the worker.
//
// SECURITY
//   - There is NO arbitrary-HTML block. Every block type renders into a fixed,
//     safe template and ALL operator/user text is HTML-escaped. This removes
//     the stored-XSS surface entirely without needing a sanitiser dependency.
//   - Merge tags ({{username}}, {{email}}) substitute HTML-escaped values.
//   - Unsubscribe tokens are HMAC(email) — a leaked DB cannot forge them, and
//     no token table is needed.
//
// IDEMPOTENCY / SAFETY
//   - Audience is materialised with INSERT IGNORE (UNIQUE(campaign_id,user_id)),
//     so re-resolving is a no-op.
//   - The worker only ever processes rows in `pending`, updating each to
//     sent/failed. A crash mid-run resumes cleanly — no double-sends.
//   - A Redis lock guards per-campaign processing so two worker ticks (or two
//     worker instances) never dispatch the same campaign concurrently.
// ============================================================================

import crypto from 'crypto';
import { Logger } from '../utils/logger';
import { DB } from '../db';
import { mirrorRedis } from '../config/redis';
import { emailService, EmailAttachment } from './emailService';

const logger = new Logger('EmailBroadcast');

// ============================================================================
// TYPES
// ============================================================================

export type ContentBlock =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'button'; text: string; url: string }
  | { type: 'image'; url: string; alt?: string }
  | { type: 'divider' };

export interface AudienceFilter {
  mode: 'all' | 'filter' | 'specific';
  /** Only users with email_verified=1. Defaults to true for deliverability. */
  verifiedOnly?: boolean;
  /** true => intake_completed=1, false => =0, undefined => no constraint. */
  intakeCompleted?: boolean;
  /** Restrict by users.role. */
  role?: string | null;
  /** ISO date — users created strictly before this. */
  registeredBefore?: string;
  /** ISO date — users created on/after this. */
  registeredAfter?: string;
  /** ISO date — users whose last_login >= this. */
  activeSince?: string;
  /** Exclude locked accounts. Defaults to true. */
  excludeLocked?: boolean;
  /** For mode='specific': explicit user ids. */
  userIds?: number[];
}

export interface CampaignInput {
  title: string;
  subject: string;
  templateKey?: string | null;
  blocks: ContentBlock[];
  audience: AudienceFilter;
  scheduledAt?: string | null;
  dryRun?: boolean;
  createdBy?: string;
  attachments?: EmailAttachment[];
}

export interface CampaignRow {
  id: number;
  title: string;
  subject: string;
  template_key: string | null;
  content_json: any;
  html_compiled: string | null;
  text_compiled: string | null;
  attachments_json: any;
  audience_filter: any;
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled';
  scheduled_at: string | null;
  created_by: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  last_error: string | null;
  dry_run: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ============================================================================
// CONFIG
// ============================================================================

const BATCH_SIZE = Math.max(1, parseInt(process.env.EMAIL_BATCH_SIZE || '50', 10));
const SEND_RATE_PER_SEC = Math.max(1, parseInt(process.env.EMAIL_SEND_RATE_PER_SEC || '8', 10));
const MAX_ATTEMPTS = 3;
const MAX_ATTACHMENT_BYTES = parseInt(process.env.EMAIL_MAX_ATTACHMENT_BYTES || '5242880', 10); // 5MB
const LOCK_TTL_SECONDS = 120;

const ALLOWED_BLOCK_TYPES = new Set(['heading', 'paragraph', 'button', 'image', 'divider']);

// ============================================================================
// HELPERS
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** HTML-escape text so operator/user content can never inject markup. */
function escapeHtml(input: string): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Only allow http(s) URLs into href/src to avoid javascript:/data: vectors.
 * Returns '#' for anything that doesn't parse as http/https.
 */
function safeUrl(input: string): string {
  try {
    const u = new URL(String(input));
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.toString();
    }
  } catch { /* fall through */ }
  return '#';
}

function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

// ============================================================================
// VALIDATION
// ============================================================================

export function validateBlocks(blocks: unknown): { ok: true; blocks: ContentBlock[] } | { ok: false; error: string } {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { ok: false, error: 'At least one content block is required' };
  }
  if (blocks.length > 100) {
    return { ok: false, error: 'Too many content blocks (max 100)' };
  }
  for (const b of blocks as any[]) {
    if (!b || typeof b !== 'object' || !ALLOWED_BLOCK_TYPES.has(b.type)) {
      return { ok: false, error: `Invalid block type: ${b?.type}` };
    }
    if ((b.type === 'heading' || b.type === 'paragraph') && typeof b.text !== 'string') {
      return { ok: false, error: `${b.type} block requires text` };
    }
    if (b.type === 'button' && (typeof b.text !== 'string' || typeof b.url !== 'string')) {
      return { ok: false, error: 'button block requires text and url' };
    }
    if (b.type === 'image' && typeof b.url !== 'string') {
      return { ok: false, error: 'image block requires url' };
    }
  }
  return { ok: true, blocks: blocks as ContentBlock[] };
}

export function validateAttachments(attachments?: EmailAttachment[]): { ok: true } | { ok: false; error: string } {
  if (!attachments || attachments.length === 0) return { ok: true };
  if (attachments.length > 5) return { ok: false, error: 'Too many attachments (max 5)' };
  let total = 0;
  for (const a of attachments) {
    if (!a.filename || typeof a.content !== 'string') {
      return { ok: false, error: 'Each attachment needs filename and base64 content' };
    }
    // base64 length -> approx byte size
    total += Math.floor((a.content.length * 3) / 4);
  }
  if (total > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: `Attachments exceed ${(MAX_ATTACHMENT_BYTES / 1048576).toFixed(1)}MB limit` };
  }
  return { ok: true };
}

// ============================================================================
// RENDERING
// ============================================================================

function renderBlockHtml(block: ContentBlock): string {
  switch (block.type) {
    case 'heading':
      return `<h2 style="color:#fff;margin:0 0 16px;font-size:22px;">${escapeHtml(block.text)}</h2>`;
    case 'paragraph':
      // Preserve author line breaks, escape everything else.
      return `<p style="color:#ccc;line-height:1.6;margin:0 0 16px;">${escapeHtml(block.text).replace(/\n/g, '<br/>')}</p>`;
    case 'button':
      return `<div style="text-align:center;margin:32px 0;">
        <a href="${safeUrl(block.url)}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;">${escapeHtml(block.text)}</a>
      </div>`;
    case 'image':
      return `<div style="text-align:center;margin:16px 0;">
        <img src="${safeUrl(block.url)}" alt="${escapeHtml(block.alt || '')}" style="max-width:100%;border-radius:8px;" />
      </div>`;
    case 'divider':
      return `<hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:24px 0;" />`;
    default:
      return '';
  }
}

function renderBlockText(block: ContentBlock): string {
  switch (block.type) {
    case 'heading':
      return `\n${block.text}\n${'='.repeat(Math.min(block.text.length, 40))}\n`;
    case 'paragraph':
      return `${block.text}\n`;
    case 'button':
      return `${block.text}: ${block.url}\n`;
    case 'image':
      return block.alt ? `[image: ${block.alt}]\n` : '';
    case 'divider':
      return `\n----------------------------------------\n`;
    default:
      return '';
  }
}

/**
 * Compile blocks into the branded shell. The result contains literal
 * {{username}} / {{email}} / {{unsubscribe_url}} placeholders, substituted
 * (HTML-escaped) per recipient at send time. The shell text is fixed and safe.
 */
export function compile(subject: string, blocks: ContentBlock[]): { html: string; text: string } {
  const inner = blocks.map(renderBlockHtml).join('\n');
  const year = new Date().getFullYear();
  const address = process.env.EMAIL_PHYSICAL_ADDRESS || 'The Underground Railroad';

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#0a0a0f;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(subject)}</div>
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;background:#0a0a0f;color:#e0e0e0;">
    <div style="text-align:center;margin-bottom:32px;">
      <h1 style="color:#ffffff;font-size:28px;margin:0;">Mirror</h1>
    </div>
    <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:32px;">
      ${inner}
    </div>
    <div style="color:#666;font-size:12px;text-align:center;margin-top:32px;line-height:1.6;">
      <p style="margin:0 0 8px;">You're receiving this because you have a Mirror account.</p>
      <p style="margin:0 0 8px;">${escapeHtml(address)}</p>
      <p style="margin:0;"><a href="{{unsubscribe_url}}" style="color:#888;text-decoration:underline;">Unsubscribe</a> &middot; Mirror &copy; ${year}</p>
    </div>
  </div>
</body>
</html>`;

  const innerText = blocks.map(renderBlockText).join('\n');
  const text = `${innerText}\n\n--\nYou're receiving this because you have a Mirror account.\n${address}\nUnsubscribe: {{unsubscribe_url}}\nMirror © ${year}`;

  return { html, text };
}

/** Substitute per-recipient merge tags (escaped) into a compiled string. */
function personalize(template: string, ctx: { username: string; email: string; unsubscribeUrl: string }): string {
  return template
    .replace(/\{\{\s*username\s*\}\}/g, escapeHtml(ctx.username))
    .replace(/\{\{\s*email\s*\}\}/g, escapeHtml(ctx.email))
    // unsubscribe_url is our own generated safe URL — inserted raw into href.
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/g, ctx.unsubscribeUrl);
}

/** Plain-text variant: same tags, no HTML escaping. */
function personalizeText(template: string, ctx: { username: string; email: string; unsubscribeUrl: string }): string {
  return template
    .replace(/\{\{\s*username\s*\}\}/g, ctx.username)
    .replace(/\{\{\s*email\s*\}\}/g, ctx.email)
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/g, ctx.unsubscribeUrl);
}

// ============================================================================
// UNSUBSCRIBE (stateless HMAC)
// ============================================================================

function unsubscribeSecret(): string {
  return process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.MIRROR_INTERNAL_SECRET || '';
}

export function unsubscribeToken(email: string): string {
  return crypto.createHmac('sha256', unsubscribeSecret())
    .update(normalizeEmail(email))
    .digest('hex')
    .slice(0, 32);
}

export function verifyUnsubscribe(email: string, token: string): boolean {
  if (!unsubscribeSecret()) return false;
  const expected = unsubscribeToken(email);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function unsubscribeUrl(email: string): string {
  const base = process.env.EMAIL_PUBLIC_BASE_URL || 'https://www.theundergroundrailroad.world';
  const e = encodeURIComponent(normalizeEmail(email));
  const t = unsubscribeToken(email);
  return `${base}/mirror/api/email/unsubscribe?e=${e}&t=${t}`;
}

// ============================================================================
// SUPPRESSION LIST
// ============================================================================

export async function isSuppressed(email: string): Promise<boolean> {
  const [rows] = await DB.query('SELECT 1 FROM email_suppressions WHERE email = ? LIMIT 1', [normalizeEmail(email)]);
  return (rows as any[]).length > 0;
}

export async function addSuppression(
  email: string,
  reason: 'unsubscribe' | 'bounce' | 'complaint' | 'manual',
  userId?: number | null,
  detail?: string,
): Promise<void> {
  await DB.query(
    `INSERT INTO email_suppressions (email, reason, user_id, detail)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE reason = VALUES(reason), detail = VALUES(detail)`,
    [normalizeEmail(email), reason, userId ?? null, detail ?? null],
  );
  logger.info('Address suppressed', { email: normalizeEmail(email), reason });
}

export async function removeSuppression(email: string): Promise<void> {
  await DB.query('DELETE FROM email_suppressions WHERE email = ?', [normalizeEmail(email)]);
}

// ============================================================================
// AUDIENCE QUERY BUILDER
// ============================================================================
// Returns a parameterised WHERE fragment + params operating on alias `u`.

function buildAudienceWhere(filter: AudienceFilter): { where: string; params: any[] } {
  const clauses: string[] = ["u.email IS NOT NULL", "u.email <> ''"];
  const params: any[] = [];

  if (filter.mode === 'specific') {
    const ids = Array.isArray(filter.userIds) ? filter.userIds.filter(n => Number.isInteger(n)) : [];
    if (ids.length === 0) {
      // No valid ids -> match nothing.
      clauses.push('1 = 0');
    } else {
      clauses.push('u.id IN (?)');
      params.push(ids);
    }
    // For explicit selection we still honour verified/locked guards below.
  }

  // verifiedOnly defaults to true.
  if (filter.verifiedOnly !== false) {
    clauses.push('u.email_verified = 1');
  }

  // excludeLocked defaults to true.
  if (filter.excludeLocked !== false) {
    clauses.push("(u.account_locked = 0 OR u.account_locked IS NULL)");
  }

  if (typeof filter.intakeCompleted === 'boolean') {
    clauses.push('u.intake_completed = ?');
    params.push(filter.intakeCompleted ? 1 : 0);
  }

  if (filter.role) {
    clauses.push('u.role = ?');
    params.push(String(filter.role));
  }

  if (filter.registeredBefore) {
    clauses.push('u.created_at < ?');
    params.push(filter.registeredBefore);
  }
  if (filter.registeredAfter) {
    clauses.push('u.created_at >= ?');
    params.push(filter.registeredAfter);
  }
  if (filter.activeSince) {
    clauses.push('u.last_login >= ?');
    params.push(filter.activeSince);
  }

  return { where: clauses.join(' AND '), params };
}

export async function previewAudience(filter: AudienceFilter): Promise<{ total: number; suppressed: number; sample: { username: string; email: string }[] }> {
  const { where, params } = buildAudienceWhere(filter);

  const [countRows] = await DB.query(`SELECT COUNT(*) AS n FROM users u WHERE ${where}`, params);
  const total = (countRows as any[])[0]?.n ?? 0;

  const [supRows] = await DB.query(
    `SELECT COUNT(*) AS n FROM users u JOIN email_suppressions s ON s.email = LOWER(u.email) WHERE ${where}`,
    params,
  );
  const suppressed = (supRows as any[])[0]?.n ?? 0;

  const [sampleRows] = await DB.query(
    `SELECT username, email FROM users u WHERE ${where} ORDER BY u.id DESC LIMIT 5`,
    params,
  );
  const sample = (sampleRows as any[]).map(r => ({ username: r.username, email: r.email }));

  return { total, suppressed, sample };
}

// ============================================================================
// CAMPAIGN CRUD
// ============================================================================

export async function createCampaign(input: CampaignInput): Promise<number> {
  const blockCheck = validateBlocks(input.blocks);
  if (!blockCheck.ok) throw new Error(blockCheck.error);
  const attCheck = validateAttachments(input.attachments);
  if (!attCheck.ok) throw new Error(attCheck.error);
  if (!input.subject || input.subject.trim().length === 0) throw new Error('Subject is required');
  if (!input.title || input.title.trim().length === 0) throw new Error('Title is required');

  const isScheduled = !!input.scheduledAt;
  const status = isScheduled ? 'scheduled' : 'draft';

  const [result] = await DB.query(
    `INSERT INTO email_campaigns
       (title, subject, template_key, content_json, attachments_json, audience_filter, status, scheduled_at, created_by, dry_run)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.title.trim(),
      input.subject.trim(),
      input.templateKey ?? null,
      JSON.stringify(input.blocks),
      input.attachments && input.attachments.length ? JSON.stringify(input.attachments) : null,
      JSON.stringify(input.audience),
      status,
      isScheduled ? new Date(input.scheduledAt as string) : null,
      input.createdBy || 'admin',
      input.dryRun ? 1 : 0,
    ],
  );
  const id = (result as any).insertId as number;

  // Scheduled campaigns materialise their audience immediately so the count is
  // stable and the worker can fire without re-resolving.
  if (isScheduled) {
    await materializeAudience(id);
  }

  logger.info('Campaign created', { id, status, scheduled: isScheduled });
  return id;
}

export async function getCampaign(id: number): Promise<CampaignRow | null> {
  const [rows] = await DB.query('SELECT * FROM email_campaigns WHERE id = ?', [id]);
  const row = (rows as any[])[0];
  if (!row) return null;
  if (typeof row.content_json === 'string') { try { row.content_json = JSON.parse(row.content_json); } catch { /* keep */ } }
  if (typeof row.audience_filter === 'string') { try { row.audience_filter = JSON.parse(row.audience_filter); } catch { /* keep */ } }
  if (typeof row.attachments_json === 'string') { try { row.attachments_json = JSON.parse(row.attachments_json); } catch { /* keep */ } }
  return row as CampaignRow;
}

export async function listCampaigns(limit = 50): Promise<CampaignRow[]> {
  const capped = Math.min(Math.max(limit, 1), 200);
  const [rows] = await DB.query(
    `SELECT id, title, subject, status, scheduled_at, created_by, total_recipients,
            sent_count, failed_count, skipped_count, dry_run, created_at, started_at, completed_at, last_error
     FROM email_campaigns ORDER BY id DESC LIMIT ?`,
    [capped],
  );
  return rows as CampaignRow[];
}

export async function cancelCampaign(id: number): Promise<boolean> {
  // Only draft/scheduled campaigns can be cancelled (never mid-send).
  const [result] = await DB.query(
    `UPDATE email_campaigns SET status = 'cancelled'
     WHERE id = ? AND status IN ('draft','scheduled')`,
    [id],
  );
  return (result as any).affectedRows > 0;
}

// ============================================================================
// AUDIENCE MATERIALISATION
// ============================================================================

async function materializeAudience(campaignId: number): Promise<void> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error('Campaign not found');
  const filter: AudienceFilter = campaign.audience_filter;
  const { where, params } = buildAudienceWhere(filter);

  // One set-based insert — never loads users into app memory.
  await DB.query(
    `INSERT IGNORE INTO email_campaign_recipients (campaign_id, user_id, email, status)
     SELECT ?, u.id, LOWER(u.email), 'pending' FROM users u WHERE ${where}`,
    [campaignId, ...params],
  );

  // Flag suppressed addresses so they're visible (and never sent).
  await DB.query(
    `UPDATE email_campaign_recipients r
       JOIN email_suppressions s ON s.email = r.email
        SET r.status = 'suppressed'
      WHERE r.campaign_id = ? AND r.status = 'pending'`,
    [campaignId],
  );

  await refreshCounters(campaignId);
}

async function refreshCounters(campaignId: number): Promise<void> {
  const [rows] = await DB.query(
    `SELECT
       COUNT(*) AS total,
       SUM(status = 'sent') AS sent,
       SUM(status = 'failed') AS failed,
       SUM(status IN ('skipped','suppressed')) AS skipped
     FROM email_campaign_recipients WHERE campaign_id = ?`,
    [campaignId],
  );
  const r = (rows as any[])[0] || {};
  await DB.query(
    `UPDATE email_campaigns
        SET total_recipients = ?, sent_count = ?, failed_count = ?, skipped_count = ?
      WHERE id = ?`,
    [Number(r.total || 0), Number(r.sent || 0), Number(r.failed || 0), Number(r.skipped || 0), campaignId],
  );
}

// ============================================================================
// SEND TEST
// ============================================================================

export async function sendTest(input: CampaignInput, toEmail: string): Promise<{ success: boolean; error?: string }> {
  const blockCheck = validateBlocks(input.blocks);
  if (!blockCheck.ok) return { success: false, error: blockCheck.error };

  const { html, text } = compile(input.subject, blockCheck.blocks);
  const to = normalizeEmail(toEmail);
  const unsubUrl = unsubscribeUrl(to);
  const ctx = { username: 'there', email: to, unsubscribeUrl: unsubUrl };

  const result = await emailService.sendCustom(
    {
      to,
      subject: `[TEST] ${input.subject}`,
      html: personalize(html, ctx),
      text: personalizeText(text, ctx),
      replyTo: process.env.EMAIL_REPLY_TO,
      headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      tags: ['broadcast', 'test'],
      attachments: input.attachments,
    },
    { dryRun: input.dryRun },
  );

  return { success: result.success, error: result.error };
}

// ============================================================================
// START + PROCESS (worker-driven)
// ============================================================================

/**
 * Transition a draft/scheduled campaign into `sending`, snapshot the compiled
 * HTML/text, and materialise its audience. Atomic status guard prevents two
 * callers from starting the same campaign twice.
 */
export async function startCampaign(id: number): Promise<{ started: boolean; reason?: string }> {
  const campaign = await getCampaign(id);
  if (!campaign) return { started: false, reason: 'not_found' };
  if (!['draft', 'scheduled'].includes(campaign.status)) {
    return { started: false, reason: `status_${campaign.status}` };
  }

  if (!emailService.isEnabled() && !campaign.dry_run) {
    await DB.query(`UPDATE email_campaigns SET status='failed', last_error=? WHERE id=?`,
      ['Email provider not configured', id]);
    return { started: false, reason: 'provider_disabled' };
  }

  const blocks: ContentBlock[] = campaign.content_json;
  const { html, text } = compile(campaign.subject, blocks);

  // Atomic guard: only the caller that flips draft/scheduled -> sending wins.
  const [result] = await DB.query(
    `UPDATE email_campaigns
        SET status='sending', html_compiled=?, text_compiled=?, started_at=NOW()
      WHERE id=? AND status IN ('draft','scheduled')`,
    [html, text, id],
  );
  if ((result as any).affectedRows === 0) {
    return { started: false, reason: 'already_started' };
  }

  // Ensure audience exists (no-op if already materialised for a scheduled one).
  await materializeAudience(id);

  logger.info('Campaign started', { id, dryRun: !!campaign.dry_run });
  return { started: true };
}

/** Acquire a short-lived per-campaign Redis lock. */
async function acquireLock(campaignId: number): Promise<boolean> {
  try {
    const client = (mirrorRedis as any).client;
    if (!client?.set) return true; // No redis -> single-worker assumption.
    const res = await client.set(`email:campaign:lock:${campaignId}`, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    return res === 'OK';
  } catch {
    return true;
  }
}

async function releaseLock(campaignId: number): Promise<void> {
  try {
    const client = (mirrorRedis as any).client;
    if (client?.del) await client.del(`email:campaign:lock:${campaignId}`);
  } catch { /* lock will expire on its own */ }
}

/**
 * Process one batch of pending recipients for a campaign. Returns the number
 * still pending afterwards (0 == done). Rate-limited to SEND_RATE_PER_SEC.
 */
export async function processCampaignBatch(campaignId: number): Promise<{ pendingRemaining: number; processed: number }> {
  const campaign = await getCampaign(campaignId);
  if (!campaign || campaign.status !== 'sending') {
    return { pendingRemaining: 0, processed: 0 };
  }

  const locked = await acquireLock(campaignId);
  if (!locked) return { pendingRemaining: 1, processed: 0 }; // another worker has it

  let processed = 0;
  try {
    const [rows] = await DB.query(
      `SELECT r.id, r.user_id, r.email, u.username
         FROM email_campaign_recipients r
         LEFT JOIN users u ON u.id = r.user_id
        WHERE r.campaign_id = ? AND r.status = 'pending'
        ORDER BY r.id LIMIT ?`,
      [campaignId, BATCH_SIZE],
    );
    const batch = rows as { id: number; user_id: number | null; email: string; username: string | null }[];

    const html = campaign.html_compiled || '';
    const text = campaign.text_compiled || '';
    const dryRun = !!campaign.dry_run;
    const attachments: EmailAttachment[] | undefined =
      Array.isArray(campaign.attachments_json) && campaign.attachments_json.length
        ? campaign.attachments_json
        : undefined;
    const delayMs = Math.floor(1000 / SEND_RATE_PER_SEC);

    for (const rec of batch) {
      const email = normalizeEmail(rec.email);

      // Defensive re-check: suppression may have arrived after materialisation.
      if (await isSuppressed(email)) {
        await DB.query(`UPDATE email_campaign_recipients SET status='suppressed' WHERE id=?`, [rec.id]);
        continue;
      }

      const unsubUrl = unsubscribeUrl(email);
      const username = rec.username || email.split('@')[0] || 'there';
      const ctx = { username, email, unsubscribeUrl: unsubUrl };

      const subject = personalizeText(campaign.subject, ctx);

      const result = await emailService.sendCustom(
        {
          to: email,
          subject,
          html: personalize(html, ctx),
          text: personalizeText(text, ctx),
          replyTo: process.env.EMAIL_REPLY_TO,
          headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
          tags: ['broadcast', `campaign:${campaignId}`],
          attachments,
        },
        { dryRun },
      );

      if (result.success) {
        await DB.query(
          `UPDATE email_campaign_recipients
              SET status='sent', message_id=?, attempts=attempts+1, sent_at=NOW(), error=NULL
            WHERE id=?`,
          [result.messageId || null, rec.id],
        );
      } else {
        // Increment attempts; mark failed only after MAX_ATTEMPTS.
        await DB.query(
          `UPDATE email_campaign_recipients
              SET status = IF(attempts + 1 >= ?, 'failed', 'pending'),
                  attempts = attempts + 1,
                  error = ?
            WHERE id=?`,
          [MAX_ATTEMPTS, (result.error || 'send failed').slice(0, 1000), rec.id],
        );
      }

      processed++;
      if (delayMs > 0) await sleep(delayMs);
    }

    await refreshCounters(campaignId);

    // Are there still pending rows whose attempts haven't maxed out?
    const [pendRows] = await DB.query(
      `SELECT COUNT(*) AS n FROM email_campaign_recipients
        WHERE campaign_id = ? AND status = 'pending' AND attempts < ?`,
      [campaignId, MAX_ATTEMPTS],
    );
    const pendingRemaining = Number((pendRows as any[])[0]?.n || 0);

    if (pendingRemaining === 0) {
      await DB.query(
        `UPDATE email_campaigns SET status='sent', completed_at=NOW() WHERE id=? AND status='sending'`,
        [campaignId],
      );
      logger.info('Campaign completed', { campaignId });
    }

    return { pendingRemaining, processed };
  } finally {
    await releaseLock(campaignId);
  }
}

/**
 * Worker entrypoint: promote any due scheduled campaigns, then process a batch
 * for every campaign currently in `sending`.
 */
export async function tick(): Promise<{ started: number; processed: number }> {
  let started = 0;
  let processed = 0;

  // 1. Promote due scheduled campaigns.
  const [dueRows] = await DB.query(
    `SELECT id FROM email_campaigns
      WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
      ORDER BY scheduled_at ASC LIMIT 10`,
  );
  for (const row of dueRows as { id: number }[]) {
    const r = await startCampaign(row.id);
    if (r.started) started++;
  }

  // 2. Process in-flight campaigns.
  const [sendingRows] = await DB.query(
    `SELECT id FROM email_campaigns WHERE status='sending' ORDER BY started_at ASC LIMIT 5`,
  );
  for (const row of sendingRows as { id: number }[]) {
    const r = await processCampaignBatch(row.id);
    processed += r.processed;
  }

  return { started, processed };
}