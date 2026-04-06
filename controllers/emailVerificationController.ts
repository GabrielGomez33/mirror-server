// ============================================================================
// EMAIL VERIFICATION CONTROLLER
// ============================================================================
// File: controllers/emailVerificationController.ts
// Handles email verification token generation, sending, and validation.
// Depends on: emailService (Phase 0.1), email_verification_tokens table (schema)
// ============================================================================

import crypto from 'crypto';
import { RequestHandler } from 'express';
import { DB } from '../db';
import { emailService } from '../services/emailService';
import { Logger } from '../utils/logger';

const logger = new Logger('EmailVerification');

// ============================================================================
// CONSTANTS
// ============================================================================

const TOKEN_LENGTH = 32; // 32 bytes = 64 hex chars
const TOKEN_EXPIRY_HOURS = 24;
const RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between resends
const MAX_ACTIVE_TOKENS = 5; // Max pending tokens per user (prevent spam)

// ============================================================================
// SEND VERIFICATION EMAIL
// ============================================================================

/**
 * POST /mirror/api/auth/send-verification
 *
 * Generates a verification token, stores it in email_verification_tokens,
 * and sends a verification email to the user.
 *
 * Requires: authenticated user (req.user set by verifyToken middleware)
 *
 * Edge cases handled:
 * - Already verified: returns success without sending
 * - Rate limiting: 1 minute cooldown between sends
 * - Token cap: max 5 pending tokens per user
 * - Email service down: returns error with retry guidance
 */
export const sendVerificationEmail: RequestHandler = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      return;
    }

    // Get user info
    const [userRows] = await DB.query(
      'SELECT email, email_verified, username FROM users WHERE id = ?',
      [userId]
    );
    const user = (userRows as any[])[0];

    if (!user) {
      res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      return;
    }

    // Already verified
    if (user.email_verified) {
      res.json({
        message: 'Email is already verified',
        verified: true,
      });
      return;
    }

    // Rate limit: check last token creation time
    const [recentTokens] = await DB.query(`
      SELECT created_at FROM email_verification_tokens
      WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
    `, [userId]);

    if ((recentTokens as any[]).length > 0) {
      const lastSent = new Date((recentTokens as any[])[0].created_at).getTime();
      const elapsed = Date.now() - lastSent;
      if (elapsed < RESEND_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
        res.status(429).json({
          error: `Please wait ${waitSeconds} seconds before requesting another verification email`,
          code: 'RATE_LIMITED',
          retryAfter: waitSeconds,
        });
        return;
      }
    }

    // Token cap: prevent spam
    const [tokenCount] = await DB.query(`
      SELECT COUNT(*) as count FROM email_verification_tokens
      WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW()
    `, [userId]);

    if ((tokenCount as any[])[0].count >= MAX_ACTIVE_TOKENS) {
      // Invalidate old tokens
      await DB.query(`
        DELETE FROM email_verification_tokens
        WHERE user_id = ? AND used_at IS NULL
      `, [userId]);
    }

    // Generate token
    const token = crypto.randomBytes(TOKEN_LENGTH).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

    // Store token
    await DB.query(`
      INSERT INTO email_verification_tokens (user_id, token, expires_at)
      VALUES (?, ?, ?)
    `, [userId, token, expiresAt]);

    // Build verification URL
    const appUrl = process.env.APP_URL || 'https://www.theundergroundrailroad.world/Mirror';
    const verificationUrl = `${appUrl}/verify-email?token=${token}`;

    // Send email
    const result = await emailService.sendTemplate(user.email, 'email_verification', {
      username: user.username || 'there',
      verificationUrl,
    });

    if (!result.success) {
      logger.error('Failed to send verification email', new Error(result.error || 'Unknown'), {
        userId,
        email: user.email,
      });

      res.status(503).json({
        error: 'Could not send verification email. Please try again in a few minutes.',
        code: 'EMAIL_SEND_FAILED',
      });
      return;
    }

    logger.info('Verification email sent', { userId, email: user.email });

    res.json({
      message: 'Verification email sent. Check your inbox.',
      expiresIn: `${TOKEN_EXPIRY_HOURS} hours`,
    });

  } catch (error: any) {
    logger.error('Send verification error', error);
    res.status(500).json({
      error: 'Failed to send verification email',
      code: 'INTERNAL_ERROR',
    });
  }
};

// ============================================================================
// VERIFY EMAIL TOKEN
// ============================================================================

/**
 * POST /mirror/api/auth/verify-email
 * Body: { token: string }
 *
 * Validates the token, marks email as verified, invalidates the token.
 *
 * Edge cases handled:
 * - Invalid/missing token
 * - Expired token
 * - Already used token
 * - Already verified user (idempotent — still returns success)
 * - Token for deleted user
 */
export const verifyEmailToken: RequestHandler = async (req, res) => {
  try {
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      res.status(400).json({
        error: 'Verification token is required',
        code: 'MISSING_TOKEN',
      });
      return;
    }

    // Basic format validation (should be 64 hex chars)
    if (!/^[a-f0-9]{64}$/.test(token)) {
      res.status(400).json({
        error: 'Invalid token format',
        code: 'INVALID_TOKEN',
      });
      return;
    }

    // Look up token
    const [tokenRows] = await DB.query(`
      SELECT t.id, t.user_id, t.expires_at, t.used_at, u.email, u.email_verified, u.username
      FROM email_verification_tokens t
      JOIN users u ON t.user_id = u.id
      WHERE t.token = ?
    `, [token]);

    const tokenRecord = (tokenRows as any[])[0];

    if (!tokenRecord) {
      res.status(404).json({
        error: 'Verification token not found or already expired',
        code: 'TOKEN_NOT_FOUND',
      });
      return;
    }

    // Already used
    if (tokenRecord.used_at) {
      // If the user is already verified, return success (idempotent)
      if (tokenRecord.email_verified) {
        res.json({
          message: 'Email is already verified',
          verified: true,
        });
        return;
      }

      res.status(410).json({
        error: 'This verification link has already been used. Request a new one.',
        code: 'TOKEN_USED',
      });
      return;
    }

    // Expired
    if (new Date(tokenRecord.expires_at) < new Date()) {
      res.status(410).json({
        error: 'This verification link has expired. Request a new one.',
        code: 'TOKEN_EXPIRED',
      });
      return;
    }

    // Mark token as used
    await DB.query(
      'UPDATE email_verification_tokens SET used_at = NOW() WHERE id = ?',
      [tokenRecord.id]
    );

    // Mark user email as verified
    await DB.query(
      'UPDATE users SET email_verified = 1 WHERE id = ?',
      [tokenRecord.user_id]
    );

    // Invalidate all other pending tokens for this user
    await DB.query(`
      UPDATE email_verification_tokens SET used_at = NOW()
      WHERE user_id = ? AND used_at IS NULL AND id != ?
    `, [tokenRecord.user_id, tokenRecord.id]);

    // Log the verification
    try {
      await DB.query(`
        INSERT INTO activity_logs (user_id, action, metadata, risk_level, page_url, created_at)
        VALUES (?, 'email_verified', ?, 'low', '/verify-email', NOW())
      `, [tokenRecord.user_id, JSON.stringify({ email: tokenRecord.email })]);
    } catch {
      // Non-blocking
    }

    logger.info('Email verified', {
      userId: tokenRecord.user_id,
      email: tokenRecord.email,
    });

    // Send welcome email now that they're verified
    await emailService.queueEmail(tokenRecord.email, 'welcome', {
      username: tokenRecord.username || 'there',
    });

    res.json({
      message: 'Email verified successfully!',
      verified: true,
    });

  } catch (error: any) {
    logger.error('Email verification error', error);
    res.status(500).json({
      error: 'Verification failed. Please try again.',
      code: 'INTERNAL_ERROR',
    });
  }
};

// ============================================================================
// CHECK VERIFICATION STATUS
// ============================================================================

/**
 * GET /mirror/api/auth/verification-status
 *
 * Returns the current email verification status for the authenticated user.
 * Used by the frontend to show/hide the verification banner.
 */
export const getVerificationStatus: RequestHandler = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      return;
    }

    const [userRows] = await DB.query(
      'SELECT email, email_verified FROM users WHERE id = ?',
      [userId]
    );
    const user = (userRows as any[])[0];

    if (!user) {
      res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      return;
    }

    // Check if there's a pending verification token
    const [pendingTokens] = await DB.query(`
      SELECT created_at, expires_at FROM email_verification_tokens
      WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1
    `, [userId]);

    const hasPendingToken = (pendingTokens as any[]).length > 0;
    const lastSentAt = hasPendingToken ? (pendingTokens as any[])[0].created_at : null;

    res.json({
      email: user.email,
      verified: !!user.email_verified,
      pendingVerification: hasPendingToken,
      lastSentAt,
      canResend: !hasPendingToken || (
        lastSentAt && (Date.now() - new Date(lastSentAt).getTime()) > RESEND_COOLDOWN_MS
      ),
    });

  } catch (error: any) {
    logger.error('Verification status check error', error);
    res.status(500).json({
      error: 'Failed to check verification status',
      code: 'INTERNAL_ERROR',
    });
  }
};
