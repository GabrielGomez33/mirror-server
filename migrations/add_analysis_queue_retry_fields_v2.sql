-- ============================================================================
-- Migration: Add Retry Fields to mirror_group_analysis_queue
-- ============================================================================
-- Compatible with MySQL 5.7+ (doesn't use IF NOT EXISTS for ALTER TABLE)
-- ============================================================================

USE mirror;

-- Add retry_count column (safe to re-run)
SET @query = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE mirror_group_analysis_queue ADD COLUMN retry_count INT DEFAULT 0 COMMENT "Number of retry attempts for this job"',
        'SELECT "retry_count already exists" AS status'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'mirror'
      AND TABLE_NAME = 'mirror_group_analysis_queue'
      AND COLUMN_NAME = 'retry_count'
);
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add next_retry_at column
SET @query = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE mirror_group_analysis_queue ADD COLUMN next_retry_at DATETIME DEFAULT NULL COMMENT "Scheduled time for next retry attempt"',
        'SELECT "next_retry_at already exists" AS status'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'mirror'
      AND TABLE_NAME = 'mirror_group_analysis_queue'
      AND COLUMN_NAME = 'next_retry_at'
);
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add last_error column
SET @query = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE mirror_group_analysis_queue ADD COLUMN last_error TEXT DEFAULT NULL COMMENT "Error message from last failed attempt"',
        'SELECT "last_error already exists" AS status'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'mirror'
      AND TABLE_NAME = 'mirror_group_analysis_queue'
      AND COLUMN_NAME = 'last_error'
);
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add started_at column
SET @query = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE mirror_group_analysis_queue ADD COLUMN started_at DATETIME DEFAULT NULL COMMENT "Timestamp when job processing started"',
        'SELECT "started_at already exists" AS status'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'mirror'
      AND TABLE_NAME = 'mirror_group_analysis_queue'
      AND COLUMN_NAME = 'started_at'
);
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add result_data column
SET @query = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE mirror_group_analysis_queue ADD COLUMN result_data JSON DEFAULT NULL COMMENT "Summary of analysis results"',
        'SELECT "result_data already exists" AS status'
    )
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'mirror'
      AND TABLE_NAME = 'mirror_group_analysis_queue'
      AND COLUMN_NAME = 'result_data'
);
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Create index for efficient retry queries (safe to re-run)
SET @query = (
    SELECT IF(
        COUNT(*) = 0,
        'CREATE INDEX idx_status_retry ON mirror_group_analysis_queue(status, next_retry_at)',
        'SELECT "idx_status_retry already exists" AS status'
    )
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = 'mirror'
      AND TABLE_NAME = 'mirror_group_analysis_queue'
      AND INDEX_NAME = 'idx_status_retry'
);
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Create index for priority-based processing (safe to re-run)
SET @query = (
    SELECT IF(
        COUNT(*) = 0,
        'CREATE INDEX idx_priority_created ON mirror_group_analysis_queue(priority DESC, created_at ASC)',
        'SELECT "idx_priority_created already exists" AS status'
    )
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = 'mirror'
      AND TABLE_NAME = 'mirror_group_analysis_queue'
      AND INDEX_NAME = 'idx_priority_created'
);
PREPARE stmt FROM @query;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

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

SELECT '✅ Migration completed successfully!' AS status;
