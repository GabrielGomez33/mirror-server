-- ============================================================================
-- MIRRORGROUPS PHASE 4: CONVERSATION INTELLIGENCE + GROUP VOTING
-- ============================================================================
-- File: migrations/007_voting_and_insights.sql
-- Date: December 1, 2025
-- Description: Creates tables for conversation insights and group voting
-- ============================================================================

-- ============================================================================
-- TABLE 1: SESSION TRANSCRIPTS (Optional, Encrypted)
-- ============================================================================
-- Stores encrypted conversation transcripts for AI analysis
-- Privacy-first: All transcript_text is encrypted at rest

CREATE TABLE IF NOT EXISTS mirror_group_session_transcripts (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) NOT NULL,
  session_id VARCHAR(36) NOT NULL,
  speaker_user_id INT NOT NULL,
  transcript_text TEXT NOT NULL,  -- Encrypted content
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Metadata
  duration_seconds INT DEFAULT NULL,  -- Length of this speech segment
  language_code VARCHAR(10) DEFAULT 'en',

  -- Foreign keys
  CONSTRAINT fk_transcript_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_transcript_speaker FOREIGN KEY (speaker_user_id)
    REFERENCES users(id) ON DELETE CASCADE,

  -- Indexes for efficient querying
  INDEX idx_session_transcripts_session (session_id),
  INDEX idx_session_transcripts_timestamp (timestamp),
  INDEX idx_session_transcripts_group_session (group_id, session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 2: AI SESSION INSIGHTS
-- ============================================================================
-- Stores AI-generated insights from conversation analysis
-- Both periodic (during session) and post-session summaries

CREATE TABLE IF NOT EXISTS mirror_group_session_insights (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) NOT NULL,
  session_id VARCHAR(36) NOT NULL,

  -- Insight type and content
  insight_type ENUM('periodic', 'post_session', 'on_demand') NOT NULL,

  -- JSON fields for structured insight data
  key_observations JSON NOT NULL,           -- Array of observation strings
  recommendations JSON DEFAULT NULL,         -- Array of recommendation strings
  dynamics_assessment JSON DEFAULT NULL,     -- Group dynamics during conversation
  compatibility_notes JSON DEFAULT NULL,     -- References to Phase 3 compatibility data

  -- Quality metrics
  confidence_score FLOAT DEFAULT 0.8,       -- AI confidence in insights
  relevance_score FLOAT DEFAULT 0.8,        -- How relevant to current discussion

  -- LLM metadata
  llm_model VARCHAR(50) DEFAULT 'mistral:7b',
  prompt_template VARCHAR(100) DEFAULT 'conversation_insight_v1',
  generation_params JSON DEFAULT NULL,

  -- Timestamps
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMP DEFAULT NULL,       -- When sent via WebSocket
  acknowledged_at TIMESTAMP DEFAULT NULL,    -- When read by members

  -- Foreign keys
  CONSTRAINT fk_insight_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,

  -- Indexes
  INDEX idx_session_insights_session (session_id),
  INDEX idx_session_insights_type (insight_type),
  INDEX idx_session_insights_generated (generated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 3: GROUP VOTES
-- ============================================================================
-- Stores vote proposals with topic, argument, and timer

CREATE TABLE IF NOT EXISTS mirror_group_votes (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) NOT NULL,
  proposer_user_id INT NOT NULL,

  -- Vote content
  topic VARCHAR(200) NOT NULL,              -- The question being voted on
  argument TEXT DEFAULT NULL,               -- Supporting argument from proposer

  -- Vote configuration
  vote_type ENUM('yes_no', 'multiple_choice', 'rating') DEFAULT 'yes_no',
  options JSON DEFAULT NULL,                -- For multiple choice: ["option1", "option2"]
  min_value INT DEFAULT NULL,               -- For rating: minimum value
  max_value INT DEFAULT NULL,               -- For rating: maximum value

  -- Timer and status
  status ENUM('active', 'completed', 'cancelled', 'expired') DEFAULT 'active',
  duration_seconds INT DEFAULT 60,          -- Default 60 second timer

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP DEFAULT NULL,        -- Set to created_at + duration_seconds
  completed_at TIMESTAMP DEFAULT NULL,      -- When voting ended

  -- Results (populated after completion)
  final_results JSON DEFAULT NULL,          -- Aggregated results
  participation_rate FLOAT DEFAULT NULL,    -- Percentage who voted

  -- Foreign keys
  CONSTRAINT fk_vote_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_vote_proposer FOREIGN KEY (proposer_user_id)
    REFERENCES users(id) ON DELETE CASCADE,

  -- Indexes
  INDEX idx_votes_group (group_id),
  INDEX idx_votes_status (status),
  INDEX idx_votes_created (created_at),
  INDEX idx_votes_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 4: VOTE RESPONSES
-- ============================================================================
-- Stores individual vote responses with unique constraint per vote+user

CREATE TABLE IF NOT EXISTS mirror_group_vote_responses (
  id VARCHAR(36) PRIMARY KEY,
  vote_id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,

  -- Response data
  response VARCHAR(100) NOT NULL,           -- 'yes', 'no', option text, or rating value
  response_index INT DEFAULT NULL,          -- For multiple choice: index of selected option

  -- Timestamps
  responded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Foreign keys
  CONSTRAINT fk_response_vote FOREIGN KEY (vote_id)
    REFERENCES mirror_group_votes(id) ON DELETE CASCADE,
  CONSTRAINT fk_response_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,

  -- Unique constraint: one vote per user per vote
  UNIQUE KEY unique_vote_user (vote_id, user_id),

  -- Indexes
  INDEX idx_responses_vote (vote_id),
  INDEX idx_responses_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TABLE 5: CONVERSATION ANALYSIS QUEUE (for background processing)
-- ============================================================================
-- Queue for scheduling periodic conversation analysis

CREATE TABLE IF NOT EXISTS mirror_group_conversation_queue (
  id VARCHAR(36) PRIMARY KEY,
  group_id VARCHAR(36) NOT NULL,
  session_id VARCHAR(36) NOT NULL,

  -- Analysis configuration
  analysis_type ENUM('periodic', 'on_demand', 'post_session') DEFAULT 'periodic',
  priority INT DEFAULT 5,                   -- 1-10, higher = more urgent

  -- Status tracking
  status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',

  -- Processing metadata
  attempts INT DEFAULT 0,
  max_attempts INT DEFAULT 3,
  last_error TEXT DEFAULT NULL,

  -- Parameters (JSON for flexibility)
  parameters JSON DEFAULT NULL,             -- { transcriptCount, timeRange, etc. }

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP DEFAULT NULL,
  completed_at TIMESTAMP DEFAULT NULL,

  -- Result reference
  insight_id VARCHAR(36) DEFAULT NULL,      -- Links to generated insight

  -- Foreign keys
  CONSTRAINT fk_conv_queue_group FOREIGN KEY (group_id)
    REFERENCES mirror_groups(id) ON DELETE CASCADE,

  -- Indexes
  INDEX idx_conv_queue_status (status),
  INDEX idx_conv_queue_session (session_id),
  INDEX idx_conv_queue_priority (priority, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-set expires_at when vote is created
DELIMITER //

CREATE TRIGGER IF NOT EXISTS set_vote_expires_at
BEFORE INSERT ON mirror_group_votes
FOR EACH ROW
BEGIN
  IF NEW.expires_at IS NULL THEN
    SET NEW.expires_at = DATE_ADD(NEW.created_at, INTERVAL NEW.duration_seconds SECOND);
  END IF;
END//

DELIMITER ;

-- ============================================================================
-- STORED PROCEDURES (Optional, for efficiency)
-- ============================================================================

-- Procedure to complete a vote and calculate results
DELIMITER //

CREATE PROCEDURE IF NOT EXISTS complete_vote(IN p_vote_id VARCHAR(36))
BEGIN
  DECLARE v_vote_type VARCHAR(20);
  DECLARE v_group_id VARCHAR(36);
  DECLARE v_total_members INT;
  DECLARE v_total_responses INT;

  -- Get vote info
  SELECT vote_type, group_id INTO v_vote_type, v_group_id
  FROM mirror_group_votes
  WHERE id = p_vote_id;

  -- Count total active members
  SELECT COUNT(*) INTO v_total_members
  FROM mirror_group_members
  WHERE group_id = v_group_id AND status = 'active';

  -- Count responses
  SELECT COUNT(*) INTO v_total_responses
  FROM mirror_group_vote_responses
  WHERE vote_id = p_vote_id;

  -- Calculate results based on vote type
  IF v_vote_type = 'yes_no' THEN
    UPDATE mirror_group_votes
    SET
      status = 'completed',
      completed_at = NOW(),
      participation_rate = (v_total_responses / v_total_members) * 100,
      final_results = (
        SELECT JSON_OBJECT(
          'yes', SUM(CASE WHEN response = 'yes' THEN 1 ELSE 0 END),
          'no', SUM(CASE WHEN response = 'no' THEN 1 ELSE 0 END),
          'total', COUNT(*),
          'totalMembers', v_total_members
        )
        FROM mirror_group_vote_responses
        WHERE vote_id = p_vote_id
      )
    WHERE id = p_vote_id;
  ELSE
    -- Multiple choice aggregation
    UPDATE mirror_group_votes
    SET
      status = 'completed',
      completed_at = NOW(),
      participation_rate = (v_total_responses / v_total_members) * 100,
      final_results = (
        SELECT JSON_ARRAYAGG(
          JSON_OBJECT('option', response, 'count', cnt)
        )
        FROM (
          SELECT response, COUNT(*) as cnt
          FROM mirror_group_vote_responses
          WHERE vote_id = p_vote_id
          GROUP BY response
        ) subq
      )
    WHERE id = p_vote_id;
  END IF;
END//

DELIMITER ;

-- ============================================================================
-- SAMPLE DATA (for testing - commented out for production)
-- ============================================================================

/*
-- Sample vote for testing
INSERT INTO mirror_group_votes (
  id, group_id, proposer_user_id, topic, argument, vote_type, duration_seconds, status
) VALUES (
  'test-vote-001',
  'existing-group-id',
  1,
  'Should we extend the meeting by 15 minutes?',
  'We still have important items to discuss.',
  'yes_no',
  60,
  'active'
);
*/

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Verify tables were created
SELECT TABLE_NAME, TABLE_ROWS, CREATE_TIME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME LIKE 'mirror_group_%'
ORDER BY TABLE_NAME;

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
