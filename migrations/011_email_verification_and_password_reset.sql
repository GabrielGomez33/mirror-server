-- ============================================================================
-- 011_email_verification_and_password_reset.sql
-- ----------------------------------------------------------------------------
-- Adds the persistence layer for two authentication flows:
--   1. Email verification (tokens table — referenced by emailVerificationController)
--   2. Forgotten-password reset (tokens table — referenced by passwordResetController)
--
-- Also hardens the `users` table with the columns the runtime already expects
-- (`email_verified`, `account_locked`, `locked_until`) in case any of them are
-- missing on older deployments. All statements are idempotent and safe to
-- replay on any environment.
--
-- IMPORTANT — FK column type must match `users.id` EXACTLY.
--   On this database `users.id` is `INT NOT NULL AUTO_INCREMENT` (signed).
--   MySQL refuses the foreign key if the referencing column differs in size
--   or signedness, hence both token tables use `INT UNSIGNED`? No — they use
--   `INT` signed, NOT NULL, to be identical to `users.id`.
--
-- DESIGN NOTES:
--   - email_verification_tokens stores the verification token as plaintext hex.
--     The token is single-use and short-lived; the security boundary is the
--     user's mailbox. This matches the existing controller's expectations.
--   - password_reset_tokens stores the SHA-256 HASH of the token, never the
--     plaintext. A leaked DB therefore cannot be used to reset anyone's
--     password directly. The plaintext only lives in the email body. We also
--     record the requesting IP and user agent for incident forensics.
--   - Foreign keys cascade on user delete so we never orphan tokens.
--   - Indexes on (user_id, used_at, expires_at) and expires_at support
--     cleanup jobs.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Defensive column adds on `users`
-- ----------------------------------------------------------------------------
-- MySQL 8.0+ supports `IF NOT EXISTS` on ADD COLUMN. If you're on 5.7, strip
-- the `IF NOT EXISTS` and run each line manually, letting it error harmlessly
-- on already-present columns.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS account_locked TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until DATETIME NULL DEFAULT NULL;

-- ----------------------------------------------------------------------------
-- 2. email_verification_tokens
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id            INT NOT NULL AUTO_INCREMENT,
  user_id       INT NOT NULL,
  token         CHAR(64) NOT NULL,
  expires_at    DATETIME NOT NULL,
  used_at       DATETIME NULL DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_evt_token (token),
  KEY idx_evt_user_pending (user_id, used_at, expires_at),
  KEY idx_evt_expires (expires_at),
  CONSTRAINT fk_evt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 3. password_reset_tokens
-- ----------------------------------------------------------------------------
-- token_hash is SHA-256(token_plaintext). The plaintext never touches the DB.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id            INT NOT NULL AUTO_INCREMENT,
  user_id       INT NOT NULL,
  token_hash    CHAR(64) NOT NULL,
  expires_at    DATETIME NOT NULL,
  used_at       DATETIME NULL DEFAULT NULL,
  ip_address    VARCHAR(64) NULL DEFAULT NULL,
  user_agent    VARCHAR(255) NULL DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_prt_token_hash (token_hash),
  KEY idx_prt_user_pending (user_id, used_at, expires_at),
  KEY idx_prt_expires (expires_at),
  CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- 4. Hygiene: optional purge event.
-- ----------------------------------------------------------------------------
-- The block below is intentionally commented out. It is OPT-IN — only enable
-- if your MySQL event scheduler is on (`SET GLOBAL event_scheduler = ON;`).
-- Otherwise call the equivalent DELETEs from cron or the app scheduler.
--
-- If you want to enable it, copy the block into `011b_purge_auth_tokens.sql`
-- and run it via the MySQL client with DELIMITER set, e.g.:
--
--   DELIMITER $$
--   CREATE EVENT IF NOT EXISTS purge_auth_tokens
--     ON SCHEDULE EVERY 1 DAY
--     DO
--       BEGIN
--         DELETE FROM email_verification_tokens
--           WHERE (used_at IS NOT NULL AND used_at < DATE_SUB(NOW(), INTERVAL 30 DAY))
--              OR expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY);
--         DELETE FROM password_reset_tokens
--           WHERE (used_at IS NOT NULL AND used_at < DATE_SUB(NOW(), INTERVAL 30 DAY))
--              OR expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY);
--       END$$
--   DELIMITER ;
--
-- (The `DELIMITER` change is what makes the `;` inside the event body parse
-- correctly. The MySQL CLI's default `;` terminator would otherwise end the
-- CREATE EVENT prematurely — that's exactly what produced the 1064 error.)