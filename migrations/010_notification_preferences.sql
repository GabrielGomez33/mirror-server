-- ============================================================================
-- PHASE 6b: PER-EVENT-TYPE NOTIFICATION PREFERENCES
-- ============================================================================
-- File: migrations/010_notification_preferences.sql
-- Description: Stores user opt-outs for individual notification categories,
--              optionally scoped to a single group. Only MUTED rows exist —
--              the absence of a row means "not muted" (default = on). This
--              keeps the table tiny and the read path a single IN-lookup.
--
-- USAGE
--   The dispatcher (services/pushNotificationDispatcher.ts) calls
--   notificationPreferencesService.getMutedSet(userId) before firing a push.
--   That returns a Set<"category:scope">. If the (category, "global") or
--   (category, groupId) key is in the set, the push is skipped.
--
--   In-app WebSocket delivery is unaffected — the notification still arrives
--   in the in-app panel, just no OS-level push.
--
-- SCHEMA NOTES
--   - category: a user-facing bucket of related event types
--     (e.g. 'chat_messages' covers chat_message; 'group_activity' covers
--     member_joined/_left and admin_promoted/_demoted). The dispatcher
--     maps event_type → category. We deliberately don't store event_type
--     directly so we can refactor types without invalidating user prefs.
--   - scope: either the literal string 'global' or a group_id (kept as
--     VARCHAR so it round-trips with the API's string IDs without
--     coercion bugs). Reserved value 'global' must never collide with a
--     real group id; group_ids in this codebase are numeric strings, so
--     'global' is safe.
--   - PRIMARY KEY (user_id, category, scope) gives us idempotent upserts
--     and a single-row delete to "unmute" without a separate id column.
--   - On user delete: CASCADE to clean up prefs.
-- ============================================================================

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id INT NOT NULL,

  -- User-facing category key (e.g. 'chat_messages', 'group_invites').
  -- Bounded to 40 chars; dispatcher uses a fixed lookup map so unknown
  -- values are inert (skipped at read time).
  category VARCHAR(40) NOT NULL,

  -- 'global' OR a group_id. Group ids in this codebase are numeric
  -- strings; 'global' is reserved and never collides with a real id.
  scope VARCHAR(40) NOT NULL DEFAULT 'global',

  -- Whether this (category, scope) is muted for the user. Only muted=1
  -- rows exist in practice (unmute = delete) but we keep the column so
  -- the API can express an explicit "muted: false" override in the future
  -- (e.g. "mute group_activity globally except for group 42").
  muted TINYINT(1) NOT NULL DEFAULT 1,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (user_id, category, scope),

  -- Fast "list all prefs for user" lookup (UI fetch + dispatcher cache fill).
  KEY idx_user (user_id),

  CONSTRAINT fk_notif_prefs_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;