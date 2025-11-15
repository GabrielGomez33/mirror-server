-- ============================================================================
-- Migration: Add Retry Fields to mirror_group_analysis_queue
-- ============================================================================
-- Adds fields needed for Phase 3 worker retry logic and metadata tracking
-- Safe to run multiple times (uses IF NOT EXISTS where possible)
-- ============================================================================

USE mirror;

-- Add retry_count column
ALTER TABLE mirror_group_analysis_queue
ADD COLUMN IF NOT EXISTS retry_count INT DEFAULT 0
COMMENT 'Number of retry attempts for this job';

-- Add next_retry_at column
ALTER TABLE mirror_group_analysis_queue
ADD COLUMN IF NOT EXISTS next_retry_at DATETIME DEFAULT NULL
COMMENT 'Scheduled time for next retry attempt';

-- Add last_error column
ALTER TABLE mirror_group_analysis_queue
ADD COLUMN IF NOT EXISTS last_error TEXT DEFAULT NULL
COMMENT 'Error message from last failed attempt';

-- Add started_at column
ALTER TABLE mirror_group_analysis_queue
ADD COLUMN IF NOT EXISTS started_at DATETIME DEFAULT NULL
COMMENT 'Timestamp when job processing started';

-- Add result_data column
ALTER TABLE mirror_group_analysis_queue
ADD COLUMN IF NOT EXISTS result_data JSON DEFAULT NULL
COMMENT 'Summary of analysis results (analysisId, confidence, etc)';

-- Create index for efficient retry queries
CREATE INDEX IF NOT EXISTS idx_status_retry
ON mirror_group_analysis_queue(status, next_retry_at);

-- Create index for priority-based processing
CREATE INDEX IF NOT EXISTS idx_priority_created
ON mirror_group_analysis_queue(priority DESC, created_at ASC);

-- Verify columns were added
SELECT
    COLUMN_NAME,
    COLUMN_TYPE,
    IS_NULLABLE,
    COLUMN_DEFAULT,
    COLUMN_COMMENT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'mirror'
  AND TABLE_NAME = 'mirror_group_analysis_queue'
  AND COLUMN_NAME IN ('retry_count', 'next_retry_at', 'last_error', 'started_at', 'result_data')
ORDER BY ORDINAL_POSITION;

-- Show table structure
SHOW CREATE TABLE mirror_group_analysis_queue;
