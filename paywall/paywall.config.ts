// ============================================================================
// PAYWALL CONFIGURATION PARSER
// ============================================================================
// File: paywall/paywall.config.ts
// Reads and validates .payenv, exports typed configuration.
// ============================================================================

import fs from 'fs';
import path from 'path';
import { Logger } from '../utils/logger';
import type {
  TierDefinition,
  FeatureGateMap,
  FreeTierLimits,
  SubscriptionTier,
  PaymentProvider,
} from './types';

const logger = new Logger('PaywallConfig');

// ============================================================================
// CONFIGURATION INTERFACE
// ============================================================================

export interface PaywallConfig {
  // Provider
  provider: PaymentProvider;
  mode: 'sandbox' | 'live';

  // PayPal
  paypal: {
    clientId: string;
    clientSecret: string;
    webhookId: string;
    apiBase: string;
  };

  // Product
  productId: string;
  productName: string;

  // Tiers
  tiers: TierDefinition[];

  // Feature gates
  gates: FeatureGateMap;

  // Free tier limits
  freeLimits: FreeTierLimits;

  // Trial
  trial: {
    enabled: boolean;
    days: number;
    tier: SubscriptionTier;
  };

  // Grace period
  gracePeriodDays: number;

  // Webhook
  webhookPath: string;

  // Currency
  currency: string;

  // URLs
  returnUrl: string;
  cancelUrl: string;
}

// ============================================================================
// PARSER
// ============================================================================

function parsePayenv(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};

  if (!fs.existsSync(filePath)) {
    logger.warn(`.payenv file not found at ${filePath}. Using environment variables only.`);
    return vars;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();

    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.substring(1, value.length - 1);
    }

    vars[key] = value;
  }

  return vars;
}

function getVar(payenvVars: Record<string, string>, key: string, fallback?: string): string {
  return process.env[key] || payenvVars[key] || fallback || '';
}

function parseJSON<T>(value: string, fallback: T, label: string): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    logger.error(`Failed to parse ${label} JSON`, error as Error);
    return fallback;
  }
}

// ============================================================================
// LOAD AND VALIDATE
// ============================================================================

export function loadPaywallConfig(payenvPath?: string): PaywallConfig {
  const filePath = payenvPath || path.resolve(process.cwd(), '.payenv');
  const vars = parsePayenv(filePath);

  const mode = getVar(vars, 'PAYWALL_MODE', 'sandbox') as 'sandbox' | 'live';
  const provider = getVar(vars, 'PAYWALL_PROVIDER', 'paypal') as PaymentProvider;

  const paypalApiBase = mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

  const config: PaywallConfig = {
    provider,
    mode,

    paypal: {
      clientId: getVar(vars, 'PAYPAL_CLIENT_ID'),
      clientSecret: getVar(vars, 'PAYPAL_CLIENT_SECRET'),
      webhookId: getVar(vars, 'PAYPAL_WEBHOOK_ID'),
      apiBase: paypalApiBase,
    },

    productId: getVar(vars, 'PAYWALL_PRODUCT_ID', 'mirror-app'),
    productName: getVar(vars, 'PAYWALL_PRODUCT_NAME', 'Mirror Premium'),

    tiers: parseJSON<TierDefinition[]>(
      getVar(vars, 'PAYWALL_TIERS'),
      [
        { id: 'free', name: 'Free', price: 0, features: [] },
        { id: 'premium', name: 'Premium', price: 9.99, features: [], trial_days: 7 },
      ],
      'PAYWALL_TIERS'
    ),

    gates: parseJSON<FeatureGateMap>(
      getVar(vars, 'PAYWALL_GATES'),
      {},
      'PAYWALL_GATES'
    ),

    freeLimits: parseJSON<FreeTierLimits>(
      getVar(vars, 'PAYWALL_FREE_LIMITS'),
      { journal_entries_per_month: 5, groups_joined: 1, dina_queries_per_day: 3 },
      'PAYWALL_FREE_LIMITS'
    ),

    trial: {
      enabled: getVar(vars, 'PAYWALL_TRIAL_ENABLED', 'true') === 'true',
      days: parseInt(getVar(vars, 'PAYWALL_TRIAL_DAYS', '7'), 10),
      tier: getVar(vars, 'PAYWALL_TRIAL_TIER', 'premium') as SubscriptionTier,
    },

    gracePeriodDays: parseInt(getVar(vars, 'PAYWALL_GRACE_PERIOD_DAYS', '5'), 10),

    webhookPath: getVar(vars, 'PAYWALL_WEBHOOK_PATH', '/mirror/api/paywall/webhooks'),

    currency: getVar(vars, 'PAYWALL_CURRENCY', 'USD'),

    returnUrl: getVar(vars, 'PAYWALL_RETURN_URL', 'https://www.theundergroundrailroad.world/Mirror/dashboard?subscription=success'),
    cancelUrl: getVar(vars, 'PAYWALL_CANCEL_URL', 'https://www.theundergroundrailroad.world/Mirror/dashboard?subscription=cancelled'),
  };

  // Validate
  validateConfig(config);

  return config;
}

function validateConfig(config: PaywallConfig): void {
  const warnings: string[] = [];
  const errors: string[] = [];

  // PayPal credentials check
  if (config.provider === 'paypal') {
    if (!config.paypal.clientId) warnings.push('PAYPAL_CLIENT_ID not set — subscription creation will fail');
    if (!config.paypal.clientSecret) warnings.push('PAYPAL_CLIENT_SECRET not set — subscription creation will fail');
    if (!config.paypal.webhookId) warnings.push('PAYPAL_WEBHOOK_ID not set — webhook verification will fail');
  }

  // Tier validation
  const tierIds = config.tiers.map(t => t.id);
  if (!tierIds.includes('free')) {
    errors.push('Tiers must include a "free" tier');
  }

  // Gate validation
  for (const [feature, tier] of Object.entries(config.gates)) {
    if (!tierIds.includes(tier)) {
      warnings.push(`Feature gate "${feature}" references unknown tier "${tier}"`);
    }
  }

  // Trial validation
  if (config.trial.enabled && config.trial.days < 1) {
    warnings.push('Trial enabled but PAYWALL_TRIAL_DAYS is less than 1');
  }

  for (const warning of warnings) {
    logger.warn(`Paywall config: ${warning}`);
  }

  for (const error of errors) {
    logger.error(`Paywall config: ${error}`);
    throw new Error(`Paywall configuration error: ${error}`);
  }

  logger.info('Paywall configuration loaded', {
    provider: config.provider,
    mode: config.mode,
    tiers: tierIds.length,
    gates: Object.keys(config.gates).length,
    trialEnabled: config.trial.enabled,
    trialDays: config.trial.days,
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/** Get tier definition by ID */
export function getTierDefinition(config: PaywallConfig, tierId: SubscriptionTier): TierDefinition | undefined {
  return config.tiers.find(t => t.id === tierId);
}

/** Get features available for a tier */
export function getTierFeatures(config: PaywallConfig, tierId: SubscriptionTier): string[] {
  const tier = getTierDefinition(config, tierId);
  return tier?.features || [];
}

/** Check if a feature requires a specific tier */
export function getRequiredTier(config: PaywallConfig, feature: string): SubscriptionTier {
  return config.gates[feature] || 'free';
}

/** Check if a tier has access to a feature */
export function tierHasFeature(config: PaywallConfig, tierId: SubscriptionTier, feature: string): boolean {
  const requiredTier = getRequiredTier(config, feature);
  const tierOrder: SubscriptionTier[] = ['free', 'premium', 'enterprise'];
  return tierOrder.indexOf(tierId) >= tierOrder.indexOf(requiredTier);
}

/** Get the usage limit for a free-tier feature */
export function getFreeTierLimit(config: PaywallConfig, featureKey: string): number | null {
  return config.freeLimits[featureKey] ?? null;
}
