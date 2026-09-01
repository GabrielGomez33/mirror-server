-- ============================================================================
-- 023_conversion_events.sql
-- ----------------------------------------------------------------------------
-- Privacy-by-design CONVERSION FUNNEL instrumentation.
--
-- PURPOSE
--   Measure where anonymous visitors drop out of the acquisition funnel
--   (landing → signup → Entry intake → first value → premium) so the
--   Instagram-ads conversion problem can be diagnosed with data, not guesswork.
--
-- PRIVACY POSTURE (this is the whole point — read before adding a column)
--   This table is ANONYMOUS + AGGREGATE by construction. It stores NO
--   personal data and has NO link to a user account:
--     * NO user_id, NO FK to users — a funnel event can never be tied to a person.
--     * NO ip_address, NO user_agent — the client IP is used only as an
--       in-memory rate-limit key at ingest and is NEVER written here.
--     * NO client-supplied timestamp — created_at is the server receive time,
--       so there is no client clock to trust or manipulate.
--     * session_token is a random, ephemeral, per-browser-session UUID
--       (sessionStorage, dies with the tab). It is NOT derived from any identity,
--       is not a cookie, and is not linkable to an account — it exists only to
--       correlate stages WITHIN one anonymous session for drop-off analysis.
--   Because there is no personal data here, this table is out of scope for DSAR
--   export / erasure (there is nothing to attribute to a data subject). That is
--   an intentional compliance property, asserted in CI by a schema guard test
--   (tests/conversionStorage.int.test.ts) that FAILS if a PII-shaped column or a
--   users FK is ever added. See docs/COMPLIANCE.md.
--
-- RETENTION
--   Aggregate signal decays fast; we keep a bounded 180-day window. The
--   authoritative pruner is the application function pruneConversionEvents()
--   (services/conversionAnalytics), proven in CI. The nightly EVENT below is a
--   deployment convenience and runs only where event_scheduler = ON.
--
-- SAFETY
--   Additive only. CREATE TABLE IF NOT EXISTS + DROP EVENT IF EXISTS are
--   idempotent; re-applying via `npm run migrate -- 023` is harmless.
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversion_events (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  -- Funnel stage key. Validated against the app allowlist (utils/conversionFunnel
  -- FUNNEL_STAGES) BEFORE insert — the column is a controlled vocabulary, never
  -- free text from the client.
  stage         VARCHAR(48)  NOT NULL,
  -- Ephemeral, random, non-identifying per-session token (UUID). NULLable.
  session_token CHAR(36)     NULL,
  -- Campaign attribution (allowlisted + sanitized at ingest). Non-identifying.
  utm_source    VARCHAR(64)  NULL,
  utm_medium    VARCHAR(64)  NULL,
  utm_campaign  VARCHAR(96)  NULL,
  -- Coarse surface: 'web' | 'pwa'. Non-identifying.
  surface       VARCHAR(16)  NULL,
  -- Server receive time — the ONLY timestamp (no client clock trusted).
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_stage_time (stage, created_at),
  INDEX idx_time (created_at),
  INDEX idx_session (session_token),
  INDEX idx_utm (utm_source, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Retention convenience (best-effort; needs SET GLOBAL event_scheduler = ON).
-- Single-statement body, so no DELIMITER block is required.
DROP EVENT IF EXISTS purge_conversion_events;

CREATE EVENT IF NOT EXISTS purge_conversion_events
  ON SCHEDULE EVERY 1 DAY
  COMMENT 'Retention: drop anonymous conversion events older than 180 days.'
  DO DELETE FROM conversion_events WHERE created_at < DATE_SUB(NOW(), INTERVAL 180 DAY);
