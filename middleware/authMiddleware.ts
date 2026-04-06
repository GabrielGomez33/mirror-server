// middleware/authMiddleware.ts
// UPDATED: Extended with subscription-aware route gating.
// Existing tier1/tier2/tier3 data access tiers preserved.
// Added: subscription hydration, premium tier gating, usage limit enforcement.
// All subscription rules driven by .payenv config — zero changes to route files needed.

import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { DB } from '../db';
import { TokenManager, SecurityMonitor } from '../controllers/authController';

// Extend Express Request interface to include user data and subscription
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
      subscription?: import('../paywall/types').SubscriptionWithUsage;
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

// ============================================================================
// SUBSCRIPTION TIER ORDERING (for premium gating)
// ============================================================================

type SubscriptionTier = 'free' | 'premium' | 'enterprise';

const SUBSCRIPTION_TIER_ORDER: Record<SubscriptionTier, number> = {
  free: 0,
  premium: 1,
  enterprise: 2,
};

// ============================================================================
// SUBSCRIPTION ROUTE GATE MAP
// ============================================================================
// Maps URL patterns + HTTP methods to subscription tier requirements.
// Checked by the subscriptionGate middleware on every authenticated request.
// Patterns support:
//   Exact:    '/journal/analyze' matches only that path
//   Wildcard: '/groups/*/insights/generate-insights' matches any group ID
//   Param:    ':id' matches any segment
//
// Rules are checked top-to-bottom — first match wins. More specific patterns
// should appear before broader ones.
//
// Rules with usageLimitKey enforce free-tier limits instead of hard gates.
// Premium users bypass all usage limits automatically.
// ============================================================================

interface SubscriptionGateRule {
  pattern: string;
  methods: string[];
  requiredTier: SubscriptionTier;
  featureName: string;
  usageLimitKey?: string;
  usagePeriodType?: 'daily' | 'monthly';
}

// Default rules — can be overridden by setSubscriptionGateRules() from paywall config
let subscriptionGateRules: SubscriptionGateRule[] = [];

// Service reference for subscription lookups — set once during initialization
let subscriptionServiceRef: any = null;

// ============================================================================
// RATE LIMITING
// ============================================================================
// In-memory rate limiting store.
// For multi-instance deployments, migrate to Redis using:
//   const key = `ratelimit:${identifier}:${Math.floor(Date.now() / windowMs)}`;
//   const count = await redis.incr(key);
//   await redis.expire(key, Math.ceil(windowMs / 1000));
// ============================================================================
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

class AuthMiddleware {

  // ==========================================================================
  // PAYWALL INTEGRATION — Configuration methods
  // ==========================================================================

  /**
   * Set the subscription gate rules. Called once during server startup
   * after loading .payenv config.
   */
  static setSubscriptionGateRules(rules: SubscriptionGateRule[]): void {
    subscriptionGateRules = rules;
    console.log(`[AUTH] Subscription gate rules loaded: ${rules.length} rules for ${rules.map(r => r.featureName).join(', ')}`);
  }

  /**
   * Set the subscription service reference for DB/cache lookups.
   * Called once during server startup.
   */
  static setSubscriptionService(service: any): void {
    subscriptionServiceRef = service;
  }

  /**
   * Build default subscription gate rules from paywall config.
   * Call this with your loaded PaywallConfig to generate rules automatically.
   */
  static buildGateRulesFromConfig(gates: Record<string, string>): SubscriptionGateRule[] {
    const rules: SubscriptionGateRule[] = [
      // JOURNAL — usage limited for free, analysis gated to premium
      // Mounted at /mirror/api/journal, route is POST /entry
      {
        pattern: '/journal/entry',
        methods: ['POST'],
        requiredTier: 'free',
        featureName: 'limited_journal',
        usageLimitKey: 'journal_entries_per_month',
        usagePeriodType: 'monthly',
      },
      {
        pattern: '/journal/analyze',
        methods: ['POST'],
        requiredTier: (gates['journal_analysis'] as SubscriptionTier) || 'premium',
        featureName: 'journal_analysis',
      },

      // PERSONAL ANALYSIS
      // Mounted at /mirror/api/personal-analysis, route is POST /generate
      {
        pattern: '/personal-analysis/generate',
        methods: ['POST'],
        requiredTier: (gates['personal_analysis'] as SubscriptionTier) || 'premium',
        featureName: 'personal_analysis',
      },

      // GROUPS — create is premium, join is usage-limited
      // Mounted at /mirror/api/groups, route is POST /create
      {
        pattern: '/groups/create',
        methods: ['POST'],
        requiredTier: (gates['create_group'] as SubscriptionTier) || 'premium',
        featureName: 'create_group',
      },
      // Mounted at /mirror/api (not /groups), route is POST /groups/:groupId/generate-insights
      {
        pattern: '/groups/*/generate-insights',
        methods: ['POST'],
        requiredTier: (gates['group_insights'] as SubscriptionTier) || 'premium',
        featureName: 'group_insights',
      },

      // GROUP JOIN — usage limited for free tier
      // Mounted at /mirror/api/groups, route is POST /join
      {
        pattern: '/groups/join',
        methods: ['POST'],
        requiredTier: 'free',
        featureName: 'join_one_group',
        usageLimitKey: 'groups_joined',
        usagePeriodType: 'monthly',
      },
      // Mounted at /mirror/api/groups, route is POST /:groupId/request-join
      {
        pattern: '/groups/*/request-join',
        methods: ['POST'],
        requiredTier: 'free',
        featureName: 'join_one_group',
        usageLimitKey: 'groups_joined',
        usagePeriodType: 'monthly',
      },
      // Mounted at /mirror/api/groups, route is POST /:groupId/accept
      {
        pattern: '/groups/*/accept',
        methods: ['POST'],
        requiredTier: 'free',
        featureName: 'join_one_group',
        usageLimitKey: 'groups_joined',
        usagePeriodType: 'monthly',
      },

      // TRUTHSTREAM — receiving reviews and analysis are premium
      {
        pattern: '/truthstream/reviews/received',
        methods: ['GET'],
        requiredTier: (gates['receive_reviews'] as SubscriptionTier) || 'premium',
        featureName: 'receive_reviews',
      },
      {
        pattern: '/truthstream/analysis/generate',
        methods: ['POST'],
        requiredTier: (gates['truth_mirror_report'] as SubscriptionTier) || 'premium',
        featureName: 'truth_mirror_report',
      },
      {
        pattern: '/truthstream/analysis',
        methods: ['GET'],
        requiredTier: (gates['truth_mirror_report'] as SubscriptionTier) || 'premium',
        featureName: 'truth_mirror_report',
      },
      {
        pattern: '/truthstream/analysis/perception-gap',
        methods: ['GET'],
        requiredTier: (gates['truth_mirror_report'] as SubscriptionTier) || 'premium',
        featureName: 'truth_mirror_report',
      },
      {
        pattern: '/truthstream/analysis/trends',
        methods: ['GET'],
        requiredTier: (gates['truth_mirror_report'] as SubscriptionTier) || 'premium',
        featureName: 'truth_mirror_report',
      },

      // DATA EXPORT
      {
        pattern: '/user/export',
        methods: ['POST', 'GET'],
        requiredTier: (gates['data_export'] as SubscriptionTier) || 'premium',
        featureName: 'data_export',
      },
    ];

    return rules;
  }

  // ==========================================================================
  // CORE: JWT Verification
  // ==========================================================================

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

      // Basic token format validation before verification
      if (token.length > 2048 || token.split('.').length !== 3) {
        return res.status(401).json({
          error: 'Invalid token format.',
          code: 'INVALID_TOKEN_FORMAT'
        });
      }

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
        const lockUntil = user.locked_until ? new Date(user.locked_until) : null;

        if (lockUntil && lockUntil > now) {
          return res.status(423).json({
            error: 'Account is temporarily locked.',
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
        ipAddress: (req.ip || req.connection?.remoteAddress || 'Unknown').replace('::ffff:', ''),
        userAgent: req.headers['user-agent'] || 'Unknown',
        tier: 'tier1' // Default tier, can be elevated by other middleware
      };

      next();
    } catch (error: any) {
      // Don't expose internal error details
      if (process.env.NODE_ENV !== 'production') {
        console.error('[AUTH MIDDLEWARE ERROR]', error);
      }
      return res.status(401).json({
        error: 'Invalid token.',
        code: 'INVALID_TOKEN'
      });
    }
  };

  // ==========================================================================
  // SUBSCRIPTION GATE — Umbrella middleware for all authenticated routes
  // ==========================================================================
  // This single middleware checks every authenticated request against the
  // subscription gate rules. It handles both tier gating and usage limits.
  // Mount ONCE after verifyToken — no changes needed in any route file.
  // ==========================================================================

  static subscriptionGate = (async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // If req.user isn't set (routes that handle auth internally), extract from JWT
      if (!req.user) {
        try {
          const authHeader = req.headers.authorization;
          if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            if (token.length <= 2048 && token.split('.').length === 3) {
              const decoded = TokenManager.verifyAccessToken(token);
              req.user = {
                id: decoded.id,
                email: decoded.email,
                username: decoded.username,
                sessionId: decoded.sessionId,
              };
            }
          }
        } catch {
          // Token invalid — skip gate, let the route handler deal with auth
        }
      }

      // Skip if still no user or no rules configured
      if (!req.user?.id || subscriptionGateRules.length === 0) {
        next();
        return;
      }

      // Use originalUrl and strip /mirror/api prefix for pattern matching
      // req.path is relative to mount point, but we need the full path
      const path = (req.originalUrl || req.path).split('?')[0].replace(/^\/mirror\/api/, '');
      const method = req.method.toUpperCase();

      if (process.env.NODE_ENV !== 'production') {
        console.log(`[SUBSCRIPTION GATE] ${method} ${path} | user=${req.user.id} | rules=${subscriptionGateRules.length}`);
      }

      // Find matching rule — first match wins
      const matchedRule = subscriptionGateRules.find(rule => {
        const methodMatch = rule.methods.includes('*') || rule.methods.includes(method);
        if (!methodMatch) return false;
        return AuthMiddleware.matchRoutePattern(path, rule.pattern);
      });

      // No matching rule — route is not gated, pass through
      if (!matchedRule) {
        next();
        return;
      }

      // Hydrate subscription if not already on request
      if (!req.subscription && subscriptionServiceRef) {
        try {
          req.subscription = await subscriptionServiceRef.getSubscription(req.user.id);
        } catch {
          // Fail open — can't block due to subscription lookup failure
          next();
          return;
        }
      }

      if (!req.subscription) {
        next();
        return;
      }

      const effectiveTier = AuthMiddleware.getEffectiveSubscriptionTier(req.subscription);

      // ----------------------------------------------------------------
      // USAGE LIMIT CHECK (for free-tier limited features like journal)
      // ----------------------------------------------------------------
      if (matchedRule.usageLimitKey && matchedRule.usagePeriodType) {
        // Premium users bypass all usage limits
        if (SUBSCRIPTION_TIER_ORDER[effectiveTier] >= SUBSCRIPTION_TIER_ORDER['premium']) {
          next();
          return;
        }

        if (subscriptionServiceRef) {
          const exceeded = await subscriptionServiceRef.isUsageExceeded(
            req.user.id,
            matchedRule.usageLimitKey,
            matchedRule.usagePeriodType
          );

          if (exceeded) {
            const usage = await subscriptionServiceRef.getUsage(
              req.user.id,
              matchedRule.usageLimitKey,
              matchedRule.usagePeriodType
            );

            AuthMiddleware.logGateBlock(req.user.id, matchedRule.featureName, 'usage_limit');

            const friendlyNames: Record<string, string> = {
              journal_entries_per_month: 'journal entries this month',
              groups_joined: 'groups joined',
              dina_queries_per_day: '@Dina queries today',
            };

            res.status(403).json({
              error: `You've reached your limit of ${usage.limit} ${friendlyNames[matchedRule.usageLimitKey] || matchedRule.usageLimitKey}. Upgrade to Premium for unlimited access.`,
              code: 'USAGE_LIMIT',
              feature: matchedRule.featureName,
              used: usage.count,
              limit: usage.limit,
              upgradeUrl: '/mirror/api/subscription/plans',
            });
            return;
          }

          // Under limit — increment and proceed
          await subscriptionServiceRef.incrementUsage(
            req.user.id,
            matchedRule.usageLimitKey,
            matchedRule.usagePeriodType
          );
        }

        next();
        return;
      }

      // ----------------------------------------------------------------
      // TIER CHECK (for hard-gated premium features)
      // ----------------------------------------------------------------
      if (SUBSCRIPTION_TIER_ORDER[effectiveTier] >= SUBSCRIPTION_TIER_ORDER[matchedRule.requiredTier]) {
        next();
        return;
      }

      // BLOCKED — insufficient tier
      AuthMiddleware.logGateBlock(req.user.id, matchedRule.featureName, 'tier_required');

      res.status(403).json({
        error: `This feature requires ${matchedRule.requiredTier}`,
        code: 'UPGRADE_REQUIRED',
        feature: matchedRule.featureName,
        requiredTier: matchedRule.requiredTier,
        currentTier: effectiveTier,
        currentStatus: req.subscription.status,
        upgradeUrl: '/mirror/api/subscription/plans',
      });
      return;

    } catch (error) {
      // FAIL OPEN — never block a paying user due to internal error
      if (process.env.NODE_ENV !== 'production') {
        console.error('[SUBSCRIPTION GATE ERROR — FAILING OPEN]', error);
      }
      next();
    }
  }) as express.RequestHandler;

  // ==========================================================================
  // SUBSCRIPTION HELPERS (private)
  // ==========================================================================

  private static matchRoutePattern(requestPath: string, pattern: string): boolean {
    const pathParts = requestPath.split('/').filter(Boolean);
    const patternParts = pattern.split('/').filter(Boolean);

    for (let i = 0; i < patternParts.length; i++) {
      const pp = patternParts[i];

      // Trailing wildcard — matches everything after
      if (pp === '*' && i === patternParts.length - 1) {
        return pathParts.length >= i;
      }

      // Segment wildcard or param — matches any single segment
      if (pp === '*' || pp.startsWith(':')) {
        if (i >= pathParts.length) return false;
        continue;
      }

      // Exact segment match
      if (i >= pathParts.length || pathParts[i] !== pp) {
        return false;
      }
    }

    return pathParts.length === patternParts.length;
  }

  private static getEffectiveSubscriptionTier(sub: any): SubscriptionTier {
    switch (sub.status) {
      case 'active':
      case 'trialing':
      case 'past_due':
        return sub.tier;
      case 'cancelled':
        if (sub.accessUntil && new Date(sub.accessUntil) > new Date()) {
          return sub.tier;
        }
        return 'free';
      default:
        return 'free';
    }
  }

  private static async logGateBlock(userId: number, feature: string, reason: string): Promise<void> {
    try {
      await DB.query(`
        INSERT INTO activity_logs (user_id, action, metadata, risk_level, page_url, created_at)
        VALUES (?, 'feature_gate_blocked', ?, 'low', '/subscription', NOW())
      `, [userId, JSON.stringify({ feature, reason })]);
    } catch {
      // Non-blocking
    }
  }

  // ==========================================================================
  // EXISTING: Email verification requirement
  // ==========================================================================

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
      if (process.env.NODE_ENV !== 'production') {
        console.error('[EMAIL VERIFICATION CHECK ERROR]', error);
      }
      return res.status(500).json({
        error: 'Verification check failed.',
        code: 'VERIFICATION_CHECK_FAILED'
      });
    }
  };

  // ==========================================================================
  // EXISTING: Rate limiting middleware
  // ==========================================================================

  static rateLimit = (maxRequests: number, windowMs: number) => {
    return (req: Request, res: Response, next: NextFunction) => {
      const identifier = req.user?.id ?
        `user_${req.user.id}` :
        req.securityContext?.ipAddress || req.ip || 'unknown';

      const now = Date.now();
      const windowStart = now - windowMs;

      let limitData = rateLimitStore.get(identifier);
      if (!limitData || limitData.resetTime < windowStart) {
        limitData = { count: 0, resetTime: now + windowMs };
        rateLimitStore.set(identifier, limitData);
      }

      if (limitData.count >= maxRequests) {
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

      limitData.count++;

      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - limitData.count));
      res.setHeader('X-RateLimit-Reset', Math.ceil(limitData.resetTime / 1000));

      next();
    };
  };

  // ==========================================================================
  // EXISTING: Tier-based data access control (tier1/tier2/tier3 encryption)
  // ==========================================================================

  static requireTierAccess = (tier: 'tier1' | 'tier2' | 'tier3', reason?: string) => {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (!req.user || !req.securityContext) {
        return res.status(401).json({
          error: 'Authentication required.',
          code: 'AUTH_REQUIRED'
        });
      }

      try {
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

        if (tier === 'tier3') {
          const [suspiciousActivity] = await DB.query(`
            SELECT COUNT(*) as count FROM security_events
            WHERE user_id = ?
            AND event_type IN ('suspicious_login_attempt', 'suspicious_data_access_pattern')
            AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
          `, [req.user.id]);

          if ((suspiciousActivity as any[])[0].count > 0) {
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

        req.securityContext.tier = tier;
        req.securityContext.accessReason = reason;

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
        if (process.env.NODE_ENV !== 'production') {
          console.error('[TIER ACCESS CHECK ERROR]', error);
        }
        return res.status(500).json({
          error: 'Access check failed.',
          code: 'ACCESS_CHECK_FAILED'
        });
      }
    };
  };

  // ==========================================================================
  // EXISTING: Admin access requirement
  // ==========================================================================

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
      if (process.env.NODE_ENV !== 'production') {
        console.error('[ADMIN CHECK ERROR]', error);
      }
      return res.status(500).json({
        error: 'Admin check failed.',
        code: 'ADMIN_CHECK_FAILED'
      });
    }
  };

  // ==========================================================================
  // EXISTING: Security-level-based middleware factory
  // ==========================================================================

  static requireSecurityLevel = (level: SecurityLevel, options?: {
    reason?: string;
    tier?: 'tier1' | 'tier2' | 'tier3';
    rateLimit?: { maxRequests: number; windowMs: number };
  }) => {
    const middlewares: any[] = [];

    if (options?.rateLimit) {
      middlewares.push(AuthMiddleware.rateLimit(
        options.rateLimit.maxRequests,
        options.rateLimit.windowMs
      ));
    }

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

  // ==========================================================================
  // EXISTING: Activity logging middleware
  // ==========================================================================

  static logActivity = (action: string) => {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (req.user) {
        try {
          await DB.query(`
            INSERT INTO activity_logs (user_id, action, details, ip_address, user_agent, session_id, page_url)
            VALUES (?, ?, ?, ?, ?, ?, ?)
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
            req.user.sessionId,
            req.path || '/unknown'
          ]);
        } catch (error) {
          if (process.env.NODE_ENV !== 'production') {
            console.error('[ACTIVITY LOGGING ERROR]', error);
          }
        }
      }
      next();
    };
  };

  // ==========================================================================
  // EXISTING: Security headers middleware (supplementary to Helmet)
  // ==========================================================================

  static securityHeaders = (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
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
}, 60000);

export default AuthMiddleware;
