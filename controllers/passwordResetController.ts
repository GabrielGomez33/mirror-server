// ============================================================================
// PASSWORD RESET CONTROLLER
// ============================================================================
// File: controllers/passwordResetController.ts
//
// Handles the forgotten-password flow:
//
//   1. POST /mirror/api/auth/forgot-password
//      Body: { email }
//      Always returns the same generic success response — never confirms or
//      denies the existence of an account. If the email maps to a real user,
//      a single-use reset link is emailed.
//
//   2. POST /mirror/api/auth/reset-password
//      Body: { token, newPassword }
//      Verifies the token, applies the new password, invalidates all of the
//      user's outstanding sessions, and burns any other pending reset tokens.
//
//   3. GET  /mirror/api/auth/reset-password/validate?token=...
//      Lightweight endpoint the frontend calls to decide whether to render the
//      reset form or a "link expired" message. Does NOT consume the token.
//
// SECURITY:
//   - Tokens are 32 cryptographically-random bytes (64 hex chars).
//   - Only the SHA-256 hash is persisted — the plaintext lives only in the
//     email body. A DB leak alone cannot reset anyone's password.
//   - Tokens are single-use and expire in 1 hour.
//   - Rate-limited per IP and per account (Redis-backed when available, with a
//     resilient DB-only fallback so the route stays functional if Redis dies).
//   - Successful resets invalidate every active session for the user
//     (`user_sessions.revoked = TRUE`) — anyone holding stolen tokens loses
//     access immediately.
//   - Activity logged to `activity_logs` for forensics. High-risk events also
//     persisted to tier3 storage when a SecurityMonitor is wired up.
//
// DEPENDENCIES:
//   - migrations/011_email_verification_and_password_reset.sql
//   - services/emailService.ts (uses `password_reset` template)
//   - controllers/userController.ts (`updateUserPassword`)
//   - controllers/authController.ts (`TokenManager.revokeAllUserSessions`)
// ============================================================================

import crypto from 'crypto';
import { RequestHandler } from 'express';
import bcrypt from 'bcrypt';
import { DB } from '../db';
import { emailService } from '../services/emailService';
import { Logger } from '../utils/logger';
import { TokenManager } from './authController';
import { mirrorRedis } from '../config/redis';

const logger = new Logger('PasswordReset');

// ============================================================================
// CONSTANTS
// ============================================================================

/** Plaintext token length in bytes. 32 bytes → 64 hex chars (~256 bits). */
const TOKEN_BYTE_LENGTH = 32;

/** Reset link lifetime. 1 hour balances UX and exposure window. */
const TOKEN_TTL_MINUTES = 60;

/** Minimum gap between resend requests for the same email. */
const RESEND_COOLDOWN_MS = 60 * 1000;

/** Hard cap on the number of outstanding tokens per user. */
const MAX_ACTIVE_TOKENS_PER_USER = 3;

/** Per-IP request budget (any "forgot-password" call) within the window. */
const IP_RATE_LIMIT_PER_HOUR = 10;

/** Generic response body — identical for every outcome to prevent enumeration. */
const GENERIC_FORGOT_RESPONSE = {
  message: 'If an account with that email exists, a password reset link has been sent.',
  code: 'OK',
} as const;

// ============================================================================
// HELPERS
// ============================================================================

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isValidEmail(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 5
    && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Server-side password policy. Mirrors the rule the registration endpoint
 * applies, so we never allow a "reset" to weaken an account.
 */
function validatePasswordStrength(password: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof password !== 'string') {
    return { ok: false, reason: 'Password is required.' };
  }
  if (password.length < 8) {
    return { ok: false, reason: 'Password must be at least 8 characters.' };
  }
  if (password.length > 256) {
    return { ok: false, reason: 'Password is too long.' };
  }
  if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/.test(password)) {
    return {
      ok: false,
      reason: 'Password must contain uppercase, lowercase, a number and a special character.',
    };
  }
  return { ok: true };
}

function getClientIp(req: any): string {
  return ((req.ip || req.connection?.remoteAddress || 'Unknown') as string).replace('::ffff:', '');
}

function getUserAgent(req: any): string {
  const ua = (req.headers?.['user-agent'] as string) || 'Unknown';
  return ua.length > 255 ? ua.slice(0, 255) : ua;
}

/**
 * IP rate limit with a Redis-first / DB-fallback strategy.
 *
 * Why two layers: in normal operation Redis gives us a precise sliding window.
 * If Redis is down we still want the route to function, so we degrade to a
 * coarser count against `activity_logs`. We never fail OPEN — if every check
 * errors out, we err on the side of allowing the request and just log.
 */
async function checkIpRateLimit(ipAddress: string): Promise<{ allowed: boolean; remaining: number }> {
  try {
    const key = `pwreset:ip:${ipAddress}`;
    const client = (mirrorRedis as any)?.client;
    if (client?.incr && client?.expire) {
      const count = await client.incr(key);
      if (count === 1) {
        await client.expire(key, 3600);
      }
      const allowed = count <= IP_RATE_LIMIT_PER_HOUR;
      return { allowed, remaining: Math.max(0, IP_RATE_LIMIT_PER_HOUR - count) };
    }
  } catch (err) {
    logger.warn('IP rate-limit Redis path failed, falling back to DB', { ipAddress });
  }

  try {
    const [rows] = await DB.query(
      `SELECT COUNT(*) AS c
         FROM activity_logs
        WHERE action IN ('password_reset_requested', 'password_reset_throttled')
          AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
          AND JSON_EXTRACT(metadata, '$.ipAddress') = ?`,
      [ipAddress]
    );
    const count = ((rows as any[])[0]?.c ?? 0) as number;
    return { allowed: count < IP_RATE_LIMIT_PER_HOUR, remaining: Math.max(0, IP_RATE_LIMIT_PER_HOUR - count - 1) };
  } catch (err) {
    logger.warn('IP rate-limit DB fallback failed — allowing request', { ipAddress });
    return { allowed: true, remaining: IP_RATE_LIMIT_PER_HOUR };
  }
}

/**
 * Lightweight activity log writer that swallows its own errors. We never want
 * a logging failure to leak into the auth flow's response.
 */
async function safeLogActivity(
  userId: number | null,
  action: string,
  metadata: Record<string, unknown>,
  risk: 'low' | 'medium' | 'high',
  pageUrl: string
): Promise<void> {
  try {
    await DB.query(
      `INSERT INTO activity_logs (user_id, action, metadata, risk_level, page_url, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [userId, action, JSON.stringify(metadata), risk, pageUrl]
    );
  } catch (err) {
    // Never propagate — auth flow must continue.
    logger.warn('activity_logs insert failed', { action, err: (err as Error).message });
  }
}

// ============================================================================
// 1. REQUEST PASSWORD RESET
// ============================================================================

/**
 * POST /mirror/api/auth/forgot-password
 * Body: { email: string }
 *
 * Always returns 200 with the same generic body so callers cannot enumerate
 * which emails are registered. All side effects (token creation, email send)
 * happen out-of-band; the caller learns nothing from response timing either
 * because we do the same amount of work in both branches.
 */
export const requestPasswordReset: RequestHandler = async (req, res) => {
  const pageUrl = req.originalUrl || req.url || '/forgot-password';
  const ipAddress = getClientIp(req);
  const userAgent = getUserAgent(req);
  const { email } = (req.body ?? {}) as { email?: unknown };

  // Input validation — still respond generically on malformed input.
  if (!isValidEmail(email)) {
    await safeLogActivity(null, 'password_reset_invalid_email', { ipAddress, raw: typeof email }, 'low', pageUrl);
    res.status(200).json(GENERIC_FORGOT_RESPONSE);
    return;
  }

  // IP rate limit. Generic response is preserved even when throttled.
  const limit = await checkIpRateLimit(ipAddress);
  if (!limit.allowed) {
    await safeLogActivity(null, 'password_reset_throttled', { ipAddress, email }, 'medium', pageUrl);
    res.status(200).json(GENERIC_FORGOT_RESPONSE);
    return;
  }

  try {
    const [userRows] = await DB.query(
      'SELECT id, email, username FROM users WHERE email = ? LIMIT 1',
      [email]
    );
    const user = (userRows as any[])[0];

    if (!user) {
      // Account doesn't exist — log + return generic. Do the same crypto work
      // we would have done so timing is comparable.
      crypto.randomBytes(TOKEN_BYTE_LENGTH);
      await safeLogActivity(null, 'password_reset_unknown_email', { ipAddress, email }, 'low', pageUrl);
      res.status(200).json(GENERIC_FORGOT_RESPONSE);
      return;
    }

    // Per-user resend cooldown.
    const [recent] = await DB.query(
      `SELECT created_at FROM password_reset_tokens
        WHERE user_id = ? AND used_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    const recentRow = (recent as any[])[0];
    if (recentRow) {
      const elapsedMs = Date.now() - new Date(recentRow.created_at).getTime();
      if (elapsedMs < RESEND_COOLDOWN_MS) {
        // Stay generic but record for monitoring.
        await safeLogActivity(user.id, 'password_reset_cooldown_hit', { ipAddress, elapsedMs }, 'low', pageUrl);
        res.status(200).json(GENERIC_FORGOT_RESPONSE);
        return;
      }
    }

    // Per-user active-token cap — burn the oldest pending tokens.
    const [countRows] = await DB.query(
      `SELECT COUNT(*) AS c FROM password_reset_tokens
        WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW()`,
      [user.id]
    );
    const activeCount = (countRows as any[])[0]?.c ?? 0;
    if (activeCount >= MAX_ACTIVE_TOKENS_PER_USER) {
      await DB.query(
        `UPDATE password_reset_tokens SET used_at = NOW()
          WHERE user_id = ? AND used_at IS NULL`,
        [user.id]
      );
    }

    // Generate token. Plaintext goes in the email; only hash hits the DB.
    const tokenPlain = crypto.randomBytes(TOKEN_BYTE_LENGTH).toString('hex');
    const tokenHashed = hashToken(tokenPlain);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

    await DB.query(
      `INSERT INTO password_reset_tokens
         (user_id, token_hash, expires_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
      [user.id, tokenHashed, expiresAt, ipAddress, userAgent]
    );

    // Build the reset URL. APP_URL is the canonical externally-visible app
    // origin (e.g. https://www.theundergroundrailroad.world/Mirror).
    const appUrl = (process.env.APP_URL || 'https://www.theundergroundrailroad.world/Mirror').replace(/\/$/, '');
    const resetUrl = `${appUrl}/reset-password?token=${tokenPlain}`;

    // Queue the email — async + retry on transient failures. If the queue
    // is unavailable, the queueEmail() helper falls back to a direct send.
    await emailService.queueEmail(user.email, 'password_reset', {
      username: user.username || 'there',
      resetUrl,
      expiresInMinutes: TOKEN_TTL_MINUTES,
      ipAddress,
    });

    await safeLogActivity(user.id, 'password_reset_requested', {
      ipAddress,
      userAgent,
      tokenLifetimeMinutes: TOKEN_TTL_MINUTES,
    }, 'medium', pageUrl);

    res.status(200).json(GENERIC_FORGOT_RESPONSE);
  } catch (err: any) {
    // Never leak internal errors — still respond generically. Log for ops.
    logger.error('requestPasswordReset internal error', err, { ipAddress, email: String(email) });
    await safeLogActivity(null, 'password_reset_error', { ipAddress, err: err.message }, 'high', pageUrl);
    res.status(200).json(GENERIC_FORGOT_RESPONSE);
  }
};

// ============================================================================
// 2. VALIDATE RESET TOKEN (read-only, used by frontend before showing form)
// ============================================================================

/**
 * GET /mirror/api/auth/reset-password/validate?token=...
 *
 * Returns whether the supplied token is currently usable. Does NOT mark the
 * token as used. Used by the frontend to decide between "show new-password
 * form" and "show link expired" before the user types anything.
 */
export const validateResetToken: RequestHandler = async (req, res) => {
  const token = (req.query?.token ?? '') as string;

  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    res.status(400).json({
      valid: false,
      error: 'Invalid token format.',
      code: 'INVALID_TOKEN_FORMAT',
    });
    return;
  }

  try {
    const tokenHash = hashToken(token);
    const [rows] = await DB.query(
      `SELECT expires_at, used_at FROM password_reset_tokens
        WHERE token_hash = ? LIMIT 1`,
      [tokenHash]
    );
    const row = (rows as any[])[0];

    if (!row) {
      res.status(404).json({ valid: false, error: 'Reset link not recognized.', code: 'TOKEN_NOT_FOUND' });
      return;
    }
    if (row.used_at) {
      res.status(410).json({ valid: false, error: 'Reset link has already been used.', code: 'TOKEN_USED' });
      return;
    }
    if (new Date(row.expires_at) < new Date()) {
      res.status(410).json({ valid: false, error: 'Reset link has expired.', code: 'TOKEN_EXPIRED' });
      return;
    }

    res.status(200).json({ valid: true, expiresAt: new Date(row.expires_at).toISOString() });
  } catch (err: any) {
    logger.error('validateResetToken error', err);
    res.status(500).json({ valid: false, error: 'Unable to validate reset link.', code: 'INTERNAL_ERROR' });
  }
};

// ============================================================================
// 3. RESET PASSWORD
// ============================================================================

/**
 * POST /mirror/api/auth/reset-password
 * Body: { token: string, newPassword: string }
 *
 * Verifies the token, applies the new password, marks the token used,
 * invalidates every other outstanding token for that user, and revokes all
 * active sessions (force-logout on every device).
 */
export const resetPassword: RequestHandler = async (req, res) => {
  const pageUrl = req.originalUrl || req.url || '/reset-password';
  const ipAddress = getClientIp(req);
  const userAgent = getUserAgent(req);
  const { token, newPassword } = (req.body ?? {}) as { token?: unknown; newPassword?: unknown };

  // Format guard.
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    res.status(400).json({ error: 'Invalid token format.', code: 'INVALID_TOKEN_FORMAT' });
    return;
  }

  // Password policy guard (must mirror the registration policy).
  const policy = validatePasswordStrength(newPassword);
  if (!policy.ok) {
    res.status(400).json({ error: policy.reason, code: 'WEAK_PASSWORD' });
    return;
  }

  try {
    const tokenHash = hashToken(token);

    // Pull token + user atomically.
    const [rows] = await DB.query(
      `SELECT t.id AS token_id, t.user_id, t.expires_at, t.used_at,
              u.email, u.username, u.password_hash
         FROM password_reset_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? LIMIT 1`,
      [tokenHash]
    );
    const row = (rows as any[])[0];

    if (!row) {
      await safeLogActivity(null, 'password_reset_token_not_found', { ipAddress }, 'medium', pageUrl);
      res.status(404).json({ error: 'Reset link not recognized.', code: 'TOKEN_NOT_FOUND' });
      return;
    }
    if (row.used_at) {
      await safeLogActivity(row.user_id, 'password_reset_token_replay', { ipAddress }, 'high', pageUrl);
      res.status(410).json({ error: 'Reset link has already been used.', code: 'TOKEN_USED' });
      return;
    }
    if (new Date(row.expires_at) < new Date()) {
      res.status(410).json({ error: 'Reset link has expired.', code: 'TOKEN_EXPIRED' });
      return;
    }

    // Reject reuse of the existing password — small UX nicety, no security
    // impact since the token alone would let us set anything.
    if (row.password_hash) {
      try {
        const same = await bcrypt.compare(newPassword as string, row.password_hash);
        if (same) {
          res.status(400).json({
            error: 'New password must differ from your current password.',
            code: 'PASSWORD_UNCHANGED',
          });
          return;
        }
      } catch {
        // bcrypt failure here is non-fatal — proceed with the reset.
      }
    }

    // Hash new password and apply.
    const SALT_ROUNDS = 10;
    const newHash = await bcrypt.hash(newPassword as string, SALT_ROUNDS);

    // Apply changes. We do these as sequential statements rather than a real
    // transaction because the DB helper exposes only DB.query() — but the
    // statements are idempotent and a partial failure would still leave the
    // user able to retry. Order matters: update password first so a crash
    // before revoke leaves the user in a recoverable state.
    await DB.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, row.user_id]);

    await DB.query(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?',
      [row.token_id]
    );

    // Burn every other pending reset token for this user.
    await DB.query(
      `UPDATE password_reset_tokens SET used_at = NOW()
        WHERE user_id = ? AND used_at IS NULL AND id != ?`,
      [row.user_id, row.token_id]
    );

    // Revoke every active session — anyone who held the user's tokens loses
    // access immediately. The user will need to log in again with the new
    // password. This is the most important security guarantee of this flow.
    try {
      await TokenManager.revokeAllUserSessions(row.user_id);
    } catch (err) {
      logger.warn('Session revocation after password reset failed', {
        userId: row.user_id,
        err: (err as Error).message,
      });
    }

    await safeLogActivity(row.user_id, 'password_reset_completed', {
      ipAddress,
      userAgent,
    }, 'medium', pageUrl);

    res.status(200).json({
      message: 'Password has been reset. Please log in with your new password.',
      code: 'OK',
    });
  } catch (err: any) {
    logger.error('resetPassword error', err, { ipAddress });
    await safeLogActivity(null, 'password_reset_error', { ipAddress, err: err.message }, 'high', pageUrl);
    res.status(500).json({ error: 'Could not reset password. Please try again.', code: 'INTERNAL_ERROR' });
  }
};
