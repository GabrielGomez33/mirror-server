// ============================================================================
// TRUTHSTREAM QUEUE PROCESSOR - Separate Worker Process
// ============================================================================
// File: workers/TruthStreamQueueProcessor.ts
// Description: Background worker that processes TruthStream async jobs:
//   1. classify_review — Call Dina to classify review tone/hostility
//   2. generate_analysis — Call Dina to generate Truth Mirror Reports
//
// ARCHITECTURE: Runs as a SEPARATE PROCESS (like AnalysisQueueProcessor)
// Start: npx ts-node workers/TruthStreamQueueProcessor.ts
// Or via PM2: pm2 start workers/TruthStreamQueueProcessor.ts --name ts-processor
//
// Pattern follows: DinaChatQueueProcessor.ts (enterprise patterns)
// All Dina calls route through mirror module's DUMP-compliant endpoints via HTTP
//
// FIXES APPLIED:
//   1. Error propagation: "Error: undefined" now shows actual error messages
//   2. processClassification: builds reviewText from structured responses when empty
//   3. handleJobFailure: extracts error message safely from any error type
//   4. callDinaEndpoint: preserves error chain with descriptive messages
//   5. isRetryableError: improved 5xx detection to avoid false positives
//   6. Added request timeout alignment with dina-server's extended LLM timeouts
//
// Enterprise features (matching DinaChatQueueProcessor):
//   - 3-state circuit breaker (closed/open/half-open) with env var config
//   - Client-side rate limiter (sliding window, per-user)
//   - Input sanitizer (null bytes, whitespace normalization, length caps)
//   - Retry with exponential backoff + jitter (thundering herd prevention)
//   - ProcessorStats + periodic stats logging (observability)
//   - isShuttingDown flag (defensive shutdown)
// ============================================================================

import crypto from 'crypto';
import { DB } from '../db';
import { mirrorRedis } from '../config/redis';
import { Logger } from '../utils/logger';

// ============================================================================
// TYPES
// ============================================================================

interface ProcessingJob {
  id: string;
  job_type: 'classify_review' | 'generate_analysis';
  reference_id: string;
  user_id: number;
  priority: number;
  status: string;
  retry_count: number;
  max_retries: number;
  input_data: string | Record<string, any>;
  created_at: Date;
}

interface ProcessorConfig {
  pollInterval: number;
  maxConcurrentJobs: number;
  maxRetries: number;
  retryDelay: number;
  shutdownTimeout: number;
  dinaEndpoint: string;
  dinaServiceKey: string;
  // Circuit breaker (configurable via env)
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
  // Rate limiter (configurable via env)
  rateLimitPerUser: number;
  rateLimitWindowMs: number;
  // Input sanitizer
  maxInputLength: number;
  // Timeouts
  dinaTimeoutMs: number;
  // Extended timeout for LLM-heavy operations
  dinaLLMTimeoutMs: number;
}

interface ProcessorStats {
  processed: number;
  succeeded: number;
  failed: number;
  retried: number;
  averageProcessingTimeMs: number;
  lastProcessedAt: Date | null;
  circuitBreakerState: 'closed' | 'open' | 'half-open';
  pollCount: number;
  lastPollAt: Date | null;
}

// ============================================================================
// HELPERS
// ============================================================================

function safeJsonParse<T = any>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

/**
 * Safely extract an error message from any error type.
 * Prevents "Error: undefined" by handling null, undefined, non-Error objects.
 */
function extractErrorMessage(error: unknown): string {
  if (error === null || error === undefined) return 'Unknown error (null/undefined)';
  if (error instanceof Error) return error.message || 'Error with no message';
  if (typeof error === 'string') return error || 'Empty error string';
  if (typeof error === 'object') {
    const obj = error as any;
    if (obj.message) return String(obj.message);
    if (obj.error) return String(obj.error);
    try { return JSON.stringify(error).substring(0, 500); } catch { /* fall through */ }
  }
  return String(error) || 'Unknown error';
}

/**
 * Build a textual summary from structured review responses.
 * Used when freeFormText is empty to ensure classify-review has meaningful text.
 */
function buildReviewTextFromResponses(responses: Record<string, any>): string {
  if (!responses || typeof responses !== 'object') return '';

  const parts: string[] = [];

  for (const [sectionId, sectionData] of Object.entries(responses)) {
    if (!sectionData || typeof sectionData !== 'object') continue;
    for (const [questionId, answer] of Object.entries(sectionData as Record<string, any>)) {
      if (answer === null || answer === undefined) continue;

      if (typeof answer === 'string' && answer.trim().length > 0) {
        parts.push(answer.trim());
      } else if (typeof answer === 'object') {
        if (answer.explanation && typeof answer.explanation === 'string' && answer.explanation.trim()) {
          parts.push(answer.explanation.trim());
        }
        if (answer.categories && Array.isArray(answer.categories)) {
          parts.push(`${questionId}: ${answer.categories.join(', ')}`);
          if (answer.explanation) parts.push(answer.explanation);
        }
        if (typeof answer.score === 'number') {
          parts.push(`${sectionId}.${questionId}: ${answer.score}/10`);
        }
      }
    }
  }

  return parts.filter(p => p.length > 0).join('. ');
}

// ============================================================================
// CIRCUIT BREAKER - 3-State Resilience Pattern
// ============================================================================
// Matches DinaChatQueueProcessor's CircuitBreaker class exactly:
//   closed    → all requests pass through
//   open      → all requests rejected immediately
//   half-open → one probe request allowed; success closes, failure re-opens
// ============================================================================

class CircuitBreaker {
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private readonly threshold: number;
  private readonly resetTimeMs: number;
  private readonly logger: Logger;

  constructor(threshold: number, resetTimeMs: number, logger: Logger) {
    this.threshold = threshold;
    this.resetTimeMs = resetTimeMs;
    this.logger = logger;
  }

  canExecute(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure >= this.resetTimeMs) {
        this.state = 'half-open';
        this.logger.info('Circuit breaker entering half-open state');
        return true;
      }
      return false;
    }

    // half-open: allow one probe request
    return true;
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.logger.info('Circuit breaker closing after successful request');
    }
    this.failureCount = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.state = 'open';
      this.logger.warn('Circuit breaker re-opened after failure in half-open state');
    } else if (this.failureCount >= this.threshold) {
      this.state = 'open';
      this.logger.warn('Circuit breaker opened', {
        failureCount: this.failureCount,
        threshold: this.threshold,
      });
    }
  }

  getState(): 'closed' | 'open' | 'half-open' {
    // Check for timeout-based transition to half-open
    if (this.state === 'open') {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure >= this.resetTimeMs) {
        return 'half-open';
      }
    }
    return this.state;
  }

  reset(): void {
    this.failureCount = 0;
    this.state = 'closed';
    this.logger.info('Circuit breaker manually reset');
  }
}

// ============================================================================
// RATE LIMITER - Per-User Sliding Window
// ============================================================================
// Matches DinaChatQueueProcessor's RateLimiter class exactly.
// Prevents thundering herd from a single user flooding the Dina service.
// ============================================================================

class RateLimiter {
  private userRequests: Map<number, number[]> = new Map();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  canProcess(userId: number): boolean {
    const now = Date.now();
    const requests = this.userRequests.get(userId) || [];
    const recentRequests = requests.filter(time => now - time < this.windowMs);

    if (recentRequests.length >= this.limit) {
      return false;
    }

    recentRequests.push(now);
    this.userRequests.set(userId, recentRequests);
    return true;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [userId, requests] of this.userRequests.entries()) {
      const recentRequests = requests.filter(time => now - time < this.windowMs);
      if (recentRequests.length === 0) {
        this.userRequests.delete(userId);
      } else {
        this.userRequests.set(userId, recentRequests);
      }
    }
  }
}

// ============================================================================
// INPUT SANITIZER - First-Line Defense
// ============================================================================
// Matches DinaChatQueueProcessor's InputSanitizer class:
//   - Null byte removal
//   - Whitespace normalization
//   - Length enforcement
// The dina-server TruthStreamSynthesizer has prompt injection defense,
// but this provides defense-in-depth on the mirror-server side.
// ============================================================================

class InputSanitizer {
  private readonly maxLength: number;

  constructor(maxLength: number) {
    this.maxLength = maxLength;
  }

  sanitize(input: string): string {
    if (!input || typeof input !== 'string') return '';

    let sanitized = input
      .replace(/\0/g, '')        // Remove null bytes
      .replace(/\s+/g, ' ')     // Normalize whitespace
      .trim();

    if (sanitized.length > this.maxLength) {
      sanitized = sanitized.substring(0, this.maxLength);
    }

    return sanitized;
  }

  sanitizeObject(obj: Record<string, any>, fieldLimits?: Record<string, number>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        const limit = fieldLimits?.[key] || this.maxLength;
        sanitized[key] = this.sanitize(value).substring(0, limit);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}

// ============================================================================
// QUEUE PROCESSOR CLASS
// ============================================================================

export class TruthStreamQueueProcessor {
  private logger: Logger;
  private config: ProcessorConfig;
  private isRunning: boolean = false;
  private isShuttingDown: boolean = false;
  private currentJobs: Set<string> = new Set();
  private pollTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;

  // Enterprise components (matching DinaChatQueueProcessor)
  private readonly circuitBreaker: CircuitBreaker;
  private readonly rateLimiter: RateLimiter;
  private readonly sanitizer: InputSanitizer;
  private readonly stats: ProcessorStats;

  // Processing time tracking for averageProcessingTimeMs
  private processingTimes: number[] = [];

  constructor(config?: Partial<ProcessorConfig>) {
    this.logger = new Logger('TruthStreamQueueProcessor');

    this.config = {
      pollInterval: parseInt(process.env.TRUTHSTREAM_POLL_INTERVAL || '5000', 10),
      maxConcurrentJobs: parseInt(process.env.TRUTHSTREAM_MAX_CONCURRENT || '3', 10),
      maxRetries: parseInt(process.env.TRUTHSTREAM_MAX_RETRIES || '3', 10),
      retryDelay: parseInt(process.env.TRUTHSTREAM_RETRY_DELAY || '10000', 10),
      shutdownTimeout: parseInt(process.env.TRUTHSTREAM_SHUTDOWN_TIMEOUT || '30000', 10),
      dinaEndpoint: process.env.DINA_ENDPOINT || 'http://localhost:8445/dina/api/v1',
      dinaServiceKey: process.env.DINA_SERVICE_KEY || process.env.DINA_API_KEY || '',
      // Circuit breaker (matching DinaChatQueueProcessor env var names)
      circuitBreakerThreshold: parseInt(process.env.TS_CIRCUIT_BREAKER_THRESHOLD || '5', 10),
      circuitBreakerResetMs: parseInt(process.env.TS_CIRCUIT_BREAKER_RESET || '60000', 10),
      // Rate limiter
      rateLimitPerUser: parseInt(process.env.TS_RATE_LIMIT_PER_USER || '10', 10),
      rateLimitWindowMs: parseInt(process.env.TS_RATE_LIMIT_WINDOW || '60000', 10),
      // Input sanitizer
      maxInputLength: parseInt(process.env.TS_MAX_INPUT_LENGTH || '10000', 10),
      // Timeouts — standard operations
      dinaTimeoutMs: parseInt(process.env.TS_DINA_TIMEOUT || '120000', 10),
      // FIX: Extended timeout for LLM-heavy operations (generate_analysis)
      // Must be less than Dina's Express route timeout (180s) to get proper errors
      dinaLLMTimeoutMs: parseInt(process.env.TS_DINA_LLM_TIMEOUT || '170000', 10),
      ...config,
    };

    // Initialize enterprise components
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold,
      this.config.circuitBreakerResetMs,
      this.logger
    );

    this.rateLimiter = new RateLimiter(
      this.config.rateLimitPerUser,
      this.config.rateLimitWindowMs
    );

    this.sanitizer = new InputSanitizer(this.config.maxInputLength);

    this.stats = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      retried: 0,
      averageProcessingTimeMs: 0,
      lastProcessedAt: null,
      circuitBreakerState: 'closed',
      pollCount: 0,
      lastPollAt: null,
    };

    this.logger.info('TruthStreamQueueProcessor initialized', {
      pollInterval: this.config.pollInterval,
      maxConcurrentJobs: this.config.maxConcurrentJobs,
      maxRetries: this.config.maxRetries,
      circuitBreakerThreshold: this.config.circuitBreakerThreshold,
      circuitBreakerResetMs: this.config.circuitBreakerResetMs,
      rateLimitPerUser: this.config.rateLimitPerUser,
      dinaEndpoint: this.config.dinaEndpoint.replace(/key.*$/i, 'key=***'),
      dinaTimeoutMs: this.config.dinaTimeoutMs,
      dinaLLMTimeoutMs: this.config.dinaLLMTimeoutMs,
    });
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Processor already running');
      return;
    }

    this.isRunning = true;
    this.isShuttingDown = false;
    this.logger.info('Starting TruthStreamQueueProcessor');

    try {
      // Subscribe to Redis pub/sub for real-time triggers
      await this.subscribeToQueue();

      // Start polling for pending jobs (fallback)
      this.startPolling();

      // Start periodic cleanup (rate limiter eviction)
      this.cleanupTimer = setInterval(() => {
        this.rateLimiter.cleanup();
      }, 60000);

      // Start periodic stats logging
      this.statusTimer = setInterval(() => {
        this.logStats();
      }, 60000);

      // Setup graceful shutdown
      this.setupShutdownHandlers();

      this.logger.info('TruthStreamQueueProcessor started successfully');
    } catch (error: any) {
      this.logger.error('Failed to start processor', { error: extractErrorMessage(error) });
      this.isRunning = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.logger.info('Stopping TruthStreamQueueProcessor', {
      currentJobs: this.currentJobs.size,
    });

    this.isShuttingDown = true;
    this.isRunning = false;

    // Clear all timers
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }

    // Wait for current jobs
    const deadline = Date.now() + this.config.shutdownTimeout;
    while (this.currentJobs.size > 0 && Date.now() < deadline) {
      this.logger.info('Waiting for jobs to complete', { remaining: this.currentJobs.size });
      await this.sleep(1000);
    }

    if (this.currentJobs.size > 0) {
      this.logger.warn('Shutdown timeout with jobs still running', {
        jobs: Array.from(this.currentJobs),
      });
    }

    try {
      await mirrorRedis.unsubscribe('mirror:truthstream:queue');
    } catch {
      // Ignore unsubscribe errors during shutdown
    }

    // Log final stats
    this.logStats();

    this.logger.info('TruthStreamQueueProcessor stopped');
  }

  // ==========================================================================
  // OBSERVABILITY (matches DinaChatQueueProcessor getStats pattern)
  // ==========================================================================

  getStats(): ProcessorStats {
    return {
      ...this.stats,
      circuitBreakerState: this.circuitBreaker.getState(),
    };
  }

  private logStats(): void {
    const stats = this.getStats();
    this.logger.info('Processor stats', {
      processed: stats.processed,
      succeeded: stats.succeeded,
      failed: stats.failed,
      retried: stats.retried,
      averageProcessingTimeMs: Math.round(stats.averageProcessingTimeMs),
      circuitBreaker: stats.circuitBreakerState,
      currentJobs: this.currentJobs.size,
      pollCount: stats.pollCount,
      lastProcessedAt: stats.lastProcessedAt?.toISOString() || null,
    });
  }

  private recordProcessingTime(durationMs: number): void {
    this.processingTimes.push(durationMs);
    // Keep last 100 entries for rolling average
    if (this.processingTimes.length > 100) {
      this.processingTimes.shift();
    }
    this.stats.averageProcessingTimeMs =
      this.processingTimes.reduce((sum, t) => sum + t, 0) / this.processingTimes.length;
  }

  // ==========================================================================
  // JOB FETCHING
  // ==========================================================================

  private async subscribeToQueue(): Promise<void> {
    try {
      await mirrorRedis.subscribe('mirror:truthstream:queue', async () => {
        if (this.isRunning && !this.isShuttingDown) {
          await this.processNextJobs();
        }
      });
      this.logger.info('Subscribed to Redis channel: mirror:truthstream:queue');
    } catch (error: any) {
      this.logger.warn('Redis subscription failed, falling back to polling only', {
        error: extractErrorMessage(error),
      });
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      if (this.isRunning && !this.isShuttingDown) {
        this.stats.pollCount++;
        this.stats.lastPollAt = new Date();
        await this.processNextJobs();
      }
    }, this.config.pollInterval);

    this.logger.info('Polling started', { interval: this.config.pollInterval });
  }

  private async processNextJobs(): Promise<void> {
    if (this.currentJobs.size >= this.config.maxConcurrentJobs) return;
    if (this.isShuttingDown) return;

    try {
      const available = this.config.maxConcurrentJobs - this.currentJobs.size;

      // Fetch pending jobs, ordered by priority and creation time
      // Use FOR UPDATE SKIP LOCKED to prevent deadlocks (edge case #19)
      const connection = await DB.getConnection();
      try {
        await connection.beginTransaction();

        const [rows] = await connection.query(
          `SELECT * FROM truth_stream_processing_queue
           WHERE status = 'pending'
             AND (next_retry_at IS NULL OR next_retry_at <= NOW())
           ORDER BY priority ASC, created_at ASC
           LIMIT ?
           FOR UPDATE SKIP LOCKED`,
          [available]
        ) as any[];

        if (!rows || rows.length === 0) {
          await connection.commit();
          return;
        }

        // Mark as processing
        const ids = rows.map((r: any) => r.id);
        await connection.query(
          `UPDATE truth_stream_processing_queue
           SET status = 'processing', started_at = NOW()
           WHERE id IN (${ids.map(() => '?').join(',')})`,
          ids
        );

        await connection.commit();

        // Process each job
        for (const job of rows) {
          this.currentJobs.add(job.id);
          this.processJob(job).finally(() => {
            this.currentJobs.delete(job.id);
          });
        }
      } catch (txError) {
        await connection.rollback();
        throw txError;
      } finally {
        connection.release();
      }
    } catch (error: any) {
      this.logger.error('Error fetching jobs', { error: extractErrorMessage(error) });
    }
  }

  // ==========================================================================
  // JOB PROCESSING
  // ==========================================================================

  private async processJob(job: ProcessingJob): Promise<void> {
    // Defensive: don't process during shutdown
    if (this.isShuttingDown) {
      this.logger.warn('Skipping job due to shutdown', { jobId: job.id });
      // Re-queue the job
      await DB.query(
        `UPDATE truth_stream_processing_queue SET status = 'pending', started_at = NULL WHERE id = ?`,
        [job.id]
      );
      return;
    }

    // Rate limit check
    if (!this.rateLimiter.canProcess(job.user_id)) {
      this.logger.warn('Rate limited - re-queuing job', {
        jobId: job.id,
        userId: job.user_id,
      });
      const retryAt = new Date(Date.now() + 30000); // Wait 30s
      await DB.query(
        `UPDATE truth_stream_processing_queue SET status = 'pending', next_retry_at = ? WHERE id = ?`,
        [retryAt, job.id]
      );
      return;
    }

    const inputData = safeJsonParse(job.input_data, {});
    const startTime = Date.now();

    this.logger.info('Processing job', {
      jobId: job.id,
      type: job.job_type,
      referenceId: job.reference_id,
      attempt: job.retry_count + 1,
    });

    try {
      switch (job.job_type) {
        case 'classify_review':
          await this.processClassification(job, inputData);
          break;
        case 'generate_analysis':
          await this.processAnalysisGeneration(job, inputData);
          break;
        default:
          throw new Error(`Unknown job type: ${job.job_type}`);
      }

      // Mark completed
      await DB.query(
        `UPDATE truth_stream_processing_queue
         SET status = 'completed', completed_at = NOW()
         WHERE id = ?`,
        [job.id]
      );

      // Update stats
      const duration = Date.now() - startTime;
      this.stats.processed++;
      this.stats.succeeded++;
      this.stats.lastProcessedAt = new Date();
      this.recordProcessingTime(duration);

      this.logger.info('Job completed', {
        jobId: job.id,
        type: job.job_type,
        durationMs: duration,
      });
    } catch (error: unknown) {
      // FIX: Use extractErrorMessage to get a meaningful error message
      // Previously this logged "Error: undefined" when error.message was empty
      const errorMessage = extractErrorMessage(error);

      // Update stats
      this.stats.processed++;
      this.stats.failed++;
      this.recordProcessingTime(Date.now() - startTime);

      // Create a proper Error object with the extracted message for handleJobFailure
      const errorObj = error instanceof Error ? error : new Error(errorMessage);
      await this.handleJobFailure(job, errorObj);
    }
  }

  // ==========================================================================
  // CLASSIFY REVIEW
  // ==========================================================================

  private async processClassification(job: ProcessingJob, inputData: any): Promise<void> {
    const { reviewId, reviewText, responses, reviewTone, revieweeGoal, qualityMetrics } = inputData;

    // FIX: Build reviewText from structured responses when free-form text is empty.
    // This was causing classify-review to fail with a 400 error because the
    // Dina endpoint validated `if (!reviewText)` and "" is falsy.
    let effectiveReviewText = reviewText ? this.sanitizer.sanitize(String(reviewText)) : '';
    if (!effectiveReviewText || effectiveReviewText.trim().length === 0) {
      effectiveReviewText = buildReviewTextFromResponses(responses || {});
    }
    if (!effectiveReviewText || effectiveReviewText.trim().length === 0) {
      effectiveReviewText = '[Structured responses only — no free-form text provided]';
    }

    // Sanitize text inputs (defense-in-depth: dina-server also sanitizes)
    const sanitizedBody = {
      reviewId,
      reviewText: effectiveReviewText,
      responses,
      reviewTone: reviewTone ? this.sanitizer.sanitize(String(reviewTone)).substring(0, 100) : undefined,
      revieweeGoal,
      qualityMetrics,
    };

    // Call Dina mirror module for classification
    const result = await this.callDinaEndpoint('/mirror/truthstream/classify-review', sanitizedBody);

    if (!result.success || !result.data) {
      throw new Error(result.error || result.message || 'Classification returned unsuccessful response');
    }

    const classification = result.data;

    // Update the review with classification results
    await DB.query(
      `UPDATE truth_stream_reviews
       SET classification = ?,
           classification_confidence = ?,
           classification_reasoning = ?,
           dina_counter_analysis = ?
       WHERE id = ?`,
      [
        classification.classification,
        classification.confidence,
        classification.reasoning,
        classification.counterAnalysis || null,
        reviewId,
      ]
    );

    // If hostile, log it and check patterns
    if (classification.classification === 'hostile') {
      await this.logHostileReview(reviewId, classification);
    }

    // Publish notification via Redis
    try {
      await mirrorRedis.publish('mirror:truthstream:notifications', JSON.stringify({
        type: 'review_classified',
        userId: job.user_id,
        reviewId,
        classification: classification.classification,
      }));
    } catch {
      // Non-critical — user will see on next page load
    }

    // Save output data for debugging
    await DB.query(
      `UPDATE truth_stream_processing_queue SET output_data = ? WHERE id = ?`,
      [JSON.stringify(classification), job.id]
    );
  }

  // ==========================================================================
  // GENERATE ANALYSIS
  // ==========================================================================

  private async processAnalysisGeneration(job: ProcessingJob, inputData: any): Promise<void> {
    const { analysisType } = inputData;
    const userId = job.user_id;

    // Gather data for analysis
    const [profileRows] = await DB.query(
      `SELECT goal, goal_category, self_statement, shared_data_types
       FROM truth_stream_profiles WHERE user_id = ?`,
      [userId]
    ) as any[];

    if (!profileRows || profileRows.length === 0) {
      throw new Error(`User profile not found for user_id=${userId}`);
    }

    const profile = profileRows[0];

    // Get all reviews received
    const [reviewRows] = await DB.query(
      `SELECT responses, classification, classification_confidence,
              quality_score, completeness_score, depth_score, created_at
       FROM truth_stream_reviews
       WHERE reviewee_id = ?
       ORDER BY created_at DESC`,
      [userId]
    ) as any[];

    if (!reviewRows || reviewRows.length < 5) {
      throw new Error(`Insufficient reviews for analysis: ${reviewRows?.length || 0} found, 5 required`);
    }

    // Build anonymized reviews for Dina
    const reviews = reviewRows.map((r: any) => ({
      classification: r.classification,
      classificationConfidence: r.classification_confidence,
      responses: safeJsonParse(r.responses, {}),
      qualityScore: r.quality_score,
      completenessScore: r.completeness_score,
      depthScore: r.depth_score,
      createdAtRounded: roundToNearestHour(r.created_at).toISOString(),
    }));

    // Get self-assessment data from intake
    let selfAssessmentData: any = null;
    try {
      const [intakeRows] = await DB.query(
        'SELECT intake_data FROM intake_data WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
        [userId]
      ) as any[];

      if (intakeRows && intakeRows.length > 0) {
        const intake = safeJsonParse<any>(intakeRows[0].intake_data, {});
        selfAssessmentData = {
          personalityProfile: intake.personalityResult ? {
            big5: intake.personalityResult.big5Profile,
            mbtiType: intake.personalityResult.mbtiType,
            dominantTraits: intake.personalityResult.dominantTraits,
          } : undefined,
          cognitiveProfile: intake.iqResults ? {
            category: intake.iqResults.category,
            strengths: intake.iqResults.strengths,
          } : undefined,
          astrologicalHighlights: intake.astrologicalResult?.synthesis?.summary,
        };
      }
    } catch {
      // Non-critical
    }

    // Get previous analysis for temporal comparison
    let previousAnalysis: any = null;
    try {
      const [prevRows] = await DB.query(
        `SELECT perception_gap_score, created_at, analysis_data
         FROM truth_stream_analyses
         WHERE user_id = ? AND analysis_type = ?
         ORDER BY created_at DESC LIMIT 1`,
        [userId, analysisType || 'truth_mirror_report']
      ) as any[];

      if (prevRows && prevRows.length > 0) {
        const prevData = safeJsonParse<any>(prevRows[0].analysis_data, {});
        previousAnalysis = {
          perceptionGapScore: prevRows[0].perception_gap_score,
          generatedAt: prevRows[0].created_at,
          keyInsights: prevData.growthRecommendations?.map((r: any) => r.recommendation) || [],
        };
      }
    } catch {
      // Non-critical
    }

    // Sanitize text fields before sending to Dina
    const sanitizedGoal = this.sanitizer.sanitize(String(profile.goal || ''));
    const sanitizedSelfStatement = profile.self_statement
      ? this.sanitizer.sanitize(String(profile.self_statement))
      : undefined;

    // FIX: Use extended LLM timeout for generate-analysis (Ollama can take 30-120s)
    const result = await this.callDinaEndpoint('/mirror/truthstream/generate-analysis', {
      userId,
      analysisType: analysisType || 'truth_mirror_report',
      reviews,
      selfAssessmentData,
      goal: sanitizedGoal,
      goalCategory: profile.goal_category,
      selfStatement: sanitizedSelfStatement,
      totalReviewCount: reviewRows.length,
      previousAnalysis,
    }, this.config.dinaLLMTimeoutMs);

    if (!result.success || !result.data) {
      throw new Error(result.error || result.message || 'Analysis returned unsuccessful response');
    }

    const analysis = result.data;

    // Save analysis to DB
    const analysisId = crypto.randomUUID();
    await DB.query(
      `INSERT INTO truth_stream_analyses
       (id, user_id, analysis_type, review_count_at_generation, analysis_data,
        perception_gap_score, confidence_level)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        analysisId, userId,
        analysis.analysisType || analysisType || 'truth_mirror_report',
        analysis.metadata?.reviewsAnalyzed || reviewRows.length,
        JSON.stringify(analysis.analysisData),
        analysis.perceptionGapScore || null,
        analysis.confidenceLevel || null,
      ]
    );

    // Update perception gap score on profile
    if (analysis.perceptionGapScore !== null && analysis.perceptionGapScore !== undefined) {
      await DB.query(
        'UPDATE truth_stream_profiles SET perception_gap_score = ? WHERE user_id = ?',
        [analysis.perceptionGapScore, userId]
      );
    }

    // Publish notification
    try {
      await mirrorRedis.publish('mirror:truthstream:notifications', JSON.stringify({
        type: 'analysis_complete',
        userId,
        analysisId,
        analysisType: analysis.analysisType,
      }));
    } catch {
      // Non-critical
    }

    // Save output for debugging
    await DB.query(
      'UPDATE truth_stream_processing_queue SET output_data = ? WHERE id = ?',
      [JSON.stringify({ analysisId, type: analysis.analysisType }), job.id]
    );
  }

  // ==========================================================================
  // HOSTILE REVIEW LOGGING
  // ==========================================================================

  private async logHostileReview(reviewId: string, classification: any): Promise<void> {
    try {
      // Get review details
      const [reviewRows] = await DB.query(
        'SELECT reviewer_id, reviewee_id FROM truth_stream_reviews WHERE id = ?',
        [reviewId]
      ) as any[];

      if (!reviewRows || reviewRows.length === 0) return;

      const { reviewer_id, reviewee_id } = reviewRows[0];

      // Count previous hostile reviews by this reviewer
      const [countRows] = await DB.query(
        'SELECT COUNT(*) as count FROM truth_stream_hostility_log WHERE reviewer_id = ?',
        [reviewer_id]
      ) as any[];

      const hostilityCount = (countRows[0]?.count || 0) + 1;

      // Insert hostility log
      await DB.query(
        `INSERT INTO truth_stream_hostility_log
         (id, review_id, reviewer_id, reviewee_id, classification_confidence,
          hostility_indicators, reviewer_hostility_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(), reviewId, reviewer_id, reviewee_id,
          classification.confidence,
          JSON.stringify(classification.hostilityIndicators || []),
          hostilityCount,
        ]
      );

      this.logger.warn('Hostile review logged', {
        reviewId,
        reviewerId: reviewer_id,
        revieweeId: reviewee_id,
        hostilityCount,
      });
    } catch (error: any) {
      this.logger.error('Failed to log hostile review', { error: extractErrorMessage(error) });
    }
  }

  // ==========================================================================
  // DINA MIRROR MODULE HTTP CALL
  // ==========================================================================
  // Enterprise patterns (matching DinaChatQueueProcessor + DINALLMConnector):
  //   - 3-state circuit breaker (closed/open/half-open)
  //   - Retry with exponential backoff + jitter (thundering herd prevention)
  //   - Proper headers (Authorization, User-Agent, X-Request-Attempt)
  //   - Retryable error detection (5xx, timeout, network; NOT 4xx)
  // ==========================================================================

  /**
   * Call a dina-server mirror module endpoint with circuit breaker and retry.
   * Routes ALL TruthStream Dina interactions through the mirror module's
   * DUMP-compliant endpoints.
   *
   * @param path - The endpoint path (e.g. /mirror/truthstream/classify-review)
   * @param body - The request body
   * @param timeoutOverride - Optional timeout override for LLM-heavy operations
   */
  private async callDinaEndpoint(path: string, body: any, timeoutOverride?: number): Promise<any> {
    // Circuit breaker check
    if (!this.circuitBreaker.canExecute()) {
      const state = this.circuitBreaker.getState().toUpperCase();
      const error = new Error(
        `Dina service unavailable: Circuit breaker ${state}. ` +
        `Service will retry after circuit breaker reset period.`
      );
      this.logger.error('Circuit breaker rejecting request', {
        state: this.circuitBreaker.getState(),
        path,
      });
      throw error;
    }

    const maxRetries = 3;
    const baseDelays = [1000, 2000, 4000];
    let lastError: Error | null = null;
    const requestTimeout = timeoutOverride || this.config.dinaTimeoutMs;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const url = this.buildDinaEndpointUrl(path);

        this.logger.debug('Calling Dina mirror module', {
          url,
          path,
          attempt: attempt + 1,
          timeoutMs: requestTimeout,
        });

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.dinaServiceKey}`,
            'User-Agent': 'MirrorTruthStream/1.0',
            'X-Request-Attempt': String(attempt + 1),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(requestTimeout),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          // Include the HTTP status in a parseable format for isRetryableError
          throw new Error(
            `Dina mirror module error: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`
          );
        }

        const result = await response.json();

        if (!result.success) {
          // FIX: Extract error message from all possible fields
          const errorMsg = result.error || result.message || 'Dina returned unsuccessful response';
          throw new Error(`Dina returned error: ${errorMsg}`);
        }

        // Success — record with circuit breaker
        this.circuitBreaker.recordSuccess();
        return result;

      } catch (error: unknown) {
        // FIX: Always create a proper Error with a meaningful message
        const errorMessage = extractErrorMessage(error);
        lastError = error instanceof Error ? error : new Error(errorMessage);

        const isLastAttempt = attempt === maxRetries - 1;
        const isRetryable = this.isRetryableError(lastError);

        if (!isLastAttempt && isRetryable) {
          // Exponential backoff + jitter (prevents thundering herd)
          const baseDelay = baseDelays[attempt];
          const jitter = Math.floor(Math.random() * baseDelay * 0.3); // Up to 30% jitter
          const delay = baseDelay + jitter;
          this.logger.warn(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`, {
            error: errorMessage,
            path,
            baseDelay,
            jitter,
          });
          await this.sleep(delay);
        } else {
          break;
        }
      }
    }

    // All retries exhausted — record failure with circuit breaker
    this.circuitBreaker.recordFailure();
    this.stats.retried++;

    // FIX: Ensure we always throw a proper Error with a message
    if (!lastError) {
      lastError = new Error(`All ${maxRetries} retries exhausted for ${path}`);
    }
    throw lastError;
  }

  /**
   * Build the full URL for a Dina mirror module endpoint.
   * Matches DINALLMConnector.buildMirrorSynthesisEndpoint() pattern.
   */
  private buildDinaEndpointUrl(path: string): string {
    const baseUrl = this.config.dinaEndpoint.replace(/\/$/, '');

    try {
      const parsed = new URL(baseUrl);
      if (parsed.pathname.endsWith('/api/v1')) {
        return baseUrl.replace(/\/api\/v1$/, '') + '/api/v1' + path;
      } else if (parsed.pathname.includes('/dina')) {
        return baseUrl + '/api/v1' + path;
      } else if (parsed.pathname === '' || parsed.pathname === '/') {
        return baseUrl + '/dina/api/v1' + path;
      } else {
        return baseUrl + path;
      }
    } catch {
      return `${baseUrl}/dina/api/v1${path}`;
    }
  }

  // ==========================================================================
  // ERROR HANDLING
  // ==========================================================================

  private async handleJobFailure(job: ProcessingJob, error: Error): Promise<void> {
    const retryCount = (job.retry_count || 0) + 1;
    const canRetry = retryCount < this.config.maxRetries && this.isRetryableError(error);
    // FIX: Use extractErrorMessage for safe error string extraction
    const errorMessage = extractErrorMessage(error);

    this.logger.error('Job failed', {
      jobId: job.id,
      type: job.job_type,
      error: errorMessage,
      retryCount,
      canRetry,
    });

    if (canRetry) {
      this.stats.retried++;
      const nextRetryAt = new Date(Date.now() + this.config.retryDelay * Math.pow(2, retryCount - 1));
      await DB.query(
        `UPDATE truth_stream_processing_queue
         SET status = 'pending', retry_count = ?, error_message = ?, next_retry_at = ?
         WHERE id = ?`,
        [retryCount, errorMessage.substring(0, 1000), nextRetryAt, job.id]
      );
    } else {
      await DB.query(
        `UPDATE truth_stream_processing_queue
         SET status = 'failed', retry_count = ?, error_message = ?, completed_at = NOW()
         WHERE id = ?`,
        [retryCount, errorMessage.substring(0, 1000), job.id]
      );

      // For classification failures, set classification to NULL (review still visible)
      if (job.job_type === 'classify_review') {
        this.logger.warn('Classification failed permanently, review remains unclassified', {
          reviewId: job.reference_id,
          error: errorMessage,
        });
      }

      // For analysis failures, log more context
      if (job.job_type === 'generate_analysis') {
        this.logger.warn('Analysis generation failed permanently', {
          referenceId: job.reference_id,
          userId: job.user_id,
          error: errorMessage,
        });
      }
    }
  }

  private isRetryableError(error: any): boolean {
    const message = (error?.message || '').toLowerCase();
    // Network errors are always retryable
    if (error?.name === 'TypeError' && message.includes('fetch')) return true;
    if (message.includes('econnrefused') || message.includes('enotfound')) return true;
    if (message.includes('econnreset') || message.includes('epipe')) return true;
    // Timeouts are retryable
    if (message.includes('timeout') || message.includes('aborted')) return true;
    // Server errors (5xx) are retryable
    if (message.match(/\b5\d{2}\b/)) return true;
    // Rate limiting is retryable
    if (message.includes('429') || message.includes('rate limit')) return true;
    // Circuit breaker state is retryable (will resolve when CB resets)
    if (message.includes('circuit breaker')) return true;
    // Client errors (4xx except 429) are NOT retryable
    if (message.match(/\b4\d{2}\b/)) return false;
    // Default: retry unknown errors
    return true;
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      this.logger.info(`${signal} received, shutting down...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function roundToNearestHour(date: Date | string): Date {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
}

// ============================================================================
// STANDALONE EXECUTION
// ============================================================================
// When run directly: npx ts-node workers/TruthStreamQueueProcessor.ts

if (require.main === module) {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║    TruthStream Queue Processor - Standalone Mode    ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Circuit Breaker: 3-state (closed/open/half-open)  ║');
  console.log('║  Rate Limiter:    Per-user sliding window          ║');
  console.log('║  Input Sanitizer: Null byte + whitespace defense   ║');
  console.log('║  Retry:           Exponential backoff + jitter     ║');
  console.log('║  DUMP Compliant:  Routes through Core Orchestrator ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  const processor = new TruthStreamQueueProcessor();
  processor.start().then(() => {
    console.log('TruthStream Queue Processor is running...');
    console.log('Press Ctrl+C to stop.');
  }).catch(error => {
    console.error('Failed to start:', error);
    process.exit(1);
  });

  // Log stats periodically (matches AnalysisQueueProcessor pattern)
  setInterval(() => {
    const stats = processor.getStats();
    console.log('[TruthStream Stats]', JSON.stringify(stats));
  }, 60000);
}
