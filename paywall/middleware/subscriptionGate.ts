// ============================================================================
// SUBSCRIPTION GATE MIDDLEWARE
// ============================================================================
// File: paywall/middleware/subscriptionGate.ts
// Express middleware factories for tier-based feature gating.
// Usage: router.post('/create', requireTier('premium'), handler)
// ============================================================================

import { Request, Response, NextFunction } from 'express';
import { Logger } from '../../utils/logger';
import { SubscriptionService } from '../services/subscription.service';
import type { SubscriptionTier } from '../types';

const logger = new Logger('SubscriptionGate');

// ============================================================================
// TIER ORDERING (for comparison)
// ============================================================================

const TIER_ORDER: Record<SubscriptionTier, number> = {
  free: 0,
  premium: 1,
  enterprise: 2,
};

// ============================================================================
// MIDDLEWARE FACTORY: requireTier
// ============================================================================

/**
 * Creates middleware that blocks requests from users below the required tier.
 *
 * Premium features: Users with active, trialing, or past_due (grace) subscriptions pass.
 * Cancelled users pass if still within their paid period.
 *
 * On block: Returns 403 with upgrade information for the frontend to display.
 * On error: Fails open — never block a paying user due to internal error.
 */
export function createRequireTier(subscriptionService: SubscriptionService) {
  return function requireTier(requiredTier: SubscriptionTier, featureName?: string) {
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

        // Load subscription if not already on request
        if (!req.subscription) {
          req.subscription = await subscriptionService.getSubscription(userId);
        }

        const sub = req.subscription;

        // Determine effective tier based on status
        let effectiveTier: SubscriptionTier = 'free';

        switch (sub.status) {
          case 'active':
          case 'trialing':
          case 'past_due': // Grace period — user still gets access
            effectiveTier = sub.tier;
            break;
          case 'cancelled':
            // Access continues until period end
            if (sub.accessUntil && new Date(sub.accessUntil) > new Date()) {
              effectiveTier = sub.tier;
            }
            break;
          default:
            effectiveTier = 'free';
        }

        // Check if user's tier meets or exceeds required tier
        if (TIER_ORDER[effectiveTier] >= TIER_ORDER[requiredTier]) {
          next();
          return;
        }

        // Blocked — log for analytics
        logger.debug('Feature gate blocked', {
          userId,
          feature: featureName || 'unknown',
          userTier: effectiveTier,
          requiredTier,
          status: sub.status,
        });

        // Log to activity_logs for conversion analytics
        try {
          const { DB } = await import('../../db');
          await DB.query(`
            INSERT INTO activity_logs (user_id, action, metadata, risk_level, page_url, created_at)
            VALUES (?, 'upgrade_prompt_shown', ?, 'low', '/subscription', NOW())
          `, [userId, JSON.stringify({ feature: featureName, requiredTier })]);
        } catch { /* analytics logging shouldn't block the response */ }

        res.status(403).json({
          error: `This feature requires ${requiredTier}`,
          code: 'UPGRADE_REQUIRED',
          feature: featureName || undefined,
          requiredTier,
          currentTier: effectiveTier,
          currentStatus: sub.status,
          upgradeUrl: '/mirror/api/subscription/plans',
        });

      } catch (error) {
        // FAIL OPEN — never block a user due to internal error
        logger.error('Subscription gate error — failing open', error as Error, {
          userId: req.user?.id,
          requiredTier,
        });
        next();
      }
    };
  };
}

// ============================================================================
// MIDDLEWARE: hydrateSubscription
// ============================================================================

/**
 * Middleware that loads subscription data onto req.subscription for all
 * authenticated requests. Lightweight — reads from Redis cache.
 * Place this AFTER auth middleware, BEFORE route handlers.
 */
export function createHydrateSubscription(subscriptionService: SubscriptionService) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.user?.id && !req.subscription) {
        req.subscription = await subscriptionService.getSubscription(req.user.id);
      }
    } catch (error) {
      // Non-blocking — subscription data is optional for non-gated routes
      logger.debug('Failed to hydrate subscription', { userId: req.user?.id });
    }
    next();
  };
}
