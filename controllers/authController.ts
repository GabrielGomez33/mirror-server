// controllers/authController.ts
//
// CHANGES vs previous version (Phase 0.3):
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
import { createUserInDB, userLogin, fetchUserInfo } from './userController';
import { writeToTier } from './directoryController';
import { DB } from '../db';
import { emailService } from '../services/emailService';
import { Logger } from '../utils/logger';

const authLogger = new Logger('AuthController');

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
): Promise<{ emailVerified: boolean; intakeCompleted: boolean; subscriptionStatus: 'free' | 'premium' | 'enterprise' }> {
  try {
    const [rows] = await DB.query(
      `SELECT email_verified, intake_completed FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    const row = (rows as any[])[0] || {};

    // subscriptionStatus is computed from the paywall table when available,
    // otherwise defaults to 'free'. We avoid failing the whole call if the
    // paywall tables are missing in older environments.
    let subscriptionStatus: 'free' | 'premium' | 'enterprise' = 'free';
    try {
      const [subRows] = await DB.query(
        `SELECT tier FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing','past_due') ORDER BY id DESC LIMIT 1`,
        [userId]
      );
      const tier = (subRows as any[])[0]?.tier;
      if (tier === 'premium' || tier === 'enterprise') subscriptionStatus = tier;
    } catch {
      // paywall not installed — leave as 'free'
    }

    return {
      emailVerified: Boolean(row.email_verified),
      intakeCompleted: Boolean(row.intake_completed),
      subscriptionStatus,
    };
  } catch {
    return { emailVerified: false, intakeCompleted: false, subscriptionStatus: 'free' };
  }
}

// ============================================================================
// REGISTER
// ============================================================================
export const registerUser: RequestHandler = async (req, res) => {
  const startTime = Date.now();
  console.log('[REGISTRATION] Starting registration process');

  try {
    const { username, email, password, deviceFingerprint } = req.body ?? {};

    if (!username || !email || !password) {
      res.status(400).json({
        error: 'All fields are required.',
        code: 'MISSING_FIELDS'
      });
      return;
    }

    if (typeof password !== 'string' || password.length < 8 ||
        !/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/.test(password)) {
      res.status(400).json({
        error: 'Password must be at least 8 characters with uppercase, lowercase, number, and special character.',
        code: 'WEAK_PASSWORD'
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

    if (error.message === 'EMAIL_ALREADY_REGISTERED') {
      res.status(409).json({ error: 'Email already registered.', code: 'EMAIL_EXISTS' });
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
    const { email, password, deviceFingerprint } = req.body ?? {};

    if (!email || !password) {
      res.status(400).json({
        error: 'Email and password are required.',
        code: 'MISSING_CREDENTIALS'
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

    // Verify credentials
    await userLogin(email, password);

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
        email: decoded.email,
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

export { TokenManager, SecurityMonitor };
