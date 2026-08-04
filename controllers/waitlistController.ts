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
import { DB } from '../db';
import { Logger } from '../utils/logger';

const logger = new Logger('WaitlistController');

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

      res.status(isNew ? 201 : 200).json({ success: true, alreadySubscribed: !isNew });
    } catch (err) {
      logger.error('Waitlist subscribe failed', err as Error);
      // Never leak internals to the marketing page; the form only needs a
      // non-2xx to show its generic error state.
      res.status(500).json({ success: false, error: 'Could not process your request right now.' });
    }
  }
}

export default new WaitlistController();
