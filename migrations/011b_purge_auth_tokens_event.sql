-- ============================================================================
-- 011b_purge_auth_tokens_event.sql  (OPTIONAL)
-- ----------------------------------------------------------------------------
-- A nightly MySQL EVENT that purges expired/used auth tokens. Run this ONLY
-- if your MySQL event scheduler is enabled:
--
--   SET GLOBAL event_scheduler = ON;
--
-- Otherwise call the equivalent DELETEs from cron or your app scheduler — the
-- mirror-server runtime does not depend on this event.
--
-- Apply with:
--   mysql mirror_db < 011b_purge_auth_tokens_event.sql
--
-- DELIMITER is changed so the `;` characters inside the BEGIN…END block parse
-- as part of the event body, not as statement terminators for CREATE EVENT.
-- ============================================================================

DELIMITER $$

DROP EVENT IF EXISTS purge_auth_tokens $$

CREATE EVENT purge_auth_tokens
  ON SCHEDULE EVERY 1 DAY
  COMMENT 'Removes expired email-verification and password-reset tokens.'
  DO
    BEGIN
      DELETE FROM email_verification_tokens
        WHERE (used_at IS NOT NULL AND used_at < DATE_SUB(NOW(), INTERVAL 30 DAY))
           OR expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY);

      DELETE FROM password_reset_tokens
        WHERE (used_at IS NOT NULL AND used_at < DATE_SUB(NOW(), INTERVAL 30 DAY))
           OR expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY);
    END$$

DELIMITER ;