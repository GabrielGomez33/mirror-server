// ============================================================================
// USER FEEDBACK CONTROLLER
// ============================================================================
// File: controllers/feedbackController.ts
// ----------------------------------------------------------------------------
// Business logic for the user-facing feedback / support page:
//   POST /mirror/api/feedback                — create a new submission
//   GET  /mirror/api/feedback/mine           — current user's submissions
//   GET  /mirror/api/feedback/stats          — aggregate rating stats (public-ish)
//   GET  /mirror/api/feedback/limits         — current user's rate-limit budget
//
// SECURITY NOTES
//   * All endpoints sit behind verifyToken — there is no anonymous path here.
//   * Input is bounded BEFORE it touches the DB (truncation + enum guards).
//   * Per-user 10-minute sliding-window rate limit (in-memory; mirrors the
//     other controllers' pattern). We do NOT use Redis here — the limit is
//     deliberately advisory and process-local. The DB index on
//     (ip_truncated, created_at) gives us a forensic backstop.
//   * The IP is truncated to /24 (IPv4) / /48 (IPv6) before we store it, so
//     we get coarse abuse-triage signal without retaining a precise locator.
// ============================================================================

import { Request, Response } from 'express';
import { DB } from '../db';
import { Logger } from '../utils/logger';
import { feedbackNotifier, FeedbackKind, FeedbackSummary } from '../services/feedbackNotifier';

const logger = new Logger('FeedbackController');

// ============================================================================
// CONFIG
// ============================================================================

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX       = Math.max(1, parseInt(process.env.FEEDBACK_RATE_LIMIT || '10', 10));

const MAX_SUBJECT_LEN = 200;
const MAX_MESSAGE_LEN = 5000;
const MAX_EMAIL_LEN   = 254;
const MAX_METADATA_BYTES = 4096;

const ALLOWED_KINDS:    ReadonlyArray<FeedbackKind> = ['rating', 'issue', 'recommendation', 'contact'];
const ALLOWED_SEVERITY: ReadonlyArray<NonNullable<FeedbackSummary['severity']>> = ['low', 'medium', 'high', 'critical'];

// ============================================================================
// TYPES
// ============================================================================

interface AuthenticatedRequest extends Request {
  user?: { id: number; email: string; username: string; sessionId: string };
}

// ============================================================================
// IN-MEMORY RATE LIMIT (sliding window — process-local)
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

function consumeRateBudget(userId: number): { allowed: boolean; remaining: number; resetMs: number } {
  const key = `feedback:${userId}`;
  const now = Date.now();
  const w = rateLimitWindows.get(key);

  if (!w || now - w.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitWindows.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetMs: RATE_LIMIT_WINDOW_MS };
  }

  if (w.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, resetMs: RATE_LIMIT_WINDOW_MS - (now - w.windowStart) };
  }

  w.count += 1;
  return { allowed: true, remaining: RATE_LIMIT_MAX - w.count, resetMs: RATE_LIMIT_WINDOW_MS - (now - w.windowStart) };
}

function peekRateBudget(userId: number): { remaining: number; resetMs: number } {
  const key = `feedback:${userId}`;
  const now = Date.now();
  const w = rateLimitWindows.get(key);
  if (!w || now - w.windowStart > RATE_LIMIT_WINDOW_MS) {
    return { remaining: RATE_LIMIT_MAX, resetMs: 0 };
  }
  return { remaining: Math.max(0, RATE_LIMIT_MAX - w.count), resetMs: RATE_LIMIT_WINDOW_MS - (now - w.windowStart) };
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

function isValidKind(value: unknown): value is FeedbackKind {
  return typeof value === 'string' && (ALLOWED_KINDS as readonly string[]).includes(value);
}

function isValidSeverity(value: unknown): value is FeedbackSummary['severity'] {
  return value == null || (typeof value === 'string' && (ALLOWED_SEVERITY as readonly string[]).includes(value));
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normaliseEmail(value: unknown): string | null {
  const s = clipString(value, MAX_EMAIL_LEN);
  if (!s) return null;
  const lower = s.toLowerCase();
  return EMAIL_RX.test(lower) ? lower : null;
}

function truncateIp(rawIp: string | undefined): string | null {
  if (!rawIp) return null;
  // Express may return "::ffff:1.2.3.4" — normalise.
  let ip = rawIp.trim();
  const v4mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4mapped) ip = v4mapped[1];

  if (ip.includes('.')) {
    // IPv4 → /24
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  } else if (ip.includes(':')) {
    // IPv6 → keep first 3 groups (~/48)
    const parts = ip.split(':');
    return `${parts.slice(0, 3).join(':')}::`;
  }
  return null;
}

function clipMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const serialised = JSON.stringify(value);
    if (serialised.length > MAX_METADATA_BYTES) {
      // Drop the metadata rather than silently truncating to malformed JSON.
      return { _note: 'metadata_too_large', size_bytes: serialised.length };
    }
    // Cheap sanitiser: re-parse to strip prototypes / non-JSON.
    return JSON.parse(serialised);
  } catch {
    return null;
  }
}

function safeJsonParse<T = unknown>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

// ============================================================================
// CONTROLLER
// ============================================================================

export class FeedbackController {

  // --------------------------------------------------------------------------
  // POST /mirror/api/feedback
  // --------------------------------------------------------------------------
  static async create(req: AuthenticatedRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
    }

    // 1) Rate-limit per user
    const budget = consumeRateBudget(userId);
    if (!budget.allowed) {
      return res.status(429).json({
        success: false,
        error: 'Too many submissions — please wait a moment and try again.',
        code: 'RATE_LIMITED',
        retryAfterSec: Math.ceil(budget.resetMs / 1000),
      });
    }

    try {
      // 2) Parse + validate body
      const body = (req.body || {}) as Record<string, unknown>;

      if (!isValidKind(body.kind)) {
        return res.status(400).json({ success: false, error: 'Invalid feedback kind', code: 'INVALID_KIND' });
      }
      const kind = body.kind;

      // rating: 1..5, otherwise null
      let rating: number | null = null;
      if (kind === 'rating') {
        const raw = Number(body.rating);
        if (!Number.isFinite(raw) || raw < 1 || raw > 5) {
          return res.status(400).json({ success: false, error: 'Rating must be an integer between 1 and 5', code: 'INVALID_RATING' });
        }
        rating = Math.round(raw);
      }

      const subject = clipString(body.subject, MAX_SUBJECT_LEN);
      const message = clipString(body.message, MAX_MESSAGE_LEN);

      // Per-kind required-field gating.
      if (kind === 'issue' || kind === 'recommendation' || kind === 'contact') {
        if (!subject) {
          return res.status(400).json({ success: false, error: 'A subject is required', code: 'MISSING_SUBJECT' });
        }
        if (!message) {
          return res.status(400).json({ success: false, error: 'A description is required', code: 'MISSING_MESSAGE' });
        }
      }
      if (kind === 'rating' && !rating) {
        return res.status(400).json({ success: false, error: 'A rating is required', code: 'MISSING_RATING' });
      }

      // Severity is only meaningful for issues; coerce off for everything else.
      let severity: FeedbackSummary['severity'] = null;
      if (kind === 'issue') {
        if (!isValidSeverity(body.severity)) {
          return res.status(400).json({ success: false, error: 'Invalid severity', code: 'INVALID_SEVERITY' });
        }
        severity = (body.severity as FeedbackSummary['severity']) || 'medium';
      }

      const submittedEmail = normaliseEmail(body.contactEmail);

      // Pull the user's on-file email/username so the row carries enough
      // context for the support inbox to reply without a second DB hit.
      const [userRows] = await DB.query(
        'SELECT id, username, email FROM users WHERE id = ? LIMIT 1',
        [userId],
      );
      const userRow: any = (userRows as any[])[0];
      if (!userRow) {
        return res.status(401).json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' });
      }
      const onFileEmail = String(userRow.email || '').toLowerCase() || null;
      const contactEmail = submittedEmail || onFileEmail;

      const metadata = clipMetadata(body.metadata);
      const ipTrunc = truncateIp(
        (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
        req.ip ||
        req.socket?.remoteAddress ||
        undefined,
      );

      // 3) Persist
      const [insertResult]: any = await DB.query(
        `INSERT INTO user_feedback
           (user_id, kind, rating, subject, message, contact_email, severity, metadata, ip_truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          kind,
          rating,
          subject,
          message,
          contactEmail,
          severity,
          metadata ? JSON.stringify(metadata) : null,
          ipTrunc,
        ],
      );

      const feedbackId = Number(insertResult?.insertId || 0);
      if (!feedbackId) {
        logger.error('Feedback insert returned no id', new Error('NO_INSERT_ID'), { userId });
        return res.status(500).json({ success: false, error: 'Could not save feedback', code: 'PERSIST_ERROR' });
      }

      // 4) Fire-and-forget email notifications — never blocks the response.
      const summary: FeedbackSummary = {
        id: feedbackId,
        userId,
        username: userRow.username || null,
        userEmail: onFileEmail,
        kind,
        rating,
        subject,
        message,
        contactEmail,
        severity,
        metadata,
        createdAt: new Date().toISOString(),
      };
      Promise.resolve().then(() => feedbackNotifier.notify(summary))
        .catch((err) => logger.warn('feedbackNotifier.notify rejected', err));

      logger.info('Feedback submitted', { feedbackId, userId, kind, rating, severity });

      return res.status(201).json({
        success: true,
        data: {
          id: feedbackId,
          kind,
          rating,
          createdAt: summary.createdAt,
          message: 'Thanks — your feedback was received.',
        },
        rateLimit: { remaining: budget.remaining, resetSec: Math.ceil(budget.resetMs / 1000) },
      });
    } catch (err: any) {
      logger.error('Failed to create feedback', err, { userId });
      return res.status(500).json({ success: false, error: 'Could not save feedback', code: 'INTERNAL_ERROR' });
    }
  }

  // --------------------------------------------------------------------------
  // GET /mirror/api/feedback/mine
  // --------------------------------------------------------------------------
  static async listMine(req: AuthenticatedRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
    }

    const limit  = Math.min(Math.max(parseInt(String(req.query.limit  || '20'), 10) || 20, 1), 50);
    const offset = Math.max(parseInt(String(req.query.offset || '0'),  10) || 0, 0);

    const kindFilter = isValidKind(req.query.kind) ? req.query.kind : null;

    try {
      const params: any[] = [userId];
      let where = 'user_id = ?';
      if (kindFilter) { where += ' AND kind = ?'; params.push(kindFilter); }

      const [rows] = await DB.query(
        `SELECT id, kind, rating, subject, message, contact_email, severity, status,
                metadata, created_at, updated_at
           FROM user_feedback
          WHERE ${where}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      );

      const items = (rows as any[]).map((r) => ({
        id: r.id,
        kind: r.kind,
        rating: r.rating,
        subject: r.subject,
        message: r.message,
        contactEmail: r.contact_email,
        severity: r.severity,
        status: r.status,
        metadata: safeJsonParse(r.metadata, null),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));

      const [countRows] = await DB.query(
        `SELECT COUNT(*) AS total FROM user_feedback WHERE ${where}`,
        params,
      );
      const total = Number((countRows as any[])[0]?.total || 0);

      return res.status(200).json({
        success: true,
        data: { items, total, limit, offset },
      });
    } catch (err: any) {
      logger.error('Failed to list user feedback', err, { userId });
      return res.status(500).json({ success: false, error: 'Could not load feedback', code: 'INTERNAL_ERROR' });
    }
  }

  // --------------------------------------------------------------------------
  // GET /mirror/api/feedback/stats
  // --------------------------------------------------------------------------
  static async ratingStats(req: AuthenticatedRequest, res: Response): Promise<Response> {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
    }

    try {
      const [rows] = await DB.query(
        `SELECT rating, COUNT(*) AS count
           FROM user_feedback
          WHERE kind = 'rating' AND rating IS NOT NULL
          GROUP BY rating`,
      );

      const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      let total = 0;
      let weighted = 0;
      for (const row of rows as any[]) {
        const r = Number(row.rating);
        const c = Number(row.count);
        if (r >= 1 && r <= 5 && Number.isFinite(c)) {
          distribution[r as 1 | 2 | 3 | 4 | 5] = c;
          total += c;
          weighted += r * c;
        }
      }

      const average = total > 0 ? Number((weighted / total).toFixed(2)) : 0;

      return res.status(200).json({
        success: true,
        data: { total, average, distribution },
      });
    } catch (err: any) {
      logger.error('Failed to load rating stats', err);
      return res.status(500).json({ success: false, error: 'Could not load stats', code: 'INTERNAL_ERROR' });
    }
  }

  // --------------------------------------------------------------------------
  // GET /mirror/api/feedback/limits
  // --------------------------------------------------------------------------
  static async limits(req: AuthenticatedRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
    }
    const { remaining, resetMs } = peekRateBudget(userId);
    return res.status(200).json({
      success: true,
      data: {
        max: RATE_LIMIT_MAX,
        remaining,
        resetSec: Math.ceil(resetMs / 1000),
        windowSec: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
      },
    });
  }
}

export default FeedbackController;