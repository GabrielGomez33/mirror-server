// ============================================================================
// PAYPAL SUBSCRIPTIONS API PROVIDER
// ============================================================================
// File: paywall/providers/paypal.provider.ts
// Implements PayPal Subscriptions API v1 for recurring billing.
// Handles: subscription creation, cancellation, status checks, webhook verification.
// ============================================================================

import { Logger } from '../../utils/logger';
import { mirrorRedis } from '../../config/redis';
import type {
  PaywallProviderInterface,
  CreateSubscriptionResponse,
  PayPalSubscription,
} from '../types';
import type { PaywallConfig } from '../paywall.config';

const logger = new Logger('PayPalProvider');

// ============================================================================
// PAYPAL PROVIDER CLASS
// ============================================================================

export class PayPalProvider implements PaywallProviderInterface {
  readonly name = 'paypal';
  private config: PaywallConfig;
  private tokenCacheKey = 'paywall:paypal:access_token';

  constructor(config: PaywallConfig) {
    this.config = config;
  }

  // ========================================================================
  // OAUTH2 TOKEN MANAGEMENT
  // ========================================================================

  private async getAccessToken(): Promise<string> {
    // Check Redis cache first
    const cached = await mirrorRedis.get(this.tokenCacheKey);
    if (cached?.token) {
      return cached.token;
    }

    const { clientId, clientSecret, apiBase } = this.config.paypal;

    if (!clientId || !clientSecret) {
      throw new Error('PayPal client credentials not configured');
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch(`${apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('PayPal OAuth token failed', new Error(error));
      throw new Error(`PayPal OAuth failed: ${response.status}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };

    // Cache token with buffer (expire 5 min early)
    const ttl = Math.max(data.expires_in - 300, 60);
    await mirrorRedis.set(this.tokenCacheKey, { token: data.access_token }, ttl);

    return data.access_token;
  }

  private async paypalRequest(
    method: string,
    path: string,
    body?: any
  ): Promise<Response> {
    const token = await this.getAccessToken();
    const { apiBase } = this.config.paypal;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Prefer': 'return=representation',
    };

    const options: RequestInit = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    return fetch(`${apiBase}${path}`, options);
  }

  // ========================================================================
  // PRODUCT & PLAN SETUP (run once during initial setup)
  // ========================================================================

  /**
   * Create a PayPal product (catalog item). Run once per application.
   * Returns the product ID to use when creating plans.
   */
  async createProduct(): Promise<string> {
    const response = await this.paypalRequest('POST', '/v1/catalogs/products', {
      name: this.config.productName,
      description: `${this.config.productName} subscription`,
      type: 'SERVICE',
      category: 'SOFTWARE',
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create PayPal product: ${error}`);
    }

    const product = await response.json() as { id: string };
    logger.info('PayPal product created', { productId: product.id });
    return product.id;
  }

  /**
   * Create a PayPal billing plan for a tier. Run once per tier.
   * Returns the plan ID to store in .payenv PAYWALL_TIERS.
   */
  async createPlan(params: {
    productId: string;
    name: string;
    price: number;
    currency?: string;
    trialDays?: number;
  }): Promise<string> {
    const billingCycles: any[] = [];

    // Add trial cycle if specified
    if (params.trialDays && params.trialDays > 0) {
      billingCycles.push({
        frequency: { interval_unit: 'DAY', interval_count: params.trialDays },
        tenure_type: 'TRIAL',
        sequence: 1,
        total_cycles: 1,
        pricing_scheme: {
          fixed_price: { value: '0', currency_code: params.currency || this.config.currency },
        },
      });
    }

    // Regular billing cycle
    billingCycles.push({
      frequency: { interval_unit: 'MONTH', interval_count: 1 },
      tenure_type: 'REGULAR',
      sequence: params.trialDays ? 2 : 1,
      total_cycles: 0, // infinite
      pricing_scheme: {
        fixed_price: {
          value: params.price.toFixed(2),
          currency_code: params.currency || this.config.currency,
        },
      },
    });

    const response = await this.paypalRequest('POST', '/v1/billing/plans', {
      product_id: params.productId,
      name: params.name,
      description: `${params.name} monthly subscription`,
      billing_cycles: billingCycles,
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: 'CANCEL',
        payment_failure_threshold: 3,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create PayPal plan: ${error}`);
    }

    const plan = await response.json() as { id: string };
    logger.info('PayPal billing plan created', { planId: plan.id, name: params.name });
    return plan.id;
  }

  // ========================================================================
  // SUBSCRIPTION LIFECYCLE
  // ========================================================================

  async createSubscription(params: {
    planId: string;
    userId: number;
    email: string;
    returnUrl: string;
    cancelUrl: string;
    trialDays?: number;
  }): Promise<CreateSubscriptionResponse> {
    if (!params.planId) {
      throw new Error('PayPal plan ID is required — run setup to create plans first');
    }

    const body: any = {
      plan_id: params.planId,
      subscriber: {
        email_address: params.email,
      },
      application_context: {
        brand_name: this.config.productName,
        locale: 'en-US',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        return_url: params.returnUrl,
        cancel_url: params.cancelUrl,
      },
      custom_id: `user_${params.userId}`,
    };

    // If trial is handled at plan level, PayPal auto-applies it.
    // If we need a custom start date:
    if (params.trialDays && params.trialDays > 0) {
      const startTime = new Date();
      startTime.setDate(startTime.getDate() + params.trialDays);
      // Trial is built into the plan, but we can set start_time for custom trials
      // For plan-level trials, omit start_time and let PayPal handle it
    }

    const response = await this.paypalRequest('POST', '/v1/billing/subscriptions', body);

    if (!response.ok) {
      const error = await response.text();
      logger.error('PayPal subscription creation failed', new Error(error), {
        userId: params.userId,
        planId: params.planId,
      });
      throw new Error(`Failed to create PayPal subscription: ${response.status}`);
    }

    const subscription = await response.json() as {
      id: string;
      status: string;
      links: Array<{ href: string; rel: string }>;
    };

    const approvalLink = subscription.links.find(l => l.rel === 'approve');
    if (!approvalLink) {
      throw new Error('PayPal subscription created but no approval URL returned');
    }

    logger.info('PayPal subscription created', {
      subscriptionId: subscription.id,
      userId: params.userId,
      status: subscription.status,
    });

    return {
      subscriptionId: subscription.id,
      approvalUrl: approvalLink.href,
    };
  }

  async cancelSubscription(subscriptionId: string, reason?: string): Promise<boolean> {
    const response = await this.paypalRequest(
      'POST',
      `/v1/billing/subscriptions/${subscriptionId}/cancel`,
      { reason: reason || 'Customer requested cancellation' }
    );

    if (!response.ok && response.status !== 204) {
      const error = await response.text();
      logger.error('PayPal subscription cancellation failed', new Error(error), { subscriptionId });
      return false;
    }

    logger.info('PayPal subscription cancelled', { subscriptionId, reason });
    return true;
  }

  async getSubscription(subscriptionId: string): Promise<PayPalSubscription | null> {
    const response = await this.paypalRequest(
      'GET',
      `/v1/billing/subscriptions/${subscriptionId}`
    );

    if (!response.ok) {
      if (response.status === 404) return null;
      const error = await response.text();
      logger.error('PayPal subscription fetch failed', new Error(error), { subscriptionId });
      return null;
    }

    return await response.json() as PayPalSubscription;
  }

  // ========================================================================
  // WEBHOOK VERIFICATION
  // ========================================================================

  async verifyWebhook(headers: Record<string, string>, body: string): Promise<boolean> {
    const { webhookId, apiBase } = this.config.paypal;

    if (!webhookId) {
      logger.warn('PayPal webhook ID not configured — skipping verification');
      return false;
    }

    const transmissionId = headers['paypal-transmission-id'];
    const transmissionTime = headers['paypal-transmission-time'];
    const transmissionSig = headers['paypal-transmission-sig'];
    const certUrl = headers['paypal-cert-url'];
    const authAlgo = headers['paypal-auth-algo'];

    if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl) {
      logger.warn('PayPal webhook missing required headers');
      return false;
    }

    try {
      const token = await this.getAccessToken();

      const verifyResponse = await fetch(`${apiBase}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          auth_algo: authAlgo,
          cert_url: certUrl,
          transmission_id: transmissionId,
          transmission_sig: transmissionSig,
          transmission_time: transmissionTime,
          webhook_id: webhookId,
          webhook_event: JSON.parse(body),
        }),
      });

      if (!verifyResponse.ok) {
        logger.error('PayPal webhook verification API failed', new Error(`Status: ${verifyResponse.status}`));
        return false;
      }

      const result = await verifyResponse.json() as { verification_status: string };
      const verified = result.verification_status === 'SUCCESS';

      if (!verified) {
        logger.warn('PayPal webhook signature verification failed', {
          transmissionId,
          verificationStatus: result.verification_status,
        });
      }

      return verified;
    } catch (error) {
      logger.error('PayPal webhook verification exception', error as Error);
      return false;
    }
  }

  // ========================================================================
  // HEALTH CHECK
  // ========================================================================

  async healthCheck(): Promise<boolean> {
    try {
      await this.getAccessToken();
      return true;
    } catch {
      return false;
    }
  }
}
