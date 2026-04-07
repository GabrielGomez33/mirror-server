// ============================================================================
// UNIVERSAL PAYWALL TYPE DEFINITIONS
// ============================================================================
// File: paywall/types/index.ts
// Shared types for the entire paywall module.
// ============================================================================

// ============================================================================
// SUBSCRIPTION TIERS
// ============================================================================

export type SubscriptionTier = 'free' | 'premium' | 'enterprise';

export type SubscriptionStatus =
  | 'free'        // No subscription, free tier
  | 'trialing'    // Active trial period
  | 'active'      // Paid and current
  | 'past_due'    // Payment failed, in grace period
  | 'cancelled'   // User cancelled, access until period end
  | 'expired';    // Fully expired, no access to premium

export type PaymentProvider = 'paypal' | 'stripe' | 'manual';

// ============================================================================
// SUBSCRIPTION STATE
// ============================================================================

export interface Subscription {
  userId: number;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  provider: PaymentProvider | null;
  providerSubscriptionId: string | null;
  providerPlanId: string | null;
  providerCustomerId: string | null;
  trialStart: Date | null;
  trialEnd: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  gracePeriodEnd: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubscriptionWithUsage extends Subscription {
  features: string[];
  usage: UsageSummary;
  trialDaysLeft: number | null;
  graceDaysLeft: number | null;
  accessUntil: Date | null;
}

// ============================================================================
// USAGE TRACKING
// ============================================================================

export interface UsageRecord {
  featureKey: string;
  periodType: 'daily' | 'weekly' | 'monthly';
  periodStart: string; // YYYY-MM-DD
  count: number;
  limit: number;
}

export interface UsageSummary {
  [featureKey: string]: {
    used: number;
    limit: number;
    resetsAt: string; // ISO date string
    isExceeded: boolean;
  };
}

// ============================================================================
// TIER DEFINITIONS (from .payenv)
// ============================================================================

export interface TierDefinition {
  id: SubscriptionTier;
  name: string;
  price: number;
  paypal_plan_id?: string;
  trial_days?: number;
  features: string[];
}

export interface FeatureGateMap {
  [featureKey: string]: SubscriptionTier;
}

export interface FreeTierLimits {
  [featureKey: string]: number;
}

// ============================================================================
// SUBSCRIPTION EVENTS
// ============================================================================

export type SubscriptionEventType =
  | 'subscription.created'
  | 'subscription.trial_started'
  | 'subscription.trial_ending'
  | 'subscription.trial_expired'
  | 'subscription.activated'
  | 'subscription.cancelled'
  | 'subscription.reactivated'
  | 'subscription.expired'
  | 'payment.completed'
  | 'payment.failed'
  | 'payment.recovered'
  | 'payment.refunded'
  | 'grace_period.started'
  | 'grace_period.expired';

export interface SubscriptionEvent {
  userId: number;
  eventType: SubscriptionEventType;
  providerEventId?: string;
  eventData?: Record<string, any>;
  metadata?: Record<string, any>;
}

// ============================================================================
// PAYPAL SPECIFIC
// ============================================================================

export interface PayPalSubscription {
  id: string;
  status: string;
  plan_id: string;
  subscriber: {
    email_address: string;
    payer_id: string;
    name?: { given_name: string; surname: string };
  };
  billing_info?: {
    next_billing_time?: string;
    last_payment?: {
      amount: { currency_code: string; value: string };
      time: string;
    };
    cycle_executions?: Array<{
      tenure_type: string;
      sequence: number;
      cycles_completed: number;
      cycles_remaining: number;
      total_cycles: number;
    }>;
  };
  create_time: string;
  update_time: string;
  start_time: string;
}

export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource_type: string;
  resource: any;
  summary: string;
  create_time: string;
}

export interface PayPalWebhookHeaders {
  'paypal-transmission-id': string;
  'paypal-transmission-time': string;
  'paypal-transmission-sig': string;
  'paypal-cert-url': string;
  'paypal-auth-algo': string;
}

// ============================================================================
// API RESPONSES
// ============================================================================

export interface SubscriptionResponse {
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  trialDaysLeft: number | null;
  graceDaysLeft: number | null;
  accessUntil: string | null;
  features: string[];
  usage: UsageSummary;
  currentPeriodEnd: string | null;
  cancelledAt: string | null;
}

export interface PlanResponse {
  id: SubscriptionTier;
  name: string;
  price: number;
  currency: string;
  features: string[];
  trialDays: number;
  isCurrent: boolean;
}

export interface CreateSubscriptionResponse {
  approvalUrl: string;
  subscriptionId: string;
}

// ============================================================================
// PROVIDER INTERFACE
// ============================================================================

export interface PaywallProviderInterface {
  readonly name: string;

  /** Create a subscription and return the approval URL for the user */
  createSubscription(params: {
    planId: string;
    userId: number;
    email: string;
    returnUrl: string;
    cancelUrl: string;
    trialDays?: number;
  }): Promise<CreateSubscriptionResponse>;

  /** Cancel an active subscription */
  cancelSubscription(subscriptionId: string, reason?: string): Promise<boolean>;

  /** Get current subscription details from the provider */
  getSubscription(subscriptionId: string): Promise<PayPalSubscription | null>;

  /** Verify webhook signature authenticity */
  verifyWebhook(headers: Record<string, string>, body: string): Promise<boolean>;

  /** Test provider connectivity */
  healthCheck(): Promise<boolean>;
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

export interface SubscriptionRequest {
  subscription?: SubscriptionWithUsage;
}

// Augment Express Request
declare global {
  namespace Express {
    interface Request {
      subscription?: SubscriptionWithUsage;
    }
  }
}

// ============================================================================
// STATE MACHINE
// ============================================================================

/** Valid state transitions for the subscription state machine */
export const VALID_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  free: ['trialing', 'active'],
  trialing: ['active', 'free', 'cancelled'],
  active: ['past_due', 'cancelled'],
  past_due: ['active', 'cancelled'],
  cancelled: ['active', 'expired'],
  expired: ['active'], // resubscribe
};
