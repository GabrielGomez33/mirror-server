-- ============================================================================
-- TRUTHSTREAM - Complete Database Migration
-- ============================================================================
-- Migration: 009_truthstream.sql
-- MySQL: 8.0.45 compatible (no CREATE INDEX IF NOT EXISTS)
-- Description: Creates all TruthStream tables, triggers, and seed questionnaire data
-- ============================================================================
-- IMPORTANT: Run this migration AFTER all existing migrations.
-- Requires: users table with id INT AUTO_INCREMENT PRIMARY KEY
-- ============================================================================

-- Wrap in a transaction-safe execution block
SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0;
SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0;
SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='TRADITIONAL,ALLOW_INVALID_DATES';

-- ============================================================================
-- 1. TRUTH CARD PROFILES
-- The user's TruthStream identity - combines intake data + new TS-specific data
-- ============================================================================
CREATE TABLE IF NOT EXISTS truth_stream_profiles (
  id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,

  -- Identity (anonymized for reviewers)
  display_alias VARCHAR(50) NOT NULL,
  age_range ENUM('18-24', '25-34', '35-44', '45-54', '55+') NOT NULL,
  gender_display VARCHAR(30) DEFAULT NULL,
  pronouns VARCHAR(20) DEFAULT NULL,
  cultural_context VARCHAR(200) DEFAULT NULL,

  -- TruthStream-specific assets
  photo_path VARCHAR(500) DEFAULT NULL,
  vocal_salutation_path VARCHAR(500) DEFAULT NULL,

  -- Goal & Statement
  goal TEXT NOT NULL,
  goal_category ENUM(
    'personal_growth', 'dating_readiness', 'professional_image',
    'social_skills', 'first_impressions', 'leadership',
    'communication', 'authenticity', 'confidence', 'custom'
  ) NOT NULL,
  self_statement TEXT DEFAULT NULL,
  feedback_areas JSON DEFAULT NULL,

  -- Data sharing control
  shared_data_types JSON NOT NULL,
  minimum_share_met TINYINT(1) NOT NULL DEFAULT 0,

  -- Stats (denormalized for performance)
  total_reviews_received INT NOT NULL DEFAULT 0,
  total_reviews_given INT NOT NULL DEFAULT 0,
  review_quality_score FLOAT NOT NULL DEFAULT 0.5,
  perception_gap_score FLOAT DEFAULT NULL,

  -- State
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  profile_completeness FLOAT NOT NULL DEFAULT 0.0,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_ts_profile_user (user_id),
  UNIQUE KEY uq_ts_display_alias (display_alias),
  INDEX idx_ts_profile_active (is_active),
  INDEX idx_ts_profile_quality (review_quality_score DESC),
  INDEX idx_ts_profile_goal (goal_category),
  INDEX idx_ts_profile_created (created_at DESC),

  CONSTRAINT fk_ts_profile_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 2. GOAL-DRIVEN QUESTIONNAIRE TEMPLATES
-- Different goals produce different questionnaires for reviewers
-- ============================================================================
CREATE TABLE IF NOT EXISTS truth_stream_questionnaires (
  id VARCHAR(36) NOT NULL,
  goal_category ENUM(
    'personal_growth', 'dating_readiness', 'professional_image',
    'social_skills', 'first_impressions', 'leadership',
    'communication', 'authenticity', 'confidence', 'custom'
  ) NOT NULL,
  version INT NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,

  -- The questionnaire structure (JSON array of sections)
  sections JSON NOT NULL,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_ts_quest_goal_active (goal_category, is_active, version DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 3. REVIEW QUEUE
-- Algorithmic assignment of profiles to reviewers in batches
-- ============================================================================
CREATE TABLE IF NOT EXISTS truth_stream_queue (
  id VARCHAR(36) NOT NULL,
  reviewer_id INT NOT NULL,
  reviewee_id INT NOT NULL,
  batch_number INT NOT NULL,

  status ENUM('pending', 'in_progress', 'completed', 'expired', 'cancelled') NOT NULL DEFAULT 'pending',

  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL DEFAULT NULL,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  expires_at TIMESTAMP NOT NULL,
  time_spent_seconds INT NOT NULL DEFAULT 0,

  PRIMARY KEY (id),
  UNIQUE KEY uq_ts_queue_assignment (reviewer_id, reviewee_id, batch_number),
  INDEX idx_ts_queue_reviewer_status (reviewer_id, status),
  INDEX idx_ts_queue_reviewee (reviewee_id),
  INDEX idx_ts_queue_expires (expires_at),
  INDEX idx_ts_queue_status_batch (status, batch_number DESC),

  CONSTRAINT fk_ts_queue_reviewer
    FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ts_queue_reviewee
    FOREIGN KEY (reviewee_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 4. SUBMITTED REVIEWS
-- Core review data structured by the goal-driven questionnaire
-- ============================================================================
CREATE TABLE IF NOT EXISTS truth_stream_reviews (
  id VARCHAR(36) NOT NULL,
  queue_id VARCHAR(36) NOT NULL,
  reviewer_id INT DEFAULT NULL,
  reviewee_id INT NOT NULL,
  questionnaire_id VARCHAR(36) NOT NULL,

  -- Responses stored as JSON (matches questionnaire structure)
  responses JSON NOT NULL,

  -- Dina Classification (populated async after submission)
  classification ENUM('constructive', 'affirming', 'raw_truth', 'hostile') DEFAULT NULL,
  classification_confidence FLOAT DEFAULT NULL,
  classification_reasoning TEXT DEFAULT NULL,
  dina_counter_analysis TEXT DEFAULT NULL,

  -- Quality metrics (calculated server-side)
  completeness_score FLOAT NOT NULL DEFAULT 0.0,
  depth_score FLOAT NOT NULL DEFAULT 0.0,
  quality_score FLOAT NOT NULL DEFAULT 0.0,
  time_spent_seconds INT NOT NULL DEFAULT 0,

  -- Social
  helpful_count INT NOT NULL DEFAULT 0,
  is_flagged TINYINT(1) NOT NULL DEFAULT 0,
  flag_reason TEXT DEFAULT NULL,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_ts_review_queue (queue_id),
  INDEX idx_ts_review_reviewee_created (reviewee_id, created_at DESC),
  INDEX idx_ts_review_reviewer (reviewer_id),
  INDEX idx_ts_review_classification (classification),
  INDEX idx_ts_review_quality (quality_score DESC),
  INDEX idx_ts_review_flagged (is_flagged),

  CONSTRAINT fk_ts_review_queue
    FOREIGN KEY (queue_id) REFERENCES truth_stream_queue(id),
  CONSTRAINT fk_ts_review_reviewee
    FOREIGN KEY (reviewee_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ts_review_questionnaire
    FOREIGN KEY (questionnaire_id) REFERENCES truth_stream_questionnaires(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- NOTE: reviewer_id does NOT have a foreign key with CASCADE.
-- This is intentional — when a user deletes their account, their written
-- reviews are preserved (reviewer_id set to NULL via trigger) so the
-- reviewee doesn't lose valuable feedback. See trigger below.


-- ============================================================================
-- 5. HELPFUL VOTES
-- Users mark reviews they received as helpful
-- ============================================================================
CREATE TABLE IF NOT EXISTS truth_stream_helpful_votes (
  id VARCHAR(36) NOT NULL,
  review_id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_ts_vote (review_id, user_id),

  CONSTRAINT fk_ts_vote_review
    FOREIGN KEY (review_id) REFERENCES truth_stream_reviews(id) ON DELETE CASCADE,
  CONSTRAINT fk_ts_vote_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 6. ANONYMOUS DIALOGUE
-- Reviewee communicates with anonymous reviewer for deeper insight
-- ============================================================================
CREATE TABLE IF NOT EXISTS truth_stream_dialogues (
  id VARCHAR(36) NOT NULL,
  review_id VARCHAR(36) NOT NULL,
  author_role ENUM('reviewee', 'reviewer') NOT NULL,
  author_user_id INT DEFAULT NULL,
  content TEXT NOT NULL,
  is_system_message TINYINT(1) NOT NULL DEFAULT 0,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_ts_dialogue_review (review_id, created_at ASC),
  INDEX idx_ts_dialogue_author (author_user_id),

  CONSTRAINT fk_ts_dialogue_review
    FOREIGN KEY (review_id) REFERENCES truth_stream_reviews(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 7. DINA ANALYSIS REPORTS
-- AI-generated comprehensive perception analysis
-- ============================================================================
CREATE TABLE IF NOT EXISTS truth_stream_analyses (
  id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,
  analysis_type ENUM(
    'truth_mirror_report',
    'perception_gap',
    'temporal_trend',
    'blind_spot',
    'growth_recommendation'
  ) NOT NULL,

  review_count_at_generation INT NOT NULL,
  analysis_data JSON NOT NULL,
  perception_gap_score FLOAT DEFAULT NULL,
  confidence_level FLOAT DEFAULT NULL,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_ts_analysis_user_type (user_id, analysis_type, created_at DESC),

  CONSTRAINT fk_ts_analysis_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 8. FEEDBACK REQUESTS
-- Users post specific questions for targeted reviews
-- ============================================================================
CREATE TABLE IF NOT EXISTS truth_stream_feedback_requests (
  id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,
  question TEXT NOT NULL,
  context TEXT DEFAULT NULL,

  is_active TINYINT(1) NOT NULL DEFAULT 1,
  response_count INT NOT NULL DEFAULT 0,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NULL DEFAULT NULL,

  PRIMARY KEY (id),
  INDEX idx_ts_feedback_active (is_active, created_at DESC),
  INDEX idx_ts_feedback_user (user_id),

  CONSTRAINT fk_ts_feedback_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 9. GROWTH MILESTONES
-- Tracks achievements and growth indicators
-- ============================================================================
CREATE TABLE IF NOT EXISTS truth_stream_milestones (
  id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,
  milestone_type VARCHAR(50) NOT NULL,
  milestone_name VARCHAR(100) NOT NULL,
  milestone_description TEXT DEFAULT NULL,
  milestone_data JSON DEFAULT NULL,

  achieved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_ts_milestone (user_id, milestone_type),
  INDEX idx_ts_milestone_user (user_id, achieved_at DESC),

  CONSTRAINT fk_ts_milestone_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 10. HOSTILE REVIEW LOG (Audit Trail)
-- Records all hostile classifications for pattern detection
-- ============================================================================
CREATE TABLE IF NOT EXISTS truth_stream_hostility_log (
  id VARCHAR(36) NOT NULL,
  review_id VARCHAR(36) NOT NULL,
  reviewer_id INT NOT NULL,
  reviewee_id INT NOT NULL,

  classification_confidence FLOAT NOT NULL,
  hostility_indicators JSON DEFAULT NULL,
  reviewer_hostility_count INT NOT NULL DEFAULT 1,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_ts_hostility_reviewer (reviewer_id, created_at DESC),
  INDEX idx_ts_hostility_reviewee (reviewee_id, created_at DESC),

  CONSTRAINT fk_ts_hostility_review
    FOREIGN KEY (review_id) REFERENCES truth_stream_reviews(id) ON DELETE CASCADE
  -- NOTE: reviewer_id has NO foreign key cascade — preserves audit trail even if user is deleted
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- 11. PROCESSING QUEUE
-- Async job queue for LLM classification and analysis generation
-- Polled by TruthStreamQueueProcessor (separate worker process)
-- ============================================================================
CREATE TABLE IF NOT EXISTS truth_stream_processing_queue (
  id VARCHAR(36) NOT NULL,
  job_type ENUM('classify_review', 'generate_analysis') NOT NULL,
  reference_id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,
  priority INT NOT NULL DEFAULT 5,

  status ENUM('pending', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  retry_count INT NOT NULL DEFAULT 0,
  max_retries INT NOT NULL DEFAULT 3,
  error_message TEXT DEFAULT NULL,

  input_data JSON DEFAULT NULL,
  output_data JSON DEFAULT NULL,

  next_retry_at TIMESTAMP NULL DEFAULT NULL,
  started_at TIMESTAMP NULL DEFAULT NULL,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_ts_procq_status_priority (status, priority DESC, created_at ASC),
  INDEX idx_ts_procq_next_retry (status, next_retry_at),
  INDEX idx_ts_procq_user (user_id),
  INDEX idx_ts_procq_reference (reference_id),

  CONSTRAINT fk_ts_procq_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- TRIGGER: Preserve reviews when a user deletes their account
-- ============================================================================
-- NOTE: This trigger requires SUPER privilege or log_bin_trust_function_creators=1
-- when binary logging is enabled. If your MySQL server has binary logging ON
-- (which is common in production), you have two options:
--
-- OPTION A (Recommended): Run 009b_truthstream_trigger_admin.sql as a
--   MySQL admin/root user to create the trigger.
--
-- OPTION B: Set the server variable before creating the trigger:
--   SET GLOBAL log_bin_trust_function_creators = 1;
--   (requires SUPER or SYSTEM_VARIABLES_ADMIN privilege)
--
-- OPTION C: The application layer handles all cascade logic in
--   cleanupUserTruthStreamData() in truthstreamController.ts.
--   This is the primary mechanism — the trigger is a safety net.
--
-- The CASCADE foreign keys on user_id handle most deletions automatically.
-- The trigger is specifically for preserving REVIEWER data (reviews written
-- for other users) when the reviewer deletes their account.
-- ============================================================================


-- ============================================================================
-- SEED DATA: Goal-Driven Questionnaire Templates
-- ============================================================================
-- Each goal category gets a tailored questionnaire.
-- All share common sections (first_impression, overall, free_form)
-- but diverge in goal-specific focus areas.
-- ============================================================================

-- Helper: UUID generation for seed data
-- MySQL 8.0 supports UUID() natively

-- ============================================================================
-- PERSONAL GROWTH Questionnaire
-- ============================================================================
INSERT INTO truth_stream_questionnaires (id, goal_category, version, is_active, sections) VALUES
(UUID(), 'personal_growth', 1, 1, JSON_ARRAY(
  JSON_OBJECT(
    'id', 'first_impression',
    'title', 'First Impression',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'gut_reaction', 'type', 'scale', 'text', 'What is your gut first impression of this person?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Negative', 'maxLabel', 'Very Positive')),
      JSON_OBJECT('id', 'impression_words', 'type', 'select_words', 'text', 'Select 3-5 words that describe your first impression', 'config', JSON_OBJECT('min', 3, 'max', 5, 'words', JSON_ARRAY('Warm', 'Cold', 'Genuine', 'Guarded', 'Confident', 'Insecure', 'Creative', 'Analytical', 'Empathetic', 'Distant', 'Energetic', 'Calm', 'Ambitious', 'Laid-back', 'Mysterious', 'Open', 'Intense', 'Gentle', 'Strong', 'Vulnerable', 'Wise', 'Naive', 'Charismatic', 'Reserved', 'Trustworthy', 'Suspicious', 'Inspiring', 'Intimidating', 'Approachable', 'Aloof'))),
      JSON_OBJECT('id', 'impression_explain', 'type', 'free_text', 'text', 'In one sentence, explain your first impression', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'perceived_strengths',
    'title', 'Perceived Strengths',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'top_strengths', 'type', 'category_explain', 'text', 'What do you perceive as this person''s top 3 strengths?', 'config', JSON_OBJECT('categories', JSON_ARRAY('Emotional Intelligence', 'Communication', 'Leadership', 'Creativity', 'Problem Solving', 'Empathy', 'Resilience', 'Self-Awareness', 'Adaptability', 'Integrity', 'Humor', 'Discipline'), 'selectCount', 3, 'requireExplanation', true)),
      JSON_OBJECT('id', 'strength_evidence', 'type', 'free_text', 'text', 'What about their profile or data made you perceive these strengths?', 'config', JSON_OBJECT('minLength', 30, 'maxLength', 1000))
    )
  ),
  JSON_OBJECT(
    'id', 'growth_areas',
    'title', 'Areas for Growth',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'struggle_areas', 'type', 'category_explain', 'text', 'Where do you think this person might struggle or have blind spots?', 'config', JSON_OBJECT('categories', JSON_ARRAY('Emotional Regulation', 'Boundaries', 'Self-Confidence', 'Communication Style', 'Openness to Feedback', 'Patience', 'Assertiveness', 'Vulnerability', 'Time Management', 'Social Awareness', 'Decision Making', 'Letting Go'), 'selectCount', 2, 'requireExplanation', true)),
      JSON_OBJECT('id', 'growth_advice', 'type', 'free_text', 'text', 'What specific advice would you give this person for personal growth?', 'config', JSON_OBJECT('minLength', 50, 'maxLength', 2000))
    )
  ),
  JSON_OBJECT(
    'id', 'blind_spots',
    'title', 'Blind Spot Assessment',
    'required', false,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'self_awareness_rating', 'type', 'scale', 'text', 'How self-aware does this person seem based on their profile?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Not Self-Aware', 'maxLabel', 'Highly Self-Aware')),
      JSON_OBJECT('id', 'hidden_qualities', 'type', 'free_text', 'text', 'What qualities might this person not realize they project?', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 1000))
    )
  ),
  JSON_OBJECT(
    'id', 'overall',
    'title', 'Overall Assessment',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'overall_score', 'type', 'scale', 'text', 'Overall impression score', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Negative', 'maxLabel', 'Very Positive')),
      JSON_OBJECT('id', 'would_want_in_group', 'type', 'multi_choice', 'text', 'Would you want this person in your circle?', 'config', JSON_OBJECT('options', JSON_ARRAY('Absolutely yes', 'Probably yes', 'Neutral', 'Probably not', 'Definitely not'))),
      JSON_OBJECT('id', 'group_reason', 'type', 'free_text', 'text', 'Why or why not?', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'free_form',
    'title', 'Free-Form Reflection',
    'required', false,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'open_reflection', 'type', 'free_text', 'text', 'Share any additional thoughts, honest opinions, criticisms, or tips for this person. Be real — the mirror reflects truth.', 'config', JSON_OBJECT('minLength', 0, 'maxLength', 5000)),
      JSON_OBJECT('id', 'self_tagged_tone', 'type', 'multi_choice', 'text', 'How would you describe the tone of your review?', 'config', JSON_OBJECT('options', JSON_ARRAY('Encouraging and supportive', 'Honest but kind', 'Direct and unfiltered', 'Critical with constructive intent', 'Tough love')))
    )
  )
));


-- ============================================================================
-- DATING READINESS Questionnaire
-- ============================================================================
INSERT INTO truth_stream_questionnaires (id, goal_category, version, is_active, sections) VALUES
(UUID(), 'dating_readiness', 1, 1, JSON_ARRAY(
  JSON_OBJECT(
    'id', 'first_impression',
    'title', 'First Impression',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'gut_reaction', 'type', 'scale', 'text', 'What is your gut first impression of this person?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Negative', 'maxLabel', 'Very Positive')),
      JSON_OBJECT('id', 'impression_words', 'type', 'select_words', 'text', 'Select 3-5 words that describe your first impression', 'config', JSON_OBJECT('min', 3, 'max', 5, 'words', JSON_ARRAY('Attractive', 'Average', 'Charming', 'Awkward', 'Confident', 'Nervous', 'Warm', 'Cold', 'Mysterious', 'Open', 'Fun', 'Boring', 'Genuine', 'Fake', 'Sexy', 'Cute', 'Smart', 'Kind', 'Intense', 'Relaxed', 'Ambitious', 'Creative', 'Trustworthy', 'Suspicious', 'Engaging', 'Forgettable', 'Magnetic', 'Repelling', 'Elegant', 'Rough'))),
      JSON_OBJECT('id', 'impression_explain', 'type', 'free_text', 'text', 'In one sentence, explain your first impression', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'physical_presentation',
    'title', 'Physical Presentation',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'physical_attractiveness', 'type', 'scale', 'text', 'Rate their overall physical presentation (grooming, style, effort)', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Needs Work', 'maxLabel', 'Excellent')),
      JSON_OBJECT('id', 'photo_impression', 'type', 'free_text', 'text', 'What does their photo communicate about them?', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500)),
      JSON_OBJECT('id', 'style_advice', 'type', 'free_text', 'text', 'Any advice on physical presentation for the dating world?', 'config', JSON_OBJECT('minLength', 0, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'emotional_attractiveness',
    'title', 'Emotional & Intellectual Attractiveness',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'emotional_appeal', 'type', 'scale', 'text', 'How emotionally appealing does this person seem?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Not Appealing', 'maxLabel', 'Very Appealing')),
      JSON_OBJECT('id', 'intellectual_appeal', 'type', 'scale', 'text', 'How intellectually stimulating do they seem?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Not Stimulating', 'maxLabel', 'Very Stimulating')),
      JSON_OBJECT('id', 'dating_energy', 'type', 'multi_choice', 'text', 'What energy do they give off in a dating context?', 'config', JSON_OBJECT('options', JSON_ARRAY('Relationship material', 'Fun but not serious', 'Friend zone energy', 'Too intense', 'Just right', 'Hard to read')))
    )
  ),
  JSON_OBJECT(
    'id', 'dating_readiness_assessment',
    'title', 'Dating Readiness',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'readiness_score', 'type', 'scale', 'text', 'How ready for dating does this person seem?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Not Ready', 'maxLabel', 'Very Ready')),
      JSON_OBJECT('id', 'would_date', 'type', 'multi_choice', 'text', 'Honestly, would you date this person?', 'config', JSON_OBJECT('options', JSON_ARRAY('Yes, definitely', 'Maybe, with more info', 'As a friend only', 'Probably not', 'No'))),
      JSON_OBJECT('id', 'dating_advice', 'type', 'free_text', 'text', 'What honest advice would you give this person about their dating presence?', 'config', JSON_OBJECT('minLength', 50, 'maxLength', 2000))
    )
  ),
  JSON_OBJECT(
    'id', 'overall',
    'title', 'Overall Assessment',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'overall_score', 'type', 'scale', 'text', 'Overall impression score', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Negative', 'maxLabel', 'Very Positive')),
      JSON_OBJECT('id', 'biggest_strength_dating', 'type', 'free_text', 'text', 'Their biggest strength in the dating world', 'config', JSON_OBJECT('minLength', 10, 'maxLength', 500)),
      JSON_OBJECT('id', 'biggest_weakness_dating', 'type', 'free_text', 'text', 'Their biggest weakness in the dating world', 'config', JSON_OBJECT('minLength', 10, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'free_form',
    'title', 'Free-Form Reflection',
    'required', false,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'open_reflection', 'type', 'free_text', 'text', 'Share any additional thoughts about this person''s dating readiness. Be honest — they came here for truth.', 'config', JSON_OBJECT('minLength', 0, 'maxLength', 5000)),
      JSON_OBJECT('id', 'self_tagged_tone', 'type', 'multi_choice', 'text', 'How would you describe the tone of your review?', 'config', JSON_OBJECT('options', JSON_ARRAY('Encouraging and supportive', 'Honest but kind', 'Direct and unfiltered', 'Critical with constructive intent', 'Tough love')))
    )
  )
));


-- ============================================================================
-- PROFESSIONAL IMAGE Questionnaire
-- ============================================================================
INSERT INTO truth_stream_questionnaires (id, goal_category, version, is_active, sections) VALUES
(UUID(), 'professional_image', 1, 1, JSON_ARRAY(
  JSON_OBJECT(
    'id', 'first_impression',
    'title', 'First Impression',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'gut_reaction', 'type', 'scale', 'text', 'What is your gut first impression of this person professionally?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Negative', 'maxLabel', 'Very Positive')),
      JSON_OBJECT('id', 'impression_words', 'type', 'select_words', 'text', 'Select 3-5 words that describe your professional impression', 'config', JSON_OBJECT('min', 3, 'max', 5, 'words', JSON_ARRAY('Competent', 'Incompetent', 'Leader', 'Follower', 'Innovative', 'Traditional', 'Reliable', 'Unreliable', 'Professional', 'Casual', 'Polished', 'Rough', 'Strategic', 'Tactical', 'Visionary', 'Practical', 'Collaborative', 'Independent', 'Ambitious', 'Complacent', 'Decisive', 'Indecisive', 'Articulate', 'Unclear', 'Trustworthy', 'Questionable', 'Executive', 'Entry-level', 'Expert', 'Generalist'))),
      JSON_OBJECT('id', 'impression_explain', 'type', 'free_text', 'text', 'In one sentence, explain your professional impression', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'leadership_perception',
    'title', 'Leadership & Competence',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'leadership_score', 'type', 'scale', 'text', 'How strong of a leader does this person appear to be?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Weak Leader', 'maxLabel', 'Strong Leader')),
      JSON_OBJECT('id', 'competence_score', 'type', 'scale', 'text', 'How competent do they appear in their domain?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Low Competence', 'maxLabel', 'High Competence')),
      JSON_OBJECT('id', 'trustworthiness', 'type', 'scale', 'text', 'How trustworthy do they seem in a professional context?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Not Trustworthy', 'maxLabel', 'Very Trustworthy'))
    )
  ),
  JSON_OBJECT(
    'id', 'communication_style',
    'title', 'Professional Communication',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'communication_rating', 'type', 'scale', 'text', 'Rate their communication effectiveness', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Poor Communicator', 'maxLabel', 'Excellent Communicator')),
      JSON_OBJECT('id', 'professional_presence', 'type', 'multi_choice', 'text', 'What professional role could you see them in?', 'config', JSON_OBJECT('options', JSON_ARRAY('C-Suite Executive', 'Senior Manager', 'Team Lead', 'Individual Contributor', 'Entrepreneur', 'Creative Director', 'Consultant'))),
      JSON_OBJECT('id', 'professional_advice', 'type', 'free_text', 'text', 'What advice would you give to improve their professional image?', 'config', JSON_OBJECT('minLength', 50, 'maxLength', 2000))
    )
  ),
  JSON_OBJECT(
    'id', 'overall',
    'title', 'Overall Professional Assessment',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'overall_score', 'type', 'scale', 'text', 'Overall professional impression score', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Negative', 'maxLabel', 'Very Positive')),
      JSON_OBJECT('id', 'hire_decision', 'type', 'multi_choice', 'text', 'If you were hiring, would you consider this person?', 'config', JSON_OBJECT('options', JSON_ARRAY('Absolutely', 'Probably yes', 'Depends on the role', 'Probably not', 'No'))),
      JSON_OBJECT('id', 'hire_reason', 'type', 'free_text', 'text', 'Why or why not?', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'free_form',
    'title', 'Free-Form Reflection',
    'required', false,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'open_reflection', 'type', 'free_text', 'text', 'Share any additional professional observations, criticisms, or career advice.', 'config', JSON_OBJECT('minLength', 0, 'maxLength', 5000)),
      JSON_OBJECT('id', 'self_tagged_tone', 'type', 'multi_choice', 'text', 'How would you describe the tone of your review?', 'config', JSON_OBJECT('options', JSON_ARRAY('Encouraging and supportive', 'Honest but kind', 'Direct and unfiltered', 'Critical with constructive intent', 'Tough love')))
    )
  )
));


-- ============================================================================
-- SOCIAL SKILLS Questionnaire
-- ============================================================================
INSERT INTO truth_stream_questionnaires (id, goal_category, version, is_active, sections) VALUES
(UUID(), 'social_skills', 1, 1, JSON_ARRAY(
  JSON_OBJECT(
    'id', 'first_impression',
    'title', 'First Impression',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'gut_reaction', 'type', 'scale', 'text', 'What is your gut first impression of this person socially?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Negative', 'maxLabel', 'Very Positive')),
      JSON_OBJECT('id', 'impression_words', 'type', 'select_words', 'text', 'Select 3-5 words that describe your social impression', 'config', JSON_OBJECT('min', 3, 'max', 5, 'words', JSON_ARRAY('Friendly', 'Standoffish', 'Life of the Party', 'Wallflower', 'Good Listener', 'Talks Too Much', 'Empathetic', 'Self-Absorbed', 'Funny', 'Serious', 'Easy-going', 'Uptight', 'Inclusive', 'Cliquey', 'Genuine', 'Performative', 'Respectful', 'Rude', 'Engaging', 'Boring', 'Generous', 'Selfish', 'Patient', 'Impatient', 'Supportive', 'Competitive', 'Diplomatic', 'Blunt', 'Thoughtful', 'Careless'))),
      JSON_OBJECT('id', 'impression_explain', 'type', 'free_text', 'text', 'In one sentence, explain your social impression', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'social_dynamics',
    'title', 'Social Dynamics',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'approachability', 'type', 'scale', 'text', 'How approachable does this person seem?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Unapproachable', 'maxLabel', 'Very Approachable')),
      JSON_OBJECT('id', 'social_energy', 'type', 'multi_choice', 'text', 'What energy do they bring to a social setting?', 'config', JSON_OBJECT('options', JSON_ARRAY('Energizes the room', 'Calm, grounding presence', 'Observer who speaks wisely', 'Dominates conversation', 'Blends into the background', 'Mood depends on the group'))),
      JSON_OBJECT('id', 'social_awareness', 'type', 'scale', 'text', 'How socially aware do they seem?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Oblivious', 'maxLabel', 'Highly Aware')),
      JSON_OBJECT('id', 'social_advice', 'type', 'free_text', 'text', 'What specific advice would you give to improve their social skills?', 'config', JSON_OBJECT('minLength', 50, 'maxLength', 2000))
    )
  ),
  JSON_OBJECT(
    'id', 'overall',
    'title', 'Overall Assessment',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'overall_score', 'type', 'scale', 'text', 'Overall social impression score', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Negative', 'maxLabel', 'Very Positive')),
      JSON_OBJECT('id', 'would_want_in_group', 'type', 'multi_choice', 'text', 'Would you want this person at your social gatherings?', 'config', JSON_OBJECT('options', JSON_ARRAY('Absolutely yes', 'Probably yes', 'Neutral', 'Probably not', 'Definitely not'))),
      JSON_OBJECT('id', 'group_reason', 'type', 'free_text', 'text', 'Why or why not?', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'free_form',
    'title', 'Free-Form Reflection',
    'required', false,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'open_reflection', 'type', 'free_text', 'text', 'Share any additional thoughts on their social presence.', 'config', JSON_OBJECT('minLength', 0, 'maxLength', 5000)),
      JSON_OBJECT('id', 'self_tagged_tone', 'type', 'multi_choice', 'text', 'How would you describe the tone of your review?', 'config', JSON_OBJECT('options', JSON_ARRAY('Encouraging and supportive', 'Honest but kind', 'Direct and unfiltered', 'Critical with constructive intent', 'Tough love')))
    )
  )
));


-- ============================================================================
-- FIRST IMPRESSIONS Questionnaire
-- ============================================================================
INSERT INTO truth_stream_questionnaires (id, goal_category, version, is_active, sections) VALUES
(UUID(), 'first_impressions', 1, 1, JSON_ARRAY(
  JSON_OBJECT(
    'id', 'first_impression',
    'title', 'First Impression',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'gut_reaction', 'type', 'scale', 'text', 'What is your instant gut reaction to this person?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Negative', 'maxLabel', 'Very Positive')),
      JSON_OBJECT('id', 'impression_words', 'type', 'select_words', 'text', 'Select 3-5 words that describe your INSTANT reaction', 'config', JSON_OBJECT('min', 3, 'max', 5, 'words', JSON_ARRAY('Attractive', 'Unattractive', 'Trustworthy', 'Suspicious', 'Intelligent', 'Dull', 'Kind', 'Mean', 'Powerful', 'Weak', 'Cool', 'Uncool', 'Interesting', 'Boring', 'Safe', 'Dangerous', 'Rich', 'Poor', 'Happy', 'Sad', 'Young', 'Old', 'Healthy', 'Unhealthy', 'Successful', 'Struggling', 'Leader', 'Follower', 'Creative', 'Conventional'))),
      JSON_OBJECT('id', 'impression_explain', 'type', 'free_text', 'text', 'Describe your instant reaction in one sentence', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'appearance_impact',
    'title', 'Appearance Impact',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'appearance_score', 'type', 'scale', 'text', 'How much does their appearance impact your impression?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'No Impact', 'maxLabel', 'Major Impact')),
      JSON_OBJECT('id', 'vibe_check', 'type', 'multi_choice', 'text', 'What vibe do they give off?', 'config', JSON_OBJECT('options', JSON_ARRAY('Corporate professional', 'Creative artist', 'Athletic/Outdoorsy', 'Academic/Intellectual', 'Street smart', 'Old soul', 'Young at heart', 'Mysterious'))),
      JSON_OBJECT('id', 'assumed_personality', 'type', 'free_text', 'text', 'Based ONLY on first impression, what personality do you assume they have?', 'config', JSON_OBJECT('minLength', 30, 'maxLength', 1000))
    )
  ),
  JSON_OBJECT(
    'id', 'reality_vs_assumption',
    'title', 'Reality vs. Assumption',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'data_surprise', 'type', 'scale', 'text', 'After seeing their data, how surprised are you vs your first impression?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Exactly As Expected', 'maxLabel', 'Completely Surprising')),
      JSON_OBJECT('id', 'assumption_vs_reality', 'type', 'free_text', 'text', 'What was your assumption and what does the data actually reveal?', 'config', JSON_OBJECT('minLength', 50, 'maxLength', 2000)),
      JSON_OBJECT('id', 'bias_reflection', 'type', 'free_text', 'text', 'What biases might have influenced your first impression?', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 1000))
    )
  ),
  JSON_OBJECT(
    'id', 'overall',
    'title', 'Overall Assessment',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'overall_score', 'type', 'scale', 'text', 'Overall impression score', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Negative', 'maxLabel', 'Very Positive')),
      JSON_OBJECT('id', 'memorable_factor', 'type', 'free_text', 'text', 'What is the single most memorable thing about this person?', 'config', JSON_OBJECT('minLength', 10, 'maxLength', 500)),
      JSON_OBJECT('id', 'impression_advice', 'type', 'free_text', 'text', 'What could they do to make a better first impression?', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 1000))
    )
  ),
  JSON_OBJECT(
    'id', 'free_form',
    'title', 'Free-Form Reflection',
    'required', false,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'open_reflection', 'type', 'free_text', 'text', 'Share any additional thoughts about how this person comes across to the world.', 'config', JSON_OBJECT('minLength', 0, 'maxLength', 5000)),
      JSON_OBJECT('id', 'self_tagged_tone', 'type', 'multi_choice', 'text', 'How would you describe the tone of your review?', 'config', JSON_OBJECT('options', JSON_ARRAY('Encouraging and supportive', 'Honest but kind', 'Direct and unfiltered', 'Critical with constructive intent', 'Tough love')))
    )
  )
));


-- ============================================================================
-- LEADERSHIP Questionnaire
-- ============================================================================
INSERT INTO truth_stream_questionnaires (id, goal_category, version, is_active, sections) VALUES
(UUID(), 'leadership', 1, 1, JSON_ARRAY(
  JSON_OBJECT(
    'id', 'first_impression',
    'title', 'First Impression',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'gut_reaction', 'type', 'scale', 'text', 'What is your gut impression of this person as a leader?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Weak Leader', 'maxLabel', 'Very Strong Leader')),
      JSON_OBJECT('id', 'impression_words', 'type', 'select_words', 'text', 'Select 3-5 words that describe their leadership presence', 'config', JSON_OBJECT('min', 3, 'max', 5, 'words', JSON_ARRAY('Commanding', 'Meek', 'Inspiring', 'Uninspiring', 'Visionary', 'Shortsighted', 'Decisive', 'Hesitant', 'Empathetic', 'Cold', 'Charismatic', 'Bland', 'Strategic', 'Reactive', 'Calm Under Pressure', 'Panicky', 'Trustworthy', 'Untrustworthy', 'Inclusive', 'Exclusive', 'Innovative', 'Conventional', 'Resilient', 'Fragile', 'Authoritative', 'Passive', 'Servant Leader', 'Autocratic', 'Collaborative', 'Domineering'))),
      JSON_OBJECT('id', 'impression_explain', 'type', 'free_text', 'text', 'In one sentence, explain your leadership impression', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'authority_presence',
    'title', 'Authority & Presence',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'authority_score', 'type', 'scale', 'text', 'How naturally authoritative do they seem?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'No Authority', 'maxLabel', 'Natural Authority')),
      JSON_OBJECT('id', 'inspiration_score', 'type', 'scale', 'text', 'How inspiring are they?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Not Inspiring', 'maxLabel', 'Very Inspiring')),
      JSON_OBJECT('id', 'empathy_in_authority', 'type', 'scale', 'text', 'How empathetic do they seem while maintaining authority?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'No Empathy', 'maxLabel', 'Highly Empathetic')),
      JSON_OBJECT('id', 'leadership_style', 'type', 'multi_choice', 'text', 'What leadership style do they project?', 'config', JSON_OBJECT('options', JSON_ARRAY('Servant Leader', 'Visionary', 'Democratic', 'Autocratic', 'Coaching', 'Laissez-faire', 'Transformational')))
    )
  ),
  JSON_OBJECT(
    'id', 'leadership_advice',
    'title', 'Leadership Development',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'leadership_strength', 'type', 'free_text', 'text', 'What is their greatest leadership quality?', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500)),
      JSON_OBJECT('id', 'leadership_weakness', 'type', 'free_text', 'text', 'What leadership quality do they most need to develop?', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500)),
      JSON_OBJECT('id', 'leadership_tips', 'type', 'free_text', 'text', 'Specific tips for becoming a better leader', 'config', JSON_OBJECT('minLength', 50, 'maxLength', 2000))
    )
  ),
  JSON_OBJECT(
    'id', 'overall',
    'title', 'Overall Assessment',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'overall_score', 'type', 'scale', 'text', 'Overall leadership impression', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Weak', 'maxLabel', 'Very Strong')),
      JSON_OBJECT('id', 'would_follow', 'type', 'multi_choice', 'text', 'Would you follow this person?', 'config', JSON_OBJECT('options', JSON_ARRAY('Absolutely', 'In the right context', 'Neutral', 'Probably not', 'Never'))),
      JSON_OBJECT('id', 'follow_reason', 'type', 'free_text', 'text', 'Why or why not?', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'free_form',
    'title', 'Free-Form Reflection',
    'required', false,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'open_reflection', 'type', 'free_text', 'text', 'Share any additional leadership observations or advice.', 'config', JSON_OBJECT('minLength', 0, 'maxLength', 5000)),
      JSON_OBJECT('id', 'self_tagged_tone', 'type', 'multi_choice', 'text', 'How would you describe the tone of your review?', 'config', JSON_OBJECT('options', JSON_ARRAY('Encouraging and supportive', 'Honest but kind', 'Direct and unfiltered', 'Critical with constructive intent', 'Tough love')))
    )
  )
));


-- ============================================================================
-- COMMUNICATION Questionnaire
-- ============================================================================
INSERT INTO truth_stream_questionnaires (id, goal_category, version, is_active, sections) VALUES
(UUID(), 'communication', 1, 1, JSON_ARRAY(
  JSON_OBJECT(
    'id', 'first_impression',
    'title', 'First Impression',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'gut_reaction', 'type', 'scale', 'text', 'What is your gut impression of this person as a communicator?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Poor Communicator', 'maxLabel', 'Excellent Communicator')),
      JSON_OBJECT('id', 'impression_words', 'type', 'select_words', 'text', 'Select 3-5 words describing their communication presence', 'config', JSON_OBJECT('min', 3, 'max', 5, 'words', JSON_ARRAY('Articulate', 'Inarticulate', 'Clear', 'Confusing', 'Persuasive', 'Unconvincing', 'Engaging', 'Monotonous', 'Empathetic', 'Tone-Deaf', 'Concise', 'Long-Winded', 'Witty', 'Dry', 'Warm', 'Clinical', 'Direct', 'Indirect', 'Confident', 'Hesitant', 'Authentic', 'Rehearsed', 'Passionate', 'Dispassionate', 'Respectful', 'Dismissive', 'Open-Minded', 'Closed-Minded', 'Diplomatic', 'Confrontational'))),
      JSON_OBJECT('id', 'impression_explain', 'type', 'free_text', 'text', 'In one sentence, explain your communication impression', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'communication_skills',
    'title', 'Communication Skills Assessment',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'clarity_score', 'type', 'scale', 'text', 'How clear is their communication?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Unclear', 'maxLabel', 'Crystal Clear')),
      JSON_OBJECT('id', 'listening_impression', 'type', 'scale', 'text', 'How good of a listener do they seem?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Poor Listener', 'maxLabel', 'Excellent Listener')),
      JSON_OBJECT('id', 'persuasiveness', 'type', 'scale', 'text', 'How persuasive do they come across?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Not Persuasive', 'maxLabel', 'Very Persuasive')),
      JSON_OBJECT('id', 'emotional_intelligence', 'type', 'scale', 'text', 'How emotionally intelligent is their communication?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Low EQ', 'maxLabel', 'High EQ')),
      JSON_OBJECT('id', 'communication_advice', 'type', 'free_text', 'text', 'What specific advice would you give to improve their communication?', 'config', JSON_OBJECT('minLength', 50, 'maxLength', 2000))
    )
  ),
  JSON_OBJECT(
    'id', 'overall',
    'title', 'Overall Assessment',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'overall_score', 'type', 'scale', 'text', 'Overall communication impression', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Poor', 'maxLabel', 'Excellent')),
      JSON_OBJECT('id', 'communication_strength', 'type', 'free_text', 'text', 'Their biggest communication strength', 'config', JSON_OBJECT('minLength', 10, 'maxLength', 500)),
      JSON_OBJECT('id', 'communication_weakness', 'type', 'free_text', 'text', 'Their biggest communication weakness', 'config', JSON_OBJECT('minLength', 10, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'free_form',
    'title', 'Free-Form Reflection',
    'required', false,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'open_reflection', 'type', 'free_text', 'text', 'Share any additional communication observations or tips.', 'config', JSON_OBJECT('minLength', 0, 'maxLength', 5000)),
      JSON_OBJECT('id', 'self_tagged_tone', 'type', 'multi_choice', 'text', 'How would you describe the tone of your review?', 'config', JSON_OBJECT('options', JSON_ARRAY('Encouraging and supportive', 'Honest but kind', 'Direct and unfiltered', 'Critical with constructive intent', 'Tough love')))
    )
  )
));


-- ============================================================================
-- AUTHENTICITY Questionnaire
-- ============================================================================
INSERT INTO truth_stream_questionnaires (id, goal_category, version, is_active, sections) VALUES
(UUID(), 'authenticity', 1, 1, JSON_ARRAY(
  JSON_OBJECT(
    'id', 'first_impression',
    'title', 'First Impression',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'gut_reaction', 'type', 'scale', 'text', 'How authentic does this person seem at first glance?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Fake', 'maxLabel', 'Very Authentic')),
      JSON_OBJECT('id', 'impression_words', 'type', 'select_words', 'text', 'Select 3-5 words about their authenticity', 'config', JSON_OBJECT('min', 3, 'max', 5, 'words', JSON_ARRAY('Genuine', 'Fake', 'Transparent', 'Hidden', 'Consistent', 'Contradictory', 'Vulnerable', 'Guarded', 'Real', 'Performative', 'Honest', 'Deceptive', 'Grounded', 'Lost', 'Self-Accepting', 'Self-Denying', 'Unapologetic', 'People-Pleasing', 'True to Self', 'Chameleon', 'Confident', 'Insecure', 'Natural', 'Rehearsed', 'Comfortable', 'Uncomfortable', 'Whole', 'Fragmented', 'Present', 'Distracted'))),
      JSON_OBJECT('id', 'impression_explain', 'type', 'free_text', 'text', 'In one sentence, describe their authenticity level', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'genuineness_assessment',
    'title', 'Genuineness Assessment',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'genuineness_score', 'type', 'scale', 'text', 'How genuine do they seem overall?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Not Genuine', 'maxLabel', 'Very Genuine')),
      JSON_OBJECT('id', 'mask_detection', 'type', 'multi_choice', 'text', 'Do you sense they are wearing a social mask?', 'config', JSON_OBJECT('options', JSON_ARRAY('No mask at all - completely open', 'Slight filter but mostly real', 'Moderate persona - hard to tell', 'Significant mask - something hidden', 'Complete facade'))),
      JSON_OBJECT('id', 'data_vibe_consistency', 'type', 'scale', 'text', 'How consistent is their data profile with the vibe they give off?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Totally Inconsistent', 'maxLabel', 'Perfectly Consistent')),
      JSON_OBJECT('id', 'authenticity_advice', 'type', 'free_text', 'text', 'What advice would you give them about being more authentic?', 'config', JSON_OBJECT('minLength', 50, 'maxLength', 2000))
    )
  ),
  JSON_OBJECT(
    'id', 'overall',
    'title', 'Overall Assessment',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'overall_score', 'type', 'scale', 'text', 'Overall authenticity impression', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Inauthentic', 'maxLabel', 'Very Authentic')),
      JSON_OBJECT('id', 'would_trust', 'type', 'multi_choice', 'text', 'Would you trust this person with something personal?', 'config', JSON_OBJECT('options', JSON_ARRAY('Absolutely', 'Probably yes', 'Neutral', 'Probably not', 'Never'))),
      JSON_OBJECT('id', 'trust_reason', 'type', 'free_text', 'text', 'Why or why not?', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'free_form',
    'title', 'Free-Form Reflection',
    'required', false,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'open_reflection', 'type', 'free_text', 'text', 'Share any thoughts on their authenticity. Be real — that is what they asked for.', 'config', JSON_OBJECT('minLength', 0, 'maxLength', 5000)),
      JSON_OBJECT('id', 'self_tagged_tone', 'type', 'multi_choice', 'text', 'How would you describe the tone of your review?', 'config', JSON_OBJECT('options', JSON_ARRAY('Encouraging and supportive', 'Honest but kind', 'Direct and unfiltered', 'Critical with constructive intent', 'Tough love')))
    )
  )
));


-- ============================================================================
-- CONFIDENCE Questionnaire
-- ============================================================================
INSERT INTO truth_stream_questionnaires (id, goal_category, version, is_active, sections) VALUES
(UUID(), 'confidence', 1, 1, JSON_ARRAY(
  JSON_OBJECT(
    'id', 'first_impression',
    'title', 'First Impression',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'gut_reaction', 'type', 'scale', 'text', 'How confident does this person appear?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Insecure', 'maxLabel', 'Very Confident')),
      JSON_OBJECT('id', 'impression_words', 'type', 'select_words', 'text', 'Select 3-5 words about their confidence', 'config', JSON_OBJECT('min', 3, 'max', 5, 'words', JSON_ARRAY('Confident', 'Insecure', 'Poised', 'Nervous', 'Grounded', 'Shaky', 'Bold', 'Timid', 'Self-Assured', 'Self-Doubting', 'Composed', 'Flustered', 'Powerful', 'Powerless', 'Comfortable', 'Uncomfortable', 'Natural', 'Forced', 'Overconfident', 'Humble', 'Arrogant', 'Meek', 'Fearless', 'Anxious', 'Stable', 'Unstable', 'Centered', 'Scattered', 'Relaxed', 'Tense'))),
      JSON_OBJECT('id', 'impression_explain', 'type', 'free_text', 'text', 'In one sentence, describe their confidence level', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'confidence_assessment',
    'title', 'Confidence Deep Dive',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'self_assurance', 'type', 'scale', 'text', 'How self-assured do they come across?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Not At All', 'maxLabel', 'Extremely')),
      JSON_OBJECT('id', 'overconfidence_check', 'type', 'scale', 'text', 'Is there a risk of overconfidence or arrogance?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Not At All', 'maxLabel', 'Definitely')),
      JSON_OBJECT('id', 'nervous_energy', 'type', 'multi_choice', 'text', 'Do you detect any nervous energy?', 'config', JSON_OBJECT('options', JSON_ARRAY('None at all', 'Slight but manageable', 'Noticeable', 'Significant', 'Overwhelming'))),
      JSON_OBJECT('id', 'groundedness', 'type', 'scale', 'text', 'How grounded and centered do they seem?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Ungrounded', 'maxLabel', 'Very Grounded')),
      JSON_OBJECT('id', 'confidence_advice', 'type', 'free_text', 'text', 'What specific advice would you give about their confidence?', 'config', JSON_OBJECT('minLength', 50, 'maxLength', 2000))
    )
  ),
  JSON_OBJECT(
    'id', 'overall',
    'title', 'Overall Assessment',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'overall_score', 'type', 'scale', 'text', 'Overall confidence impression', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Low', 'maxLabel', 'Very High')),
      JSON_OBJECT('id', 'confidence_type', 'type', 'multi_choice', 'text', 'What type of confidence do they project?', 'config', JSON_OBJECT('options', JSON_ARRAY('Quiet confidence', 'Loud confidence', 'Earned confidence', 'Fake-it-til-you-make-it', 'Fragile confidence', 'Unshakeable confidence'))),
      JSON_OBJECT('id', 'confidence_source', 'type', 'free_text', 'text', 'Where do you think their confidence (or lack thereof) comes from?', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'free_form',
    'title', 'Free-Form Reflection',
    'required', false,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'open_reflection', 'type', 'free_text', 'text', 'Share any additional thoughts on their confidence and self-image.', 'config', JSON_OBJECT('minLength', 0, 'maxLength', 5000)),
      JSON_OBJECT('id', 'self_tagged_tone', 'type', 'multi_choice', 'text', 'How would you describe the tone of your review?', 'config', JSON_OBJECT('options', JSON_ARRAY('Encouraging and supportive', 'Honest but kind', 'Direct and unfiltered', 'Critical with constructive intent', 'Tough love')))
    )
  )
));


-- ============================================================================
-- CUSTOM Questionnaire (includes ALL standard sections + placeholder for custom)
-- ============================================================================
INSERT INTO truth_stream_questionnaires (id, goal_category, version, is_active, sections) VALUES
(UUID(), 'custom', 1, 1, JSON_ARRAY(
  JSON_OBJECT(
    'id', 'first_impression',
    'title', 'First Impression',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'gut_reaction', 'type', 'scale', 'text', 'What is your gut first impression of this person?', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Negative', 'maxLabel', 'Very Positive')),
      JSON_OBJECT('id', 'impression_words', 'type', 'select_words', 'text', 'Select 3-5 words that describe your first impression', 'config', JSON_OBJECT('min', 3, 'max', 5, 'words', JSON_ARRAY('Warm', 'Cold', 'Genuine', 'Guarded', 'Confident', 'Insecure', 'Creative', 'Analytical', 'Empathetic', 'Distant', 'Energetic', 'Calm', 'Ambitious', 'Laid-back', 'Mysterious', 'Open', 'Intense', 'Gentle', 'Strong', 'Vulnerable', 'Wise', 'Naive', 'Charismatic', 'Reserved', 'Trustworthy', 'Suspicious', 'Inspiring', 'Intimidating', 'Approachable', 'Aloof'))),
      JSON_OBJECT('id', 'impression_explain', 'type', 'free_text', 'text', 'In one sentence, explain your first impression', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'custom_focus',
    'title', 'Custom Focus Area',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'custom_rating', 'type', 'scale', 'text', 'Based on what this person is seeking feedback on, rate them', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Needs Major Improvement', 'maxLabel', 'Excellent')),
      JSON_OBJECT('id', 'custom_observations', 'type', 'free_text', 'text', 'What observations do you have related to their stated goal?', 'config', JSON_OBJECT('minLength', 50, 'maxLength', 2000)),
      JSON_OBJECT('id', 'custom_advice', 'type', 'free_text', 'text', 'What specific advice would you give related to their goal?', 'config', JSON_OBJECT('minLength', 50, 'maxLength', 2000))
    )
  ),
  JSON_OBJECT(
    'id', 'overall',
    'title', 'Overall Assessment',
    'required', true,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'overall_score', 'type', 'scale', 'text', 'Overall impression score', 'config', JSON_OBJECT('min', 1, 'max', 10, 'minLabel', 'Very Negative', 'maxLabel', 'Very Positive')),
      JSON_OBJECT('id', 'would_want_in_group', 'type', 'multi_choice', 'text', 'Would you want this person in your circle?', 'config', JSON_OBJECT('options', JSON_ARRAY('Absolutely yes', 'Probably yes', 'Neutral', 'Probably not', 'Definitely not'))),
      JSON_OBJECT('id', 'group_reason', 'type', 'free_text', 'text', 'Why or why not?', 'config', JSON_OBJECT('minLength', 20, 'maxLength', 500))
    )
  ),
  JSON_OBJECT(
    'id', 'free_form',
    'title', 'Free-Form Reflection',
    'required', false,
    'questions', JSON_ARRAY(
      JSON_OBJECT('id', 'open_reflection', 'type', 'free_text', 'text', 'Share any additional thoughts, honest opinions, or advice. The mirror reflects all truth.', 'config', JSON_OBJECT('minLength', 0, 'maxLength', 5000)),
      JSON_OBJECT('id', 'self_tagged_tone', 'type', 'multi_choice', 'text', 'How would you describe the tone of your review?', 'config', JSON_OBJECT('options', JSON_ARRAY('Encouraging and supportive', 'Honest but kind', 'Direct and unfiltered', 'Critical with constructive intent', 'Tough love')))
    )
  )
));


-- ============================================================================
-- RESTORE SETTINGS
-- ============================================================================
SET SQL_MODE=@OLD_SQL_MODE;
SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;
SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS;

-- ============================================================================
-- MIGRATION VERIFICATION
-- ============================================================================
-- Run these queries after migration to verify:
--
-- SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES
-- WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'truth_stream_%';
--
-- SELECT id, goal_category, version, is_active FROM truth_stream_questionnaires;
--
-- SHOW TRIGGERS LIKE 'users';
-- ============================================================================
