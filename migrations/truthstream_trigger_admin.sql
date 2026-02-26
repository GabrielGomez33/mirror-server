-- ============================================================================
-- TRUTHSTREAM - Trigger Migration (Requires Admin Privileges)
-- ============================================================================
-- Migration: 009b_truthstream_trigger_admin.sql
-- MySQL: 8.0.45 compatible
-- Prerequisite: 009_truthstream.sql must be run first
-- ============================================================================
-- This file must be run by a MySQL user with SUPER privilege, or after setting:
--   SET GLOBAL log_bin_trust_function_creators = 1;
--
-- This trigger is a SAFETY NET. The application layer in mirror-server
-- handles all cascade logic via cleanupUserTruthStreamData() BEFORE deleting
-- the user row. This trigger catches any edge case where the application
-- layer is bypassed (e.g., direct SQL deletion by an admin).
-- ============================================================================

DELIMITER //

CREATE TRIGGER before_user_delete_truthstream
BEFORE DELETE ON users
FOR EACH ROW
BEGIN
  -- 1. Preserve reviews this user wrote for other people
  --    Set reviewer_id to NULL so the review content remains for the reviewee
  UPDATE truth_stream_reviews
  SET reviewer_id = NULL
  WHERE reviewer_id = OLD.id;

  -- 2. Cancel incomplete queue assignments where this user was reviewer
  --    (completed ones will be handled by the application or left as-is)
  DELETE FROM truth_stream_queue
  WHERE reviewer_id = OLD.id AND status IN ('pending', 'in_progress');

  -- 3. Mark dialogues from this user as system messages (identity removed)
  UPDATE truth_stream_dialogues
  SET author_user_id = NULL,
      content = CONCAT('[This user has deleted their account] ', content),
      is_system_message = 1
  WHERE author_user_id = OLD.id;

  -- 4. Cancel any pending processing jobs for this user
  UPDATE truth_stream_processing_queue
  SET status = 'failed',
      error_message = 'User account deleted'
  WHERE user_id = OLD.id AND status IN ('pending', 'processing');
END //

DELIMITER ;

-- Verify trigger was created
SHOW TRIGGERS WHERE `Table` = 'users' AND `Trigger` = 'before_user_delete_truthstream';
