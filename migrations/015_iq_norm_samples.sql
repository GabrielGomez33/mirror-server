-- 015_iq_norm_samples.sql
-- ---------------------------------------------------------------------------
-- Self-norming data for the intake IQ / cognitive assessment.
--
-- Rather than scoring against a purchased population norm, we accumulate a
-- de-identified score distribution from our own users and report each new
-- result as a percentile *relative to other Mirror users*. This table holds
-- one row per user's FIRST completed attempt on a given item set.
--
-- Design notes:
--   * One row per (user_id, item_set_version). The UNIQUE key makes the
--     recording write idempotent and enforces "first attempt only" — retakes
--     (which skew the distribution upward) are dropped via INSERT IGNORE.
--   * raw_score is re-derived SERVER-SIDE from the submitted answers against a
--     versioned answer key, so a spoofed client iqScore cannot poison the
--     norm. Samples we could not re-score (unknown item_set_version) are kept
--     with verified = FALSE and excluded from norm computation.
--   * ability is the chance-corrected proportion in [0,1], stored so the norm
--     can be recomputed without re-reading the answer key.
--   * age_years is nullable. v1 reports a single pooled norm; age-banded norms
--     come later, once each band individually clears the minimum-N gate.
--   * No answers or identifying free-text are stored here — only the numeric
--     score, a coarse age, and the FK. Deleting a user cascades their sample
--     out of the norm.
--
-- Idempotent: safe to run repeatedly. Apply BEFORE deploying the norm endpoint
-- (controllers/iqNormsController.ts + routes/intake.ts).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS iq_norm_samples (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id            INT             NOT NULL,
  item_set_version   VARCHAR(32)     NOT NULL,
  raw_score          SMALLINT        NOT NULL,
  total_questions    SMALLINT        NOT NULL,
  ability            DECIMAL(6,4)    NOT NULL,        -- chance-corrected proportion 0..1
  category_breakdown JSON            NULL,
  age_years          SMALLINT        NULL,
  verified           BOOLEAN         NOT NULL DEFAULT FALSE, -- server re-scored from answers
  created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_version (user_id, item_set_version),
  KEY idx_norm_lookup (item_set_version, verified, raw_score),
  KEY idx_norm_age (item_set_version, verified, age_years),
  CONSTRAINT fk_iq_norm_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;