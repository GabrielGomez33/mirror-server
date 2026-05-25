-- 012_user_consent.sql
-- ---------------------------------------------------------------------------
-- Consent audit trail for Terms & Conditions (and, later, a separate Privacy
-- Notice). One row per (user, document, version) accepted. Re-accepting the
-- same version updates the timestamp in place; accepting a new version inserts
-- a new row, preserving the full history.
--
-- Idempotent: safe to run repeatedly. Apply BEFORE deploying the consent
-- endpoints (controllers/consentController.ts + routes/auth.ts).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_consent (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      INT             NOT NULL,
  document     ENUM('terms','privacy') NOT NULL DEFAULT 'terms',
  version      VARCHAR(16)     NOT NULL,
  accepted_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address   VARCHAR(45)     NULL,
  user_agent   VARCHAR(512)    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_doc_version (user_id, document, version),
  KEY idx_consent_user (user_id),
  CONSTRAINT fk_consent_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;