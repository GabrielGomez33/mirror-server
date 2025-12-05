-- ============================================================================
-- MIRRORGROUPS PHASE 5: REAL-TIME CHAT INFRASTRUCTURE
-- ============================================================================
-- File: migrations/008_group_chat_infrastructure.sql
-- Date: December 5, 2025
-- Description: Creates comprehensive chat tables with WebSocket support,
--              end-to-end encryption, reactions, threading, and mobile-first design
-- ============================================================================

-- ============================================================================
-- TABLE 1: CHAT MESSAGES (Core Message Storage)
-- ============================================================================
-- Stores all chat messages with encryption, threading, and rich content support

CREATE TABLE IF NOT EXISTS mirror_group_messages (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) NOT NULL,
  sender_user_id INT NOT NULL,

  -- Message content (encrypted for security)
  content TEXT NOT NULL,                    -- Encrypted message content
  content_type ENUM('text', 'image', 'file', 'audio', 'video', 'system', 'reply') DEFAULT 'text',

  -- Threading support
  parent_message_id VARCHAR(36) DEFAULT NULL,  -- For reply threads
  thread_root_id VARCHAR(36) DEFAULT NULL,     -- Root of thread chain
  thread_reply_count INT DEFAULT 0,            -- Cached reply count for efficiency

  -- Rich content metadata (JSON for flexibility)
  metadata JSON DEFAULT NULL,               -- {mentions: [], links: [], formatting: {}}

  -- Delivery status
  status ENUM('sending', 'sent', 'delivered', 'failed') DEFAULT 'sending',

  -- Edit tracking
  is_edited BOOLEAN DEFAULT FALSE,
  edited_at TIMESTAMP DEFAULT NULL,
  edit_count INT DEFAULT 0,

  -- Deletion (soft delete for compliance)
  is_deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMP DEFAULT NULL,
  deleted_by INT DEFAULT NULL,

  -- Encryption metadata
  encryption_key_id VARCHAR(36) DEFAULT NULL,
  encryption_version INT DEFAULT 1,

  -- Client-side deduplication
  client_message_id VARCHAR(64) DEFAULT NULL,  -- UUID from client for dedup

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Foreign keys
  CONSTRAINT fk_message_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_message_sender FOREIGN KEY (sender_user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_message_parent FOREIGN KEY (parent_message_id)
    REFERENCES mirror_group_messages(id) ON DELETE SET NULL,
  CONSTRAINT fk_message_deleted_by FOREIGN KEY (deleted_by)
    REFERENCES users(id) ON DELETE SET NULL,

  -- Indexes for efficient querying
  INDEX idx_messages_group (group_id),
  INDEX idx_messages_group_created (group_id, created_at DESC),
  INDEX idx_messages_sender (sender_user_id),
  INDEX idx_messages_thread_root (thread_root_id),
  INDEX idx_messages_parent (parent_message_id),
  INDEX idx_messages_status (status),
  INDEX idx_messages_client_id (client_message_id),
  INDEX idx_messages_created (created_at DESC),

  -- Composite index for pagination queries
  INDEX idx_messages_group_pagination (group_id, is_deleted, created_at DESC),

  -- Full-text search index
  FULLTEXT INDEX idx_messages_content_search (content)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 2: MESSAGE READ RECEIPTS
-- ============================================================================
-- Tracks when each user reads each message (for delivery status)

CREATE TABLE IF NOT EXISTS mirror_group_message_reads (
  id VARCHAR(36) PRIMARY KEY,
  message_id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,
  group_id VARCHAR(36) NOT NULL,           -- Denormalized for efficient queries

  -- Read tracking
  read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Foreign keys
  CONSTRAINT fk_read_message FOREIGN KEY (message_id)
    REFERENCES mirror_group_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_read_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_read_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,

  -- Unique constraint: one read record per user per message
  UNIQUE KEY unique_message_user_read (message_id, user_id),

  -- Indexes
  INDEX idx_reads_message (message_id),
  INDEX idx_reads_user (user_id),
  INDEX idx_reads_group (group_id),
  INDEX idx_reads_group_user (group_id, user_id),
  INDEX idx_reads_timestamp (read_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 3: MESSAGE REACTIONS
-- ============================================================================
-- Stores emoji reactions on messages

CREATE TABLE IF NOT EXISTS mirror_group_message_reactions (
  id VARCHAR(36) PRIMARY KEY,
  message_id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,
  group_id VARCHAR(36) NOT NULL,           -- Denormalized for efficient queries

  -- Reaction data
  emoji VARCHAR(32) NOT NULL,              -- Unicode emoji or custom emoji code
  emoji_name VARCHAR(64) DEFAULT NULL,     -- Optional: readable name for custom emoji

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Foreign keys
  CONSTRAINT fk_reaction_message FOREIGN KEY (message_id)
    REFERENCES mirror_group_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_reaction_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_reaction_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,

  -- Unique constraint: one reaction per emoji per user per message
  UNIQUE KEY unique_reaction (message_id, user_id, emoji),

  -- Indexes
  INDEX idx_reactions_message (message_id),
  INDEX idx_reactions_user (user_id),
  INDEX idx_reactions_emoji (emoji),
  INDEX idx_reactions_message_emoji (message_id, emoji)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 4: CHAT ATTACHMENTS
-- ============================================================================
-- Stores file attachments for messages

CREATE TABLE IF NOT EXISTS mirror_group_chat_attachments (
  id VARCHAR(36) PRIMARY KEY,
  message_id VARCHAR(36) NOT NULL,
  group_id VARCHAR(36) NOT NULL,
  uploader_user_id INT NOT NULL,

  -- File information
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(100) NOT NULL,         -- MIME type
  file_size BIGINT NOT NULL,               -- Size in bytes
  file_path VARCHAR(512) NOT NULL,         -- Storage path (encrypted)

  -- Media-specific metadata
  thumbnail_path VARCHAR(512) DEFAULT NULL, -- For images/videos
  width INT DEFAULT NULL,                   -- For images/videos
  height INT DEFAULT NULL,                  -- For images/videos
  duration INT DEFAULT NULL,                -- For audio/video (seconds)

  -- Encryption
  is_encrypted BOOLEAN DEFAULT TRUE,
  encryption_key_id VARCHAR(36) DEFAULT NULL,

  -- Processing status
  processing_status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Foreign keys
  CONSTRAINT fk_attachment_message FOREIGN KEY (message_id)
    REFERENCES mirror_group_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_attachment_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_attachment_uploader FOREIGN KEY (uploader_user_id)
    REFERENCES users(id) ON DELETE CASCADE,

  -- Indexes
  INDEX idx_attachments_message (message_id),
  INDEX idx_attachments_group (group_id),
  INDEX idx_attachments_type (file_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 5: TYPING INDICATORS (Short-lived, managed by Redis primarily)
-- ============================================================================
-- Backup storage for typing indicators (mainly use Redis for real-time)

CREATE TABLE IF NOT EXISTS mirror_group_typing_indicators (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,

  -- Typing status
  is_typing BOOLEAN DEFAULT TRUE,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,           -- Auto-expire after 5 seconds

  -- Foreign keys
  CONSTRAINT fk_typing_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_typing_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,

  -- Unique constraint: one typing record per user per group
  UNIQUE KEY unique_typing (group_id, user_id),

  -- Indexes
  INDEX idx_typing_group (group_id),
  INDEX idx_typing_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 6: USER CHAT PREFERENCES
-- ============================================================================
-- Per-user chat settings for each group

CREATE TABLE IF NOT EXISTS mirror_group_chat_preferences (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,

  -- Notification preferences
  muted_until TIMESTAMP DEFAULT NULL,      -- NULL = not muted
  notification_level ENUM('all', 'mentions', 'none') DEFAULT 'all',

  -- UI preferences
  pinned BOOLEAN DEFAULT FALSE,            -- Pinned to top of chat list
  archived BOOLEAN DEFAULT FALSE,          -- Hidden from main list

  -- Read tracking
  last_read_message_id VARCHAR(36) DEFAULT NULL,
  last_read_at TIMESTAMP DEFAULT NULL,
  unread_count INT DEFAULT 0,              -- Cached for efficiency

  -- Custom settings
  custom_notification_sound VARCHAR(100) DEFAULT NULL,
  show_previews BOOLEAN DEFAULT TRUE,

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Foreign keys
  CONSTRAINT fk_pref_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_pref_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,

  -- Unique constraint
  UNIQUE KEY unique_user_group_pref (group_id, user_id),

  -- Indexes
  INDEX idx_prefs_user (user_id),
  INDEX idx_prefs_muted (muted_until),
  INDEX idx_prefs_pinned (user_id, pinned)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 7: MESSAGE MENTIONS
-- ============================================================================
-- Tracks @mentions in messages for efficient notification

CREATE TABLE IF NOT EXISTS mirror_group_message_mentions (
  id VARCHAR(36) PRIMARY KEY,
  message_id VARCHAR(36) NOT NULL,
  mentioned_user_id INT NOT NULL,
  group_id VARCHAR(36) NOT NULL,           -- Denormalized for queries

  -- Mention type
  mention_type ENUM('user', 'everyone', 'role') DEFAULT 'user',

  -- Notification tracking
  notified BOOLEAN DEFAULT FALSE,
  notified_at TIMESTAMP DEFAULT NULL,

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Foreign keys
  CONSTRAINT fk_mention_message FOREIGN KEY (message_id)
    REFERENCES mirror_group_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_mention_user FOREIGN KEY (mentioned_user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mention_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,

  -- Unique constraint
  UNIQUE KEY unique_mention (message_id, mentioned_user_id),

  -- Indexes
  INDEX idx_mentions_user (mentioned_user_id),
  INDEX idx_mentions_group_user (group_id, mentioned_user_id),
  INDEX idx_mentions_unnotified (notified, mentioned_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 8: PINNED MESSAGES
-- ============================================================================
-- Tracks pinned messages in groups for easy access

CREATE TABLE IF NOT EXISTS mirror_group_pinned_messages (
  id VARCHAR(36) PRIMARY KEY,
  message_id VARCHAR(36) NOT NULL,
  group_id VARCHAR(36) NOT NULL,
  pinned_by_user_id INT NOT NULL,

  -- Pin metadata
  pin_order INT DEFAULT 0,                 -- For custom ordering
  pin_note VARCHAR(255) DEFAULT NULL,      -- Optional note about why pinned

  -- Timestamps
  pinned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Foreign keys
  CONSTRAINT fk_pin_message FOREIGN KEY (message_id)
    REFERENCES mirror_group_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_pin_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_pin_user FOREIGN KEY (pinned_by_user_id)
    REFERENCES users(id) ON DELETE CASCADE,

  -- Unique constraint: each message can only be pinned once per group
  UNIQUE KEY unique_pinned_message (message_id, group_id),

  -- Indexes
  INDEX idx_pinned_group (group_id),
  INDEX idx_pinned_order (group_id, pin_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 9: CHAT PRESENCE (Online/Offline status)
-- ============================================================================
-- Tracks user online status for groups

CREATE TABLE IF NOT EXISTS mirror_group_chat_presence (
  id VARCHAR(36) PRIMARY KEY,
  user_id INT NOT NULL,
  group_id VARCHAR(36) NOT NULL,

  -- Presence status
  status ENUM('online', 'away', 'busy', 'offline') DEFAULT 'offline',
  custom_status VARCHAR(100) DEFAULT NULL,  -- Custom status message

  -- Connection tracking
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  connected_at TIMESTAMP DEFAULT NULL,
  connection_id VARCHAR(64) DEFAULT NULL,   -- WebSocket connection ID

  -- Device information (for multi-device support)
  device_type ENUM('web', 'mobile_ios', 'mobile_android', 'desktop') DEFAULT 'web',

  -- Timestamps
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Foreign keys
  CONSTRAINT fk_presence_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_presence_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,

  -- Unique constraint
  UNIQUE KEY unique_user_group_presence (user_id, group_id),

  -- Indexes
  INDEX idx_presence_group (group_id),
  INDEX idx_presence_status (group_id, status),
  INDEX idx_presence_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 10: MESSAGE DELIVERY QUEUE (For Offline Message Delivery)
-- ============================================================================
-- Queue for messages that need to be delivered when user comes online

CREATE TABLE IF NOT EXISTS mirror_group_message_delivery_queue (
  id VARCHAR(36) PRIMARY KEY,
  message_id VARCHAR(36) NOT NULL,
  recipient_user_id INT NOT NULL,
  group_id VARCHAR(36) NOT NULL,

  -- Delivery status
  status ENUM('pending', 'delivered', 'failed', 'expired') DEFAULT 'pending',

  -- Retry tracking
  attempt_count INT DEFAULT 0,
  max_attempts INT DEFAULT 5,
  last_attempt_at TIMESTAMP DEFAULT NULL,
  next_retry_at TIMESTAMP DEFAULT NULL,

  -- Error tracking
  last_error TEXT DEFAULT NULL,

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMP DEFAULT NULL,
  expires_at TIMESTAMP DEFAULT NULL,       -- Messages expire after 7 days

  -- Foreign keys
  CONSTRAINT fk_queue_message FOREIGN KEY (message_id)
    REFERENCES mirror_group_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_queue_recipient FOREIGN KEY (recipient_user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_queue_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,

  -- Indexes
  INDEX idx_queue_recipient (recipient_user_id),
  INDEX idx_queue_status (status),
  INDEX idx_queue_retry (status, next_retry_at),
  INDEX idx_queue_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- STORED PROCEDURES
-- ============================================================================

-- Procedure to update unread count for a user in a group
DELIMITER //

CREATE PROCEDURE IF NOT EXISTS update_unread_count(
  IN p_group_id VARCHAR(36),
  IN p_user_id INT
)
BEGIN
  DECLARE v_last_read_id VARCHAR(36);
  DECLARE v_count INT;

  -- Get last read message ID
  SELECT last_read_message_id INTO v_last_read_id
  FROM mirror_group_chat_preferences
  WHERE group_id = p_group_id AND user_id = p_user_id;

  -- Count unread messages
  IF v_last_read_id IS NULL THEN
    SELECT COUNT(*) INTO v_count
    FROM mirror_group_messages
    WHERE group_id = p_group_id
      AND sender_user_id != p_user_id
      AND is_deleted = FALSE;
  ELSE
    SELECT COUNT(*) INTO v_count
    FROM mirror_group_messages
    WHERE group_id = p_group_id
      AND sender_user_id != p_user_id
      AND is_deleted = FALSE
      AND created_at > (
        SELECT created_at FROM mirror_group_messages WHERE id = v_last_read_id
      );
  END IF;

  -- Update the cached count
  UPDATE mirror_group_chat_preferences
  SET unread_count = v_count,
      updated_at = NOW()
  WHERE group_id = p_group_id AND user_id = p_user_id;

  -- If no preference exists, create one
  IF ROW_COUNT() = 0 THEN
    INSERT INTO mirror_group_chat_preferences (
      id, group_id, user_id, unread_count, created_at, updated_at
    ) VALUES (
      UUID(), p_group_id, p_user_id, v_count, NOW(), NOW()
    );
  END IF;
END//

-- Procedure to mark messages as read up to a certain message
CREATE PROCEDURE IF NOT EXISTS mark_messages_read(
  IN p_group_id VARCHAR(36),
  IN p_user_id INT,
  IN p_message_id VARCHAR(36)
)
BEGIN
  DECLARE v_message_created_at TIMESTAMP;

  -- Get the timestamp of the message being marked as read
  SELECT created_at INTO v_message_created_at
  FROM mirror_group_messages
  WHERE id = p_message_id;

  -- Insert read receipts for all unread messages up to this one
  INSERT IGNORE INTO mirror_group_message_reads (id, message_id, user_id, group_id, read_at)
  SELECT
    UUID(),
    m.id,
    p_user_id,
    p_group_id,
    NOW()
  FROM mirror_group_messages m
  WHERE m.group_id = p_group_id
    AND m.sender_user_id != p_user_id
    AND m.is_deleted = FALSE
    AND m.created_at <= v_message_created_at
    AND NOT EXISTS (
      SELECT 1 FROM mirror_group_message_reads r
      WHERE r.message_id = m.id AND r.user_id = p_user_id
    );

  -- Update preferences
  INSERT INTO mirror_group_chat_preferences (
    id, group_id, user_id, last_read_message_id, last_read_at, unread_count
  ) VALUES (
    UUID(), p_group_id, p_user_id, p_message_id, NOW(), 0
  )
  ON DUPLICATE KEY UPDATE
    last_read_message_id = p_message_id,
    last_read_at = NOW(),
    unread_count = 0;
END//

-- Procedure to clean up expired typing indicators
CREATE PROCEDURE IF NOT EXISTS cleanup_expired_typing()
BEGIN
  DELETE FROM mirror_group_typing_indicators
  WHERE expires_at < NOW();
END//

-- Procedure to clean up old delivery queue entries
CREATE PROCEDURE IF NOT EXISTS cleanup_delivery_queue()
BEGIN
  -- Mark expired entries
  UPDATE mirror_group_message_delivery_queue
  SET status = 'expired'
  WHERE status = 'pending' AND expires_at < NOW();

  -- Delete old completed/failed/expired entries (older than 7 days)
  DELETE FROM mirror_group_message_delivery_queue
  WHERE status IN ('delivered', 'failed', 'expired')
    AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY);
END//

DELIMITER ;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Trigger to update thread reply count when a reply is added
DELIMITER //

CREATE TRIGGER IF NOT EXISTS update_thread_count_insert
AFTER INSERT ON mirror_group_messages
FOR EACH ROW
BEGIN
  IF NEW.thread_root_id IS NOT NULL THEN
    UPDATE mirror_group_messages
    SET thread_reply_count = thread_reply_count + 1
    WHERE id = NEW.thread_root_id;
  END IF;
END//

-- Trigger to update thread reply count when a reply is deleted
CREATE TRIGGER IF NOT EXISTS update_thread_count_delete
AFTER UPDATE ON mirror_group_messages
FOR EACH ROW
BEGIN
  IF NEW.is_deleted = TRUE AND OLD.is_deleted = FALSE AND NEW.thread_root_id IS NOT NULL THEN
    UPDATE mirror_group_messages
    SET thread_reply_count = GREATEST(0, thread_reply_count - 1)
    WHERE id = NEW.thread_root_id;
  END IF;
END//

DELIMITER ;

-- ============================================================================
-- SCHEDULED EVENTS (Optional - requires EVENT scheduler)
-- ============================================================================

-- Enable event scheduler (run once on server)
-- SET GLOBAL event_scheduler = ON;

-- Event to clean up expired typing indicators every minute
DELIMITER //

CREATE EVENT IF NOT EXISTS cleanup_typing_indicators
ON SCHEDULE EVERY 1 MINUTE
DO
BEGIN
  CALL cleanup_expired_typing();
END//

-- Event to clean up delivery queue daily
CREATE EVENT IF NOT EXISTS cleanup_delivery_queue_daily
ON SCHEDULE EVERY 1 DAY
STARTS CURRENT_TIMESTAMP
DO
BEGIN
  CALL cleanup_delivery_queue();
END//

DELIMITER ;

-- ============================================================================
-- VIEWS (For convenient queries)
-- ============================================================================

-- View for message with sender info and reaction counts
CREATE OR REPLACE VIEW v_chat_messages AS
SELECT
  m.id,
  m.group_id,
  m.sender_user_id,
  u.username as sender_username,
  m.content,
  m.content_type,
  m.parent_message_id,
  m.thread_root_id,
  m.thread_reply_count,
  m.metadata,
  m.status,
  m.is_edited,
  m.is_deleted,
  m.created_at,
  m.updated_at,
  (SELECT COUNT(*) FROM mirror_group_message_reactions r WHERE r.message_id = m.id) as reaction_count,
  (SELECT JSON_ARRAYAGG(
    JSON_OBJECT('emoji', r.emoji, 'count', cnt)
  ) FROM (
    SELECT emoji, COUNT(*) as cnt
    FROM mirror_group_message_reactions
    WHERE message_id = m.id
    GROUP BY emoji
  ) r) as reactions_summary
FROM mirror_group_messages m
JOIN users u ON m.sender_user_id = u.id;

-- View for unread message counts per group per user
CREATE OR REPLACE VIEW v_unread_counts AS
SELECT
  p.user_id,
  p.group_id,
  p.unread_count,
  p.last_read_at,
  g.name as group_name
FROM mirror_group_chat_preferences p
JOIN mirror_groups g ON p.group_id = g.id;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

SELECT TABLE_NAME, TABLE_ROWS, CREATE_TIME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME LIKE 'mirror_group_%'
ORDER BY TABLE_NAME;

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
