// middleware/authMiddleware.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { DB } from '../config/database';
import { TokenManager, SecurityMonitor } from '../controllers/authController';

// Extend Express Request interface to include user data
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        email: string;
        username: string;
        sessionId: string;
      };
      securityContext?: {
        ipAddress: string;
        userAgent: string;
        tier: 'tier1' | 'tier2' | 'tier3';
        accessReason?: string;
      };
    }
  }
}

// Enhanced JWT payload interface
interface JWTPayload {
  id: number;
  email: string;
  username: string;
  sessionId: string;
  iat?: number;
  exp?: number;
}

// Security levels for different operations
export enum SecurityLevel {
  PUBLIC = 0,       // No authentication required
  BASIC = 1,        // Valid JWT required
  VERIFIED = 2,     // Valid JWT + email verification
  TIER2_ACCESS = 3, // VERIFIED + tier2 data access permissions
  TIER3_ACCESS = 4, // VERIFIED + tier3 data access permissions
  ADMIN = 5         // Admin privileges required
}

// Rate limiting store (in production, use Redis)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

class AuthMiddleware {
  // Basic JWT verification
  static verifyToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({
          error: 'No token provided.',
          code: 'NO_TOKEN'
        });
      }

      const token = authHeader.substring(7);
      
      // Verify and decode token
      const decoded = TokenManager.verifyAccessToken(token);
      
      // Validate session exists and is active
      const isValidSession = await TokenManager.validateSession(decoded.id, decoded.sessionId);
      if (!isValidSession) {
        return res.status(401).json({
          error: 'Session expired or invalid.',
          code: 'SESSION_EXPIRED'
        });
      }

      // Check if user account is locked
      const [userRows] = await DB.query(
        'SELECT account_locked, locked_until, email_verified FROM users WHERE id = ?',
        [decoded.id]
      );
      
      const user = (userRows as any[])[0];
      if (!user) {
        return res.status(401).json({
          error: 'User not found.',
          code: 'USER_NOT_FOUND'
        });
      }

      if (user.account_locked) {
        const now = new Date();
        const lockUntil = new Date(user.locked_until);
        
        if (lockUntil > now) {
          return res.status(423).json({
            error: 'Account is locked.',
            code: 'ACCOUNT_LOCKED',
            lockedUntil: lockUntil.toISOString()
          });
        } else {
          // Auto-unlock expired locks
          await DB.query(
            'UPDATE users SET account_locked = FALSE, locked_until = NULL WHERE id = ?',
            [decoded.id]
          );
        }
      }

      // Set user context
      req.user = {
        id: decoded.id,
        email: decoded.email,
        username: decoded.username,
        sessionId: decoded.sessionId
      };

      // Set security context
      req.securityContext = {
        ipAddress: (req.ip || req.connection.remoteAddress || 'Unknown').replace('::ffff:', ''),
        userAgent: req.headers['user-agent'] || 'Unknown',
        tier: 'tier1' // Default tier, can be elevated by other middleware
      };

      next();
    } catch (error: any) {
      console.error('[AUTH MIDDLEWARE ERROR]', error);
      return res.status(401).json({
        error: 'Invalid token.',
        code: 'INVALID_TOKEN'
      });
    }
  };

  // Email verification requirement
  static requireEmailVerification = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required.',
        code: 'AUTH_REQUIRED'
      });
    }

    try {
      const [userRows] = await DB.query(
        'SELECT email_verified FROM users WHERE id = ?',
        [req.user.id]
      );
      
      const user = (userRows as any[])[0];
      if (!user?.email_verified) {
        return res.status(403).json({
          error: 'Email verification required.',
          code: 'EMAIL_VERIFICATION_REQUIRED'
        });
      }

      next();
    } catch (error) {
      console.error('[EMAIL VERIFICATION CHECK ERROR]', error);
      return res.status(500).json({
        error: 'Verification check failed.',
        code: 'VERIFICATION_CHECK_FAILED'
      });
    }
  };

  // Rate limiting middleware
  static rateLimit = (maxRequests: number, windowMs: number) => {
    return (req: Request, res: Response, next: NextFunction) => {
      const identifier = req.user?.id ? 
        `user_${req.user.id}` : 
        req.securityContext?.ipAddress || 'unknown';
      
      const now = Date.now();
      const windowStart = now - windowMs;
      
      // Get or create rate limit entry
      let limitData = rateLimitStore.get(identifier);
      if (!limitData || limitData.resetTime < windowStart) {
        limitData = { count: 0, resetTime: now + windowMs };
        rateLimitStore.set(identifier, limitData);
      }

      // Check if rate limit exceeded
      if (limitData.count >= maxRequests) {
        // Log rate limit violation
        if (req.user) {
          SecurityMonitor.logSecurityEvent(req.user.id, 'rate_limit_exceeded', {
            identifier,
            count: limitData.count,
            maxRequests,
            windowMs,
            ipAddress: req.securityContext?.ipAddress,
            userAgent: req.securityContext?.userAgent
          }, 'medium');
        }

        return res.status(429).json({
          error: 'Rate limit exceeded.',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: Math.ceil((limitData.resetTime - now) / 1000)
        });
      }

      // Increment counter
      limitData.count++;
      
      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - limitData.count));
      res.setHeader('X-RateLimit-Reset', Math.ceil(limitData.resetTime / 1000));

      next();
    };
  };

  // Tier-based access control
  static requireTierAccess = (tier: 'tier1' | 'tier2' | 'tier3', reason?: string) => {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (!req.user || !req.securityContext) {
        return res.status(401).json({
          error: 'Authentication required.',
          code: 'AUTH_REQUIRED'
        });
      }

      try {
        // Email verification required for tier2 and tier3
        if (tier !== 'tier1') {
          const [userRows] = await DB.query(
            'SELECT email_verified, privacy_level FROM users WHERE id = ?',
            [req.user.id]
          );
          
          const user = (userRows as any[])[0];
          if (!user?.email_verified) {
            return res.status(403).json({
              error: 'Email verification required for sensitive data access.',
              code: 'EMAIL_VERIFICATION_REQUIRED'
            });
          }
        }

        // Additional security checks for tier3
        if (tier === 'tier3') {
          // Check for suspicious activity in the last hour
          const [suspiciousActivity] = await DB.query(`
            SELECT COUNT(*) as count FROM security_events 
            WHERE user_id = ? 
            AND event_type IN ('suspicious_login_attempt', 'suspicious_data_access_pattern')
            AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
          `, [req.user.id]);

          if ((suspiciousActivity as any[])[0].count > 0) {
            // Log the blocked access attempt
            await SecurityMonitor.logSecurityEvent(req.user.id, 'tier3_access_blocked', {
              reason: 'suspicious_activity_detected',
              tier,
              requestedResource: req.path,
              ipAddress: req.securityContext.ipAddress,
              userAgent: req.securityContext.userAgent
            }, 'high');

            return res.status(403).json({
              error: 'Access temporarily restricted due to security concerns.',
              code: 'SECURITY_RESTRICTION'
            });
          }
        }

        // Update security context
        req.securityContext.tier = tier;
        req.securityContext.accessReason = reason;

        // Log data access attempt
        await DB.query(`
          INSERT INTO data_access_log (
            user_id, accessed_by, data_tier, file_path, access_type, 
            access_reason, ip_address, user_agent, session_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          req.user.id,
          req.user.id,
          tier,
          req.path,
          req.method.toLowerCase() === 'get' ? 'read' : 'write',
          reason || 'api_access',
          req.securityContext.ipAddress,
          req.securityContext.userAgent,
          req.user.sessionId
        ]);

        next();
      } catch (error) {
        console.error('[TIER ACCESS CHECK ERROR]', error);
        return res.status(500).json({
          error: 'Access check failed.',
          code: 'ACCESS_CHECK_FAILED'
        });
      }
    };
  };

  // Admin access requirement
  static requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required.',
        code: 'AUTH_REQUIRED'
      });
    }

    try {
      const [adminRows] = await DB.query(
        'SELECT role FROM users WHERE id = ? AND role = "admin"',
        [req.user.id]
      );
      
      if ((adminRows as any[]).length === 0) {
        // Log unauthorized admin access attempt
        await SecurityMonitor.logSecurityEvent(req.user.id, 'unauthorized_admin_access', {
          requestedResource: req.path,
          ipAddress: req.securityContext?.ipAddress,
          userAgent: req.securityContext?.userAgent
        }, 'high');

        return res.status(403).json({
          error: 'Admin privileges required.',
          code: 'INSUFFICIENT_PRIVILEGES'
        });
      }

      next();
    } catch (error) {
      console.error('[ADMIN CHECK ERROR]', error);
      return res.status(500).json({
        error: 'Admin check failed.',
        code: 'ADMIN_CHECK_FAILED'
      });
    }
  };

  // Security-level-based middleware factory
  static requireSecurityLevel = (level: SecurityLevel, options?: {
    reason?: string;
    tier?: 'tier1' | 'tier2' | 'tier3';
    rateLimit?: { maxRequests: number; windowMs: number };
  }) => {
    const middlewares: any[] = [];

    // Add rate limiting if specified
    if (options?.rateLimit) {
      middlewares.push(AuthMiddleware.rateLimit(
        options.rateLimit.maxRequests,
        options.rateLimit.windowMs
      ));
    }

    // Add authentication based on security level
    if (level >= SecurityLevel.BASIC) {
      middlewares.push(AuthMiddleware.verifyToken);
    }

    if (level >= SecurityLevel.VERIFIED) {
      middlewares.push(AuthMiddleware.requireEmailVerification);
    }

    if (level >= SecurityLevel.TIER2_ACCESS || options?.tier === 'tier2') {
      middlewares.push(AuthMiddleware.requireTierAccess('tier2', options?.reason));
    }

    if (level >= SecurityLevel.TIER3_ACCESS || options?.tier === 'tier3') {
      middlewares.push(AuthMiddleware.requireTierAccess('tier3', options?.reason));
    }

    if (level >= SecurityLevel.ADMIN) {
      middlewares.push(AuthMiddleware.requireAdmin);
    }

    return middlewares;
  };

  // Activity logging middleware
  static logActivity = (action: string) => {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (req.user) {
        try {
          await DB.query(`
            INSERT INTO activity_logs (user_id, action, details, ip_address, user_agent, session_id) 
            VALUES (?, ?, ?, ?, ?, ?)
          `, [
            req.user.id,
            action,
            JSON.stringify({
              path: req.path,
              method: req.method,
              query: req.query,
              tier: req.securityContext?.tier
            }),
            req.securityContext?.ipAddress,
            req.securityContext?.userAgent,
            req.user.sessionId
          ]);
        } catch (error) {
          console.error('[ACTIVITY LOGGING ERROR]', error);
          // Don't block the request if logging fails
        }
      }
      next();
    };
  };

  // Security headers middleware
  static securityHeaders = (req: Request, res: Response, next: NextFunction) => {
    // Set security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    
    // HSTS header for HTTPS
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }
    
    // CSP header
    res.setHeader('Content-Security-Policy', 
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; " +
      "font-src 'self' https:; " +
      "connect-src 'self'; " +
      "frame-ancestors 'none';"
    );

    next();
  };
}

// Cleanup function for rate limiting store
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (data.resetTime < now) {
      rateLimitStore.delete(key);
    }
  }
}, 60000); // Clean up every minute

export default AuthMiddleware;
export { SecurityLevel };
