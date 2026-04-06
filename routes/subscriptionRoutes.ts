// ============================================================================
// SUBSCRIPTION ROUTES
// ============================================================================
// File: routes/subscriptionRoutes.ts
// API endpoints for subscription management.
// All routes require authentication via AuthMiddleware.verifyToken.
// ============================================================================

import { Router, Request, Response } from 'express';
import { Logger } from '../utils/logger';
import { DB } from '../db';
import { SubscriptionService } from '../paywall/services/subscription.service';
import { getTierDefinition } from '../paywall/paywall.config';
import type { PaywallConfig } from '../paywall/paywall.config';
import type { PayPalProvider } from '../paywall/providers/paypal.provider';
import type { PlanResponse } from '../paywall/types';

const logger = new Logger('SubscriptionRoutes');

// ============================================================================
// HELPERS
// ============================================================================

/** Safely convert a value to ISO string — handles Date objects AND strings from Redis cache */
function safeISOString(val: any): string | null {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

// ============================================================================
// ROUTE FACTORY
// ============================================================================

export function createSubscriptionRoutes(
  config: PaywallConfig,
  subscriptionService: SubscriptionService,
  paypalProvider: PayPalProvider | null
): Router {
  const router = Router();

  // ========================================================================
  // GET /subscription — Current subscription status
  // ========================================================================

  router.get('/', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const sub = await subscriptionService.getSubscription(userId);

      res.json({
        tier: sub.tier,
        status: sub.status,
        trialDaysLeft: sub.trialDaysLeft,
        graceDaysLeft: sub.graceDaysLeft,
        accessUntil: safeISOString(sub.accessUntil),
        features: sub.features,
        usage: sub.usage,
        currentPeriodEnd: safeISOString(sub.currentPeriodEnd),
        cancelledAt: safeISOString(sub.cancelledAt),
        provider: sub.provider,
      });
    } catch (error) {
      logger.error('Failed to get subscription', error as Error, { userId: req.user?.id });
      res.status(500).json({ error: 'Failed to retrieve subscription', code: 'INTERNAL_ERROR' });
    }
  });

  // ========================================================================
  // GET /subscription/plans — Available plans
  // ========================================================================

  router.get('/plans', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const currentSub = await subscriptionService.getSubscription(userId);

      const plans: PlanResponse[] = config.tiers
        .filter(t => t.id !== 'enterprise') // Enterprise not available for self-service
        .map(tier => ({
          id: tier.id,
          name: tier.name,
          price: tier.price,
          currency: config.currency,
          features: tier.features,
          trialDays: tier.trial_days || 0,
          isCurrent: currentSub.tier === tier.id,
        }));

      res.json({ plans });
    } catch (error) {
      logger.error('Failed to get plans', error as Error);
      res.status(500).json({ error: 'Failed to retrieve plans', code: 'INTERNAL_ERROR' });
    }
  });

  // ========================================================================
  // POST /subscription/create — Create a new subscription (PayPal)
  // ========================================================================

  router.post('/create', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const { planId } = req.body;

      // Validate user has verified email
      const [userRows] = await DB.query(
        'SELECT email, email_verified FROM users WHERE id = ?',
        [userId]
      );
      const user = (userRows as any[])[0];

      if (!user) {
        res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      if (!user.email_verified) {
        res.status(403).json({
          error: 'Please verify your email before subscribing',
          code: 'EMAIL_NOT_VERIFIED',
        });
        return;
      }

      // Check not already active
      const currentSub = await subscriptionService.getSubscription(userId);
      if (currentSub.status === 'active') {
        res.status(409).json({
          error: 'You already have an active subscription',
          code: 'ALREADY_SUBSCRIBED',
        });
        return;
      }

      // Find the tier to subscribe to
      const tier = config.tiers.find(t => t.paypal_plan_id === planId || t.id === planId);
      if (!tier || !tier.paypal_plan_id) {
        res.status(400).json({
          error: 'Invalid plan',
          code: 'INVALID_PLAN',
        });
        return;
      }

      if (!paypalProvider) {
        res.status(503).json({
          error: 'Payment processing is not available',
          code: 'PAYMENT_UNAVAILABLE',
        });
        return;
      }

      // Create PayPal subscription
      const result = await paypalProvider.createSubscription({
        planId: tier.paypal_plan_id,
        userId,
        email: user.email,
        returnUrl: config.returnUrl,
        cancelUrl: config.cancelUrl,
        trialDays: config.trial.enabled ? config.trial.days : undefined,
      });

      // Log the intent
      await DB.query(`
        INSERT INTO activity_logs (user_id, action, metadata, risk_level, page_url, created_at)
        VALUES (?, 'subscription_initiated', ?, 'low', '/subscription', NOW())
      `, [userId, JSON.stringify({ planId: tier.id, providerSubscriptionId: result.subscriptionId })]);

      res.json({
        approvalUrl: result.approvalUrl,
        subscriptionId: result.subscriptionId,
      });

    } catch (error: any) {
      logger.error('Failed to create subscription', error, { userId: req.user?.id });
      res.status(500).json({
        error: 'Failed to create subscription. Please try again.',
        code: 'CREATION_FAILED',
      });
    }
  });

  // ========================================================================
  // POST /subscription/activate — Activate after PayPal approval
  // ========================================================================

  router.post('/activate', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const { subscriptionId } = req.body;

      if (!subscriptionId) {
        res.status(400).json({ error: 'Subscription ID required', code: 'VALIDATION_ERROR' });
        return;
      }

      if (!paypalProvider) {
        res.status(503).json({ error: 'Payment processing unavailable', code: 'PAYMENT_UNAVAILABLE' });
        return;
      }

      // Verify with PayPal that the subscription is active
      const paypalSub = await paypalProvider.getSubscription(subscriptionId);

      if (!paypalSub) {
        res.status(404).json({ error: 'Subscription not found at PayPal', code: 'NOT_FOUND' });
        return;
      }

      if (paypalSub.status !== 'ACTIVE' && paypalSub.status !== 'APPROVED') {
        res.status(400).json({
          error: `Subscription is ${paypalSub.status}, not active`,
          code: 'NOT_ACTIVE',
        });
        return;
      }

      // Activate in our system
      const sub = await subscriptionService.activateSubscription(userId, {
        provider: 'paypal',
        providerSubscriptionId: subscriptionId,
        providerPlanId: paypalSub.plan_id,
        providerCustomerId: paypalSub.subscriber?.payer_id,
      });

      const fullSub = await subscriptionService.getSubscription(userId);

      res.json({
        tier: fullSub.tier,
        status: fullSub.status,
        features: fullSub.features,
        currentPeriodEnd: safeISOString(fullSub.currentPeriodEnd),
        message: 'Subscription activated successfully',
      });

    } catch (error: any) {
      logger.error('Failed to activate subscription', error, { userId: req.user?.id });
      res.status(500).json({ error: 'Failed to activate subscription', code: 'ACTIVATION_FAILED' });
    }
  });

  // ========================================================================
  // POST /subscription/cancel — Cancel subscription
  // ========================================================================

  router.post('/cancel', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const { reason } = req.body;

      const currentSub = await subscriptionService.getSubscription(userId);

      if (currentSub.status === 'free' || currentSub.status === 'expired') {
        res.status(400).json({
          error: 'No active subscription to cancel',
          code: 'NOT_SUBSCRIBED',
        });
        return;
      }

      const sub = await subscriptionService.cancelSubscription(
        userId,
        reason?.substring(0, 500) // Limit reason length
      );

      const fullSub = await subscriptionService.getSubscription(userId);

      res.json({
        status: fullSub.status,
        accessUntil: safeISOString(fullSub.accessUntil),
        message: 'Subscription cancelled. You retain access until your current period ends.',
      });

    } catch (error: any) {
      logger.error('Failed to cancel subscription', error, { userId: req.user?.id });
      res.status(500).json({ error: 'Failed to cancel subscription', code: 'CANCEL_FAILED' });
    }
  });

  // ========================================================================
  // POST /subscription/reactivate — Resubscribe after cancellation
  // ========================================================================

  router.post('/reactivate', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const currentSub = await subscriptionService.getSubscription(userId);

      if (currentSub.status !== 'cancelled' && currentSub.status !== 'expired') {
        res.status(400).json({
          error: 'Subscription is not cancelled',
          code: 'NOT_CANCELLED',
        });
        return;
      }

      // Direct to create flow — they need to set up a new PayPal subscription
      const premiumTier = config.tiers.find(t => t.id === 'premium');

      res.json({
        message: 'To reactivate, please create a new subscription',
        action: 'create',
        planId: premiumTier?.paypal_plan_id || 'premium',
      });

    } catch (error: any) {
      logger.error('Failed to reactivate subscription', error, { userId: req.user?.id });
      res.status(500).json({ error: 'Failed to process reactivation', code: 'REACTIVATE_FAILED' });
    }
  });

  // ========================================================================
  // GET /subscription/usage — Detailed usage breakdown
  // ========================================================================

  router.get('/usage', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;
      const sub = await subscriptionService.getSubscription(userId);

      res.json({
        tier: sub.tier,
        usage: sub.usage,
        isPremium: sub.tier !== 'free' && ['active', 'trialing', 'past_due'].includes(sub.status),
      });

    } catch (error) {
      logger.error('Failed to get usage', error as Error, { userId: req.user?.id });
      res.status(500).json({ error: 'Failed to retrieve usage', code: 'INTERNAL_ERROR' });
    }
  });

  // ========================================================================
  // POST /subscription/start-trial — Manually start trial
  // ========================================================================

  router.post('/start-trial', async (req: Request, res: Response) => {
    try {
      const userId = req.user!.id;

      if (!config.trial.enabled) {
        res.status(400).json({ error: 'Trials are not available', code: 'TRIAL_DISABLED' });
        return;
      }

      // Require email verification before trial
      const [userRows] = await DB.query(
        'SELECT email_verified FROM users WHERE id = ?',
        [userId]
      );
      const userRecord = (userRows as any[])[0];
      if (!userRecord?.email_verified) {
        res.status(403).json({
          error: 'Please verify your email before starting a trial',
          code: 'EMAIL_NOT_VERIFIED',
        });
        return;
      }

      const currentSub = await subscriptionService.getSubscription(userId);

      // Only allow trial from free status
      if (currentSub.status !== 'free') {
        res.status(400).json({
          error: 'Trial is only available for free-tier users',
          code: 'TRIAL_NOT_AVAILABLE',
        });
        return;
      }

      // Check if user has had a trial before
      const [trialEvents] = await DB.query(`
        SELECT id FROM subscription_events
        WHERE user_id = ? AND event_type = 'subscription.trial_started'
        LIMIT 1
      `, [userId]);

      if ((trialEvents as any[]).length > 0) {
        res.status(400).json({
          error: 'You have already used your free trial',
          code: 'TRIAL_ALREADY_USED',
        });
        return;
      }

      await subscriptionService.startTrial(userId);
      const fullSub = await subscriptionService.getSubscription(userId);

      res.json({
        status: fullSub.status,
        tier: fullSub.tier,
        trialDaysLeft: fullSub.trialDaysLeft,
        features: fullSub.features,
        message: `Your ${config.trial.days}-day free trial has started!`,
      });

    } catch (error: any) {
      logger.error('Failed to start trial', error, { userId: req.user?.id });
      res.status(500).json({ error: 'Failed to start trial', code: 'TRIAL_FAILED' });
    }
  });

  return router;
}
