
// controllers/authController.ts
import { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { createUserInDB, userLogin, fetchUserInfo } from './userController';
import { writeToTier, readFromTier } from './directoryController';
import { DB } from '../db';

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
  private static readonly SESSION_EXPIRY = '24h';

  // Generate secure session ID
  static generateSessionId(): string {
    const crypto = require('crypto');
    return crypto.randomBytes(32).toString('hex');
  }

  // Create access token (short-lived)
  static createAccessToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
    return jwt.sign(payload, this.JWT_SECRET, {
      expiresIn: this.ACCESS_TOKEN_EXPIRY,
      algorithm: 'HS256'
    });
  }

  // Create refresh token (long-lived)
  static createRefreshToken(payload: { id: number; sessionId: string }): string {
    return jwt.sign(payload, this.JWT_REFRESH_SECRET, {
      expiresIn: this.REFRESH_TOKEN_EXPIRY,
      algorithm: 'HS256'
    });
  }

  // Verify access token
  static verifyAccessToken(token: string): JWTPayload {
    try {
      return jwt.verify(token, this.JWT_SECRET) as JWTPayload;
    } catch (error) {
      throw new Error('Invalid or expired access token');
    }
  }

  // Verify refresh token
  static verifyRefreshToken(token: string): { id: number; sessionId: string } {
    try {
      return jwt.verify(token, this.JWT_REFRESH_SECRET) as { id: number; sessionId: string };
    } catch (error) {
      throw new Error('Invalid or expired refresh token');
    }
  }

  // Store session in database with security metadata
  static async createSession(userId: number, sessionId: string, metadata: {
    userAgent?: string;
    ipAddress?: string;
    fingerprint?: string;
  }): Promise<void> {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

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

    // Store session data in encrypted tier2 storage
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

    // Fix: Convert userId to string for writeToTier
    await writeToTier(userId.toString(), 'tier2', `session_${sessionId}.json`, JSON.stringify(sessionData));
  }

  // Validate session exists and is active
  static async validateSession(userId: number, sessionId: string): Promise<boolean> {
    const [rows] = await DB.query(`
      SELECT id FROM user_sessions
      WHERE user_id = ? AND session_id = ? AND expires_at > NOW() AND revoked = FALSE
    `, [userId, sessionId]);

    return (rows as any[]).length > 0;
  }

  // Revoke specific session
  static async revokeSession(userId: number, sessionId: string): Promise<void> {
    await DB.query(`
      UPDATE user_sessions
      SET revoked = TRUE, revoked_at = NOW()
      WHERE user_id = ? AND session_id = ?
    `, [userId, sessionId]);
  }

  // Revoke all sessions for user (security breach response)
  static async revokeAllUserSessions(userId: number): Promise<void> {
    await DB.query(`
      UPDATE user_sessions
      SET revoked = TRUE, revoked_at = NOW()
      WHERE user_id = ? AND revoked = FALSE
    `, [userId]);
  }

  // Clean expired sessions
  static async cleanExpiredSessions(): Promise<void> {
    await DB.query(`
      DELETE FROM user_sessions
      WHERE expires_at < NOW() OR (revoked = TRUE AND revoked_at < DATE_SUB(NOW(), INTERVAL 30 DAY))
    `);
  }
}

// Security monitoring utilities
class SecurityMonitor {
  // Log security events to activity_logs and tier3 storage
  static async logSecurityEvent(userId: number | null, event: string, details: any, risk: 'low' | 'medium' | 'high', requestUrl:string='NULL'): Promise<void> {
    // Database logging
    await DB.query(`
      INSERT INTO activity_logs (user_id, action, metadata, risk_level, page_url, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())
    `, [userId, event, JSON.stringify(details), risk, requestUrl ]); // Changed 'details' to 'metadata'

    // Tier3 encrypted storage for high-risk events
    if (risk === 'high') {
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
    }
  }

  // Detect suspicious login patterns
  static async detectSuspiciousActivity(userId: number, ipAddress: string, userAgent: string): Promise<boolean> {
    // Check for multiple failed attempts
    const [failedAttempts] = await DB.query(`
      SELECT COUNT(*) as count FROM activity_logs
      WHERE user_id = ? AND action = 'failed_login'
      AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `, [userId]);

    if ((failedAttempts as any[])[0].count >= 5) {
      return true;
    }

    // Check for login from new location/device
    const [recentLogins] = await DB.query(`
      SELECT DISTINCT ip_address, user_agent FROM user_sessions
      WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
    `, [userId]);

    const knownIPs = (recentLogins as any[]).map(r => r.ip_address);
    const knownAgents = (recentLogins as any[]).map(r => r.user_agent);

    const isNewIP = !knownIPs.includes(ipAddress);
    const isNewAgent = !knownAgents.includes(userAgent) && userAgent !== 'Unknown';

    return isNewIP || isNewAgent;
  }
}

// Enhanced registration endpoint
export const registerUser: RequestHandler = async (req, res) => {
  const startTime = Date.now();
  console.log('[REGISTRATION] Starting registration process');

  try {
    const { username, email, password, deviceFingerprint } = req.body;

    // Enhanced validation
    if (!username || !email || !password) {
      res.status(400).json({ // Removed 'return' here
        error: 'All fields are required.',
        code: 'MISSING_FIELDS'
      });
      return; // Keep return to prevent further execution
    }

    // Password strength validation
    if (password.length < 8 || !/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/.test(password)) {
      res.status(400).json({ // Removed 'return' here
        error: 'Password must be at least 8 characters with uppercase, lowercase, number, and special character.',
        code: 'WEAK_PASSWORD'
      });
      return; // Keep return to prevent further execution
    }

    const userId = await createUserInDB(username, email, password);

    // Generate initial session
    const sessionId = TokenManager.generateSessionId();
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const ipAddress = (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', '');

    await TokenManager.createSession(userId, sessionId, {
      userAgent,
      ipAddress,
      fingerprint: deviceFingerprint
    });

    // Log successful registration
    await SecurityMonitor.logSecurityEvent(userId, 'user_registered', {
      username,
      email,
      ipAddress,
      userAgent,
      registrationTime: Date.now() - startTime
    }, 'low', req.url);

    // Get user info with username
    const userInfo = await fetchUserInfo(email);
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

    // Store initial user preferences in tier1
    const initialUserData = {
      username,
      email,
      registeredAt: new Date().toISOString(),
      preferences: {
        theme: 'cosmic',
        notifications: true,
        privacy: 'medium'
      }
    };
    await writeToTier(userId.toString(), 'tier1', 'profile.json', JSON.stringify(initialUserData));

    res.status(201).json({ // Removed 'return' here
      message: 'User registered successfully.',
      user: {
        id: userInfo.id,
        username: userInfo.username,
        email: userInfo.email
      },
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: 900 // 15 minutes
      }
    });
	}// controllers/authController.ts
	// ... (rest of your imports and code)
	
	// Inside the registerUser catch block
	catch (error: any) {
	    console.error('[REGISTRATION ERROR]', error);
	
	    // Log failed registration attempt (without a user_id if registration failed due to email conflict)
	    // REMOVED: const currentURL = window.location.href; // This line causes the error
	    // Use req.originalUrl or construct the URL from req
	    const pageUrl = req.originalUrl || req.url; // Get the URL path from the request
	    const ipAddress = (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', '');
	
	    await DB.query(`
	      INSERT INTO activity_logs (user_id, action, metadata, risk_level, page_url, created_at)
	      VALUES (NULL, 'failed_registration', ?, 'medium', ?, NOW())
	    `, [
	        JSON.stringify({
	            error: error.message,
	            email: req.body.email,
	            ipAddress,
	            userAgent: req.headers['user-agent']
	        }),
	        pageUrl // Pass pageUrl as a parameter
	    ]);
	
	    if (error.message === 'EMAIL_ALREADY_REGISTERED') {
	        res.status(409).json({
	            error: 'Email already registered.',
	            code: 'EMAIL_EXISTS'
	        });
	        return;
	    }
	
	    res.status(500).json({
	        error: 'Registration failed. Please try again.',
	        code: 'REGISTRATION_FAILED'
	    });
	}
  
};

// Enhanced login endpoint
export const loginUser: RequestHandler = async (req, res) => {
  const startTime = Date.now();

  try {
    const { email, password, deviceFingerprint, rememberMe } = req.body;

    if (!email || !password) {
      res.status(400).json({ // Removed 'return' here
        error: 'Email and password are required.',
        code: 'MISSING_CREDENTIALS'
      });
      return; // Keep return to prevent further execution
    }

    const userAgent = req.headers['user-agent'] || 'Unknown';
    const ipAddress = (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', '');

    // Get user info first
    const userInfo = await fetchUserInfo(email);

    // Check for suspicious activity
    const isSuspicious = await SecurityMonitor.detectSuspiciousActivity(
      userInfo.id,
      ipAddress,
      userAgent
    );

    if (isSuspicious) {
      await SecurityMonitor.logSecurityEvent(userInfo.id, 'suspicious_login_attempt', {
        ipAddress,
        userAgent,
        deviceFingerprint
      }, 'high');
    }

    // Verify credentials
    const token = await userLogin(email, password);

    // Create new session
    const sessionId = TokenManager.generateSessionId();
    await TokenManager.createSession(userInfo.id, sessionId, {
      userAgent,
      ipAddress,
      fingerprint: deviceFingerprint
    });

    // Create tokens
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

    // Log successful login
    await SecurityMonitor.logSecurityEvent(userInfo.id, 'successful_login', {
      ipAddress,
      userAgent,
      deviceFingerprint,
      loginTime: Date.now() - startTime,
      suspicious: isSuspicious
    }, isSuspicious ? 'medium' : 'low');

    res.status(200).json({ // Removed 'return' here
      message: 'Login successful.',
      user: {
        id: userInfo.id,
        username: userInfo.username,
        email: userInfo.email,
        lastLogin: new Date().toISOString()
      },
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: 900 // 15 minutes
      },
      security: {
        suspicious: isSuspicious,
        newDevice: !isSuspicious
      }
    });
    // No return needed here.

  } catch (error: any) {
    console.error('[LOGIN ERROR]', error);

    const ipAddress = (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', '');
    const userAgent = req.headers['user-agent'];

    // Log failed login
    try {
      const userInfo = await fetchUserInfo(req.body.email);
      await SecurityMonitor.logSecurityEvent(userInfo.id, 'failed_login', {
        ipAddress,
        userAgent,
        error: error.message
      }, 'medium');
    } catch (e) {
      // User doesn't exist - log as general failed attempt with NULL user_id
      await DB.query(`
        INSERT INTO activity_logs (user_id, action, metadata, risk_level, created_at)
        VALUES (NULL, 'failed_login_unknown_email', ?, 'medium', NOW())
      `, [JSON.stringify({ // Changed 'details' to 'metadata'
        email: req.body.email,
        ipAddress,
        userAgent,
        error: error.message
      })]);
    }

    res.status(401).json({ // Removed 'return' here
      error: error.message === 'ACCOUNT_LOCKED' ? 'Your account is locked.' :
             error.message === 'EMAIL_NOT_VERIFIED' ? 'Please verify your email to log in.' :
             'Invalid credentials.',
      code: error.message === 'ACCOUNT_LOCKED' ? 'ACCOUNT_LOCKED' :
            error.message === 'EMAIL_NOT_VERIFIED' ? 'EMAIL_NOT_VERIFIED' :
            'INVALID_CREDENTIALS'
    });
    // No return needed here.
  }
};

// Token refresh endpoint
export const refreshToken: RequestHandler = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      res.status(400).json({ // Removed 'return' here
        error: 'Refresh token is required.',
        code: 'MISSING_REFRESH_TOKEN'
      });
      return; // Keep return to prevent further execution
    }

    // Verify refresh token
    const decoded = TokenManager.verifyRefreshToken(refreshToken);

    // Validate session is still active
    const isValidSession = await TokenManager.validateSession(decoded.id, decoded.sessionId);
    if (!isValidSession) {
      res.status(401).json({ // Removed 'return' here
        error: 'Session expired or invalid.',
        code: 'INVALID_SESSION'
      });
      return; // Keep return to prevent further execution
    }

    // Get fresh user info
    const [userRows] = await DB.query('SELECT id, email, username FROM users WHERE id = ?', [decoded.id]);
    const user = (userRows as any[])[0];

    if (!user) {
      res.status(401).json({ // Removed 'return' here
        error: 'User not found.',
        code: 'USER_NOT_FOUND'
      });
      return; // Keep return to prevent further execution
    }

    // Create new access token
    const newAccessToken = TokenManager.createAccessToken({
      id: user.id,
      email: user.email,
      username: user.username,
      sessionId: decoded.sessionId
    });

    res.status(200).json({ // Removed 'return' here
      accessToken: newAccessToken,
      expiresIn: 900
    });
    // No return needed here.

  } catch (error: any) {
    console.error('[REFRESH TOKEN ERROR]', error);
    res.status(401).json({ // Removed 'return' here
      error: 'Invalid refresh token.',
      code: 'INVALID_REFRESH_TOKEN'
    });
    // No return needed here.
  }
};

// Logout endpoint
export const logoutUser: RequestHandler = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ // Removed 'return' here
        error: 'No token provided.',
        code: 'NO_TOKEN'
      });
      return; // Keep return to prevent further execution
    }

    const token = authHeader.substring(7);
    const decoded = TokenManager.verifyAccessToken(token);

    // Revoke the session
    await TokenManager.revokeSession(decoded.id, decoded.sessionId);

    // Log logout
    await SecurityMonitor.logSecurityEvent(decoded.id, 'user_logout', {
      sessionId: decoded.sessionId,
      ipAddress: (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', ''),
      userAgent: req.headers['user-agent']
    }, 'low');

    res.status(200).json({ // Removed 'return' here
      message: 'Logged out successfully.'
    });
    // No return needed here.

  } catch (error: any) {
    console.error('[LOGOUT ERROR]', error);
    res.status(200).json({ // Removed 'return' here
      message: 'Logged out successfully, but an internal error occurred during logging.'
    });
    // No return needed here.
  }
};

// Logout from all devices
export const logoutAllDevices: RequestHandler = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ // Removed 'return' here
        error: 'No token provided.',
        code: 'NO_TOKEN'
      });
      return; // Keep return to prevent further execution
    }

    const token = authHeader.substring(7);
    const decoded = TokenManager.verifyAccessToken(token);

    // Revoke all sessions
    await TokenManager.revokeAllUserSessions(decoded.id);

    // Log security action
    await SecurityMonitor.logSecurityEvent(decoded.id, 'logout_all_devices', {
      ipAddress: (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', ''),
      userAgent: req.headers['user-agent']
    }, 'medium');

    res.status(200).json({ // Removed 'return' here
      message: 'Logged out from all devices successfully.'
    });
    // No return needed here.

  } catch (error: any) {
    console.error('[LOGOUT ALL ERROR]', error);
    res.status(500).json({ // Removed 'return' here
      error: 'Failed to logout from all devices.',
      code: 'LOGOUT_ALL_FAILED'
    });
    // No return needed here.
  }
};

// Verify token endpoint (for client-side checks)
export const verifyToken: RequestHandler = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ // Removed 'return' here
        valid: false,
        error: 'No token provided.',
        code: 'NO_TOKEN'
      });
      return; // Keep return to prevent further execution
    }

    const token = authHeader.substring(7);
    const decoded = TokenManager.verifyAccessToken(token);

    // Validate session
    const isValidSession = await TokenManager.validateSession(decoded.id, decoded.sessionId);
    if (!isValidSession) {
      res.status(401).json({ // Removed 'return' here
        valid: false,
        error: 'Session expired.',
        code: 'INVALID_SESSION'
      });
      return; // Keep return to prevent further execution
    }

    res.status(200).json({ // Removed 'return' here
      valid: true,
      user: {
        id: decoded.id,
        email: decoded.email,
        username: decoded.username
      },
      expiresAt: new Date(decoded.exp! * 1000).toISOString()
    });
    // No return needed here.

  } catch (error: any) {
    res.status(401).json({ // Removed 'return' here
      valid: false,
      error: 'Invalid token.',
      code: 'INVALID_TOKEN'
    });
    // No return needed here.
  }
};

// Cleanup utility (should be run periodically)
export const cleanupSessions: RequestHandler = async (req, res) => {
  try {
    await TokenManager.cleanExpiredSessions();
    res.status(200).json({ message: 'Sessions cleaned up successfully.' }); // Removed 'return' here
    // No return needed here.
  } catch (error) {
    console.error('[CLEANUP ERROR]', error);
    res.status(500).json({ error: 'Cleanup failed.' }); // Removed 'return' here
    // No return needed here.
  }
};

export { TokenManager, SecurityMonitor };
