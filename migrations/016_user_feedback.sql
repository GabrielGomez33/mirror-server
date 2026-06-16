-- ============================================================================
-- 015_user_feedback.sql
-- ----------------------------------------------------------------------------
-- Persistence layer for the user-facing Feedback & Support page:
--   * Star ratings (1-5) with optional comment
--   * Issue / bug reports
--   * Feature recommendations
--   * Direct contact-support messages
--
-- TABLES
--   1. user_feedback             One row per submission (all 4 kinds).
--   2. user_feedback_email_log   Per-submission email delivery audit, so
--                                  the controller never double-sends the
--                                  operator-inbox copy on retry.
--
-- DESIGN NOTES
--   * FK columns referencing users(id) are INT signed NOT NULL to match
--     users.id exactly (see migration 011 — MySQL refuses the FK otherwise).
--   * ON DELETE CASCADE: when a user is purged (GDPR / account deletion),
--     their feedback rows go with them. The email_log row also CASCADEs so
--     no orphaned audit data is left behind.
--   * `kind` is an ENUM so corrupt values cannot be inserted, and so the
--     query planner can use covering indexes for the dashboard list page.
--   * `status` is intentionally an ENUM and not free-form text — the admin
--     dashboard will filter on it.
--   * `metadata` is JSON for forward-compat (e.g. browser/device info,
--     screenshot blob refs, page URL the user was on when they submitted).
--   * All CREATE/ALTER statements are idempotent and safe to replay.
--   * MySQL 8.0+. Charset utf8mb4 to support unicode comments.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. user_feedback
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_feedback (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The submitting user. NULL is not allowed: anonymous feedback comes in
  -- via a separate public endpoint we do not currently expose.
  user_id          INT             NOT NULL,

  -- Submission kind drives both UI behaviour and downstream routing.
  kind             ENUM('rating','issue','recommendation','contact')
                                   NOT NULL,

  -- 1..5 stars. Only populated for kind='rating'; NULL otherwise.
  rating           TINYINT UNSIGNED NULL DEFAULT NULL,

  -- Short user-supplied summary line. Required for issue / recommendation
  -- / contact; optional for rating.
  subject          VARCHAR(200)    NULL DEFAULT NULL,

  -- The main body. Required for issue / recommendation / contact. Optional
  -- comment for rating.
  message          TEXT            NULL DEFAULT NULL,

  -- Reply-to address the user wants us to use. Defaults to the user's
  -- on-file email at submit-time so a later email change does not break
  -- the support thread.
  contact_email    VARCHAR(255)    NULL DEFAULT NULL,

  -- Lifecycle. `new` -> `triaged` -> `in_progress` -> `resolved` | `wontfix`.
  status           ENUM('new','triaged','in_progress','resolved','wontfix')
                                   NOT NULL DEFAULT 'new',

  -- Severity is only meaningful for issues; null-friendly for everything
  -- else. Computed client-side from the form, server-validates the enum.
  severity         ENUM('low','medium','high','critical')
                                   NULL DEFAULT NULL,

  -- Free-form forward-compat envelope: page_url, app_version, user_agent,
  -- platform, screenshot pointer, browser language, etc. NEVER trust the
  -- contents for queries — only use it for human triage.
  metadata         JSON            NULL DEFAULT NULL,

  -- IP at submit-time. Stored for abuse triage only. Trimmed to /24 for
  -- IPv4 and /48 for IPv6 by the controller to limit retention exposure.
  ip_truncated     VARCHAR(45)     NULL DEFAULT NULL,

  -- Operator-side internal note (admin dashboard, not surfaced to user).
  admin_note       TEXT            NULL DEFAULT NULL,

  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                                                  ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  CONSTRAINT fk_user_feedback_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,

  -- Listings: admin filters by kind+status, sorted by recency.
  INDEX idx_uf_kind_status_created (kind, status, created_at DESC),

  -- Per-user history (the user's own page can list their submissions).
  INDEX idx_uf_user_created       (user_id, created_at DESC),

  -- Star-rating aggregates (avg, distribution) hit this index path.
  INDEX idx_uf_rating             (kind, rating),

  -- Rate-limit lookback by IP for abuse triage.
  INDEX idx_uf_ip_created         (ip_truncated, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ----------------------------------------------------------------------------
-- 2. user_feedback_email_log
-- ----------------------------------------------------------------------------
-- Per-feedback email audit. There are at most two operator-side emails per
-- submission: the operator-inbox copy and the user acknowledgement reply.
-- Idempotent retries: controller INSERT IGNOREs the (feedback_id, channel)
-- row before sending; if a unique-key violation is raised, send is skipped.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_feedback_email_log (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  feedback_id      BIGINT UNSIGNED NOT NULL,

  -- 'operator_inbox' : email to support inbox describing the submission.
  -- 'user_ack'       : automatic ack reply back to the submitter.
  channel          ENUM('operator_inbox','user_ack')
                                   NOT NULL,

  -- Final delivery status reported by the email provider.
  status           ENUM('queued','sent','failed','skipped')
                                   NOT NULL DEFAULT 'queued',

  -- Provider message id (Resend / Brevo) when available.
  provider_message_id VARCHAR(255) NULL DEFAULT NULL,

  -- Last error string from the provider on failure (truncated to 500).
  error            VARCHAR(500)    NULL DEFAULT NULL,

  sent_at          TIMESTAMP       NULL DEFAULT NULL,
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- One row per (submission, channel). Drives idempotent retry behaviour.
  UNIQUE KEY uq_feedback_email_channel (feedback_id, channel),

  CONSTRAINT fk_uf_email_feedback
    FOREIGN KEY (feedback_id) REFERENCES user_feedback(id) ON DELETE CASCADE,

  INDEX idx_uf_email_status_created (status, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;