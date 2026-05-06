// ============================================================================
// WEB PUSH SERVICE
// ============================================================================
// File: services/pushService.ts
// Description: Thin wrapper around the `web-push` library. Handles VAPID
//              setup, fan-out to a user's devices, soft-pruning of expired
//              subscriptions (404/410), Retry-After respect on 429s, and
//              per-user device caps.
//
// USAGE
//   await pushService.send(userId, {
//     title: 'New review on your TruthStream',
//     body: 'Someone left you feedback.',
//     url: '/Mirror/truthstream/received',
//     tag: 'truthstream-review',
//   });
//
// HOW IT WORKS
//   - send() pulls every active subscription for the user, encrypts the
//     payload per RFC 8291 (web-push does the crypto), and POSTs it to
//     the push service endpoint (FCM/APNs/Mozilla).
//   - Push services respond with:
//       201 Created — accepted, will deliver when the device next checks in
//       410 Gone    — subscription revoked; soft-delete via expired_at
//       404         — same; soft-delete
//       413         — payload too big; we guard before sending
//       429         — rate limited; honor Retry-After if present
//       4xx/5xx     — log into last_error / failure_count; don't propagate
//   - Fan-out failures don't propagate. Push is best-effort — the in-app
//     notification system is the source of truth.
//
// LIMITS (configurable via env)
//   MAX_PUSH_SUBSCRIPTIONS_PER_USER  default 10
//   MAX_PUSH_PAYLOAD_BYTES           default 3000 (web-push encrypted limit
//                                    is ~4096; raw payload + crypto overhead
//                                    must stay under that)
//
// ENV REQUIRED FOR ACTUAL DELIVERY
//   VAPID_PUBLIC_KEY   — base64url P-256 public key
//   VAPID_PRIVATE_KEY  — base64url P-256 private key
//   VAPID_SUBJECT      — mailto: or https:// URL for push-service contact
// ============================================================================

import webpush, { PushSubscription as WebPushSubscription, SendResult } from 'web-push';
import crypto from 'crypto';
import { DB } from '../db';
import { Logger } from '../utils/logger';

const logger = new Logger('PushService');

// ============================================================================
// CONFIG
// ============================================================================

const MAX_SUBS_PER_USER = parseInt(
  process.env.MAX_PUSH_SUBSCRIPTIONS_PER_USER || '10',
  10,
);
const MAX_PAYLOAD_BYTES = parseInt(
  process.env.MAX_PUSH_PAYLOAD_BYTES || '3000',
  10,
);

// Push send TTL (seconds). Push services discard undelivered messages after
// this. 24h is the reasonable upper bound for "you should know about this"
// notifications. Set per-call if needed.
const DEFAULT_TTL_SECONDS = 60 * 60 * 24;

// ============================================================================
// PAYLOAD SHAPE
// ============================================================================

/**
 * Payload sent to the service worker's `push` event listener.
 * Keep it small — push services cap at ~4 KB total (encrypted).
 *
 * `tag` lets the SW collapse duplicates: e.g. five replies in a noisy group
 * chat with the same tag will overwrite each other instead of stacking.
 */
export interface PushPayload {
  title: string;
  body: string;
  /** Absolute or root-relative URL the SW navigates to on click. */
  url?: string;
  /** Notification tag for de-duplication on the device. */
  tag?: string;
  /** Notification icon (defaults to /Mirror/pwa-192x192.png in the SW). */
  icon?: string;
  /** Notification badge icon (small, monochrome). */
  badge?: string;
  /** Free-form data passed to the SW for deep-link routing. */
  data?: Record<string, unknown>;
  /** OS app-icon badge count to set after delivery. 0 clears the badge. */
  unreadCount?: number;
  /** Don't auto-dismiss the notification — user must interact (good for invites). */
  requireInteraction?: boolean;
  /** Silent delivery — no sound/vibration (rarely useful; OS may override). */
  silent?: boolean;
  /** Re-alert on tag-replace instead of silently swapping. */
  renotify?: boolean;
}

// ============================================================================
// VAPID INITIALIZATION
// ============================================================================

let initialized = false;
let initFailedLogged = false;

function init(): boolean {
  if (initialized) return true;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;

  if (!publicKey || !privateKey || !subject) {
    if (!initFailedLogged) {
      logger.warn('VAPID env vars missing — push disabled', {
        hasPublic: !!publicKey,
        hasPrivate: !!privateKey,
        hasSubject: !!subject,
      });
      initFailedLogged = true;
    }
    return false;
  }

  if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
    logger.error('VAPID_SUBJECT must start with mailto: or https://');
    return false;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    initialized = true;
    logger.info('Web push initialized', {
      maxSubsPerUser: MAX_SUBS_PER_USER,
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
    });
    return true;
  } catch (err) {
    logger.error('Failed to initialize web-push', err as Error);
    return false;
  }
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

// ============================================================================
// DB ROW SHAPE
// ============================================================================

interface SubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth_secret: string;
  retry_after: Date | null;
}

// ============================================================================
// HELPERS
// ============================================================================

function endpointHash(endpoint: string): string {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

function rowToWebPushSubscription(row: SubscriptionRow): WebPushSubscription {
  return {
    endpoint: row.endpoint,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth_secret,
    },
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Parse a push-service error's Retry-After. Push services send either an
 * integer (seconds) or an HTTP-date. Returns a Date in the future, or null
 * if the header is missing/unparseable. Capped at 7 days to bound damage
 * from misbehaving services.
 */
function parseRetryAfter(err: unknown): Date | null {
  if (!err || typeof err !== 'object') return null;
  const headers = (err as { headers?: Record<string, string> }).headers;
  if (!headers) return null;
  const raw = headers['retry-after'] || headers['Retry-After'];
  if (!raw) return null;

  const seconds = parseInt(raw, 10);
  if (!Number.isNaN(seconds) && seconds > 0) {
    const capped = Math.min(seconds, 60 * 60 * 24 * 7);
    return new Date(Date.now() + capped * 1000);
  }

  const asDate = new Date(raw);
  if (!Number.isNaN(asDate.getTime()) && asDate.getTime() > Date.now()) {
    const cap = Date.now() + 1000 * 60 * 60 * 24 * 7;
    return new Date(Math.min(asDate.getTime(), cap));
  }

  return null;
}

async function markExpired(subscriptionId: number, reason: string): Promise<void> {
  try {
    await DB.execute(
      `UPDATE push_subscriptions
       SET expired_at = CURRENT_TIMESTAMP,
           last_error = ?
       WHERE id = ? AND expired_at IS NULL`,
      [truncate(reason, 500), subscriptionId],
    );
  } catch (err) {
    logger.error('Failed to mark subscription expired', err as Error, { subscriptionId });
  }
}

async function recordFailure(
  subscriptionId: number,
  message: string,
  retryAfter: Date | null,
): Promise<void> {
  try {
    await DB.execute(
      `UPDATE push_subscriptions
       SET failure_count = failure_count + 1,
           last_error = ?,
           retry_after = ?
       WHERE id = ?`,
      [truncate(message, 500), retryAfter, subscriptionId],
    );
  } catch (err) {
    logger.error('Failed to record push failure', err as Error, { subscriptionId });
  }
}

async function recordSuccess(subscriptionId: number): Promise<void> {
  try {
    await DB.execute(
      `UPDATE push_subscriptions
       SET last_success_at = CURRENT_TIMESTAMP,
           failure_count = 0,
           last_error = NULL,
           retry_after = NULL
       WHERE id = ?`,
      [subscriptionId],
    );
  } catch {
    // Bookkeeping failures shouldn't break delivery reporting.
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export class PushDeviceLimitError extends Error {
  readonly code = 'DEVICE_LIMIT_REACHED';
  readonly limit: number;
  constructor(limit: number) {
    super(`Maximum of ${limit} subscribed devices reached`);
    this.limit = limit;
  }
}

export class PushPayloadTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE';
  readonly limit: number;
  readonly size: number;
  constructor(size: number, limit: number) {
    super(`Push payload ${size}B exceeds ${limit}B limit`);
    this.size = size;
    this.limit = limit;
  }
}

export const pushService = {
  /**
   * Persist a new (or update an existing) push subscription for a user.
   * Idempotent: re-subscribing the same device updates the keys.
   *
   * Enforces MAX_PUSH_SUBSCRIPTIONS_PER_USER. Existing endpoints (i.e. the
   * same device re-subscribing) don't count against the cap — the upsert
   * just refreshes the row.
   */
  async upsert(
    userId: number,
    sub: WebPushSubscription,
    userAgent: string | null,
    ip: string | null,
  ): Promise<void> {
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      throw new Error('Invalid subscription shape');
    }

    const hash = endpointHash(sub.endpoint);

    // Check the device cap, but ONLY if this endpoint is new for the user.
    // A re-subscribe (same hash) just updates in place.
    const [existingRows] = await DB.execute(
      `SELECT id FROM push_subscriptions
       WHERE user_id = ? AND endpoint_hash = ? LIMIT 1`,
      [userId, hash],
    );
    const isNew = (existingRows as unknown[]).length === 0;

    if (isNew) {
      const [countRows] = await DB.execute(
        `SELECT COUNT(*) AS active
         FROM push_subscriptions
         WHERE user_id = ? AND expired_at IS NULL`,
        [userId],
      );
      const active = ((countRows as Array<{ active: number }>)[0]?.active) ?? 0;
      if (active >= MAX_SUBS_PER_USER) {
        throw new PushDeviceLimitError(MAX_SUBS_PER_USER);
      }
    }

    await DB.execute(
      `INSERT INTO push_subscriptions
         (user_id, endpoint, endpoint_hash, p256dh, auth_secret, user_agent, created_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         p256dh = VALUES(p256dh),
         auth_secret = VALUES(auth_secret),
         user_agent = VALUES(user_agent),
         expired_at = NULL,
         last_error = NULL,
         failure_count = 0,
         retry_after = NULL`,
      [
        userId,
        sub.endpoint,
        hash,
        sub.keys.p256dh,
        sub.keys.auth,
        userAgent ? truncate(userAgent, 500) : null,
        ip ? truncate(ip, 45) : null,
      ],
    );
  },

  /**
   * Remove a single subscription for a user. Used when the client toggles
   * notifications off, before it calls PushSubscription.unsubscribe().
   */
  async remove(userId: number, endpoint: string): Promise<void> {
    const hash = endpointHash(endpoint);
    await DB.execute(
      `DELETE FROM push_subscriptions
       WHERE user_id = ? AND endpoint_hash = ?`,
      [userId, hash],
    );
  },

  /**
   * Count active devices for a user (useful for UI: "Notifications enabled
   * on 3 devices").
   */
  async countActive(userId: number): Promise<number> {
    const [rows] = await DB.execute(
      `SELECT COUNT(*) AS n FROM push_subscriptions
       WHERE user_id = ? AND expired_at IS NULL`,
      [userId],
    );
    return ((rows as Array<{ n: number }>)[0]?.n) ?? 0;
  },

  /**
   * Send a push to every active device for a user. Best-effort: failures
   * are logged but never thrown to the caller. Returns counts for metrics.
   *
   * Throws PushPayloadTooLargeError if the serialized payload exceeds
   * MAX_PUSH_PAYLOAD_BYTES — the caller is expected to shorten body/title
   * before retrying.
   */
  async send(
    userId: number,
    payload: PushPayload,
  ): Promise<{ sent: number; failed: number; expired: number; skipped: number }> {
    if (!init()) return { sent: 0, failed: 0, expired: 0, skipped: 0 };

    const body = JSON.stringify(payload);
    const size = Buffer.byteLength(body, 'utf8');
    if (size > MAX_PAYLOAD_BYTES) {
      throw new PushPayloadTooLargeError(size, MAX_PAYLOAD_BYTES);
    }

    const [rows] = await DB.execute(
      `SELECT id, endpoint, p256dh, auth_secret, retry_after
       FROM push_subscriptions
       WHERE user_id = ? AND expired_at IS NULL`,
      [userId],
    );
    const subscriptions = rows as SubscriptionRow[];

    if (subscriptions.length === 0) {
      return { sent: 0, failed: 0, expired: 0, skipped: 0 };
    }

    const now = Date.now();
    const eligible: SubscriptionRow[] = [];
    let skipped = 0;
    for (const row of subscriptions) {
      if (row.retry_after && row.retry_after.getTime() > now) {
        skipped++;
        continue;
      }
      eligible.push(row);
    }

    if (eligible.length === 0) {
      return { sent: 0, failed: 0, expired: 0, skipped };
    }

    let sent = 0;
    let failed = 0;
    let expired = 0;

    const results = await Promise.allSettled(
      eligible.map((row) =>
        webpush
          .sendNotification(rowToWebPushSubscription(row), body, {
            TTL: DEFAULT_TTL_SECONDS,
          })
          .then<{ row: SubscriptionRow; result: SendResult }>((result) => ({ row, result })),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const row = eligible[i];

      if (r.status === 'fulfilled') {
        sent++;
        await recordSuccess(row.id);
        continue;
      }

      const err = r.reason as { statusCode?: number; body?: string; message?: string };
      const statusCode = err?.statusCode;

      if (statusCode === 404 || statusCode === 410) {
        expired++;
        await markExpired(row.id, `gone:${statusCode}`);
        continue;
      }

      failed++;
      const retryAfter = parseRetryAfter(r.reason);
      const message = err?.message || `status:${statusCode ?? 'unknown'}`;
      await recordFailure(row.id, message, retryAfter);

      logger.warn('Push send failed', {
        userId,
        subscriptionId: row.id,
        statusCode,
        retryAfter: retryAfter?.toISOString() ?? null,
        message,
      });
    }

    return { sent, failed, expired, skipped };
  },

  /**
   * Periodic cleanup: hard-delete subscriptions that have been expired for
   * more than `olderThanDays` days. Safe to call from a cron / interval.
   */
  async pruneExpired(olderThanDays = 30): Promise<number> {
    const [result] = await DB.execute(
      `DELETE FROM push_subscriptions
       WHERE expired_at IS NOT NULL
         AND expired_at < (NOW() - INTERVAL ? DAY)`,
      [olderThanDays],
    );
    const affected = (result as { affectedRows?: number }).affectedRows ?? 0;
    if (affected > 0) {
      logger.info(`Pruned ${affected} expired push subscriptions`);
    }
    return affected;
  },
};
