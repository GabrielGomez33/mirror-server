-- ============================================================================
-- 019_campaign_recipients_waitlist.sql
-- ----------------------------------------------------------------------------
-- Lets the existing email-campaign engine target the WAITLIST audience
-- (waitlist_signups) in addition to registered users — WITHOUT a second
-- recipients table, a second worker, or any change to the send path.
--
-- WHY THESE COLUMNS
--   email_campaign_recipients was built users-first:
--     * user_id INT  FK -> users(id)
--     * idempotency key  UNIQUE(campaign_id, user_id)
--   Waitlist signups have NO users.id. If we inserted them with user_id = NULL,
--   MySQL treats each NULL as DISTINCT in a UNIQUE key, so re-materialising an
--   audience would DUPLICATE rows and risk DOUBLE-SENDS. To fix that safely we
--   add a dedicated idempotency key for the waitlist source:
--
--     * source       ENUM('user','waitlist')  — which audience a row came from
--     * waitlist_id  BIGINT UNSIGNED NULL      — waitlist_signups.id (NULL for users)
--     * UNIQUE(campaign_id, waitlist_id)       — dedupes waitlist rows
--
--   Because every EXISTING row gets waitlist_id = NULL (and repeated NULLs are
--   allowed in a UNIQUE index), adding this key CANNOT fail on historical data
--   and does NOT require users.email to be unique. The users path is untouched:
--   it keeps deduping on the original UNIQUE(campaign_id, user_id).
--
-- NO FK on waitlist_id (deliberate): the recipients table is the immutable send
--   record. If a waitlist row is later purged we keep the historical send (email
--   is the real payload); we do not want a cascade or a hard dependency on the
--   marketing table. waitlist_id is a best-effort provenance pointer only.
--
-- IDEMPOTENT + ENGINE-PORTABLE
--   Guarded with INFORMATION_SCHEMA so re-running is a no-op, and so it works on
--   both MySQL 8.x and MariaDB (we do NOT rely on `ADD COLUMN IF NOT EXISTS`,
--   which only exists on MariaDB). Apply with the single-connection runner:
--       npm run migrate -- 019
--   (session @variables + PREPARE/EXECUTE require one connection, which the
--    runner uses.)
-- ============================================================================

-- ---- column: source --------------------------------------------------------
SET @has_source := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'email_campaign_recipients'
     AND COLUMN_NAME  = 'source'
);
SET @ddl := IF(@has_source = 0,
  'ALTER TABLE email_campaign_recipients ADD COLUMN source ENUM(''user'',''waitlist'') NOT NULL DEFAULT ''user'' AFTER campaign_id',
  'DO 0');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ---- column: waitlist_id ---------------------------------------------------
SET @has_wid := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'email_campaign_recipients'
     AND COLUMN_NAME  = 'waitlist_id'
);
SET @ddl := IF(@has_wid = 0,
  'ALTER TABLE email_campaign_recipients ADD COLUMN waitlist_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER user_id',
  'DO 0');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ---- unique key: uq_campaign_waitlist (campaign_id, waitlist_id) ------------
-- Idempotency for waitlist rows. Repeated NULLs (all existing/user rows) are
-- allowed, so this ALTER is always safe to add.
SET @has_uq := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'email_campaign_recipients'
     AND INDEX_NAME   = 'uq_campaign_waitlist'
);
SET @ddl := IF(@has_uq = 0,
  'ALTER TABLE email_campaign_recipients ADD UNIQUE KEY uq_campaign_waitlist (campaign_id, waitlist_id)',
  'DO 0');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;

-- ---- helper index: source (reporting: "how many waitlist vs user rows") -----
SET @has_srcidx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'email_campaign_recipients'
     AND INDEX_NAME   = 'idx_recipient_source'
);
SET @ddl := IF(@has_srcidx = 0,
  'ALTER TABLE email_campaign_recipients ADD KEY idx_recipient_source (campaign_id, source)',
  'DO 0');
PREPARE s FROM @ddl;
EXECUTE s;
DEALLOCATE PREPARE s;
