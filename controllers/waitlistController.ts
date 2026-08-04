// ============================================================================
// WAITLIST CONTROLLER
// ============================================================================
// File: controllers/waitlistController.ts
// ----------------------------------------------------------------------------
// Business logic for the public marketing landing page's email capture:
//   POST /mirror/api/waitlist   — capture a prospect email (anonymous)
//
// SECURITY NOTES
//   * This endpoint is intentionally UNAUTHENTICATED — the caller is an
//     anonymous visitor on the marketing site, not a logged-in user. It is
//     mounted BEFORE any auth/subscription gate in index.ts, exactly like the
//     public email (unsubscribe/webhook) routes.
//   * CORS is already restricted to the two production origins in index.ts, so
//     the browser will only let our own landing page post here.
//   * Input is bounded BEFORE it touches the DB (email regex + length clamps).
//   * Per-IP 10-minute sliding-window rate limit (in-memory, process-local),
//     mirroring feedbackController. Deliberately advisory — the DB index on
//     (ip_truncated, created_at) is the forensic backstop.
//   * The IP is truncated to /24 (IPv4) / /48 (IPv6) before storage, so we get
//     coarse abuse-triage signal without retaining a precise locator.
//   * The upsert (INSERT ... ON DUPLICATE KEY UPDATE) makes a repeat submit
//     idempotent: never a duplicate row, never a 500 the visitor can see.
// ============================================================================

import { Request, Response } from 'express';
import crypto from 'crypto';
import { DB } from '../db';
import { Logger } from '../utils/logger';
import { emailService } from '../services/emailService';

const logger = new Logger('WaitlistController');

// ============================================================================
// DOUBLE OPT-IN (confirmation) — stateless HMAC token, no token table
// ----------------------------------------------------------------------------
// Gmail's sender guidelines recommend confirming each recipient's address. On a
// NEW signup we email a confirmation link; clicking it moves the row
// pending -> confirmed. The token is HMAC(email) so a leaked DB can't forge it
// and no token storage is needed (same pattern as the unsubscribe token).
// ============================================================================

function confirmSecret(): string {
  return process.env.WAITLIST_CONFIRM_SECRET || process.env.MIRROR_INTERNAL_SECRET || '';
}

export function confirmToken(email: string): string {
  return crypto.createHmac('sha256', confirmSecret())
    .update(String(email).trim().toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

export function verifyConfirmToken(email: string, token: string): boolean {
  if (!confirmSecret()) return false;
  const expected = confirmToken(email);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function confirmUrl(email: string): string {
  const base = process.env.EMAIL_PUBLIC_BASE_URL || 'https://www.theundergroundrailroad.world';
  const e = encodeURIComponent(String(email).trim().toLowerCase());
  const t = confirmToken(email);
  return `${base}/mirror/api/waitlist/confirm?e=${e}&t=${t}`;
}

function htmlEscape(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A small confirmation-result page (mirrors the public unsubscribe page style). */
function resultPage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>${htmlEscape(title)}</title></head>
<body style="margin:0;background:#0a0a0f;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:80px auto;padding:40px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:12px;text-align:center;">
    <h1 style="color:#fff;font-size:24px;margin:0 0 16px;">Mirror</h1>
    <h2 style="color:#fff;font-size:18px;margin:0 0 12px;">${htmlEscape(title)}</h2>
    <p style="color:#ccc;line-height:1.6;">${htmlEscape(message)}</p>
  </div>
</body></html>`;
}

/**
 * Best-effort confirmation email. Never throws — signup must succeed even if the
 * provider is down or unconfigured.
 */
async function sendConfirmationEmail(email: string): Promise<void> {
  if (!emailService.isEnabled()) return;
  const url = confirmUrl(email);
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#0a0a0f;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a0f;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e0e0e0;">
        <tr><td align="center" style="text-align:center;padding-bottom:24px;"><h1 style="color:#fff;font-size:28px;margin:0;">Mirror</h1></td></tr>
        <tr><td style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:32px;text-align:center;">
          <p style="color:#ccc;line-height:1.6;margin:0 0 20px;">You're on the Mirror waitlist. Confirm your email to lock in your spot and be first to know when we open.</p>
          <a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;">Confirm my spot</a>
          <p style="color:#666;font-size:12px;margin:24px 0 0;">If you didn't sign up, you can ignore this email — you won't hear from us again.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const text = `You're on the Mirror waitlist. Confirm your email to lock in your spot:\n\n${url}\n\nIf you didn't sign up, ignore this email.`;
  try {
    await emailService.sendCustom({
      to: String(email).trim().toLowerCase(),
      from: process.env.EMAIL_CAMPAIGN_FROM || undefined,
      subject: 'Confirm your spot on the Mirror waitlist',
      html,
      text,
      tags: ['waitlist', 'confirm'],
    });
  } catch (err) {
    logger.warn('Waitlist confirmation email failed (non-fatal)', { error: (err as Error).message });
  }
}

// ============================================================================
// CONFIG
// ============================================================================

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX       = Math.max(1, parseInt(process.env.WAITLIST_RATE_LIMIT || '15', 10));

const MAX_EMAIL_LEN    = 254;
const MAX_SOURCE_LEN   = 100;
const MAX_REFERRER_LEN = 500;
const MAX_UA_LEN       = 500;

// ============================================================================
// IN-MEMORY RATE LIMIT (sliding window — process-local, keyed by IP)
// ============================================================================

interface RateWindow { count: number; windowStart: number }
const rateLimitWindows = new Map<string, RateWindow>();

// Periodic GC — keeps the map bounded under runaway abuse.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, w] of rateLimitWindows) {
    if (w.windowStart < cutoff) rateLimitWindows.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS).unref?.();

function consumeRateBudget(key: string): { allowed: boolean } {
  const now = Date.now();
  const w = rateLimitWindows.get(key);

  if (!w || now - w.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitWindows.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }
  if (w.count >= RATE_LIMIT_MAX) {
    return { allowed: false };
  }
  w.count += 1;
  return { allowed: true };
}

// ============================================================================
// INPUT HELPERS
// ============================================================================

function clipString(value: unknown, max: number): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normaliseEmail(value: unknown): string | null {
  const s = clipString(value, MAX_EMAIL_LEN);
  if (!s) return null;
  const lower = s.toLowerCase();
  return EMAIL_RX.test(lower) ? lower : null;
}

// A conservative slug for `source` — the form sends 'landing', but keep it
// bounded and free of anything surprising if a future page posts here.
function normaliseSource(value: unknown): string {
  const s = clipString(value, MAX_SOURCE_LEN);
  if (!s) return 'landing';
  const cleaned = s.toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, MAX_SOURCE_LEN);
  return cleaned || 'landing';
}

function truncateIp(rawIp: string | undefined): string | null {
  if (!rawIp) return null;
  // Express may return "::ffff:1.2.3.4" — normalise the v4-mapped form.
  let ip = rawIp.trim();
  const v4mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4mapped) ip = v4mapped[1];

  if (ip.includes('.')) {
    // IPv4 -> keep the first three octets (/24).
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
    return null;
  }
  if (ip.includes(':')) {
    // IPv6 -> keep the first three hextets (/48).
    const parts = ip.split(':');
    return `${parts.slice(0, 3).join(':')}::`;
  }
  return null;
}

// ============================================================================
// CONTROLLER
// ============================================================================

class WaitlistController {
  // --------------------------------------------------------------------------
  // POST /mirror/api/waitlist
  // Body: { email: string, source?: string, metadata?: object }
  // Always returns a small JSON body. Success is 200/201; a repeat email is
  // still success (idempotent). Invalid email is a 400 the form surfaces.
  // --------------------------------------------------------------------------
  public async subscribe(req: Request, res: Response): Promise<void> {
    try {
      const email = normaliseEmail(req.body?.email);
      if (!email) {
        res.status(400).json({ success: false, error: 'A valid email address is required.' });
        return;
      }

      const ipTruncated = truncateIp(req.ip || req.socket?.remoteAddress);

      // Rate-limit by truncated IP (falls back to a shared bucket if the IP is
      // somehow absent — still bounded, just coarser).
      const rl = consumeRateBudget(`waitlist:${ipTruncated || 'unknown'}`);
      if (!rl.allowed) {
        res.status(429).json({ success: false, error: 'Too many requests. Please try again shortly.' });
        return;
      }

      const source   = normaliseSource(req.body?.source);
      const referrer = clipString(req.body?.referrer ?? req.get('referer'), MAX_REFERRER_LEN);
      const ua       = clipString(req.get('user-agent'), MAX_UA_LEN);

      // Only accept a plain-object metadata envelope, and cap its serialized
      // size so a hostile client can't bloat the row.
      let metadataJson: string | null = null;
      const rawMeta = req.body?.metadata;
      if (rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)) {
        try {
          const serialized = JSON.stringify(rawMeta);
          if (serialized && serialized.length <= 4096) metadataJson = serialized;
        } catch {
          metadataJson = null;
        }
      }

      // Idempotent upsert. On a repeat email we refresh the attribution fields
      // but never resurrect an unsubscribed prospect back into 'pending'.
      const [result]: any = await DB.query(
        `INSERT INTO waitlist_signups
           (email, source, referrer, user_agent, ip_truncated, metadata)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           source       = VALUES(source),
           referrer     = COALESCE(VALUES(referrer), referrer),
           user_agent   = COALESCE(VALUES(user_agent), user_agent),
           ip_truncated = COALESCE(VALUES(ip_truncated), ip_truncated),
           metadata     = COALESCE(VALUES(metadata), metadata),
           updated_at   = CURRENT_TIMESTAMP`,
        [email, source, referrer, ua, ipTruncated, metadataJson]
      );

      // mysql2 affectedRows: 1 = inserted, 2 = updated existing (duplicate).
      const isNew = result?.affectedRows === 1;
      logger.info('Waitlist signup', { source, isNew });

      // Double opt-in: on a brand-new signup, email a confirmation link.
      // Fire-and-forget + self-catching, so it never blocks or fails the
      // response, and a repeat submit (isNew=false) never re-emails.
      if (isNew) void sendConfirmationEmail(email);

      res.status(isNew ? 201 : 200).json({ success: true, alreadySubscribed: !isNew });
    } catch (err) {
      logger.error('Waitlist subscribe failed', err as Error);
      // Never leak internals to the marketing page; the form only needs a
      // non-2xx to show its generic error state.
      res.status(500).json({ success: false, error: 'Could not process your request right now.' });
    }
  }

  // --------------------------------------------------------------------------
  // GET/POST /mirror/api/waitlist/confirm?e=<email>&t=<token>
  // Double opt-in confirmation. Moves a 'pending' signup to 'confirmed'.
  // Unauthenticated by design (a recipient clicking a link has no session),
  // protected by the stateless HMAC token.
  // --------------------------------------------------------------------------
  public async confirm(req: Request, res: Response): Promise<void> {
    const email = String((req.query.e ?? req.body?.e) || '').trim().toLowerCase();
    const token = String((req.query.t ?? req.body?.t) || '').trim();
    const isPost = req.method === 'POST';

    if (!email || !token || !verifyConfirmToken(email, token)) {
      if (isPost) { res.status(400).json({ success: false, error: 'Invalid confirmation link' }); return; }
      res.status(400).send(resultPage('Invalid link', 'This confirmation link is invalid or has expired.'));
      return;
    }

    try {
      // Only pending -> confirmed. 'unsubscribed' / 'converted' are left as-is,
      // and a non-existent email simply changes nothing (no enumeration leak).
      const [result]: any = await DB.query(
        `UPDATE waitlist_signups SET status='confirmed', updated_at=CURRENT_TIMESTAMP
          WHERE email = ? AND status = 'pending'`,
        [email],
      );
      const changed = (result?.affectedRows ?? 0) > 0;
      logger.info('Waitlist confirm', { changed });

      if (isPost) { res.status(200).json({ success: true, confirmed: true }); return; }
      res.status(200).send(resultPage(
        "You're confirmed",
        changed
          ? "Your spot on the Mirror waitlist is confirmed. We'll be in touch when we open."
          : "You're all set — your spot was already confirmed.",
      ));
    } catch (err) {
      logger.error('Waitlist confirm failed', err as Error);
      if (isPost) { res.status(500).json({ success: false }); return; }
      res.status(500).send(resultPage('Something went wrong', 'We could not confirm your spot right now. Please try again later.'));
    }
  }
}

export default new WaitlistController();
