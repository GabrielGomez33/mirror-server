-- ============================================================================
-- PAYWALL DATABASE SCHEMA
-- ============================================================================
-- File: paywall/models/subscription.schema.sql
-- Run this migration to add subscription support to the mirror-server database.
-- All statements use IF NOT EXISTS for safe re-execution.
-- ============================================================================

-- User subscription state (one row per user)
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  tier ENUM('free', 'premium', 'enterprise') NOT NULL DEFAULT 'free',
  status ENUM('free', 'trialing', 'active', 'past_due', 'cancelled', 'expired') NOT NULL DEFAULT 'free',
  provider ENUM('paypal', 'stripe', 'manual') NULL,
  provider_subscription_id VARCHAR(255) NULL,
  provider_plan_id VARCHAR(255) NULL,
  provider_customer_id VARCHAR(255) NULL,
  trial_start TIMESTAMP NULL,
  trial_end TIMESTAMP NULL,
  current_period_start TIMESTAMP NULL,
  current_period_end TIMESTAMP NULL,
  grace_period_end TIMESTAMP NULL,
  cancelled_at TIMESTAMP NULL,
  cancel_reason VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_provider_sub (provider_subscription_id),
  INDEX idx_grace (grace_period_end),
  INDEX idx_trial_end (trial_end),
  CONSTRAINT fk_subscription_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Subscription event log (immutable audit trail)
CREATE TABLE IF NOT EXISTS subscription_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  provider_event_id VARCHAR(255) NULL,
  event_data JSON NULL,
  metadata JSON NULL,
  processed_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_events (user_id, event_type, created_at),
  UNIQUE INDEX idx_idempotency (provider_event_id),
  CONSTRAINT fk_event_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Usage tracking for free-tier limits
CREATE TABLE IF NOT EXISTS usage_tracking (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  feature_key VARCHAR(100) NOT NULL,
  period_type ENUM('daily', 'weekly', 'monthly') NOT NULL,
  period_start DATE NOT NULL,
  count INT NOT NULL DEFAULT 0,
  limit_value INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_user_feature_period (user_id, feature_key, period_type, period_start),
  INDEX idx_user_id (user_id),
  CONSTRAINT fk_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Email verification tokens
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token VARCHAR(128) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_token (token),
  INDEX idx_user (user_id),
  CONSTRAINT fk_verification_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
