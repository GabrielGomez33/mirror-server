-- ----------------------------------------------------------------------------
-- 013_pending_email_changes.sql
-- ----------------------------------------------------------------------------
-- Backs the authenticated "change email" flow (re-verify model):
--
--   1. POST /mirror/api/auth/change-email  { newEmail, currentPassword }
--      - re-authenticates with the current password
--      - writes a PENDING row here (it does NOT touch users.email yet)
--      - emails a single-use token to the NEW address
--
--   2. POST /mirror/api/auth/change-email/confirm  { token }
--      - validates the token, then applies users.email = new_email and sets
--        users.email_verified = 1 (the new address is proven by the click)
--      - marks the row used and invalidates the user's other pending rows
--
-- Design notes (mirrors email_verification_tokens in 011):
--   - token is plaintext hex (CHAR(64)); single-use + short-lived, delivered
--     only to the address being claimed, so the click itself is the secret.
--   - new_email is stored alongside the token so the click knows what to apply
--     even if the user starts several changes.
--   - FK cascades on user delete so we never orphan pending changes.
--   - Indexes support the "latest pending for this user" and expiry-sweep
--     access patterns.
--
-- MySQL 8.0+ assumed (consistent with 011). Idempotent: IF NOT EXISTS.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pending_email_changes (
  id            INT NOT NULL AUTO_INCREMENT,
  user_id       INT NOT NULL,
  new_email     VARCHAR(255) NOT NULL,
  token         CHAR(64) NOT NULL,
  expires_at    DATETIME NOT NULL,
  used_at       DATETIME NULL DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pec_token (token),
  KEY idx_pec_user_pending (user_id, used_at, expires_at),
  KEY idx_pec_expires (expires_at),
  CONSTRAINT fk_pec_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;