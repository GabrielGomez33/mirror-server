// ============================================================================
// USAGE LIMITER MIDDLEWARE
// ============================================================================
// File: paywall/middleware/usageLimiter.ts
// Express middleware factory for enforcing free-tier usage limits.
// Usage: router.post('/create', enforceLimit('journal_entries_per_month', 'monthly'), handler)
// Premium users bypass all limits automatically.
// ============================================================================

import { Request, Response, NextFunction } from 'express';
import { Logger } from '../../utils/logger';
import { SubscriptionService } from '../services/subscription.service';

const logger = new Logger('UsageLimiter');

// ============================================================================
// MIDDLEWARE FACTORY: enforceLimit
// ============================================================================

/**
 * Creates middleware that checks and enforces usage limits for free-tier users.
 *
 * Premium users: Bypassed entirely (no DB check, no increment).
 * Free users at limit: Returns 403 with usage info and reset time.
 * Free users under limit: Increments counter and proceeds.
 *
 * @param featureKey - The feature to limit (must match PAYWALL_FREE_LIMITS key)
 * @param periodType - 'daily' or 'monthly'
 * @param options - Optional configuration
 */
export function createEnforceLimit(subscriptionService: SubscriptionService) {
  return function enforceLimit(
    featureKey: string,
    periodType: 'daily' | 'monthly',
    options?: {
      /** Custom error message */
      message?: string;
      /** If true, only check limit without incrementing */
      checkOnly?: boolean;
    }
  ) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const userId = req.user?.id;

        if (!userId) {
          res.status(401).json({
            error: 'Authentication required',
            code: 'AUTH_REQUIRED',
          });
          return;
        }

        // Load subscription if not already hydrated
        if (!req.subscription) {
          req.subscription = await subscriptionService.getSubscription(userId);
        }

        const sub = req.subscription;

        // Premium, trialing, or past_due (grace) users bypass all limits
        if (sub.tier !== 'free' && ['active', 'trialing', 'past_due'].includes(sub.status)) {
          next();
          return;
        }

        // Cancelled users within period also bypass
        if (sub.status === 'cancelled' && sub.accessUntil && new Date(sub.accessUntil) > new Date()) {
          next();
          return;
        }

        // Free tier — check usage
        if (options?.checkOnly) {
          const exceeded = await subscriptionService.isUsageExceeded(userId, featureKey, periodType);
          if (exceeded) {
            return sendLimitResponse(res, userId, featureKey, periodType, subscriptionService, options?.message);
          }
          next();
          return;
        }

        // Check if already at limit BEFORE incrementing
        const exceeded = await subscriptionService.isUsageExceeded(userId, featureKey, periodType);
        if (exceeded) {
          return sendLimitResponse(res, userId, featureKey, periodType, subscriptionService, options?.message);
        }

        // Under limit — increment and proceed
        const result = await subscriptionService.incrementUsage(userId, featureKey, periodType);

        // Attach usage info to request for handlers that need it
        (req as any).usageInfo = {
          featureKey,
          used: result.count,
          limit: result.limit,
          remaining: Math.max(0, result.limit - result.count),
        };

        next();

      } catch (error) {
        // FAIL OPEN — never block a user due to internal error
        logger.error('Usage limiter error — failing open', error as Error, {
          userId: req.user?.id,
          featureKey,
        });
        next();
      }
    };
  };
}

// ============================================================================
// HELPER: Send limit exceeded response
// ============================================================================

async function sendLimitResponse(
  res: Response,
  userId: number,
  featureKey: string,
  periodType: 'daily' | 'monthly',
  subscriptionService: SubscriptionService,
  customMessage?: string
): Promise<void> {
  const usage = await subscriptionService.getUsage(userId, featureKey, periodType);

  const resetsAt = periodType === 'daily'
    ? getNextDayStart().toISOString()
    : getNextMonthStart().toISOString();

  // Log for analytics
  try {
    const { DB } = await import('../../db');
    await DB.query(`
      INSERT INTO activity_logs (user_id, action, metadata, risk_level, page_url, created_at)
      VALUES (?, 'usage_limit_reached', ?, 'low', '/subscription', NOW())
    `, [userId, JSON.stringify({ featureKey, used: usage.count, limit: usage.limit })]);
  } catch { /* non-blocking */ }

  const friendlyNames: Record<string, string> = {
    journal_entries_per_month: 'journal entries this month',
    groups_joined: 'groups joined',
    dina_queries_per_day: '@Dina queries today',
  };

  res.status(403).json({
    error: customMessage || `You've reached your limit of ${usage.limit} ${friendlyNames[featureKey] || featureKey}. Upgrade to Premium for unlimited access.`,
    code: 'USAGE_LIMIT',
    feature: featureKey,
    used: usage.count,
    limit: usage.limit,
    resetsAt,
    upgradeUrl: '/mirror/api/subscription/plans',
  });
}

function getNextDayStart(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function getNextMonthStart(): Date {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
