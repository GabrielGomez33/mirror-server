// controllers/authController.ts
//
// CHANGES vs previous version (Phase 2b — mobile registration hardening):
//   - registerUser() now trims username/email, normalises iOS smart quotes
//     and smart dashes in the password, and uses a unified password policy
//     that accepts ANY non-alphanumeric character as a "special character"
//     (previous policy only accepted `[@$!%*?&]`, which rejected iOS
//     Suggested Strong Password output and any common keyboard symbol
//     mobile users reach for first like `.`, `,`, `-`). The character set
//     is now consistent with the client-side validation, eliminating the
//     "client says Strong → server rejects WEAK_PASSWORD" mismatch that
//     was blocking mobile registrations.
//   - The same broader password policy now applies to changePassword and
//     the email-flow validators below, so credential rotations and resets
//     stay consistent with sign-up.
//   - Returned error payloads from /register now include a `field` hint
//     (`username` | `email` | `password`) so the client can highlight
//     exactly which input the user must fix.
//   - All edits below are additive or surgical. Token issuance, session
//     storage, the Dina-side purge pipeline, security monitoring, refresh,
//     logout, logout-all-devices and verifyToken are unchanged.
//
// CHANGES vs previous version (Phase 2a — account deletion):
//   - Added deleteAccount() handler. Authenticated via JWT (user identity
//     comes from req.user, never from the body). Requires the user's
//     current password as a second factor and a literal "DELETE" string in
//     the body to defeat accidental triggering. After local cleanup, it
//     best-effort notifies the Dina mirror module so Dina-side analyses,
//     contexts, embeddings, notifications etc. are purged too. Local
//     deletion is the source of truth — a Dina-side failure is logged but
//     does not roll back the local delete.
//
// CHANGES vs Phase 0.3:
//   1. registerUser() now best-effort fires a verification email immediately
//      after a successful insert. Non-blocking: if the email queue/provider is
//      down, registration still succeeds and the user can hit "Resend" later.
//   2. loginUser() now returns `emailVerified` in the user payload, so the
//      frontend can render the verification banner without a separate call.
//   3. verifyToken() now returns `emailVerified` and `subscriptionStatus`
//      alongside `intakeCompleted`, so AuthContext can hydrate the full user
//      object on page refresh.
//   4. Email-verification gating at login is OPT-IN via env
//      `LOGIN_REQUIRE_EMAIL_VERIFIED=true`. Default is OFF — we let unverified
//      users in and gate sensitive features client/middleware-side.
//   5. Light hardening: tightened types around req.body, made activity_logs
//      writes non-fatal.
//
// PRESERVED: token issuance, session storage, security monitoring, refresh,
// logout, logout-all-devices, verifyToken — all original behaviour intact.

import { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { createUserInDB, userLogin, fetchUserInfo, deleteUserFromDB } from './userController';
import { writeToTier } from './directoryController';
import { DB } from '../db';
import { emailService } from '../services/emailService';
import { Logger } from '../utils/logger';

const authLogger = new Logger('AuthController');

// ============================================================================
// TIMING-EQUALISATION DUMMY HASH
// ============================================================================
//
// loginUser previously short-circuited with a single ~5ms DB-miss when the
// supplied email didn't exist, but spent ~100ms on bcrypt.compare when it
// did. An attacker measuring the round-trip can use that delta to enumerate
// which addresses have accounts (a known oracle in OWASP's authentication
// cheat sheet).
//
// We precompute one bcrypt hash at the same cost factor the column uses and
// always run a bcrypt.compare against it in the user-not-found failure
// path, so both branches take the same wall-clock time. The hash itself is
// derived from a random module-load secret — never used as a real password,
// never persisted.
const DUMMY_HASH_PROMISE: Promise<string> = bcrypt.hash(
  crypto.randomBytes(32).toString('hex'),
  10
);
DUMMY_HASH_PROMISE.catch((err) => {
  // Surface but don't crash — bcrypt.hash failing at module load would
  // mean the deploy is broken in deeper ways. The timing defence simply
  // wouldn't engage in that case.
  authLogger.warn('Dummy bcrypt hash init failed (timing defence disabled)', { err: (err as Error).message });
});

// ============================================================================
// INPUT NORMALISATION
// ============================================================================
//
// Mobile keyboards (especially iOS) silently substitute "smart" Unicode
// characters as the user types: ASCII `'` becomes `’`, `"` becomes `“ ”`,
// `-` becomes `–` or `—`, `...` becomes `…`. bcrypt cares about the exact
// byte sequence — a password the user types as `Ab1!cd-ef` on iOS gets
// hashed differently than the same string typed on desktop, and the next
// login fails. We normalise these out on every write/check path before
// the value reaches bcrypt or the regex.
//
// Username/email are trimmed of all whitespace (a single trailing space
// that iOS autocorrect adds to an email like "you@gmail.com " is a
// silent registration killer otherwise).

const SMART_QUOTE_SINGLE_RE = /[‘’‚‛]/g;
const SMART_QUOTE_DOUBLE_RE = /[“”„‟]/g;
const SMART_DASH_RE         = /[–—―−]/g;
const HORIZONTAL_ELLIPSIS_RE = /…/g;

function normalisePassword(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(SMART_QUOTE_SINGLE_RE, "'")
    .replace(SMART_QUOTE_DOUBLE_RE, '"')
    .replace(SMART_DASH_RE, '-')
    .replace(HORIZONTAL_ELLIPSIS_RE, '...');
}

function normaliseUsername(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Strip ALL internal whitespace — usernames have never been allowed to
  // contain spaces and iOS's auto-period-after-double-space can sneak one
  // in just before the field loses focus.
  return raw.replace(/\s+/g, '').slice(0, 64);
}

function normaliseEmail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Trim, drop interior whitespace (autocorrect dust), bound the length.
  // We do NOT lower-case here — the SQL collation handles case-insensitivity
  // and preserving the case the user picked feels more honest.
  return raw.trim().replace(/\s+/g, '').slice(0, 254);
}

// ============================================================================
// PASSWORD POLICY (single source of truth — used by register + changePassword)
// ============================================================================
//
// Rules:
//   - 8–128 chars (upper bound stops pathological inputs reaching bcrypt)
//   - At least one lowercase, uppercase, digit, AND non-alphanumeric.
//
// We deliberately accept ANY non-alphanumeric, non-whitespace byte as the
// "special character". The previous narrow set `[@$!%*?&]` rejected:
//   - iOS Suggested Strong Password (which uses hyphens),
//   - mobile users hitting `,` or `.` on the main keyboard,
//   - everyday users picking `_`, `#`, `^`, `(`, etc.
// The client validation in client/src/components/intake/RegistrationStep.tsx
// uses the same rule — keep these two in sync.

const REGISTRATION_PASSWORD_MIN = 8;
const REGISTRATION_PASSWORD_MAX = 128;

function passwordMeetsPolicy(pw: string): boolean {
  if (typeof pw !== 'string') return false;
  if (pw.length < REGISTRATION_PASSWORD_MIN) return false;
  if (pw.length > REGISTRATION_PASSWORD_MAX) return false;
  if (!/[a-z]/.test(pw)) return false;
  if (!/[A-Z]/.test(pw)) return false;
  if (!/\d/.test(pw)) return false;
  if (!/[^A-Za-z0-9\s]/.test(pw)) return false;
  return true;
}

// RFC-5322-lite email regex. Good enough to reject obvious garbage without
// false negatives on real addresses; verification clicks are the
// authoritative check. Hoisted here (instead of next to changeEmail) so
// registerUser can use it without relying on const-hoisting subtleties.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// JWT Payload interface
interface JWTPayload {
  id: number;
  email: string;
  username: string;
  sessionId: string;
  iat?: number;
  exp?: number;
}

// Token management utilities
class TokenManager {
  private static readonly JWT_SECRET = process.env.JWT_SECRET!;
  private static readonly JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!;
  private static readonly ACCESS_TOKEN_EXPIRY = '15m';
  private static readonly REFRESH_TOKEN_EXPIRY = '7d';

  static generateSessionId(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  static createAccessToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
    return jwt.sign(payload, this.JWT_SECRET, {
      expiresIn: this.ACCESS_TOKEN_EXPIRY,
      algorithm: 'HS256'
    });
  }

  static createRefreshToken(payload: { id: number; sessionId: string }): string {
    return jwt.sign(payload, this.JWT_REFRESH_SECRET, {
      expiresIn: this.REFRESH_TOKEN_EXPIRY,
      algorithm: 'HS256'
    });
  }

  static verifyAccessToken(token: string): JWTPayload {
    try {
      return jwt.verify(token, this.JWT_SECRET) as JWTPayload;
    } catch (error) {
      throw new Error('Invalid or expired access token');
    }
  }

  static verifyRefreshToken(token: string): { id: number; sessionId: string } {
    try {
      return jwt.verify(token, this.JWT_REFRESH_SECRET) as { id: number; sessionId: string };
    } catch (error) {
      throw new Error('Invalid or expired refresh token');
    }
  }

  static async createSession(userId: number, sessionId: string, metadata: {
    userAgent?: string;
    ipAddress?: string;
    fingerprint?: string;
  }): Promise<void> {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await DB.query(`
      INSERT INTO user_sessions (
        user_id, session_id, user_agent, ip_address,
        device_fingerprint, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [
      userId,
      sessionId,
      metadata.userAgent?.substring(0, 255) || null,
      metadata.ipAddress || null,
      metadata.fingerprint || null,
      expiresAt
    ]);

    const sessionData = {
      sessionId,
      userId,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      metadata: {
        userAgent: metadata.userAgent,
        ipAddress: metadata.ipAddress,
        fingerprint: metadata.fingerprint
      }
    };

    await writeToTier(userId.toString(), 'tier2', `session_${sessionId}.json`, JSON.stringify(sessionData));
  }

  static async validateSession(userId: number, sessionId: string): Promise<boolean> {
    const [rows] = await DB.query(`
      SELECT id FROM user_sessions
      WHERE user_id = ? AND session_id = ? AND expires_at > NOW() AND revoked = FALSE
    `, [userId, sessionId]);

    return (rows as any[]).length > 0;
  }

  static async revokeSession(userId: number, sessionId: string): Promise<void> {
    await DB.query(`
      UPDATE user_sessions
      SET revoked = TRUE, revoked_at = NOW()
      WHERE user_id = ? AND session_id = ?
    `, [userId, sessionId]);
  }

  static async revokeAllUserSessions(userId: number): Promise<void> {
    await DB.query(`
      UPDATE user_sessions
      SET revoked = TRUE, revoked_at = NOW()
      WHERE user_id = ? AND revoked = FALSE
    `, [userId]);
  }

  static async cleanExpiredSessions(): Promise<void> {
    await DB.query(`
      DELETE FROM user_sessions
      WHERE expires_at < NOW() OR (revoked = TRUE AND revoked_at < DATE_SUB(NOW(), INTERVAL 30 DAY))
    `);
  }
}

// Security monitoring utilities
class SecurityMonitor {
  static async logSecurityEvent(
    userId: number | null,
    event: string,
    details: any,
    risk: 'low' | 'medium' | 'high',
    requestUrl?: string
  ): Promise<void> {
    try {
      await DB.query(
        `INSERT INTO activity_logs (user_id, action, metadata, risk_level, page_url, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [userId, event, JSON.stringify(details), risk, requestUrl || 'placeholder']
      );
    } catch (err) {
      authLogger.warn('activity_logs insert failed', { event, err: (err as Error).message });
      return; // don't try the tier3 write if even the DB write failed
    }

    if (risk === 'high') {
      try {
        const securityLog = {
          timestamp: new Date().toISOString(),
          userId,
          event,
          details,
          risk,
          serverInfo: {
            nodeVersion: process.version,
            platform: process.platform,
            memory: process.memoryUsage()
          }
        };
        const filename = `security_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.json`;
        await writeToTier(userId?.toString() || 'unknown_user', 'tier3', filename, JSON.stringify(securityLog));
      } catch (err) {
        authLogger.warn('tier3 security log write failed', { err: (err as Error).message });
      }
    }
  }

  static async detectSuspiciousActivity(userId: number, ipAddress: string, userAgent: string): Promise<boolean> {
    try {
      const [failedAttempts] = await DB.query(`
        SELECT COUNT(*) as count FROM activity_logs
        WHERE user_id = ? AND action = 'failed_login'
        AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
      `, [userId]);

      if ((failedAttempts as any[])[0].count >= 5) return true;

      const [recentLogins] = await DB.query(`
        SELECT DISTINCT ip_address, user_agent FROM user_sessions
        WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
      `, [userId]);

      const knownIPs = (recentLogins as any[]).map(r => r.ip_address);
      const knownAgents = (recentLogins as any[]).map(r => r.user_agent);

      const isNewIP = !knownIPs.includes(ipAddress);
      const isNewAgent = !knownAgents.includes(userAgent) && userAgent !== 'Unknown';

      return isNewIP || isNewAgent;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Internal helper — fire-and-forget verification email after registration
// ============================================================================
/**
 * Mints a verification token, persists it, and queues the email. NEVER throws
 * — the registration response must succeed even if email delivery is broken.
 * The user can hit "Resend" from the inline banner once they're inside the
 * app.
 */
async function dispatchInitialVerificationEmail(
  userId: number,
  email: string,
  username: string
): Promise<void> {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await DB.query(
      `INSERT INTO email_verification_tokens (user_id, token, expires_at)
       VALUES (?, ?, ?)`,
      [userId, token, expiresAt]
    );

    const appUrl = (process.env.APP_URL || 'https://www.theundergroundrailroad.world/Mirror').replace(/\/$/, '');
    const verificationUrl = `${appUrl}/verify-email?token=${token}`;

    await emailService.queueEmail(email, 'email_verification', {
      username: username || 'there',
      verificationUrl,
    });

    authLogger.info('Initial verification email queued', { userId, email });
  } catch (err) {
    // Non-fatal — surface to ops, but never to the registration response.
    authLogger.warn('Initial verification email dispatch failed (non-fatal)', {
      userId,
      err: (err as Error).message,
    });
  }
}

// ============================================================================
// Helper — load the latest user fields the frontend cares about
// ============================================================================
async function loadUserContextFields(
  userId: number
): Promise<{ email: string; emailVerified: boolean; intakeCompleted: boolean; subscriptionStatus: 'free' | 'premium' | 'enterprise' }> {
  try {
    const [rows] = await DB.query(
      `SELECT email, email_verified, intake_completed FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    const row = (rows as any[])[0] || {};

    // subscriptionStatus is computed from the paywall table when available,
    // otherwise defaults to 'free'. We avoid failing the whole call if the
    // paywall tables are missing in older environments.
    //
    // Read `user_subscriptions` FIRST — that is the table the premium gate
    // (subscriptionService) actually enforces, so the login/refresh response
    // stays consistent with what the gate allows (previously this read a legacy
    // `subscriptions` table that could disagree with the gate, so premium users
    // were shown the upgrade wall even though the backend allowed them through).
    // Fall back to `subscriptions` for environments that only have that table.
    // Table names below are hard-coded literals, never user input.
    let subscriptionStatus: 'free' | 'premium' | 'enterprise' = 'free';
    for (const table of ['user_subscriptions', 'subscriptions']) {
      try {
        const [subRows] = await DB.query(
          `SELECT tier FROM ${table} WHERE user_id = ? AND status IN ('active','trialing','past_due') ORDER BY id DESC LIMIT 1`,
          [userId]
        );
        const tier = (subRows as any[])[0]?.tier;
        if (tier === 'premium' || tier === 'enterprise') {
          subscriptionStatus = tier;
          break;
        }
      } catch {
        // table missing in this environment — try the next one
      }
    }

    return {
      email: String(row.email || ''),
      emailVerified: Boolean(row.email_verified),
      intakeCompleted: Boolean(row.intake_completed),
      subscriptionStatus,
    };
  } catch {
    return { email: '', emailVerified: false, intakeCompleted: false, subscriptionStatus: 'free' };
  }
}

// ============================================================================
// REGISTER
// ============================================================================
export const registerUser: RequestHandler = async (req, res) => {
  const startTime = Date.now();
  console.log('[REGISTRATION] Starting registration process');

  try {
    const body = (req.body ?? {}) as {
      username?: unknown;
      email?: unknown;
      password?: unknown;
      deviceFingerprint?: unknown;
    };

    // Normalise BEFORE any validation so the value we check is the same
    // value we hash. Without this, a trailing autocorrect space or a
    // smart-quote in the password passes regex on one keyboard and fails
    // on another.
    const username = normaliseUsername(body.username);
    const email = normaliseEmail(body.email);
    const password = normalisePassword(body.password);
    const deviceFingerprint = typeof body.deviceFingerprint === 'string'
      ? body.deviceFingerprint
      : undefined;

    if (!username || !email || !password) {
      // Report which specific field is missing so the client can highlight it.
      const missing = !username ? 'username' : !email ? 'email' : 'password';
      res.status(400).json({
        error: 'All fields are required.',
        code: 'MISSING_FIELDS',
        field: missing,
      });
      return;
    }

    if (username.length < 3 || username.length > 20 || !/^[a-zA-Z0-9_]+$/.test(username)) {
      res.status(400).json({
        error: 'Username must be 3–20 characters, letters, numbers and underscores only.',
        code: 'INVALID_USERNAME',
        field: 'username',
      });
      return;
    }

    if (!EMAIL_RE.test(email) || email.length > 254) {
      res.status(400).json({
        error: 'Please enter a valid email address.',
        code: 'INVALID_EMAIL',
        field: 'email',
      });
      return;
    }

    if (!passwordMeetsPolicy(password)) {
      res.status(400).json({
        error: 'Password must be 8–128 characters and include uppercase, lowercase, a number, and one symbol.',
        code: 'WEAK_PASSWORD',
        field: 'password',
      });
      return;
    }

    const userId = await createUserInDB(username, email, password);

    const sessionId = TokenManager.generateSessionId();
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const ipAddress = (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', '');

    await TokenManager.createSession(userId, sessionId, {
      userAgent,
      ipAddress,
      fingerprint: deviceFingerprint
    });

    await SecurityMonitor.logSecurityEvent(userId, 'user_registered', {
      username, email, ipAddress, userAgent,
      registrationTime: Date.now() - startTime
    }, 'low', req.originalUrl || req.url);

    const userInfo = await fetchUserInfo(email);

    // Best-effort: send the verification email right away. Failures don't
    // block registration. The frontend will also have a manual "Resend" CTA.
    await dispatchInitialVerificationEmail(userInfo.id, userInfo.email, userInfo.username);

    const accessToken = TokenManager.createAccessToken({
      id: userInfo.id,
      email: userInfo.email,
      username: userInfo.username,
      sessionId
    });
    const refreshToken = TokenManager.createRefreshToken({
      id: userInfo.id,
      sessionId
    });

    const initialUserData = {
      username, email,
      registeredAt: new Date().toISOString(),
      preferences: { theme: 'cosmic', notifications: true, privacy: 'medium' }
    };
    await writeToTier(userId.toString(), 'tier1', 'profile.json', JSON.stringify(initialUserData));

    res.status(201).json({
      message: 'User registered successfully. We just sent you a verification email.',
      user: {
        id: userInfo.id,
        username: userInfo.username,
        email: userInfo.email,
        emailVerified: false,
        intakeCompleted: userInfo.intakeCompleted,
        subscriptionStatus: 'free',
        sessionId,
        lastLogin: new Date().toISOString()
      },
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: 900
      },
      verification: {
        emailSent: true,
        message: 'Check your inbox for a verification link. You can also resend it from your dashboard.'
      }
    });
  } catch (error: any) {
    console.error('[REGISTRATION ERROR]', error);

    const pageUrl = req.originalUrl || req.url;
    const ipAddress = (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', '');

    try {
      await DB.query(
        `INSERT INTO activity_logs (user_id, action, metadata, risk_level, page_url, created_at)
         VALUES (NULL, 'failed_registration', ?, 'medium', ?, NOW())`,
        [
          JSON.stringify({
            error: error.message,
            email: req.body?.email,
            ipAddress,
            userAgent: req.headers['user-agent']
          }),
          pageUrl
        ]
      );
    } catch (logErr) {
      authLogger.warn('activity_logs insert failed', { err: (logErr as Error).message });
    }

    // Map createUserInDB() domain errors back to specific HTTP responses
    // with field hints so the client can highlight exactly which input
    // to fix.
    if (error.message === 'EMAIL_ALREADY_REGISTERED') {
      res.status(409).json({
        error: 'That email is already registered. Try signing in instead.',
        code: 'EMAIL_EXISTS',
        field: 'email',
      });
      return;
    }
    if (error.message === 'USERNAME_TAKEN') {
      res.status(409).json({
        error: 'That username is taken. Please pick another.',
        code: 'USERNAME_TAKEN',
        field: 'username',
      });
      return;
    }
    if (error.message === 'DISPOSABLE_EMAIL') {
      res.status(400).json({
        error: 'Disposable email addresses are not supported. Please use your regular inbox.',
        code: 'DISPOSABLE_EMAIL',
        field: 'email',
      });
      return;
    }

    res.status(500).json({
      error: 'Registration failed. Please try again.',
      code: 'REGISTRATION_FAILED'
    });
  }
};

// ============================================================================
// LOGIN
// ============================================================================
export const loginUser: RequestHandler = async (req, res) => {
  const startTime = Date.now();

  try {
    const body = (req.body ?? {}) as {
      email?: unknown;
      password?: unknown;
      deviceFingerprint?: unknown;
    };

    // Normalise on the login path too — a user who registered on desktop
    // (ASCII password) and now signs in on iOS would otherwise have their
    // password silently smart-quoted by iOS's keyboard before submission.
    // The stored hash is of the normalised form (registerUser sees to that),
    // so we normalise here on the way in.
    const email = normaliseEmail(body.email);
    const password = normalisePassword(body.password);
    const deviceFingerprint = typeof body.deviceFingerprint === 'string'
      ? body.deviceFingerprint
      : undefined;

    if (!email || !password) {
      res.status(400).json({
        error: 'Email and password are required.',
        code: 'MISSING_CREDENTIALS'
      });
      return;
    }

    // Hard cap BEFORE bcrypt.compare. Without this, a single request with
    // a 100KB password can pin a CPU core grinding through bcrypt for
    // seconds — multiply by the rate limit and you have a cheap DoS vector.
    // 256 matches the bound used by changePassword / deleteAccount /
    // changeEmail (MAX_PASSWORD_INPUT). Failed length check looks identical
    // to a wrong password so it doesn't leak which side is too long.
    if (password.length > 256 || email.length > 254) {
      res.status(401).json({
        error: 'Invalid credentials.',
        code: 'INVALID_CREDENTIALS'
      });
      return;
    }

    const userAgent = req.headers['user-agent'] || 'Unknown';
    const ipAddress = (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', '');

    // Get user info first
    const userInfo = await fetchUserInfo(email);

    // Hydrate verification + intake + subscription state for the response.
    const contextFields = await loadUserContextFields(userInfo.id);

    // Opt-in gating: block login for unverified users when explicitly enabled.
    if (
      process.env.LOGIN_REQUIRE_EMAIL_VERIFIED === 'true' &&
      !contextFields.emailVerified
    ) {
      await SecurityMonitor.logSecurityEvent(userInfo.id, 'login_blocked_unverified_email', {
        ipAddress, userAgent
      }, 'low', req.originalUrl || req.url);

      res.status(403).json({
        error: 'Please verify your email before logging in. We sent you a link when you signed up.',
        code: 'EMAIL_NOT_VERIFIED'
      });
      return;
    }

    const isSuspicious = await SecurityMonitor.detectSuspiciousActivity(
      userInfo.id, ipAddress, userAgent
    );

    if (isSuspicious) {
      await SecurityMonitor.logSecurityEvent(userInfo.id, 'suspicious_login_attempt', {
        ipAddress, userAgent, deviceFingerprint
      }, 'high');
    }

    // Verify credentials.
    //
    // Backward-compat fallback for password normalisation: any account that
    // existed BEFORE the registration path started normalising iOS smart
    // quotes / dashes may have a stored hash of the raw (un-normalised) PW.
    // If the normalised compare fails, we retry once with the raw body
    // password before declaring the credential invalid. This keeps existing
    // users from being locked out by the policy change.
    const rawPassword = typeof body.password === 'string' ? body.password : '';
    try {
      await userLogin(email, password);
    } catch (firstErr) {
      if (rawPassword && rawPassword !== password) {
        try {
          await userLogin(email, rawPassword);
        } catch {
          throw firstErr;
        }
      } else {
        throw firstErr;
      }
    }

    const sessionId = TokenManager.generateSessionId();
    await TokenManager.createSession(userInfo.id, sessionId, {
      userAgent, ipAddress, fingerprint: deviceFingerprint
    });

    const accessToken = TokenManager.createAccessToken({
      id: userInfo.id, email: userInfo.email, username: userInfo.username, sessionId
    });
    const refreshToken = TokenManager.createRefreshToken({
      id: userInfo.id, sessionId
    });

    // Fire-and-forget new-device notification when this login looks like
    // it came from a previously-unseen IP or User-Agent. Best effort: a
    // queue / template / SMTP failure must never block the user's response.
    // We deliberately do NOT await — the response goes out immediately and
    // the email is dispatched in the background.
    if (isSuspicious) {
      const appUrl = (process.env.APP_URL || 'https://www.theundergroundrailroad.world/Mirror').replace(/\/$/, '');
      void emailService
        .queueEmail(userInfo.email, 'new_device_login', {
          username: userInfo.username || 'there',
          loginTime: new Date().toUTCString(),
          ipAddress,
          userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 200) : 'unknown',
          resetPasswordUrl: `${appUrl}/forgot-password`,
        })
        .catch((err) =>
          authLogger.warn('new_device_login email dispatch failed (non-fatal)', {
            userId: userInfo.id,
            err: (err as Error).message,
          })
        );
    }

    await SecurityMonitor.logSecurityEvent(userInfo.id, 'successful_login', {
      ipAddress, userAgent, deviceFingerprint,
      loginTime: Date.now() - startTime,
      suspicious: isSuspicious
    }, isSuspicious ? 'medium' : 'low');

    res.status(200).json({
      message: 'Login successful.',
      user: {
        id: userInfo.id,
        username: userInfo.username,
        email: userInfo.email,
        emailVerified: contextFields.emailVerified,
        intakeCompleted: contextFields.intakeCompleted,
        subscriptionStatus: contextFields.subscriptionStatus,
        sessionId,
        lastLogin: new Date().toISOString()
      },
      tokens: {
        accessToken, refreshToken,
        expiresIn: 900
      },
      security: {
        suspicious: isSuspicious,
        newDevice: !isSuspicious
      }
    });
  } catch (error: any) {
    console.error('[LOGIN ERROR]', error);

    const ipAddress = (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', '');
    const userAgent = req.headers['user-agent'];

    try {
      const userInfo = await fetchUserInfo(req.body?.email);
      await SecurityMonitor.logSecurityEvent(userInfo.id, 'failed_login', {
        ipAddress, userAgent, error: error.message
      }, 'medium');
    } catch (e) {
      // ----- Timing-attack equalisation ---------------------------------
      // The user-doesn't-exist path otherwise resolves in ~5ms while
      // user-exists-wrong-password takes ~100ms (the bcrypt round on the
      // real hash). That delta is a known account-enumeration oracle.
      // Run one bcrypt.compare against the precomputed dummy hash so
      // both paths take the same wall-clock time.
      try {
        const probe = typeof req.body?.password === 'string'
          ? req.body.password
          : 'x';
        const dummy = await DUMMY_HASH_PROMISE;
        await bcrypt.compare(probe, dummy);
      } catch {
        // If even the dummy compare can't run we still want to fall
        // through to the response — better to leak a tiny timing diff
        // than to 500 on a failed login.
      }

      try {
        await DB.query(
          `INSERT INTO activity_logs (user_id, action, metadata, risk_level, created_at)
           VALUES (NULL, 'failed_login_unknown_email', ?, 'medium', NOW())`,
          [JSON.stringify({
            email: req.body?.email,
            ipAddress, userAgent,
            error: error.message
          })]
        );
      } catch (logErr) {
        authLogger.warn('activity_logs insert failed', { err: (logErr as Error).message });
      }
    }

    res.status(401).json({
      error: error.message === 'ACCOUNT_LOCKED' ? 'Your account is locked.' :
             error.message === 'EMAIL_NOT_VERIFIED' ? 'Please verify your email to log in.' :
             'Invalid credentials.',
      code: error.message === 'ACCOUNT_LOCKED' ? 'ACCOUNT_LOCKED' :
            error.message === 'EMAIL_NOT_VERIFIED' ? 'EMAIL_NOT_VERIFIED' :
            'INVALID_CREDENTIALS'
    });
  }
};

// ============================================================================
// REFRESH
// ============================================================================
export const refreshToken: RequestHandler = async (req, res) => {
  try {
    const { refreshToken } = req.body ?? {};

    if (!refreshToken) {
      res.status(400).json({
        error: 'Refresh token is required.',
        code: 'MISSING_REFRESH_TOKEN'
      });
      return;
    }

    const decoded = TokenManager.verifyRefreshToken(refreshToken);

    const isValidSession = await TokenManager.validateSession(decoded.id, decoded.sessionId);
    if (!isValidSession) {
      res.status(401).json({ error: 'Session expired or invalid.', code: 'INVALID_SESSION' });
      return;
    }

    const [userRows] = await DB.query('SELECT id, email, username FROM users WHERE id = ?', [decoded.id]);
    const user = (userRows as any[])[0];

    if (!user) {
      res.status(401).json({ error: 'User not found.', code: 'USER_NOT_FOUND' });
      return;
    }

    const newAccessToken = TokenManager.createAccessToken({
      id: user.id, email: user.email, username: user.username, sessionId: decoded.sessionId
    });

    res.status(200).json({ accessToken: newAccessToken, expiresIn: 900 });
  } catch (error: any) {
    console.error('[REFRESH TOKEN ERROR]', error);
    res.status(401).json({ error: 'Invalid refresh token.', code: 'INVALID_REFRESH_TOKEN' });
  }
};

// ============================================================================
// LOGOUT
// ============================================================================
export const logoutUser: RequestHandler = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided.', code: 'NO_TOKEN' });
      return;
    }

    const token = authHeader.substring(7);
    const decoded = TokenManager.verifyAccessToken(token);

    await TokenManager.revokeSession(decoded.id, decoded.sessionId);

    await SecurityMonitor.logSecurityEvent(decoded.id, 'user_logout', {
      sessionId: decoded.sessionId,
      ipAddress: (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', ''),
      userAgent: req.headers['user-agent']
    }, 'low');

    res.status(200).json({ message: 'Logged out successfully.' });
  } catch (error: any) {
    console.error('[LOGOUT ERROR]', error);
    res.status(200).json({ message: 'Logged out successfully, but an internal error occurred during logging.' });
  }
};

// ============================================================================
// LOGOUT ALL DEVICES
// ============================================================================
export const logoutAllDevices: RequestHandler = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided.', code: 'NO_TOKEN' });
      return;
    }

    const token = authHeader.substring(7);
    const decoded = TokenManager.verifyAccessToken(token);

    await TokenManager.revokeAllUserSessions(decoded.id);

    await SecurityMonitor.logSecurityEvent(decoded.id, 'logout_all_devices', {
      ipAddress: (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', ''),
      userAgent: req.headers['user-agent']
    }, 'medium');

    res.status(200).json({ message: 'Logged out from all devices successfully.' });
  } catch (error: any) {
    console.error('[LOGOUT ALL ERROR]', error);
    res.status(500).json({ error: 'Failed to logout from all devices.', code: 'LOGOUT_ALL_FAILED' });
  }
};

// ============================================================================
// VERIFY TOKEN
// ============================================================================
export const verifyToken: RequestHandler = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ valid: false, error: 'No token provided.', code: 'NO_TOKEN' });
      return;
    }

    const token = authHeader.substring(7);
    const decoded = TokenManager.verifyAccessToken(token);

    const isValidSession = await TokenManager.validateSession(decoded.id, decoded.sessionId);
    if (!isValidSession) {
      res.status(401).json({ valid: false, error: 'Session expired.', code: 'INVALID_SESSION' });
      return;
    }

    const ctx = await loadUserContextFields(decoded.id);

    res.status(200).json({
      valid: true,
      user: {
        id: decoded.id,
        // Live from DB so an email change is reflected on refresh without
        // needing a new access token (the JWT still carries the old address).
        email: ctx.email || decoded.email,
        username: decoded.username,
        sessionId: decoded.sessionId,
        emailVerified: ctx.emailVerified,
        intakeCompleted: ctx.intakeCompleted,
        subscriptionStatus: ctx.subscriptionStatus,
      },
      expiresAt: new Date(decoded.exp! * 1000).toISOString()
    });
  } catch (error: any) {
    res.status(401).json({ valid: false, error: 'Invalid token.', code: 'INVALID_TOKEN' });
  }
};

// ============================================================================
// CLEANUP UTILITY
// ============================================================================
export const cleanupSessions: RequestHandler = async (_req, res) => {
  try {
    await TokenManager.cleanExpiredSessions();
    res.status(200).json({ message: 'Sessions cleaned up successfully.' });
  } catch (error) {
    console.error('[CLEANUP ERROR]', error);
    res.status(500).json({ error: 'Cleanup failed.' });
  }
};

// ============================================================================
// ACCOUNT DELETION
// ============================================================================
//
// Pipeline:
//   1. Identity            — JWT-verified via AuthMiddleware.verifyToken
//                            (route-level). req.user.id is the only userId
//                            we ever trust. Body inputs are *credentials*,
//                            never identity.
//   2. Intent              — body must contain confirmation === "DELETE"
//                            (typed by the user in the modal).
//   3. Re-auth             — body must contain password matching the stored
//                            bcrypt hash. Defeats stolen-session deletion.
//   4. Local purge         — deleteUserFromDB() handles files + DB cascade +
//                            TruthStream review re-anonymisation.
//   5. Dina-side purge     — best-effort fire-and-wait HTTP POST to the
//                            Dina mirror module. A failure here is logged
//                            but does NOT roll back local deletion. The
//                            local DB is the source of truth; Dina-side
//                            data without a corresponding user row is
//                            orphaned and harmless until garbage-collected.
//   6. Session revocation  — all device sessions wiped so the (now-invalid)
//                            JWT cannot be used to hit other endpoints
//                            before its natural expiry.
//
// Idempotency: each downstream call is safe to retry. If the client retries
// after a server-side error, deleteUserFromDB short-circuits cleanly because
// the user row is already gone.
// ============================================================================

const DINA_PURGE_TIMEOUT_MS = 15000;

async function notifyDinaPurge(userId: number, sessionId: string | undefined): Promise<{
  notified: boolean;
  detail?: string;
}> {
  const base = process.env.DINA_SERVER_URL || 'https://theundergroundrailroad.world';
  // Dina-server lives behind the `/dina` Apache prefix (see dina-server's
  // src/index.ts: `setupAPI(app, dinaCore, '/dina')`) and mounts its API
  // router at `${basePath}/api/v1`. Final external path is
  // /dina/api/v1/mirror/purge-user. An override env var is provided in
  // case the prefix ever moves.
  const path = process.env.DINA_PURGE_PATH || '/dina/api/v1/mirror/purge-user';
  const url = `${base.replace(/\/$/, '')}${path.startsWith('/') ? path : '/' + path}`;

  // Dina-server gates internal-only routes with `requireServiceAuth`, which
  // reads `X-Service-Key` and timing-safe-compares it against
  // `MIRROR_SERVICE_KEY` on the dina-server side. If neither side has that
  // env var configured, dina-server logs a warning and lets the call
  // through (backwards-compatible fallback) — so this still works on a
  // fresh deploy without operator action, and tightens automatically the
  // moment the env var is set on both fleets.
  const serviceKey = process.env.MIRROR_SERVICE_KEY || '';

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mirror-Server/2.0.0 account-deletion',
    };
    if (serviceKey) {
      headers['X-Service-Key'] = serviceKey;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userId: String(userId),
        sessionId: sessionId || null,
        reason: 'user_account_deletion',
        requestedAt: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(DINA_PURGE_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      authLogger.warn('notifyDinaPurge: Dina returned non-OK status', {
        userId,
        status: response.status,
        body: text.slice(0, 240),
      });
      return { notified: false, detail: `dina_status_${response.status}` };
    }

    return { notified: true };
  } catch (err: any) {
    authLogger.warn('notifyDinaPurge: Dina purge call failed', {
      userId,
      error: err?.message || String(err),
    });
    return { notified: false, detail: 'network_error' };
  }
}

export const deleteAccount: RequestHandler = async (req, res) => {
  // Identity from JWT — never from body. AuthMiddleware.verifyToken has
  // already populated req.user before we get here.
  const authed = (req as any).user as { id?: number; email?: string; sessionId?: string } | undefined;
  const userId = Number(authed?.id);
  if (!userId || Number.isNaN(userId)) {
    res.status(401).json({ error: 'Authentication required.', code: 'NO_AUTH' });
    return;
  }

  const body = (req.body || {}) as { password?: unknown; confirmation?: unknown };
  // Normalise iOS smart quotes/dashes so an account password set on desktop
  // can still be re-auth'd when typing the deletion confirmation on iOS.
  const password = normalisePassword(body.password);
  const confirmation = typeof body.confirmation === 'string' ? body.confirmation : '';

  if (!password) {
    res.status(400).json({ error: 'Current password is required.', code: 'PASSWORD_REQUIRED' });
    return;
  }
  if (confirmation.toUpperCase() !== 'DELETE') {
    res.status(400).json({
      error: 'Confirmation text does not match.',
      code: 'CONFIRMATION_MISMATCH',
    });
    return;
  }
  // Hard bound — prevents pathological inputs reaching bcrypt.compare which
  // is happy to grind for 72+ chars on a single request.
  if (password.length > 256) {
    res.status(400).json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' });
    return;
  }

  // Verify password
  let storedHash: string | null = null;
  let storedEmail = '';
  try {
    const [rows] = await DB.query(
      'SELECT password_hash, email FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    const userRow = (rows as any[])[0];
    if (!userRow) {
      // Either the user was already deleted, or the token is for a non-
      // existent user. Either way: treat as already-deleted (idempotent).
      res.status(200).json({ message: 'Account already deleted.' });
      return;
    }
    storedHash = String(userRow.password_hash || '');
    storedEmail = String(userRow.email || '');
  } catch (err) {
    console.error('[DELETE ACCOUNT] Failed to load user for password check', err);
    res.status(500).json({ error: 'Account deletion failed.', code: 'INTERNAL_ERROR' });
    return;
  }

  let passwordOk = false;
  try {
    passwordOk = await bcrypt.compare(password, storedHash || '');
  } catch (err) {
    console.error('[DELETE ACCOUNT] bcrypt.compare threw', err);
    passwordOk = false;
  }
  if (!passwordOk) {
    // Backward-compat fallback: pre-normalisation hashes may carry smart-
    // quote/dash bytes from iOS. Retry once with the raw input.
    const rawPassword = typeof body.password === 'string' ? body.password : '';
    if (rawPassword && rawPassword !== password) {
      try { passwordOk = await bcrypt.compare(rawPassword, storedHash || ''); } catch { passwordOk = false; }
    }
  }

  if (!passwordOk) {
    await SecurityMonitor.logSecurityEvent(userId, 'account_deletion_password_failed', {
      ipAddress: (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', ''),
      userAgent: req.headers['user-agent'] || 'Unknown',
    }, 'medium');
    res.status(401).json({ error: 'Invalid password.', code: 'INVALID_CREDENTIALS' });
    return;
  }

  // Local purge (source of truth)
  try {
    await deleteUserFromDB(String(userId), userId);
  } catch (err) {
    console.error('[DELETE ACCOUNT] deleteUserFromDB threw', err);
    const message = (err as Error)?.message || 'unknown';
    await SecurityMonitor.logSecurityEvent(userId, 'account_deletion_local_failed', {
      error: message,
    }, 'high');
    // Caller is already JWT-authenticated and password-verified, so it's
    // safe — and very useful for debugging FK-constraint surprises — to
    // pass the underlying message back. Truncated to keep ridiculous SQL
    // dumps out of the response body.
    res.status(500).json({
      error: 'Account deletion failed.',
      code: 'LOCAL_DELETE_FAILED',
      detail: message.slice(0, 500),
    });
    return;
  }

  // Best-effort Dina-side purge. Awaited (so the client knows what happened)
  // but a failure here doesn't unwind the local delete.
  const dinaResult = await notifyDinaPurge(userId, authed?.sessionId);

  // Revoke any remaining sessions defensively. The CASCADE in deleteUserFromDB
  // should already have removed user_sessions rows; this is a belt-and-braces
  // call in case the FK constraint isn't present in some environment.
  try {
    await TokenManager.revokeAllUserSessions(userId);
  } catch {
    /* non-fatal — user row is already gone */
  }

  // Audit trail
  await SecurityMonitor.logSecurityEvent(userId, 'account_deleted', {
    email: storedEmail,
    ipAddress: (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', ''),
    userAgent: req.headers['user-agent'] || 'Unknown',
    dinaNotified: dinaResult.notified,
    dinaDetail: dinaResult.detail || null,
  }, 'high');

  res.status(200).json({
    message: 'Account deleted successfully.',
    dinaNotified: dinaResult.notified,
    ...(dinaResult.detail ? { dinaDetail: dinaResult.detail } : {}),
  });
};

// ============================================================================
// SELF-SERVICE CREDENTIAL CHANGES — change password / change email
// ============================================================================
//
// Both flows share the non-negotiables proven out by deleteAccount:
//   - Identity comes from req.user.id (JWT), NEVER from the body. The body
//     only ever carries *credentials* (the current password) and the new
//     value being set.
//   - The current password is re-verified with bcrypt before any change, so a
//     stolen/forgotten session can't silently rotate a victim's credentials.
//   - Inputs are length-bounded before they reach bcrypt.compare (which will
//     happily grind on 72+ char inputs) and validated against the same policy
//     used at registration.
//   - Errors are generic where leaking would help an attacker (bad password ->
//     INVALID_CREDENTIALS) and specific where it only helps the legitimate
//     user (weak password, email in use).
//
// Email change uses a *re-verify* model: the new address is never written to
// users.email until the owner of that address clicks a single-use link. Until
// then the change lives in pending_email_changes (see migration 013).
// ----------------------------------------------------------------------------

// Credential-rotation paths delegate to the unified passwordMeetsPolicy()
// helper defined at the top of this file so register / change-password
// always accept the same character set.
// MAX_PASSWORD_INPUT (256) here is the hard bound for re-auth strings
// passed to bcrypt.compare (which would otherwise grind on huge inputs);
// the policy-bound 128 still applies for NEW passwords being set.
const PASSWORD_SALT_ROUNDS = 10; // matches SALT_ROUNDS in userController
const MAX_PASSWORD_INPUT = 256;  // hard bound before bcrypt.compare/hash

function isStrongPassword(pw: unknown): pw is string {
  if (typeof pw !== 'string') return false;
  // Normalise iOS smart-quote/dash characters here too — change-password
  // is the most common path through which they leak in after registration.
  return passwordMeetsPolicy(normalisePassword(pw));
}

// EMAIL_RE is now defined at the top of this file alongside the password
// helpers so registerUser() can use the same regex. Re-declaring here would
// shadow it; we leave the canonical definition above.
const EMAIL_CHANGE_TOKEN_BYTES = 32;          // -> 64 hex chars (CHAR(64))
const EMAIL_CHANGE_EXPIRY_HOURS = 24;
const EMAIL_CHANGE_RESEND_COOLDOWN_MS = 60_000; // 1 min between requests
const EMAIL_CHANGE_MAX_PENDING = 3;

function clientIp(req: Parameters<RequestHandler>[0]): string {
  return (req.ip || req.connection?.remoteAddress || 'Unknown').replace('::ffff:', '');
}

/**
 * POST /mirror/api/auth/change-password   (JWT-protected)
 * Body: { currentPassword, newPassword }
 *
 * Re-auths with the current password, applies the new one, and revokes every
 * OTHER device session (the current session is preserved so the user isn't
 * bounced out of the tab they just used). Idempotent-safe: no-op-equal
 * passwords are rejected up front.
 */
export const changePassword: RequestHandler = async (req, res) => {
  const authed = (req as any).user as { id?: number; sessionId?: string } | undefined;
  const userId = Number(authed?.id);
  if (!userId || Number.isNaN(userId)) {
    res.status(401).json({ error: 'Authentication required.', code: 'NO_AUTH' });
    return;
  }

  const body = (req.body || {}) as { currentPassword?: unknown; oldPassword?: unknown; newPassword?: unknown };
  // Accept either `currentPassword` (canonical) or `oldPassword` (legacy client).
  // Normalise both inputs so iOS smart quotes / dashes don't desync from the
  // hash stored during registration (which is of the normalised form).
  const currentPassword = normalisePassword(
    typeof body.currentPassword === 'string'
      ? body.currentPassword
      : typeof body.oldPassword === 'string' ? body.oldPassword : ''
  );
  const newPassword = normalisePassword(body.newPassword);

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: 'Current and new password are required.', code: 'MISSING_FIELDS' });
    return;
  }
  if (currentPassword.length > MAX_PASSWORD_INPUT) {
    res.status(401).json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' });
    return;
  }
  if (!isStrongPassword(newPassword)) {
    res.status(400).json({
      error: 'Password must be at least 8 characters with uppercase, lowercase, number, and special character.',
      code: 'WEAK_PASSWORD',
    });
    return;
  }
  if (newPassword === currentPassword) {
    res.status(400).json({ error: 'New password must be different from the current one.', code: 'PASSWORD_UNCHANGED' });
    return;
  }

  let storedHash = '';
  try {
    const [rows] = await DB.query('SELECT password_hash FROM users WHERE id = ? LIMIT 1', [userId]);
    const row = (rows as any[])[0];
    if (!row) {
      res.status(401).json({ error: 'Authentication required.', code: 'NO_AUTH' });
      return;
    }
    storedHash = String(row.password_hash || '');
  } catch (err) {
    authLogger.error('changePassword: failed to load user', err as Error, { userId });
    res.status(500).json({ error: 'Could not change password.', code: 'INTERNAL_ERROR' });
    return;
  }

  let ok = false;
  try { ok = await bcrypt.compare(currentPassword, storedHash); } catch { ok = false; }
  if (!ok) {
    // Backward-compat fallback: pre-normalisation registrations stored the
    // raw (smart-quoted) PW hash. Try the raw body once before failing.
    const rawCurrent = typeof body.currentPassword === 'string'
      ? body.currentPassword
      : typeof body.oldPassword === 'string' ? body.oldPassword : '';
    if (rawCurrent && rawCurrent !== currentPassword) {
      try { ok = await bcrypt.compare(rawCurrent, storedHash); } catch { ok = false; }
    }
  }
  if (!ok) {
    await SecurityMonitor.logSecurityEvent(userId, 'password_change_failed', {
      reason: 'bad_current_password', ipAddress: clientIp(req), userAgent: req.headers['user-agent'] || 'Unknown',
    }, 'medium', req.originalUrl || req.url);
    res.status(401).json({ error: 'Current password is incorrect.', code: 'INVALID_CREDENTIALS' });
    return;
  }

  try {
    const newHash = await bcrypt.hash(newPassword, PASSWORD_SALT_ROUNDS);
    await DB.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);
  } catch (err) {
    authLogger.error('changePassword: hash/update failed', err as Error, { userId });
    res.status(500).json({ error: 'Could not change password.', code: 'INTERNAL_ERROR' });
    return;
  }

  // Security hygiene: a password rotation invalidates every OTHER session.
  // The current session is kept so the user stays signed in where they are.
  try {
    await DB.query(
      `UPDATE user_sessions SET revoked = TRUE, revoked_at = NOW()
       WHERE user_id = ? AND revoked = FALSE AND session_id != ?`,
      [userId, authed?.sessionId || '']
    );
  } catch (err) {
    authLogger.warn('changePassword: other-session revoke failed (non-fatal)', { userId, err: (err as Error).message });
  }

  await SecurityMonitor.logSecurityEvent(userId, 'password_changed', {
    ipAddress: clientIp(req), userAgent: req.headers['user-agent'] || 'Unknown',
  }, 'high', req.originalUrl || req.url);

  res.status(200).json({ message: 'Password changed. Other devices have been signed out.' });
};

/**
 * POST /mirror/api/auth/change-email   (JWT-protected)
 * Body: { newEmail, currentPassword }
 *
 * Re-auths, then stages a pending change and emails a single-use link to the
 * NEW address. users.email is NOT touched until that link is confirmed.
 * Responses are intentionally uniform so an attacker who guesses a session
 * can't probe which addresses already exist (we still 409 on a duplicate the
 * legitimate user would want to know about — the address is theirs to pick).
 */
export const changeEmail: RequestHandler = async (req, res) => {
  const authed = (req as any).user as { id?: number; email?: string } | undefined;
  const userId = Number(authed?.id);
  if (!userId || Number.isNaN(userId)) {
    res.status(401).json({ error: 'Authentication required.', code: 'NO_AUTH' });
    return;
  }

  const body = (req.body || {}) as { newEmail?: unknown; currentPassword?: unknown; password?: unknown };
  const newEmailRaw = typeof body.newEmail === 'string' ? body.newEmail : '';
  // Normalise so iOS smart quotes don't break the re-auth bcrypt.compare.
  const currentPassword = normalisePassword(
    typeof body.currentPassword === 'string'
      ? body.currentPassword
      : typeof body.password === 'string' ? body.password : ''
  );
  const newEmail = normaliseEmail(newEmailRaw).toLowerCase();

  if (!newEmail || !currentPassword) {
    res.status(400).json({ error: 'New email and current password are required.', code: 'MISSING_FIELDS' });
    return;
  }
  if (newEmail.length > 255 || !EMAIL_RE.test(newEmail)) {
    res.status(400).json({ error: 'Please enter a valid email address.', code: 'INVALID_EMAIL' });
    return;
  }
  if (currentPassword.length > MAX_PASSWORD_INPUT) {
    res.status(401).json({ error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' });
    return;
  }

  // Load current user (hash + current email) and re-auth.
  let storedHash = '';
  let currentEmail = '';
  let username = 'there';
  try {
    const [rows] = await DB.query('SELECT password_hash, email, username FROM users WHERE id = ? LIMIT 1', [userId]);
    const row = (rows as any[])[0];
    if (!row) {
      res.status(401).json({ error: 'Authentication required.', code: 'NO_AUTH' });
      return;
    }
    storedHash = String(row.password_hash || '');
    currentEmail = String(row.email || '').toLowerCase();
    username = String(row.username || 'there');
  } catch (err) {
    authLogger.error('changeEmail: failed to load user', err as Error, { userId });
    res.status(500).json({ error: 'Could not start email change.', code: 'INTERNAL_ERROR' });
    return;
  }

  let ok = false;
  try { ok = await bcrypt.compare(currentPassword, storedHash); } catch { ok = false; }
  if (!ok) {
    // Backward-compat fallback for pre-normalisation password hashes.
    const rawCurrent = typeof body.currentPassword === 'string'
      ? body.currentPassword
      : typeof body.password === 'string' ? body.password : '';
    if (rawCurrent && rawCurrent !== currentPassword) {
      try { ok = await bcrypt.compare(rawCurrent, storedHash); } catch { ok = false; }
    }
  }
  if (!ok) {
    await SecurityMonitor.logSecurityEvent(userId, 'email_change_failed', {
      reason: 'bad_current_password', ipAddress: clientIp(req), userAgent: req.headers['user-agent'] || 'Unknown',
    }, 'medium', req.originalUrl || req.url);
    res.status(401).json({ error: 'Current password is incorrect.', code: 'INVALID_CREDENTIALS' });
    return;
  }

  if (newEmail === currentEmail) {
    res.status(400).json({ error: 'That is already your email address.', code: 'EMAIL_UNCHANGED' });
    return;
  }

  // Uniqueness: reject if the address belongs to a DIFFERENT account.
  try {
    const [dupe] = await DB.query('SELECT id FROM users WHERE LOWER(email) = ? AND id != ? LIMIT 1', [newEmail, userId]);
    if ((dupe as any[]).length > 0) {
      res.status(409).json({ error: 'That email address is already in use.', code: 'EMAIL_IN_USE' });
      return;
    }
  } catch (err) {
    authLogger.error('changeEmail: uniqueness check failed', err as Error, { userId });
    res.status(500).json({ error: 'Could not start email change.', code: 'INTERNAL_ERROR' });
    return;
  }

  // Rate-limit: cooldown since last pending request + cap on active pendings.
  try {
    const [recent] = await DB.query(
      `SELECT created_at FROM pending_email_changes
       WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    const last = (recent as any[])[0];
    if (last && Date.now() - new Date(last.created_at).getTime() < EMAIL_CHANGE_RESEND_COOLDOWN_MS) {
      res.status(429).json({ error: 'Please wait a minute before requesting another change.', code: 'RATE_LIMITED' });
      return;
    }
    const [pendingCount] = await DB.query(
      `SELECT COUNT(*) AS count FROM pending_email_changes
       WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW()`,
      [userId]
    );
    if ((pendingCount as any[])[0].count >= EMAIL_CHANGE_MAX_PENDING) {
      // Invalidate the backlog so the user isn't permanently wedged.
      await DB.query(
        `UPDATE pending_email_changes SET used_at = NOW()
         WHERE user_id = ? AND used_at IS NULL`,
        [userId]
      );
    }
  } catch (err) {
    authLogger.warn('changeEmail: rate-limit check failed (continuing)', { userId, err: (err as Error).message });
  }

  // Stage the pending change + email the token to the NEW address.
  const token = crypto.randomBytes(EMAIL_CHANGE_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_EXPIRY_HOURS * 60 * 60 * 1000);
  try {
    await DB.query(
      `INSERT INTO pending_email_changes (user_id, new_email, token, expires_at)
       VALUES (?, ?, ?, ?)`,
      [userId, newEmail, token, expiresAt]
    );
  } catch (err) {
    authLogger.error('changeEmail: failed to persist pending change', err as Error, { userId });
    res.status(500).json({ error: 'Could not start email change.', code: 'INTERNAL_ERROR' });
    return;
  }

  const appUrl = process.env.APP_URL || 'https://www.theundergroundrailroad.world/Mirror';
  // Reuse the existing /verify-email route (which the host already serves) with
  // type=change so we don't depend on a new SPA-fallback path being configured.
  const verificationUrl = `${appUrl}/verify-email?type=change&token=${token}`;
  const result = await emailService.sendTemplate(newEmail, 'email_change_verification', {
    username,
    verificationUrl,
    newEmail,
  });
  if (!result.success) {
    authLogger.error('changeEmail: verification email send failed', new Error(result.error || 'Unknown'), { userId });
    res.status(503).json({ error: 'Could not send the confirmation email. Please try again shortly.', code: 'EMAIL_SEND_FAILED' });
    return;
  }

  await SecurityMonitor.logSecurityEvent(userId, 'email_change_requested', {
    // Never log the full target address at non-high risk; keep an obfuscated hint.
    newEmailHint: newEmail.replace(/^(.).*(@.*)$/, '$1***$2'),
    ipAddress: clientIp(req), userAgent: req.headers['user-agent'] || 'Unknown',
  }, 'high', req.originalUrl || req.url);

  res.status(200).json({
    message: `Confirmation link sent to ${newEmail}. Click it to finish changing your email.`,
    expiresIn: `${EMAIL_CHANGE_EXPIRY_HOURS} hours`,
  });
};

/**
 * POST /mirror/api/auth/change-email/confirm   (UNauthenticated — the token IS
 * the credential, exactly like /verify-email).
 * Body: { token }
 *
 * Applies the pending change: users.email = new_email, email_verified = 1.
 * Re-checks uniqueness at apply-time (the address could have been taken in the
 * window between request and click) and invalidates the row + the user's other
 * pendings. Distinct status codes let the client render precise messaging.
 */
export const confirmEmailChange: RequestHandler = async (req, res) => {
  const token = typeof (req.body || {}).token === 'string' ? (req.body as any).token : '';
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    res.status(400).json({ error: 'Invalid or missing confirmation token.', code: 'INVALID_TOKEN' });
    return;
  }

  let record: any = null;
  try {
    const [rows] = await DB.query(
      `SELECT id, user_id, new_email, expires_at, used_at FROM pending_email_changes WHERE token = ? LIMIT 1`,
      [token]
    );
    record = (rows as any[])[0] || null;
  } catch (err) {
    authLogger.error('confirmEmailChange: lookup failed', err as Error);
    res.status(500).json({ error: 'Could not confirm email change.', code: 'INTERNAL_ERROR' });
    return;
  }

  if (!record) {
    res.status(404).json({ error: 'This confirmation link is invalid.', code: 'TOKEN_NOT_FOUND' });
    return;
  }
  if (record.used_at) {
    res.status(410).json({ error: 'This confirmation link has already been used.', code: 'TOKEN_USED' });
    return;
  }
  if (new Date(record.expires_at) < new Date()) {
    res.status(410).json({ error: 'This confirmation link has expired. Please request a new email change.', code: 'TOKEN_EXPIRED' });
    return;
  }

  const userId = Number(record.user_id);
  const newEmail = String(record.new_email || '').toLowerCase();

  // Re-check uniqueness at apply time (TOCTOU window since the request).
  try {
    const [dupe] = await DB.query('SELECT id FROM users WHERE LOWER(email) = ? AND id != ? LIMIT 1', [newEmail, userId]);
    if ((dupe as any[]).length > 0) {
      await DB.query('UPDATE pending_email_changes SET used_at = NOW() WHERE id = ?', [record.id]);
      res.status(409).json({ error: 'That email address is no longer available.', code: 'EMAIL_IN_USE' });
      return;
    }
  } catch (err) {
    authLogger.error('confirmEmailChange: uniqueness re-check failed', err as Error, { userId });
    res.status(500).json({ error: 'Could not confirm email change.', code: 'INTERNAL_ERROR' });
    return;
  }

  try {
    await DB.query('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?', [newEmail, userId]);
    await DB.query('UPDATE pending_email_changes SET used_at = NOW() WHERE id = ?', [record.id]);
    // Invalidate the user's other pending changes.
    await DB.query(
      `UPDATE pending_email_changes SET used_at = NOW()
       WHERE user_id = ? AND used_at IS NULL AND id != ?`,
      [userId, record.id]
    );
  } catch (err: any) {
    // A race could still trip the users.email UNIQUE constraint.
    if (err?.code === 'ER_DUP_ENTRY') {
      await DB.query('UPDATE pending_email_changes SET used_at = NOW() WHERE id = ?', [record.id]).catch(() => {});
      res.status(409).json({ error: 'That email address is no longer available.', code: 'EMAIL_IN_USE' });
      return;
    }
    authLogger.error('confirmEmailChange: apply failed', err as Error, { userId });
    res.status(500).json({ error: 'Could not confirm email change.', code: 'INTERNAL_ERROR' });
    return;
  }

  await SecurityMonitor.logSecurityEvent(userId, 'email_changed', {
    newEmailHint: newEmail.replace(/^(.).*(@.*)$/, '$1***$2'),
    ipAddress: clientIp(req), userAgent: req.headers['user-agent'] || 'Unknown',
  }, 'high', req.originalUrl || req.url);

  res.status(200).json({ message: 'Your email address has been updated.', email: newEmail });
};

export { TokenManager, SecurityMonitor };