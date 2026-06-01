-- ============================================================================
-- 014_email_broadcasts.sql
-- ----------------------------------------------------------------------------
-- Persistence layer for admin email broadcasts ("campaigns") sent from the
-- TUGRR Admin Portal through mirror-server's existing EmailService.
--
-- TABLES
--   1. email_campaigns            One row per composed broadcast.
--   2. email_campaign_recipients  One row per (campaign, user). Source of truth
--                                 for idempotent, resumable sending.
--   3. email_suppressions         Unsubscribe / bounce / complaint list. Keyed
--                                 by EMAIL (not user_id) so an opt-out is
--                                 honoured forever, even after account deletion.
--
-- DESIGN NOTES
--   - FK columns referencing users(id) are `INT` signed NOT NULL to match
--     `users.id` EXACTLY (see migration 011 — MySQL refuses the FK otherwise).
--   - email_campaign_recipients has UNIQUE(campaign_id, user_id): the worker
--     INSERT IGNOREs the audience, then only ever processes rows still in
--     `pending`. A crashed/restarted worker resumes safely with no double-send.
--   - email_suppressions.email is the PRIMARY KEY (normalised lower-case).
--     user_id is nullable and ON DELETE SET NULL: deleting a user must NOT
--     delete their suppression (legal requirement to keep honouring opt-outs).
--   - All statements are idempotent and safe to replay on any environment.
--   - MySQL 8.0+. Charset utf8mb4 to support unicode subjects/bodies.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. email_campaigns
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_campaigns (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Internal label shown in the admin UI (not sent to recipients).
  title            VARCHAR(200)    NOT NULL,

  -- The actual email subject line (sent to recipients).
  subject          VARCHAR(300)    NOT NULL,

  -- Optional named template the content was built on ('announcement' etc.).
  template_key     VARCHAR(60)     NULL DEFAULT NULL,

  -- Structured content blocks the composer produced (heading/paragraph/
  -- button/image/divider). Stored verbatim so a campaign can be re-opened
  -- and edited. Rendering always happens server-side from this JSON.
  content_json     JSON            NOT NULL,

  -- The compiled, sanitised HTML actually sent. Snapshotted at send time so
  -- the record is immutable evidence of what each recipient received.
  html_compiled    MEDIUMTEXT      NULL DEFAULT NULL,

  -- Plain-text alternative (auto-generated from blocks).
  text_compiled    MEDIUMTEXT      NULL DEFAULT NULL,

  -- Optional attachments ([{filename, content(base64), contentType}]). Sent on
  -- every message in the campaign. Kept small by the app-level size cap.
  attachments_json JSON            NULL DEFAULT NULL,

  -- Audience selector snapshot: { mode, filters, userIds, ... }.
  audience_filter  JSON            NOT NULL,

  -- draft       : composed, not yet scheduled or sent
  -- scheduled   : has scheduled_at in the future, worker will pick it up
  -- sending     : worker is actively dispatching batches
  -- sent        : all recipients processed (some may have failed)
  -- failed      : aborted before/at start (e.g. provider disabled)
  -- cancelled   : operator cancelled a draft/scheduled campaign
  status           ENUM('draft','scheduled','sending','sent','failed','cancelled')
                                   NOT NULL DEFAULT 'draft',

  -- When set and status='scheduled', the worker fires it at/after this UTC time.
  scheduled_at     DATETIME        NULL DEFAULT NULL,

  -- Identity of the admin operator (from the admin portal token / header).
  created_by       VARCHAR(120)    NOT NULL DEFAULT 'admin',

  -- Recipient counters, maintained by the worker as it progresses.
  total_recipients INT UNSIGNED    NOT NULL DEFAULT 0,
  sent_count       INT UNSIGNED    NOT NULL DEFAULT 0,
  failed_count     INT UNSIGNED    NOT NULL DEFAULT 0,
  skipped_count    INT UNSIGNED    NOT NULL DEFAULT 0,

  -- If the whole campaign aborts, why.
  last_error       VARCHAR(1000)   NULL DEFAULT NULL,

  -- When true the worker logs instead of calling the provider (dry-run).
  dry_run          TINYINT(1)      NOT NULL DEFAULT 0,

  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP,
  started_at       DATETIME        NULL DEFAULT NULL,
  completed_at     DATETIME        NULL DEFAULT NULL,

  PRIMARY KEY (id),
  KEY idx_campaign_status (status),
  KEY idx_campaign_scheduled (status, scheduled_at),
  KEY idx_campaign_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 2. email_campaign_recipients
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_campaign_recipients (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id  BIGINT UNSIGNED NOT NULL,

  -- Nullable + ON DELETE SET NULL: if the user is later deleted we keep the
  -- send record for audit, just detached from the (gone) user row.
  user_id      INT             NULL DEFAULT NULL,

  -- Snapshot of the address at audience-resolution time (lower-cased).
  email        VARCHAR(320)    NOT NULL,

  -- pending    : queued, not yet attempted
  -- sent       : provider accepted it
  -- failed     : provider rejected after max attempts
  -- skipped    : excluded at send time (e.g. became invalid)
  -- suppressed : on the suppression list (unsub/bounce) — never attempted
  status       ENUM('pending','sent','failed','skipped','suppressed')
                               NOT NULL DEFAULT 'pending',

  -- Provider message id on success (for tracing / future webhook correlation).
  message_id   VARCHAR(255)    NULL DEFAULT NULL,
  error        VARCHAR(1000)   NULL DEFAULT NULL,
  attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  sent_at      DATETIME        NULL DEFAULT NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- Idempotency: one row per user per campaign. The worker INSERT IGNOREs,
  -- so re-resolving the audience is a no-op.
  UNIQUE KEY uq_campaign_user (campaign_id, user_id),

  -- The worker's hot path: "give me the next N pending rows for this campaign".
  KEY idx_recipient_pending (campaign_id, status),
  KEY idx_recipient_email (email),

  CONSTRAINT fk_ecr_campaign
    FOREIGN KEY (campaign_id) REFERENCES email_campaigns(id) ON DELETE CASCADE,
  CONSTRAINT fk_ecr_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 3. email_suppressions
-- ----------------------------------------------------------------------------
-- One row per suppressed address. Presence == "do not send broadcasts here".
-- Keyed by email so it survives user deletion (compliance). Transactional mail
-- (password reset, verification) deliberately does NOT consult this table —
-- only broadcasts do.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email       VARCHAR(320)    NOT NULL,
  reason      ENUM('unsubscribe','bounce','complaint','manual')
                              NOT NULL DEFAULT 'unsubscribe',

  -- Best-effort link back to a user at suppression time; SET NULL on delete.
  user_id     INT             NULL DEFAULT NULL,

  -- Free-form context (e.g. originating campaign id, bounce detail).
  detail      VARCHAR(500)    NULL DEFAULT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (email),
  KEY idx_suppression_reason (reason),
  CONSTRAINT fk_supp_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;