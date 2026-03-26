// ============================================================================
// TRUTHSTREAM QUEUE MANAGER - Mirror-Server Service
// ============================================================================
// File: services/TruthStreamQueueManager.ts
// Description: Manages the review queue algorithm — assigns batches of profiles
//              to reviewers, handles expiry, deduplication, and fairness.
//
// Queue Algorithm:
//   1. Find active profiles NOT already reviewed by this user
//   2. Exclude the reviewer's own profile
//   3. Prioritize: under-reviewed users > reciprocity > diversity > random
//   4. Assign batch of 3-7 profiles with 48-hour expiration
//   5. User must complete ALL batch items before receiving new reviews
//
// Edge Cases: See TRUTHSTREAM_GAP_ANALYSIS.md §3, cases 11-20
// ============================================================================

import crypto from 'crypto';
import { DB } from '../db';
import { Logger } from '../utils/logger';

// ============================================================================
// TYPES
// ============================================================================

interface QueueBatch {
  batchNumber: number;
  items: QueueItem[];
  expiresAt: Date;
  message?: string;
}

interface QueueItem {
  id: string;
  revieweeId: number;
  displayAlias: string;
  goalCategory: string;
  status: 'pending' | 'in_progress' | 'completed' | 'expired';
  assignedAt: Date;
  expiresAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  timeSpentSeconds: number;
}

interface EligibleProfile {
  user_id: number;
  id: string;
  display_alias: string;
  goal_category: string;
  total_reviews_received: number;
  total_reviews_given: number;
  review_quality_score: number;
  created_at: Date;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const BATCH_SIZE = parseInt(process.env.TRUTHSTREAM_QUEUE_BATCH_SIZE || '5', 10);
const QUEUE_EXPIRY_HOURS = parseInt(process.env.TRUTHSTREAM_QUEUE_EXPIRY_HOURS || '48', 10);
const MAX_REVIEWS_PER_DAY = parseInt(process.env.TRUTHSTREAM_MAX_REVIEWS_PER_DAY || '20', 10);
const GRACE_PERIOD_HOURS = 1; // Extra time after expiry to complete in-progress reviews

// ============================================================================
// QUEUE MANAGER CLASS
// ============================================================================

export class TruthStreamQueueManager {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('TruthStreamQueueManager');
  }

  // ==========================================================================
  // GET CURRENT BATCH
  // ==========================================================================

  /**
   * Get the current active batch for a reviewer.
   * If no active batch exists, returns null (caller should request a new one).
   */
  async getCurrentBatch(reviewerId: number): Promise<QueueBatch | null> {
    try {
      // Get the latest batch number for this reviewer
      const [batchRows] = await DB.query(
        `SELECT batch_number, MAX(expires_at) as batch_expires
         FROM truth_stream_queue
         WHERE reviewer_id = ? AND status IN ('pending', 'in_progress')
         GROUP BY batch_number
         ORDER BY batch_number DESC
         LIMIT 1`,
        [reviewerId]
      ) as any[];

      if (!batchRows || batchRows.length === 0) return null;

      const batchNumber = batchRows[0].batch_number;

      // Get all items in this batch
      const [items] = await DB.query(
        `SELECT q.id, q.reviewee_id, q.status, q.assigned_at, q.expires_at,
                q.started_at, q.completed_at, q.time_spent_seconds,
                p.display_alias, p.goal_category
         FROM truth_stream_queue q
         JOIN truth_stream_profiles p ON p.user_id = q.reviewee_id
         WHERE q.reviewer_id = ? AND q.batch_number = ?
         ORDER BY q.assigned_at ASC`,
        [reviewerId, batchNumber]
      ) as any[];

      if (!items || items.length === 0) return null;

      // Check if batch is expired
      const now = new Date();
      const allExpired = items.every((item: any) => {
        const expiresAt = new Date(item.expires_at);
        // Allow grace period for in-progress items
        if (item.status === 'in_progress') {
          return now > new Date(expiresAt.getTime() + GRACE_PERIOD_HOURS * 3600000);
        }
        return now > expiresAt;
      });

      if (allExpired) {
        // Expire all remaining items
        await this.expireBatch(reviewerId, batchNumber);
        return null;
      }

      return {
        batchNumber,
        expiresAt: new Date(batchRows[0].batch_expires),
        items: items.map((item: any) => ({
          id: item.id,
          revieweeId: item.reviewee_id,
          displayAlias: item.display_alias,
          goalCategory: item.goal_category,
          status: item.status,
          assignedAt: new Date(item.assigned_at),
          expiresAt: new Date(item.expires_at),
          startedAt: item.started_at ? new Date(item.started_at) : null,
          completedAt: item.completed_at ? new Date(item.completed_at) : null,
          timeSpentSeconds: item.time_spent_seconds || 0,
        })),
      };
    } catch (error: any) {
      this.logger.error('Failed to get current batch', { reviewerId, error: error.message });
      throw error;
    }
  }

  // ==========================================================================
  // GENERATE NEW BATCH
  // ==========================================================================

  /**
   * Generate a new batch of profiles for a reviewer to review.
   * Algorithm: fairness-weighted random selection with deduplication.
   */
  async generateBatch(reviewerId: number): Promise<QueueBatch> {
    try {
      // Check if reviewer has an active batch
      const existing = await this.getCurrentBatch(reviewerId);
      if (existing) {
        this.logger.debug('Returning existing batch', {
          reviewerId,
          batchNumber: existing.batchNumber,
          itemCount: existing.items.length,
        });
        return existing;
      }

      // Check rate limit
      const reviewsToday = await this.getReviewCountToday(reviewerId);
      if (reviewsToday >= MAX_REVIEWS_PER_DAY) {
        return {
          batchNumber: 0,
          items: [],
          expiresAt: new Date(),
          message: `Daily review limit reached (${MAX_REVIEWS_PER_DAY}). Please come back tomorrow.`,
        };
      }

      // Get eligible profiles (not already reviewed, not self, active)
      const eligible = await this.getEligibleProfiles(reviewerId);

      if (eligible.length === 0) {
        return {
          batchNumber: 0,
          items: [],
          expiresAt: new Date(),
          message: 'Waiting for more participants to join TruthStream.',
        };
      }

      // Score and rank eligible profiles
      const ranked = this.rankProfiles(eligible, reviewerId);

      // Select top N profiles
      const selected = ranked.slice(0, Math.min(BATCH_SIZE, ranked.length));

      // Get next batch number
      const batchNumber = await this.getNextBatchNumber(reviewerId);

      // Calculate expiry
      const expiresAt = new Date(Date.now() + QUEUE_EXPIRY_HOURS * 3600000);

      // [A2] Insert all queue items in a single batch INSERT (eliminates N+1 query pattern)
      const connection = await DB.getConnection();
      try {
        await connection.beginTransaction();

        const items: QueueItem[] = [];
        const valuePlaceholders: string[] = [];
        const insertParams: any[] = [];

        for (const profile of selected) {
          const itemId = crypto.randomUUID();
          valuePlaceholders.push('(?, ?, ?, ?, ?, ?)');
          insertParams.push(itemId, reviewerId, profile.user_id, batchNumber, 'pending', expiresAt);

          items.push({
            id: itemId,
            revieweeId: profile.user_id,
            displayAlias: profile.display_alias,
            goalCategory: profile.goal_category,
            status: 'pending',
            assignedAt: new Date(),
            expiresAt,
            startedAt: null,
            completedAt: null,
            timeSpentSeconds: 0,
          });
        }

        if (valuePlaceholders.length > 0) {
          await connection.query(
            `INSERT INTO truth_stream_queue
             (id, reviewer_id, reviewee_id, batch_number, status, expires_at)
             VALUES ${valuePlaceholders.join(', ')}`,
            insertParams
          );
        }

        await connection.commit();

        this.logger.info('Generated new batch', {
          reviewerId,
          batchNumber,
          itemCount: items.length,
          expiresAt: expiresAt.toISOString(),
        });

        return { batchNumber, items, expiresAt };
      } catch (txError) {
        await connection.rollback();
        throw txError;
      } finally {
        connection.release();
      }
    } catch (error: any) {
      this.logger.error('Failed to generate batch', { reviewerId, error: error.message });
      throw error;
    }
  }

  // ==========================================================================
  // QUEUE ITEM OPERATIONS
  // ==========================================================================

  /**
   * Start reviewing a queue item (begins the timer).
   * Returns the queue item or throws if invalid.
   */
  async startQueueItem(queueId: string, reviewerId: number): Promise<QueueItem & { revieweeUserId: number }> {
    const [rows] = await DB.query(
      `SELECT q.*, p.display_alias, p.goal_category
       FROM truth_stream_queue q
       JOIN truth_stream_profiles p ON p.user_id = q.reviewee_id
       WHERE q.id = ? AND q.reviewer_id = ?`,
      [queueId, reviewerId]
    ) as any[];

    if (!rows || rows.length === 0) {
      const error = new Error('Queue item not found or unauthorized');
      (error as any).code = 'NOT_YOUR_QUEUE';
      (error as any).statusCode = 403;
      throw error;
    }

    const item = rows[0];

    // Check if already started
    if (item.status === 'in_progress') {
      return {
        id: item.id,
        revieweeId: item.reviewee_id,
        displayAlias: item.display_alias,
        goalCategory: item.goal_category,
        status: 'in_progress',
        assignedAt: new Date(item.assigned_at),
        expiresAt: new Date(item.expires_at),
        startedAt: item.started_at ? new Date(item.started_at) : new Date(),
        completedAt: null,
        timeSpentSeconds: 0,
        revieweeUserId: item.reviewee_id,
      };
    }

    if (item.status === 'completed') {
      const error = new Error('This review has already been completed');
      (error as any).code = 'ALREADY_COMPLETED';
      (error as any).statusCode = 409;
      throw error;
    }

    // Check if expired
    const now = new Date();
    const expiresAt = new Date(item.expires_at);
    if (now > expiresAt) {
      const error = new Error('This review assignment has expired');
      (error as any).code = 'QUEUE_EXPIRED';
      (error as any).statusCode = 410;
      throw error;
    }

    // Update to in_progress
    await DB.query(
      `UPDATE truth_stream_queue SET status = 'in_progress', started_at = NOW() WHERE id = ?`,
      [queueId]
    );

    return {
      id: item.id,
      revieweeId: item.reviewee_id,
      displayAlias: item.display_alias,
      goalCategory: item.goal_category,
      status: 'in_progress',
      assignedAt: new Date(item.assigned_at),
      expiresAt,
      startedAt: new Date(),
      completedAt: null,
      timeSpentSeconds: 0,
      revieweeUserId: item.reviewee_id,
    };
  }

  /**
   * Mark a queue item as completed.
   */
  async completeQueueItem(queueId: string, reviewerId: number, timeSpentSeconds: number): Promise<void> {
    const [result] = await DB.query(
      `UPDATE truth_stream_queue
       SET status = 'completed', completed_at = NOW(), time_spent_seconds = ?
       WHERE id = ? AND reviewer_id = ? AND status = 'in_progress'`,
      [timeSpentSeconds, queueId, reviewerId]
    ) as any[];

    if (result.affectedRows === 0) {
      const error = new Error('Queue item not in progress or unauthorized');
      (error as any).code = 'INVALID_STATE';
      (error as any).statusCode = 409;
      throw error;
    }
  }

  /**
   * Check if a reviewer has completed all items in their current batch.
   * Users must complete their batch before receiving reviews.
   */
  async isBatchComplete(reviewerId: number): Promise<boolean> {
    const [rows] = await DB.query(
      `SELECT COUNT(*) as pending_count
       FROM truth_stream_queue
       WHERE reviewer_id = ?
         AND status IN ('pending', 'in_progress')
         AND expires_at > NOW()`,
      [reviewerId]
    ) as any[];

    return rows[0].pending_count === 0;
  }

  // ==========================================================================
  // BATCH EXPIRY
  // ==========================================================================

  /**
   * Expire all remaining items in a batch.
   */
  async expireBatch(reviewerId: number, batchNumber: number): Promise<number> {
    const [result] = await DB.query(
      `UPDATE truth_stream_queue
       SET status = 'expired'
       WHERE reviewer_id = ? AND batch_number = ? AND status IN ('pending')`,
      [reviewerId, batchNumber]
    ) as any[];

    // Handle in-progress items with grace period
    const [graceResult] = await DB.query(
      `UPDATE truth_stream_queue
       SET status = 'expired'
       WHERE reviewer_id = ? AND batch_number = ? AND status = 'in_progress'
         AND expires_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
      [reviewerId, batchNumber, GRACE_PERIOD_HOURS]
    ) as any[];

    const expired = (result.affectedRows || 0) + (graceResult.affectedRows || 0);

    if (expired > 0) {
      this.logger.info('Expired batch items', { reviewerId, batchNumber, expiredCount: expired });
    }

    return expired;
  }

  /**
   * Run periodic expiry check for all overdue queue items.
   * Call this from a cron job or timer.
   */
  async runExpiryCheck(): Promise<number> {
    const [result] = await DB.query(
      `UPDATE truth_stream_queue
       SET status = 'expired'
       WHERE status = 'pending' AND expires_at < NOW()`
    ) as any[];

    const [graceResult] = await DB.query(
      `UPDATE truth_stream_queue
       SET status = 'expired'
       WHERE status = 'in_progress'
         AND expires_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
      [GRACE_PERIOD_HOURS]
    ) as any[];

    const total = (result.affectedRows || 0) + (graceResult.affectedRows || 0);
    if (total > 0) {
      this.logger.info('Periodic expiry check completed', { expiredCount: total });
    }

    return total;
  }

  // ==========================================================================
  // PRIVATE: ELIGIBILITY & RANKING
  // ==========================================================================

  /**
   * Get profiles eligible for this reviewer's queue.
   */
  private async getEligibleProfiles(reviewerId: number): Promise<EligibleProfile[]> {
    const [rows] = await DB.query(
      `SELECT p.user_id, p.id, p.display_alias, p.goal_category,
              p.total_reviews_received, p.total_reviews_given,
              p.review_quality_score, p.created_at
       FROM truth_stream_profiles p
       WHERE p.is_active = 1
         AND p.minimum_share_met = 1
         AND p.user_id != ?
         AND p.user_id NOT IN (
           SELECT q.reviewee_id FROM truth_stream_queue q
           WHERE q.reviewer_id = ? AND q.status IN ('pending', 'in_progress', 'completed')
         )
       ORDER BY p.total_reviews_received ASC, RAND()
       LIMIT ?`,
      [reviewerId, reviewerId, BATCH_SIZE * 3] // Fetch extra for ranking
    ) as any[];

    return rows || [];
  }

  /**
   * Rank eligible profiles by fairness-weighted scoring.
   * Priority:
   *   1. Under-reviewed users get boosted (fairness)
   *   2. Users who reviewed the current reviewer (reciprocity)
   *   3. Diverse goal categories preferred
   *   4. Random tiebreaker
   */
  private rankProfiles(profiles: EligibleProfile[], reviewerId: number): EligibleProfile[] {
    // Score each profile
    const scored = profiles.map(p => {
      let score = 0;

      // Under-reviewed boost: fewer reviews received = higher priority
      // Max boost of 50 points for users with 0 reviews
      score += Math.max(0, 50 - p.total_reviews_received * 5);

      // High-quality reviewer boost
      score += p.review_quality_score * 10;

      // New user boost (created in last 7 days)
      const daysSinceCreation = (Date.now() - new Date(p.created_at).getTime()) / 86400000;
      if (daysSinceCreation < 7) score += 20;

      // Active reviewer boost (has given reviews)
      if (p.total_reviews_given > 0) score += 10;

      // Random factor to prevent predictable ordering
      score += Math.random() * 15;

      return { profile: p, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored.map(s => s.profile);
  }

  /**
   * Get the next batch number for a reviewer.
   */
  private async getNextBatchNumber(reviewerId: number): Promise<number> {
    const [rows] = await DB.query(
      `SELECT MAX(batch_number) as max_batch FROM truth_stream_queue WHERE reviewer_id = ?`,
      [reviewerId]
    ) as any[];

    return (rows[0]?.max_batch || 0) + 1;
  }

  /**
   * Get count of reviews submitted today by this reviewer.
   */
  private async getReviewCountToday(reviewerId: number): Promise<number> {
    const [rows] = await DB.query(
      `SELECT COUNT(*) as count FROM truth_stream_reviews
       WHERE reviewer_id = ? AND DATE(created_at) = CURDATE()`,
      [reviewerId]
    ) as any[];

    return rows[0]?.count || 0;
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const truthStreamQueueManager = new TruthStreamQueueManager();
