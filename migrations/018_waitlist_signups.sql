-- ============================================================================
-- 018_waitlist_signups.sql
-- ----------------------------------------------------------------------------
-- Persistence for the public marketing landing page's email capture form
-- (theundergroundrailroad.world -> POST /mirror/api/waitlist).
--
-- CONTEXT
--   The landing page is served statically at the bare domain root and posts
--   an anonymous { email, source } payload. There is NO authenticated user
--   behind these rows — they are prospects, not accounts. This table is
--   therefore deliberately standalone: it has no FK to users(id).
--
-- DESIGN NOTES
--   * `email` is UNIQUE — the controller upserts (INSERT ... ON DUPLICATE KEY)
--     so a visitor submitting twice is idempotent, never a duplicate row and
--     never a 500. Stored lower-cased/trimmed by the controller.
--   * `source` tags the acquisition surface ('landing', a future 'blog',
--     'referral', etc.) so marketing can attribute signups without a schema
--     change.
--   * `referrer` / `user_agent` are coarse attribution signal, bounded in the
--     controller before insert. Never trusted for queries.
--   * `ip_truncated` is /24 (IPv4) or /48 (IPv6), matching the feedback
--     controller's abuse-triage approach — coarse signal, no precise locator.
--   * `metadata` is JSON for forward-compat (utm_* params, campaign tags, etc.)
--     without a migration.
--   * `status` tracks the prospect lifecycle so the existing EmailCampaignWorker
--     can later target 'pending' rows for a launch broadcast and mark them
--     'invited' / 'converted'.
--   * Idempotent + replayable. MySQL 8.0+, utf8mb4.
-- ============================================================================

CREATE TABLE IF NOT EXISTS waitlist_signups (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Prospect email. Lower-cased + trimmed by the controller. UNIQUE so a
  -- resubmission upserts instead of duplicating.
  email          VARCHAR(255)    NOT NULL,

  -- Acquisition surface. Defaults to 'landing' but the endpoint accepts any
  -- short tag so future pages/campaigns can attribute without a migration.
  source         VARCHAR(100)    NOT NULL DEFAULT 'landing',

  -- Document.referrer at submit-time (coarse attribution). Bounded to 500.
  referrer       VARCHAR(500)    NULL DEFAULT NULL,

  -- User-Agent header at submit-time. Bounded to 500.
  user_agent     VARCHAR(500)    NULL DEFAULT NULL,

  -- IP truncated to /24 (IPv4) or /48 (IPv6) for abuse triage only.
  ip_truncated   VARCHAR(45)     NULL DEFAULT NULL,

  -- Forward-compat envelope: utm_source/medium/campaign, referral codes, etc.
  metadata       JSON            NULL DEFAULT NULL,

  -- Prospect lifecycle:
  --   pending      -> captured, not yet emailed
  --   confirmed    -> double-opt-in confirmed (reserved for future use)
  --   invited      -> sent a launch / early-access invite
  --   converted    -> created a Mirror account
  --   unsubscribed -> asked out; suppress from broadcasts
  status         ENUM('pending','confirmed','invited','converted','unsubscribed')
                                 NOT NULL DEFAULT 'pending',

  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                                                ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- Idempotent capture: the controller relies on this unique key for upsert.
  UNIQUE KEY uq_waitlist_email (email),

  -- Marketing list-building: pull 'pending' rows oldest-first for a broadcast.
  INDEX idx_waitlist_status_created (status, created_at),

  -- Attribution reporting: signups by surface over time.
  INDEX idx_waitlist_source_created (source, created_at),

  -- Rate-limit / abuse lookback by IP.
  INDEX idx_waitlist_ip_created (ip_truncated, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
