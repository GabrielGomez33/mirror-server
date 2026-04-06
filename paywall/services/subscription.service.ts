// ============================================================================
// SUBSCRIPTION SERVICE — STATE MACHINE & BUSINESS LOGIC
// ============================================================================
// File: paywall/services/subscription.service.ts
// Manages subscription lifecycle, state transitions, usage tracking, caching.
// This is the single source of truth for subscription state.
// ============================================================================

import { DB } from '../../db';
import { mirrorRedis } from '../../config/redis';
import { Logger } from '../../utils/logger';
import { emailService } from '../../services/emailService';
import type { PaywallConfig } from '../paywall.config';
import { getTierFeatures, getFreeTierLimit, tierHasFeature } from '../paywall.config';
import type {
  Subscription,
  SubscriptionWithUsage,
  SubscriptionTier,
  SubscriptionStatus,
  SubscriptionEventType,
  SubscriptionEvent,
  UsageSummary,
  UsageRecord,
  PaymentProvider,
} from '../types';
import { VALID_TRANSITIONS } from '../types';
import type { PayPalProvider } from '../providers/paypal.provider';

const logger = new Logger('SubscriptionService');

// ============================================================================
// CACHE KEYS & TTL
// ============================================================================

const CACHE_PREFIX = 'subscription';
const CACHE_TTL = 300; // 5 minutes

function cacheKey(userId: number): string {
  return `${CACHE_PREFIX}:${userId}`;
}

// ============================================================================
// SUBSCRIPTION SERVICE CLASS
// ============================================================================

export class SubscriptionService {
  private config: PaywallConfig;
  private provider: PayPalProvider | null;

  constructor(config: PaywallConfig, provider: PayPalProvider | null) {
    this.config = config;
    this.provider = provider;
  }

  // ========================================================================
  // READ OPERATIONS
  // ========================================================================

  /**
   * Get full subscription state with usage for a user.
   * Reads from Redis cache first, falls back to DB.
   */
  async getSubscription(userId: number): Promise<SubscriptionWithUsage> {
    // Check cache
    const cached = await mirrorRedis.get(cacheKey(userId));
    if (cached) {
      return cached as SubscriptionWithUsage;
    }

    // Query DB
    const [rows] = await DB.query(
      'SELECT * FROM user_subscriptions WHERE user_id = ?',
      [userId]
    );

    const dbRows = rows as any[];
    let sub: Subscription;

    if (dbRows.length === 0) {
      // No subscription record — create free tier
      sub = await this.createFreeSubscription(userId);
    } else {
      sub = this.mapRowToSubscription(dbRows[0]);
    }

    // Build full response with usage
    const full = await this.buildSubscriptionWithUsage(sub);

    // Cache
    await mirrorRedis.set(cacheKey(userId), full, CACHE_TTL);

    return full;
  }

  /**
   * Light check — just tier and status. Faster for middleware.
   */
  async getSubscriptionTier(userId: number): Promise<{ tier: SubscriptionTier; status: SubscriptionStatus }> {
    const cached = await mirrorRedis.get(cacheKey(userId));
    if (cached) {
      return { tier: cached.tier, status: cached.status };
    }

    const [rows] = await DB.query(
      'SELECT tier, status FROM user_subscriptions WHERE user_id = ?',
      [userId]
    );

    const dbRows = rows as any[];
    if (dbRows.length === 0) {
      return { tier: 'free', status: 'free' };
    }

    return { tier: dbRows[0].tier, status: dbRows[0].status };
  }

  // ========================================================================
  // STATE TRANSITIONS
  // ========================================================================

  /**
   * Create a free subscription record for a new user.
   */
  async createFreeSubscription(userId: number): Promise<Subscription> {
    await DB.query(`
      INSERT INTO user_subscriptions (user_id, tier, status)
      VALUES (?, 'free', 'free')
      ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP
    `, [userId]);

    await this.logEvent({
      userId,
      eventType: 'subscription.created',
      metadata: { tier: 'free' },
    });

    return this.getSubscriptionFromDB(userId);
  }

  /**
   * Start a free trial for a user.
   */
  async startTrial(userId: number): Promise<Subscription> {
    const current = await this.getSubscriptionFromDB(userId);
    this.validateTransition(current.status, 'trialing');

    const trialDays = this.config.trial.days;
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + trialDays);

    await DB.query(`
      UPDATE user_subscriptions
      SET tier = ?, status = 'trialing', trial_start = NOW(), trial_end = ?
      WHERE user_id = ?
    `, [this.config.trial.tier, trialEnd, userId]);

    await this.invalidateCache(userId);

    await this.logEvent({
      userId,
      eventType: 'subscription.trial_started',
      metadata: { trialDays, trialEnd: trialEnd.toISOString() },
    });

    logger.info('Trial started', { userId, trialDays, trialEnd: trialEnd.toISOString() });

    return this.getSubscriptionFromDB(userId);
  }

  /**
   * Activate a paid subscription (after PayPal approval or payment success).
   */
  async activateSubscription(userId: number, params: {
    provider: PaymentProvider;
    providerSubscriptionId: string;
    providerPlanId: string;
    providerCustomerId?: string;
    periodStart?: Date;
    periodEnd?: Date;
  }): Promise<Subscription> {
    const current = await this.getSubscriptionFromDB(userId);
    this.validateTransition(current.status, 'active');

    const periodStart = params.periodStart || new Date();
    const periodEnd = params.periodEnd || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await DB.query(`
      UPDATE user_subscriptions
      SET tier = 'premium',
          status = 'active',
          provider = ?,
          provider_subscription_id = ?,
          provider_plan_id = ?,
          provider_customer_id = ?,
          current_period_start = ?,
          current_period_end = ?,
          grace_period_end = NULL,
          cancelled_at = NULL,
          cancel_reason = NULL
      WHERE user_id = ?
    `, [
      params.provider,
      params.providerSubscriptionId,
      params.providerPlanId,
      params.providerCustomerId || null,
      periodStart,
      periodEnd,
      userId,
    ]);

    await this.invalidateCache(userId);

    await this.logEvent({
      userId,
      eventType: 'subscription.activated',
      metadata: {
        provider: params.provider,
        providerSubscriptionId: params.providerSubscriptionId,
      },
    });

    // Send confirmation email
    const [userRows] = await DB.query('SELECT email FROM users WHERE id = ?', [userId]);
    const user = (userRows as any[])[0];
    if (user?.email) {
      await emailService.queueEmail(user.email, 'payment_confirmed', {
        amount: '9.99',
        nextBillingDate: periodEnd.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      });
    }

    logger.info('Subscription activated', { userId, provider: params.provider });

    return this.getSubscriptionFromDB(userId);
  }

  /**
   * Handle a failed payment — move to past_due with grace period.
   */
  async handlePaymentFailed(userId: number): Promise<Subscription> {
    const current = await this.getSubscriptionFromDB(userId);
    this.validateTransition(current.status, 'past_due');

    const gracePeriodEnd = new Date();
    gracePeriodEnd.setDate(gracePeriodEnd.getDate() + this.config.gracePeriodDays);

    await DB.query(`
      UPDATE user_subscriptions
      SET status = 'past_due', grace_period_end = ?
      WHERE user_id = ?
    `, [gracePeriodEnd, userId]);

    await this.invalidateCache(userId);

    await this.logEvent({
      userId,
      eventType: 'payment.failed',
      metadata: { gracePeriodEnd: gracePeriodEnd.toISOString() },
    });

    await this.logEvent({
      userId,
      eventType: 'grace_period.started',
      metadata: { days: this.config.gracePeriodDays },
    });

    // Send payment failed email
    const [userRows] = await DB.query('SELECT email FROM users WHERE id = ?', [userId]);
    const user = (userRows as any[])[0];
    if (user?.email) {
      await emailService.queueEmail(user.email, 'payment_failed', {
        graceDaysLeft: String(this.config.gracePeriodDays),
        updatePaymentUrl: 'https://www.paypal.com/myaccount/autopay',
      });
    }

    logger.warn('Payment failed, grace period started', {
      userId,
      gracePeriodEnd: gracePeriodEnd.toISOString(),
    });

    return this.getSubscriptionFromDB(userId);
  }

  /**
   * Handle successful payment recovery (after past_due).
   */
  async handlePaymentSuccess(userId: number, periodEnd?: Date): Promise<Subscription> {
    const current = await this.getSubscriptionFromDB(userId);

    // Only transition if currently past_due
    if (current.status === 'past_due') {
      this.validateTransition(current.status, 'active');

      const newPeriodEnd = periodEnd || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await DB.query(`
        UPDATE user_subscriptions
        SET status = 'active',
            grace_period_end = NULL,
            current_period_start = NOW(),
            current_period_end = ?
        WHERE user_id = ?
      `, [newPeriodEnd, userId]);

      await this.logEvent({
        userId,
        eventType: 'payment.recovered',
        metadata: { newPeriodEnd: newPeriodEnd.toISOString() },
      });

      logger.info('Payment recovered', { userId });
    } else if (current.status === 'active') {
      // Regular renewal — just update period
      const newPeriodEnd = periodEnd || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await DB.query(`
        UPDATE user_subscriptions
        SET current_period_start = NOW(), current_period_end = ?
        WHERE user_id = ?
      `, [newPeriodEnd, userId]);

      await this.logEvent({
        userId,
        eventType: 'payment.completed',
        metadata: { newPeriodEnd: newPeriodEnd.toISOString() },
      });
    }

    await this.invalidateCache(userId);

    // Send confirmation email
    const [userRows] = await DB.query('SELECT email FROM users WHERE id = ?', [userId]);
    const user = (userRows as any[])[0];
    if (user?.email) {
      const updatedSub = await this.getSubscriptionFromDB(userId);
      await emailService.queueEmail(user.email, 'payment_confirmed', {
        amount: '9.99',
        nextBillingDate: updatedSub.currentPeriodEnd?.toLocaleDateString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric',
        }) || 'N/A',
      });
    }

    return this.getSubscriptionFromDB(userId);
  }

  /**
   * Cancel subscription — user-initiated.
   */
  async cancelSubscription(userId: number, reason?: string): Promise<Subscription> {
    const current = await this.getSubscriptionFromDB(userId);
    this.validateTransition(current.status, 'cancelled');

    // Cancel with PayPal if applicable
    if (current.providerSubscriptionId && this.provider) {
      await this.provider.cancelSubscription(current.providerSubscriptionId, reason);
    }

    await DB.query(`
      UPDATE user_subscriptions
      SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = ?
      WHERE user_id = ?
    `, [reason || null, userId]);

    await this.invalidateCache(userId);

    await this.logEvent({
      userId,
      eventType: 'subscription.cancelled',
      metadata: { reason, accessUntil: current.currentPeriodEnd?.toISOString() },
    });

    // Send cancellation email
    const [userRows] = await DB.query('SELECT email FROM users WHERE id = ?', [userId]);
    const user = (userRows as any[])[0];
    if (user?.email) {
      await emailService.queueEmail(user.email, 'subscription_cancelled', {
        accessUntil: current.currentPeriodEnd?.toLocaleDateString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric',
        }) || 'immediately',
      });
    }

    logger.info('Subscription cancelled', { userId, reason });

    return this.getSubscriptionFromDB(userId);
  }

  /**
   * Reactivate a cancelled subscription.
   */
  async reactivateSubscription(userId: number, params: {
    provider: PaymentProvider;
    providerSubscriptionId: string;
    providerPlanId: string;
    providerCustomerId?: string;
  }): Promise<Subscription> {
    const current = await this.getSubscriptionFromDB(userId);
    this.validateTransition(current.status, 'active');

    return this.activateSubscription(userId, params);
  }

  // ========================================================================
  // USAGE TRACKING
  // ========================================================================

  /**
   * Get usage for a specific feature and period.
   */
  async getUsage(userId: number, featureKey: string, periodType: 'daily' | 'monthly'): Promise<UsageRecord> {
    const periodStart = this.getCurrentPeriodStart(periodType);
    const limit = getFreeTierLimit(this.config, featureKey) ?? 999999;

    const [rows] = await DB.query(`
      SELECT count, limit_value FROM usage_tracking
      WHERE user_id = ? AND feature_key = ? AND period_type = ? AND period_start = ?
    `, [userId, featureKey, periodType, periodStart]);

    const dbRows = rows as any[];
    if (dbRows.length === 0) {
      return { featureKey, periodType, periodStart, count: 0, limit };
    }

    return {
      featureKey,
      periodType,
      periodStart,
      count: dbRows[0].count,
      limit: dbRows[0].limit_value,
    };
  }

  /**
   * Increment usage counter. Returns updated count and whether limit is exceeded.
   */
  async incrementUsage(userId: number, featureKey: string, periodType: 'daily' | 'monthly'): Promise<{
    count: number;
    limit: number;
    exceeded: boolean;
  }> {
    const periodStart = this.getCurrentPeriodStart(periodType);
    const limit = getFreeTierLimit(this.config, featureKey) ?? 999999;

    await DB.query(`
      INSERT INTO usage_tracking (user_id, feature_key, period_type, period_start, count, limit_value)
      VALUES (?, ?, ?, ?, 1, ?)
      ON DUPLICATE KEY UPDATE count = count + 1, updated_at = CURRENT_TIMESTAMP
    `, [userId, featureKey, periodType, periodStart, limit]);

    // Invalidate subscription cache so usage is reflected immediately
    await this.invalidateCache(userId);

    const usage = await this.getUsage(userId, featureKey, periodType);

    return {
      count: usage.count,
      limit: usage.limit,
      exceeded: usage.count > usage.limit,
    };
  }

  /**
   * Check if a feature's usage limit is exceeded (without incrementing).
   */
  async isUsageExceeded(userId: number, featureKey: string, periodType: 'daily' | 'monthly'): Promise<boolean> {
    const usage = await this.getUsage(userId, featureKey, periodType);
    return usage.count >= usage.limit;
  }

  /**
   * Check if user has access to a specific feature based on their tier.
   */
  async isFeatureAllowed(userId: number, feature: string): Promise<boolean> {
    const { tier, status } = await this.getSubscriptionTier(userId);

    // Active, trialing, past_due (grace), and cancelled (within period) get tier access
    const hasAccess = ['active', 'trialing', 'past_due'].includes(status) ||
      (status === 'cancelled' && await this.isWithinPeriod(userId));

    const effectiveTier = hasAccess ? tier : 'free';
    return tierHasFeature(this.config, effectiveTier, feature);
  }

  // ========================================================================
  // CRON JOBS
  // ========================================================================

  /**
   * Check and expire grace periods. Run every hour.
   */
  async checkAndExpireGracePeriods(): Promise<number> {
    const [rows] = await DB.query(`
      SELECT user_id FROM user_subscriptions
      WHERE status = 'past_due' AND grace_period_end IS NOT NULL AND grace_period_end < NOW()
    `);

    const users = rows as any[];
    let expired = 0;

    for (const row of users) {
      try {
        await DB.query(`
          UPDATE user_subscriptions
          SET status = 'cancelled', tier = 'free', cancelled_at = NOW(), cancel_reason = 'Grace period expired'
          WHERE user_id = ?
        `, [row.user_id]);

        await this.invalidateCache(row.user_id);

        await this.logEvent({
          userId: row.user_id,
          eventType: 'grace_period.expired',
        });

        expired++;
        logger.info('Grace period expired, downgraded to free', { userId: row.user_id });
      } catch (error) {
        logger.error('Failed to expire grace period', error as Error, { userId: row.user_id });
      }
    }

    return expired;
  }

  /**
   * Check and expire trials. Run every hour.
   */
  async checkAndExpireTrials(): Promise<number> {
    const [rows] = await DB.query(`
      SELECT user_id FROM user_subscriptions
      WHERE status = 'trialing' AND trial_end IS NOT NULL AND trial_end < NOW()
    `);

    const users = rows as any[];
    let expired = 0;

    for (const row of users) {
      try {
        await DB.query(`
          UPDATE user_subscriptions
          SET status = 'free', tier = 'free'
          WHERE user_id = ? AND status = 'trialing'
        `, [row.user_id]);

        await this.invalidateCache(row.user_id);

        await this.logEvent({
          userId: row.user_id,
          eventType: 'subscription.trial_expired',
        });

        expired++;
        logger.info('Trial expired', { userId: row.user_id });
      } catch (error) {
        logger.error('Failed to expire trial', error as Error, { userId: row.user_id });
      }
    }

    return expired;
  }

  /**
   * Send trial ending notifications. Run daily.
   * Sends email when trial has 2 days left.
   */
  async sendTrialEndingNotifications(): Promise<number> {
    const [rows] = await DB.query(`
      SELECT us.user_id, us.trial_end, u.email
      FROM user_subscriptions us
      JOIN users u ON us.user_id = u.id
      WHERE us.status = 'trialing'
        AND us.trial_end IS NOT NULL
        AND us.trial_end BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 2 DAY)
    `);

    const users = rows as any[];
    let sent = 0;

    for (const row of users) {
      try {
        const daysLeft = Math.ceil(
          (new Date(row.trial_end).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
        );

        await emailService.queueEmail(row.email, 'trial_ending', {
          daysLeft: String(daysLeft),
        });

        await this.logEvent({
          userId: row.user_id,
          eventType: 'subscription.trial_ending',
          metadata: { daysLeft },
        });

        sent++;
      } catch (error) {
        logger.error('Failed to send trial ending notification', error as Error, { userId: row.user_id });
      }
    }

    return sent;
  }

  /**
   * Expire cancelled subscriptions after 90 days.
   */
  async expireCancelledSubscriptions(): Promise<number> {
    const [result] = await DB.query(`
      UPDATE user_subscriptions
      SET status = 'expired'
      WHERE status = 'cancelled'
        AND cancelled_at IS NOT NULL
        AND cancelled_at < DATE_SUB(NOW(), INTERVAL 90 DAY)
    `);

    const affected = (result as any).affectedRows || 0;
    if (affected > 0) {
      logger.info(`Expired ${affected} cancelled subscriptions`);
    }
    return affected;
  }

  // ========================================================================
  // INTERNAL HELPERS
  // ========================================================================

  private async getSubscriptionFromDB(userId: number): Promise<Subscription> {
    const [rows] = await DB.query(
      'SELECT * FROM user_subscriptions WHERE user_id = ?',
      [userId]
    );

    const dbRows = rows as any[];
    if (dbRows.length === 0) {
      return this.createFreeSubscription(userId);
    }

    return this.mapRowToSubscription(dbRows[0]);
  }

  private mapRowToSubscription(row: any): Subscription {
    return {
      userId: row.user_id,
      tier: row.tier,
      status: row.status,
      provider: row.provider,
      providerSubscriptionId: row.provider_subscription_id,
      providerPlanId: row.provider_plan_id,
      providerCustomerId: row.provider_customer_id,
      trialStart: row.trial_start ? new Date(row.trial_start) : null,
      trialEnd: row.trial_end ? new Date(row.trial_end) : null,
      currentPeriodStart: row.current_period_start ? new Date(row.current_period_start) : null,
      currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end) : null,
      gracePeriodEnd: row.grace_period_end ? new Date(row.grace_period_end) : null,
      cancelledAt: row.cancelled_at ? new Date(row.cancelled_at) : null,
      cancelReason: row.cancel_reason,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private async buildSubscriptionWithUsage(sub: Subscription): Promise<SubscriptionWithUsage> {
    const effectiveTier = this.getEffectiveTier(sub);
    const features = getTierFeatures(this.config, effectiveTier);
    const usage = await this.buildUsageSummary(sub.userId, effectiveTier);

    let trialDaysLeft: number | null = null;
    if (sub.status === 'trialing' && sub.trialEnd) {
      trialDaysLeft = Math.max(0, Math.ceil(
        (sub.trialEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
      ));
    }

    let graceDaysLeft: number | null = null;
    if (sub.status === 'past_due' && sub.gracePeriodEnd) {
      graceDaysLeft = Math.max(0, Math.ceil(
        (sub.gracePeriodEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
      ));
    }

    let accessUntil: Date | null = null;
    if (sub.status === 'cancelled' && sub.currentPeriodEnd) {
      accessUntil = sub.currentPeriodEnd;
    } else if (sub.status === 'trialing' && sub.trialEnd) {
      accessUntil = sub.trialEnd;
    } else if (sub.status === 'past_due' && sub.gracePeriodEnd) {
      accessUntil = sub.gracePeriodEnd;
    }

    return {
      ...sub,
      features,
      usage,
      trialDaysLeft,
      graceDaysLeft,
      accessUntil,
    };
  }

  private async buildUsageSummary(userId: number, tier: SubscriptionTier): Promise<UsageSummary> {
    // Premium users have no limits
    if (tier !== 'free') {
      return {};
    }

    const summary: UsageSummary = {};
    const limits = this.config.freeLimits;

    for (const [featureKey, limit] of Object.entries(limits)) {
      const periodType = featureKey.includes('per_day') ? 'daily' as const : 'monthly' as const;
      const usage = await this.getUsage(userId, featureKey, periodType);

      const resetsAt = periodType === 'daily'
        ? this.getNextDayStart()
        : this.getNextMonthStart();

      summary[featureKey] = {
        used: usage.count,
        limit,
        resetsAt: resetsAt.toISOString(),
        isExceeded: usage.count >= limit,
      };
    }

    return summary;
  }

  private getEffectiveTier(sub: Subscription): SubscriptionTier {
    switch (sub.status) {
      case 'active':
      case 'trialing':
      case 'past_due':
        return sub.tier;
      case 'cancelled':
        // Access continues until period end
        if (sub.currentPeriodEnd && sub.currentPeriodEnd > new Date()) {
          return sub.tier;
        }
        return 'free';
      default:
        return 'free';
    }
  }

  private async isWithinPeriod(userId: number): Promise<boolean> {
    const [rows] = await DB.query(
      'SELECT current_period_end FROM user_subscriptions WHERE user_id = ? AND current_period_end > NOW()',
      [userId]
    );
    return (rows as any[]).length > 0;
  }

  private validateTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      throw new Error(`Invalid subscription transition: ${from} → ${to}`);
    }
  }

  private async invalidateCache(userId: number): Promise<void> {
    await mirrorRedis.del(cacheKey(userId));
  }

  private async logEvent(event: SubscriptionEvent): Promise<void> {
    try {
      await DB.query(`
        INSERT INTO subscription_events (user_id, event_type, provider_event_id, event_data, metadata, processed_at)
        VALUES (?, ?, ?, ?, ?, NOW())
      `, [
        event.userId,
        event.eventType,
        event.providerEventId || null,
        event.eventData ? JSON.stringify(event.eventData) : null,
        event.metadata ? JSON.stringify(event.metadata) : null,
      ]);

      // Also log to activity_logs for analytics
      await DB.query(`
        INSERT INTO activity_logs (user_id, action, metadata, risk_level, page_url, created_at)
        VALUES (?, ?, ?, 'low', ?, NOW())
      `, [
        event.userId,
        event.eventType,
        JSON.stringify({ ...event.metadata, ...event.eventData }),
        '/subscription',
      ]);
    } catch (error) {
      logger.error('Failed to log subscription event', error as Error, {
        userId: event.userId,
        eventType: event.eventType,
      });
    }
  }

  private getCurrentPeriodStart(periodType: 'daily' | 'monthly'): string {
    const now = new Date();
    if (periodType === 'daily') {
      return now.toISOString().split('T')[0]; // YYYY-MM-DD
    }
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }

  private getNextDayStart(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private getNextMonthStart(): Date {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + 1, 1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
}
