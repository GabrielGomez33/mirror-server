// ============================================================================
// ROUTE GATE FILTER — UMBRELLA MIDDLEWARE
// ============================================================================
// File: paywall/middleware/routeGateFilter.ts
//
// Single middleware that intercepts ALL authenticated requests and
// automatically applies tier gates and usage limits based on URL pattern
// matching against the .payenv configuration.
//
// This eliminates the need to modify any existing route file.
// All gating rules are defined in .payenv and applied here.
//
// Mount ONCE in index.ts after auth and subscription hydration:
//   APP.use('/mirror/api', authMiddleware, hydrateSubscription, routeGateFilter);
//
// ============================================================================

import { Request, Response, NextFunction } from 'express';
import { Logger } from '../../utils/logger';
import { DB } from '../../db';
import { SubscriptionService } from '../services/subscription.service';
import type { PaywallConfig } from '../paywall.config';
import type { SubscriptionTier, SubscriptionWithUsage } from '../types';

const logger = new Logger('RouteGateFilter');

// ============================================================================
// TYPES
// ============================================================================

interface RouteGateRule {
  /** URL pattern to match (supports exact, prefix, and simple wildcards) */
  pattern: string;
  /** HTTP method(s) to match. '*' matches all. */
  methods: string[];
  /** Required subscription tier */
  requiredTier: SubscriptionTier;
  /** Feature name for analytics and upgrade modal context */
  featureName: string;
  /** Optional: usage limit key (for free-tier limits instead of hard gate) */
  usageLimitKey?: string;
  /** Optional: usage period type */
  usagePeriodType?: 'daily' | 'monthly';
}

// ============================================================================
// ROUTE GATE MAP — Defined from .payenv
// ============================================================================
// This maps URL patterns + HTTP methods to tier requirements.
// Patterns are checked in order — first match wins.
// Patterns support:
//   - Exact: '/journal/analyze' matches only that path
//   - Prefix with wildcard: '/analysis/*' matches anything under /analysis/
//   - Param segments: '/groups/:id/insights' matches any group ID
// ============================================================================

function buildRouteGateRules(config: PaywallConfig): RouteGateRule[] {
  // Core rules derived from PAYWALL_GATES config
  // These map the feature keys in .payenv to actual URL patterns
  const rules: RouteGateRule[] = [
    // ====================================================================
    // JOURNAL GATES
    // ====================================================================
    {
      pattern: '/journal',
      methods: ['POST'],
      requiredTier: 'free', // Free users CAN create, but with limits
      featureName: 'limited_journal',
      usageLimitKey: 'journal_entries_per_month',
      usagePeriodType: 'monthly',
    },
    {
      pattern: '/journal/analyze',
      methods: ['POST'],
      requiredTier: config.gates['journal_analysis'] || 'premium',
      featureName: 'journal_analysis',
    },

    // ====================================================================
    // PERSONAL ANALYSIS GATES
    // ====================================================================
    {
      pattern: '/personal-analysis/generate',
      methods: ['POST'],
      requiredTier: config.gates['personal_analysis'] || 'premium',
      featureName: 'personal_analysis',
    },

    // ====================================================================
    // GROUP GATES
    // ====================================================================
    {
      pattern: '/groups',
      methods: ['POST'],
      requiredTier: config.gates['create_group'] || 'premium',
      featureName: 'create_group',
    },
    // Group insights generation (matches /groups/:groupId/insights/generate-insights)
    {
      pattern: '/groups/*/insights/generate-insights',
      methods: ['POST'],
      requiredTier: config.gates['group_insights'] || 'premium',
      featureName: 'group_insights',
    },
    // Group join — usage limited for free tier
    {
      pattern: '/groups/*/members/join',
      methods: ['POST'],
      requiredTier: 'free',
      featureName: 'join_one_group',
      usageLimitKey: 'groups_joined',
      usagePeriodType: 'monthly',
    },

    // ====================================================================
    // TRUTHSTREAM GATES
    // ====================================================================
    {
      pattern: '/truthstream/reviews/received',
      methods: ['GET'],
      requiredTier: config.gates['receive_reviews'] || 'premium',
      featureName: 'receive_reviews',
    },
    {
      pattern: '/truthstream/analysis/generate',
      methods: ['POST'],
      requiredTier: config.gates['truth_mirror_report'] || 'premium',
      featureName: 'truth_mirror_report',
    },
    {
      pattern: '/truthstream/analysis',
      methods: ['GET'],
      requiredTier: config.gates['truth_mirror_report'] || 'premium',
      featureName: 'truth_mirror_report',
    },
    {
      pattern: '/truthstream/analysis/perception-gap',
      methods: ['GET'],
      requiredTier: config.gates['truth_mirror_report'] || 'premium',
      featureName: 'truth_mirror_report',
    },
    {
      pattern: '/truthstream/analysis/trends',
      methods: ['GET'],
      requiredTier: config.gates['truth_mirror_report'] || 'premium',
      featureName: 'truth_mirror_report',
    },

    // ====================================================================
    // DATA EXPORT GATE
    // ====================================================================
    {
      pattern: '/user/export',
      methods: ['POST', 'GET'],
      requiredTier: config.gates['data_export'] || 'premium',
      featureName: 'data_export',
    },
  ];

  return rules;
}

// ============================================================================
// TIER ORDERING
// ============================================================================

const TIER_ORDER: Record<SubscriptionTier, number> = {
  free: 0,
  premium: 1,
  enterprise: 2,
};

// ============================================================================
// PATTERN MATCHING
// ============================================================================

// Match a request path against a route pattern.
// Supports:
//   - Exact match: '/journal/analyze'
//   - Wildcard segments: '/groups/[wildcard]/insights' matches '/groups/abc123/insights'
//   - Trailing wildcard: '/analysis/[wildcard]' matches '/analysis/anything/here'
function matchRoute(requestPath: string, pattern: string): boolean {
  // Strip the /mirror/api prefix if present
  const cleanPath = requestPath.replace(/^\/mirror\/api/, '');
  const cleanPattern = pattern.replace(/^\/mirror\/api/, '');

  const pathParts = cleanPath.split('/').filter(Boolean);
  const patternParts = cleanPattern.split('/').filter(Boolean);

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

  // Pattern fully consumed — path length must match (unless trailing wildcard handled above)
  return pathParts.length === patternParts.length;
}

// ============================================================================
// EFFECTIVE TIER CALCULATION
// ============================================================================

function getEffectiveTier(sub: SubscriptionWithUsage): SubscriptionTier {
  switch (sub.status) {
    case 'active':
    case 'trialing':
    case 'past_due': // Grace period — still gets access
      return sub.tier;
    case 'cancelled':
      // Access continues until period end
      if (sub.accessUntil && new Date(sub.accessUntil) > new Date()) {
        return sub.tier;
      }
      return 'free';
    default:
      return 'free';
  }
}

// ============================================================================
// MIDDLEWARE FACTORY
// ============================================================================

export function createRouteGateFilter(
  config: PaywallConfig,
  subscriptionService: SubscriptionService
) {
  const rules = buildRouteGateRules(config);

  logger.info('Route gate filter initialized', {
    ruleCount: rules.length,
    gatedFeatures: rules.map(r => r.featureName),
  });

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Skip if no authenticated user (let auth middleware handle that)
      if (!req.user?.id) {
        next();
        return;
      }

      // Find matching rule
      const method = req.method.toUpperCase();
      const path = req.path;

      const matchedRule = rules.find(rule => {
        const methodMatch = rule.methods.includes('*') || rule.methods.includes(method);
        if (!methodMatch) return false;
        return matchRoute(path, rule.pattern);
      });

      // No matching rule — route is not gated, pass through
      if (!matchedRule) {
        next();
        return;
      }

      // Load subscription if not already hydrated
      if (!req.subscription) {
        req.subscription = await subscriptionService.getSubscription(req.user.id);
      }

      const sub = req.subscription;
      const effectiveTier = getEffectiveTier(sub);

      // ====================================================================
      // USAGE LIMIT CHECK (for free-tier limited features)
      // ====================================================================
      if (matchedRule.usageLimitKey && matchedRule.usagePeriodType) {
        // Premium users bypass all usage limits
        if (TIER_ORDER[effectiveTier] >= TIER_ORDER['premium']) {
          next();
          return;
        }

        // Check usage limit
        const exceeded = await subscriptionService.isUsageExceeded(
          req.user.id,
          matchedRule.usageLimitKey,
          matchedRule.usagePeriodType
        );

        if (exceeded) {
          const usage = await subscriptionService.getUsage(
            req.user.id,
            matchedRule.usageLimitKey,
            matchedRule.usagePeriodType
          );

          // Log for analytics
          logGateBlock(req.user.id, matchedRule.featureName, 'usage_limit');

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
            resetsAt: matchedRule.usagePeriodType === 'daily'
              ? getNextDayStart().toISOString()
              : getNextMonthStart().toISOString(),
            upgradeUrl: '/mirror/api/subscription/plans',
          });
          return;
        }

        // Under limit — increment usage counter
        await subscriptionService.incrementUsage(
          req.user.id,
          matchedRule.usageLimitKey,
          matchedRule.usagePeriodType
        );

        next();
        return;
      }

      // ====================================================================
      // TIER CHECK (for hard-gated premium features)
      // ====================================================================
      if (TIER_ORDER[effectiveTier] >= TIER_ORDER[matchedRule.requiredTier]) {
        next();
        return;
      }

      // BLOCKED — insufficient tier
      logGateBlock(req.user.id, matchedRule.featureName, 'tier_required');

      res.status(403).json({
        error: `This feature requires ${matchedRule.requiredTier}`,
        code: 'UPGRADE_REQUIRED',
        feature: matchedRule.featureName,
        requiredTier: matchedRule.requiredTier,
        currentTier: effectiveTier,
        currentStatus: sub.status,
        upgradeUrl: '/mirror/api/subscription/plans',
      });

    } catch (error) {
      // FAIL OPEN — never block a paying user due to internal error
      logger.error('Route gate filter error — failing open', error as Error, {
        userId: req.user?.id,
        path: req.path,
        method: req.method,
      });
      next();
    }
  };
}

// ============================================================================
// HELPERS
// ============================================================================

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

async function logGateBlock(userId: number, feature: string, reason: string): Promise<void> {
  try {
    await DB.query(`
      INSERT INTO activity_logs (user_id, action, metadata, risk_level, page_url, created_at)
      VALUES (?, 'feature_gate_blocked', ?, 'low', '/subscription', NOW())
    `, [userId, JSON.stringify({ feature, reason })]);
  } catch {
    // Non-blocking — analytics shouldn't disrupt the response
  }
}
