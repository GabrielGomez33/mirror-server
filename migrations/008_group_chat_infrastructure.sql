-- ============================================================================
-- MIRRORGROUPS PHASE 5: REAL-TIME CHAT INFRASTRUCTURE (No Triggers Version)
-- ============================================================================
-- File: migrations/008_group_chat_infrastructure_no_triggers.sql
-- Date: December 5, 2025
-- Description: Creates comprehensive chat tables - triggers/procedures removed
--              for compatibility with non-SUPER privilege accounts
-- ============================================================================

-- ============================================================================
-- TABLE 1: CHAT MESSAGES (Core Message Storage)
-- ============================================================================

CREATE TABLE IF NOT EXISTS mirror_group_messages (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) NOT NULL,
  sender_user_id INT NOT NULL,

  -- Message content (encrypted for security)
  content TEXT NOT NULL,
  content_type ENUM('text', 'image', 'file', 'audio', 'video', 'system', 'reply') DEFAULT 'text',

  -- Threading support
  parent_message_id VARCHAR(36) DEFAULT NULL,
  thread_root_id VARCHAR(36) DEFAULT NULL,
  thread_reply_count INT DEFAULT 0,

  -- Rich content metadata (JSON for flexibility)
  metadata JSON DEFAULT NULL,

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
  client_message_id VARCHAR(64) DEFAULT NULL,

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

  -- Indexes
  INDEX idx_messages_group (group_id),
  INDEX idx_messages_group_created (group_id, created_at DESC),
  INDEX idx_messages_sender (sender_user_id),
  INDEX idx_messages_thread_root (thread_root_id),
  INDEX idx_messages_parent (parent_message_id),
  INDEX idx_messages_status (status),
  INDEX idx_messages_client_id (client_message_id),
  INDEX idx_messages_created (created_at DESC),
  INDEX idx_messages_group_pagination (group_id, is_deleted, created_at DESC),
  FULLTEXT INDEX idx_messages_content_search (content)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 2: MESSAGE READ RECEIPTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS mirror_group_message_reads (
  id VARCHAR(36) PRIMARY KEY,
  message_id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,
  group_id VARCHAR(36) NOT NULL,
  read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_read_message FOREIGN KEY (message_id)
    REFERENCES mirror_group_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_read_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_read_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,

  UNIQUE KEY unique_message_user_read (message_id, user_id),
  INDEX idx_reads_message (message_id),
  INDEX idx_reads_user (user_id),
  INDEX idx_reads_group (group_id),
  INDEX idx_reads_group_user (group_id, user_id),
  INDEX idx_reads_timestamp (read_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 3: MESSAGE REACTIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS mirror_group_message_reactions (
  id VARCHAR(36) PRIMARY KEY,
  message_id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,
  group_id VARCHAR(36) NOT NULL,
  emoji VARCHAR(32) NOT NULL,
  emoji_name VARCHAR(64) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_reaction_message FOREIGN KEY (message_id)
    REFERENCES mirror_group_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_reaction_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_reaction_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,

  UNIQUE KEY unique_reaction (message_id, user_id, emoji),
  INDEX idx_reactions_message (message_id),
  INDEX idx_reactions_user (user_id),
  INDEX idx_reactions_emoji (emoji),
  INDEX idx_reactions_message_emoji (message_id, emoji)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 4: CHAT ATTACHMENTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS mirror_group_chat_attachments (
  id VARCHAR(36) PRIMARY KEY,
  message_id VARCHAR(36) NOT NULL,
  group_id VARCHAR(36) NOT NULL,
  uploader_user_id INT NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(100) NOT NULL,
  file_size BIGINT NOT NULL,
  file_path VARCHAR(512) NOT NULL,
  thumbnail_path VARCHAR(512) DEFAULT NULL,
  width INT DEFAULT NULL,
  height INT DEFAULT NULL,
  duration INT DEFAULT NULL,
  is_encrypted BOOLEAN DEFAULT TRUE,
  encryption_key_id VARCHAR(36) DEFAULT NULL,
  processing_status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_attachment_message FOREIGN KEY (message_id)
    REFERENCES mirror_group_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_attachment_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_attachment_uploader FOREIGN KEY (uploader_user_id)
    REFERENCES users(id) ON DELETE CASCADE,

  INDEX idx_attachments_message (message_id),
  INDEX idx_attachments_group (group_id),
  INDEX idx_attachments_type (file_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 5: TYPING INDICATORS
-- ============================================================================

CREATE TABLE IF NOT EXISTS mirror_group_typing_indicators (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,
  is_typing BOOLEAN DEFAULT TRUE,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,

  CONSTRAINT fk_typing_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_typing_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,

  UNIQUE KEY unique_typing (group_id, user_id),
  INDEX idx_typing_group (group_id),
  INDEX idx_typing_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 6: USER CHAT PREFERENCES
-- ============================================================================

CREATE TABLE IF NOT EXISTS mirror_group_chat_preferences (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,
  muted_until TIMESTAMP DEFAULT NULL,
  notification_level ENUM('all', 'mentions', 'none') DEFAULT 'all',
  pinned BOOLEAN DEFAULT FALSE,
  archived BOOLEAN DEFAULT FALSE,
  last_read_message_id VARCHAR(36) DEFAULT NULL,
  last_read_at TIMESTAMP DEFAULT NULL,
  unread_count INT DEFAULT 0,
  custom_notification_sound VARCHAR(100) DEFAULT NULL,
  show_previews BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_pref_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_pref_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,

  UNIQUE KEY unique_user_group_pref (group_id, user_id),
  INDEX idx_prefs_user (user_id),
  INDEX idx_prefs_muted (muted_until),
  INDEX idx_prefs_pinned (user_id, pinned)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 7: MESSAGE MENTIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS mirror_group_message_mentions (
  id VARCHAR(36) PRIMARY KEY,
  message_id VARCHAR(36) NOT NULL,
  mentioned_user_id INT NOT NULL,
  group_id VARCHAR(36) NOT NULL,
  mention_type ENUM('user', 'everyone', 'role') DEFAULT 'user',
  notified BOOLEAN DEFAULT FALSE,
  notified_at TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_mention_message FOREIGN KEY (message_id)
    REFERENCES mirror_group_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_mention_user FOREIGN KEY (mentioned_user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mention_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,

  UNIQUE KEY unique_mention (message_id, mentioned_user_id),
  INDEX idx_mentions_user (mentioned_user_id),
  INDEX idx_mentions_group_user (group_id, mentioned_user_id),
  INDEX idx_mentions_unnotified (notified, mentioned_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 8: PINNED MESSAGES
-- ============================================================================

CREATE TABLE IF NOT EXISTS mirror_group_pinned_messages (
  id VARCHAR(36) PRIMARY KEY,
  message_id VARCHAR(36) NOT NULL,
  group_id VARCHAR(36) NOT NULL,
  pinned_by_user_id INT NOT NULL,
  pin_order INT DEFAULT 0,
  pin_note VARCHAR(255) DEFAULT NULL,
  pinned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_pin_message FOREIGN KEY (message_id)
    REFERENCES mirror_group_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_pin_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_pin_user FOREIGN KEY (pinned_by_user_id)
    REFERENCES users(id) ON DELETE CASCADE,

  UNIQUE KEY unique_pinned_message (message_id, group_id),
  INDEX idx_pinned_group (group_id),
  INDEX idx_pinned_order (group_id, pin_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 9: CHAT PRESENCE
-- ============================================================================

CREATE TABLE IF NOT EXISTS mirror_group_chat_presence (
  id VARCHAR(36) PRIMARY KEY,
  user_id INT NOT NULL,
  group_id VARCHAR(36) NOT NULL,
  status ENUM('online', 'away', 'busy', 'offline') DEFAULT 'offline',
  custom_status VARCHAR(100) DEFAULT NULL,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  connected_at TIMESTAMP DEFAULT NULL,
  connection_id VARCHAR(64) DEFAULT NULL,
  device_type ENUM('web', 'mobile_ios', 'mobile_android', 'desktop') DEFAULT 'web',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_presence_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_presence_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,

  UNIQUE KEY unique_user_group_presence (user_id, group_id),
  INDEX idx_presence_group (group_id),
  INDEX idx_presence_status (group_id, status),
  INDEX idx_presence_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 10: MESSAGE DELIVERY QUEUE
-- ============================================================================

CREATE TABLE IF NOT EXISTS mirror_group_message_delivery_queue (
  id VARCHAR(36) PRIMARY KEY,
  message_id VARCHAR(36) NOT NULL,
  recipient_user_id INT NOT NULL,
  group_id VARCHAR(36) NOT NULL,
  status ENUM('pending', 'delivered', 'failed', 'expired') DEFAULT 'pending',
  attempt_count INT DEFAULT 0,
  max_attempts INT DEFAULT 5,
  last_attempt_at TIMESTAMP DEFAULT NULL,
  next_retry_at TIMESTAMP DEFAULT NULL,
  last_error TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMP DEFAULT NULL,
  expires_at TIMESTAMP DEFAULT NULL,

  CONSTRAINT fk_queue_message FOREIGN KEY (message_id)
    REFERENCES mirror_group_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_queue_recipient FOREIGN KEY (recipient_user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_queue_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,

  INDEX idx_queue_recipient (recipient_user_id),
  INDEX idx_queue_status (status),
  INDEX idx_queue_retry (status, next_retry_at),
  INDEX idx_queue_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- VERIFICATION
-- ============================================================================

SELECT TABLE_NAME, TABLE_ROWS, CREATE_TIME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME LIKE 'mirror_group_%'
ORDER BY TABLE_NAME;

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
