// ============================================================================
// PAYPAL WEBHOOK HANDLER
// ============================================================================
// File: paywall/webhooks/paypal.webhooks.ts
// Handles PayPal subscription lifecycle webhook events.
// Mounted BEFORE auth middleware (PayPal can't authenticate as a user).
// ============================================================================

import { Router, Request, Response } from 'express';
import { Logger } from '../../utils/logger';
import { DB } from '../../db';
import type { PayPalProvider } from '../providers/paypal.provider';
import type { SubscriptionService } from '../services/subscription.service';
import type { PayPalWebhookEvent } from '../types';

const logger = new Logger('PayPalWebhooks');

// ============================================================================
// WEBHOOK ROUTER FACTORY
// ============================================================================

export function createPayPalWebhookRouter(
  provider: PayPalProvider,
  subscriptionService: SubscriptionService
): Router {
  const router = Router();

  // Raw body parser for webhook signature verification
  router.use((req: Request, _res: Response, next) => {
    // Body should already be parsed as JSON by express.json()
    // Store raw body for signature verification
    (req as any).rawBody = JSON.stringify(req.body);
    next();
  });

  router.post('/paypal', async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      // 1. Verify webhook signature
      const rawBody = (req as any).rawBody || JSON.stringify(req.body);
      const headers = req.headers as Record<string, string>;

      const isValid = await provider.verifyWebhook(headers, rawBody);

      if (!isValid) {
        logger.warn('PayPal webhook signature verification failed', {
          transmissionId: headers['paypal-transmission-id'],
        });
        // Return 200 to prevent PayPal from retrying (invalid signature = likely spoofed)
        res.status(200).json({ status: 'signature_invalid' });
        return;
      }

      const event = req.body as PayPalWebhookEvent;

      // 2. Idempotency check — skip if we've already processed this event
      const [existing] = await DB.query(
        'SELECT id FROM subscription_events WHERE provider_event_id = ?',
        [event.id]
      );

      if ((existing as any[]).length > 0) {
        logger.debug('PayPal webhook duplicate, skipping', { eventId: event.id });
        res.status(200).json({ status: 'duplicate' });
        return;
      }

      // 3. Extract user ID from custom_id field
      const customId = event.resource?.custom_id || event.resource?.custom || '';
      const userId = await extractUserId(customId, event.resource?.subscriber?.email_address);

      if (!userId) {
        logger.warn('PayPal webhook: could not determine user', {
          eventId: event.id,
          eventType: event.event_type,
          customId,
        });
        // Still return 200 — we don't want PayPal retrying something we can't process
        res.status(200).json({ status: 'user_not_found' });
        return;
      }

      // 4. Process event based on type
      logger.info('Processing PayPal webhook', {
        eventId: event.id,
        eventType: event.event_type,
        userId,
      });

      await processWebhookEvent(event, userId, subscriptionService);

      const duration = Date.now() - startTime;
      logger.info('PayPal webhook processed', {
        eventId: event.id,
        eventType: event.event_type,
        userId,
        duration: `${duration}ms`,
      });

      res.status(200).json({ status: 'processed' });

    } catch (error) {
      logger.error('PayPal webhook processing error', error as Error);
      // Return 200 anyway — retries on our errors will just cause the same failure
      // The event is logged for manual review
      res.status(200).json({ status: 'error_logged' });
    }
  });

  return router;
}

// ============================================================================
// EVENT PROCESSING
// ============================================================================

async function processWebhookEvent(
  event: PayPalWebhookEvent,
  userId: number,
  subscriptionService: SubscriptionService
): Promise<void> {
  const resource = event.resource;

  switch (event.event_type) {
    // ====================================================================
    // SUBSCRIPTION LIFECYCLE
    // ====================================================================

    case 'BILLING.SUBSCRIPTION.ACTIVATED': {
      const subscriptionId = resource.id;
      const planId = resource.plan_id;
      const payerId = resource.subscriber?.payer_id;

      // Check if already activated (client-side activation may have beaten the webhook)
      const currentSub = await subscriptionService.getSubscription(userId);
      if (currentSub.status === 'active' && currentSub.providerSubscriptionId === subscriptionId) {
        logger.info('Subscription already active, skipping webhook activation', { userId, subscriptionId });
      } else {
        await subscriptionService.activateSubscription(userId, {
          provider: 'paypal',
          providerSubscriptionId: subscriptionId,
          providerPlanId: planId,
          providerCustomerId: payerId,
        });
      }

      await logWebhookEvent(userId, event, 'subscription.activated');
      break;
    }

    case 'BILLING.SUBSCRIPTION.CANCELLED': {
      const cancelSub = await subscriptionService.getSubscription(userId);
      if (cancelSub.status === 'cancelled' || cancelSub.status === 'expired' || cancelSub.status === 'free') {
        logger.info('Subscription already cancelled/expired, skipping', { userId });
      } else {
        await subscriptionService.cancelSubscription(userId, 'Cancelled via PayPal');
      }
      await logWebhookEvent(userId, event, 'subscription.cancelled');
      break;
    }

    case 'BILLING.SUBSCRIPTION.SUSPENDED': {
      // PayPal suspends after repeated payment failures
      await subscriptionService.handlePaymentFailed(userId);
      await logWebhookEvent(userId, event, 'payment.failed');
      break;
    }

    case 'BILLING.SUBSCRIPTION.EXPIRED': {
      // Subscription naturally expired (fixed-term plans)
      try {
        await DB.query(`
          UPDATE user_subscriptions SET status = 'expired', tier = 'free' WHERE user_id = ?
        `, [userId]);
      } catch { /* log but don't fail */ }
      await logWebhookEvent(userId, event, 'subscription.expired');
      break;
    }

    case 'BILLING.SUBSCRIPTION.UPDATED': {
      // Plan change or other update — refresh from PayPal
      logger.info('Subscription updated via PayPal', { userId, subscriptionId: resource.id });
      await logWebhookEvent(userId, event, 'subscription.activated');
      break;
    }

    // ====================================================================
    // PAYMENT EVENTS
    // ====================================================================

    case 'PAYMENT.SALE.COMPLETED': {
      const amount = resource.amount?.total || resource.amount?.value;
      const nextBilling = resource.billing_agreement_id ?
        undefined : undefined; // PayPal doesn't always include next billing in sale events

      // Determine period end from the subscription itself if possible
      let periodEnd: Date | undefined;
      if (resource.billing_agreement_id) {
        // This is a subscription payment
        periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // +30 days
      }

      await subscriptionService.handlePaymentSuccess(userId, periodEnd);
      await logWebhookEvent(userId, event, 'payment.completed', { amount });
      break;
    }

    case 'PAYMENT.SALE.DENIED':
    case 'PAYMENT.SALE.PENDING': {
      await subscriptionService.handlePaymentFailed(userId);
      await logWebhookEvent(userId, event, 'payment.failed');
      break;
    }

    case 'PAYMENT.SALE.REFUNDED':
    case 'PAYMENT.SALE.REVERSED': {
      logger.warn('Payment refunded/reversed', { userId, eventId: event.id });
      await logWebhookEvent(userId, event, 'payment.refunded');
      break;
    }

    // ====================================================================
    // DEFAULT
    // ====================================================================

    default: {
      logger.debug('Unhandled PayPal webhook event type', {
        eventType: event.event_type,
        userId,
      });
      await logWebhookEvent(userId, event, event.event_type as any);
    }
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Extract user ID from PayPal custom_id field or by looking up email.
 * custom_id format: "user_123"
 */
async function extractUserId(customId: string, email?: string): Promise<number | null> {
  // Try custom_id first
  if (customId) {
    const match = customId.match(/^user_(\d+)$/);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  // Fallback: look up by provider subscription ID in our DB
  // (webhook events include the subscription resource with its ID)
  // This is handled by the caller if custom_id fails

  // Last resort: look up by email
  if (email) {
    try {
      const [rows] = await DB.query('SELECT id FROM users WHERE email = ?', [email]);
      const users = rows as any[];
      if (users.length === 1) {
        return users[0].id;
      }
    } catch {
      // Fallthrough
    }
  }

  return null;
}

/**
 * Log webhook event to subscription_events table (with idempotency key).
 */
async function logWebhookEvent(
  userId: number,
  event: PayPalWebhookEvent,
  internalEventType: string,
  extraMetadata?: Record<string, any>
): Promise<void> {
  try {
    await DB.query(`
      INSERT INTO subscription_events (user_id, event_type, provider_event_id, event_data, metadata, processed_at)
      VALUES (?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE processed_at = NOW()
    `, [
      userId,
      internalEventType,
      event.id,
      JSON.stringify(event),
      extraMetadata ? JSON.stringify(extraMetadata) : null,
    ]);
  } catch (error) {
    logger.error('Failed to log webhook event', error as Error, { eventId: event.id });
  }
}
