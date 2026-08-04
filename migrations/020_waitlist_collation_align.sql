-- ============================================================================
-- 020_waitlist_collation_align.sql
-- ----------------------------------------------------------------------------
-- Fixes a schema inconsistency introduced in migration 018: waitlist_signups
-- was created with COLLATE utf8mb4_0900_ai_ci, while the rest of the email
-- stack (email_suppressions, email_campaigns, email_campaign_recipients — see
-- migration 014 — and the users table) uses utf8mb4_unicode_ci.
--
-- The mismatch makes any cross-table string comparison against waitlist emails
-- fail with "Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT) and
-- (utf8mb4_0900_ai_ci,IMPLICIT) for operation '='" — e.g. the waitlist audience
-- suppression join (waitlist_signups.email = email_suppressions.email).
--
-- This aligns waitlist_signups with the system-wide collation so those joins
-- work implicitly and no future query needs a COLLATE hint. The application
-- also carries an explicit COLLATE on the one affected join (defence in depth),
-- so it already works before this migration — this makes the schema correct.
--
-- SAFETY
--   * CONVERT TO CHARACTER SET rebuilds the table's character columns in the new
--     collation. The waitlist table is small; this is a quick, safe rebuild.
--   * The metadata JSON column is unaffected (JSON has its own storage).
--   * The UNIQUE(email) key is rebuilt automatically in the new collation.
--   * Idempotent in effect: re-running converts unicode_ci -> unicode_ci (a
--     no-op rebuild). Apply with:  npm run migrate -- 020
-- ============================================================================

ALTER TABLE waitlist_signups
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
