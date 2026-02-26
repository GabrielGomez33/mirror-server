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
// Pattern follows: AnalysisQueueProcessor.ts (DB polling + Redis pub/sub)
// All Dina calls route through mirror module via HTTP
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

// ============================================================================
// QUEUE PROCESSOR CLASS
// ============================================================================

export class TruthStreamQueueProcessor {
  private logger: Logger;
  private config: ProcessorConfig;
  private isRunning: boolean = false;
  private currentJobs: Set<string> = new Set();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(config?: Partial<ProcessorConfig>) {
    this.logger = new Logger('TruthStreamQueueProcessor');

    this.config = {
      pollInterval: parseInt(process.env.TRUTHSTREAM_POLL_INTERVAL || '5000', 10),
      maxConcurrentJobs: parseInt(process.env.TRUTHSTREAM_MAX_CONCURRENT || '3', 10),
      maxRetries: parseInt(process.env.TRUTHSTREAM_MAX_RETRIES || '3', 10),
      retryDelay: parseInt(process.env.TRUTHSTREAM_RETRY_DELAY || '10000', 10),
      shutdownTimeout: 30000,
      dinaEndpoint: process.env.DINA_ENDPOINT || 'http://localhost:7777',
      dinaServiceKey: process.env.DINA_SERVICE_KEY || process.env.DINA_API_KEY || '',
      ...config,
    };

    this.logger.info('TruthStreamQueueProcessor initialized', {
      pollInterval: this.config.pollInterval,
      maxConcurrentJobs: this.config.maxConcurrentJobs,
      maxRetries: this.config.maxRetries,
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
    this.logger.info('Starting TruthStreamQueueProcessor');

    try {
      // Subscribe to Redis pub/sub for real-time triggers
      await this.subscribeToQueue();

      // Start polling for pending jobs (fallback)
      this.startPolling();

      // Setup graceful shutdown
      this.setupShutdownHandlers();

      this.logger.info('TruthStreamQueueProcessor started successfully');
    } catch (error: any) {
      this.logger.error('Failed to start processor', { error: error.message });
      this.isRunning = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.logger.info('Stopping TruthStreamQueueProcessor', {
      currentJobs: this.currentJobs.size,
    });

    this.isRunning = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
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

    this.logger.info('TruthStreamQueueProcessor stopped');
  }

  // ==========================================================================
  // JOB FETCHING
  // ==========================================================================

  private async subscribeToQueue(): Promise<void> {
    try {
      await mirrorRedis.subscribe('mirror:truthstream:queue', async () => {
        if (this.isRunning) {
          await this.processNextJobs();
        }
      });
      this.logger.info('Subscribed to Redis channel: mirror:truthstream:queue');
    } catch (error: any) {
      this.logger.warn('Redis subscription failed, falling back to polling only', {
        error: error.message,
      });
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      if (this.isRunning) {
        await this.processNextJobs();
      }
    }, this.config.pollInterval);

    this.logger.info('Polling started', { interval: this.config.pollInterval });
  }

  private async processNextJobs(): Promise<void> {
    if (this.currentJobs.size >= this.config.maxConcurrentJobs) return;

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
      this.logger.error('Error fetching jobs', { error: error.message });
    }
  }

  // ==========================================================================
  // JOB PROCESSING
  // ==========================================================================

  private async processJob(job: ProcessingJob): Promise<void> {
    const inputData = safeJsonParse(job.input_data, {});

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

      this.logger.info('Job completed', { jobId: job.id, type: job.job_type });
    } catch (error: any) {
      await this.handleJobFailure(job, error);
    }
  }

  // ==========================================================================
  // CLASSIFY REVIEW
  // ==========================================================================

  private async processClassification(job: ProcessingJob, inputData: any): Promise<void> {
    const { reviewId, reviewText, responses, reviewTone, revieweeGoal, qualityMetrics } = inputData;

    // Call Dina mirror module for classification
    const result = await this.callDinaEndpoint('/mirror/truthstream/classify-review', {
      reviewId,
      reviewText: String(reviewText || '').substring(0, 10000),
      responses,
      reviewTone,
      revieweeGoal,
      qualityMetrics,
    });

    if (!result.success || !result.data) {
      throw new Error(result.error || 'Classification returned unsuccessful response');
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
      throw new Error('User profile not found');
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
      throw new Error('Insufficient reviews for analysis');
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
        'SELECT intake_data FROM user_intake WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
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

    // Call Dina mirror module for analysis
    const result = await this.callDinaEndpoint('/mirror/truthstream/generate-analysis', {
      userId,
      analysisType: analysisType || 'truth_mirror_report',
      reviews,
      selfAssessmentData,
      goal: profile.goal,
      goalCategory: profile.goal_category,
      selfStatement: profile.self_statement,
      totalReviewCount: reviewRows.length,
      previousAnalysis,
    });

    if (!result.success || !result.data) {
      throw new Error(result.error || 'Analysis returned unsuccessful response');
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
      this.logger.error('Failed to log hostile review', { error: error.message });
    }
  }

  // ==========================================================================
  // DINA MIRROR MODULE HTTP CALL
  // ==========================================================================

  /**
   * Call a dina-server mirror module endpoint.
   * Routes ALL TruthStream Dina interactions through the mirror module.
   */
  private async callDinaEndpoint(path: string, body: any): Promise<any> {
    const baseUrl = this.config.dinaEndpoint.replace(/\/$/, '');

    // Build the full URL (follows DINALLMConnector pattern)
    let url: string;
    try {
      const parsed = new URL(baseUrl);
      if (parsed.pathname.endsWith('/api/v1')) {
        url = baseUrl.replace(/\/api\/v1$/, '') + '/api/v1' + path;
      } else if (parsed.pathname.includes('/dina')) {
        url = baseUrl + '/api/v1' + path;
      } else if (parsed.pathname === '' || parsed.pathname === '/') {
        url = baseUrl + '/dina/api/v1' + path;
      } else {
        url = baseUrl + path;
      }
    } catch {
      url = `${baseUrl}/dina/api/v1${path}`;
    }

    this.logger.debug('Calling Dina mirror module', { url, path });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.dinaServiceKey}`,
        'User-Agent': 'MirrorTruthStream/1.0',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(
        `Dina mirror module error: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`
      );
    }

    return response.json();
  }

  // ==========================================================================
  // ERROR HANDLING
  // ==========================================================================

  private async handleJobFailure(job: ProcessingJob, error: any): Promise<void> {
    const retryCount = (job.retry_count || 0) + 1;
    const canRetry = retryCount < this.config.maxRetries && this.isRetryableError(error);

    this.logger.error('Job failed', {
      jobId: job.id,
      type: job.job_type,
      error: error.message,
      retryCount,
      canRetry,
    });

    if (canRetry) {
      const nextRetryAt = new Date(Date.now() + this.config.retryDelay * Math.pow(2, retryCount - 1));
      await DB.query(
        `UPDATE truth_stream_processing_queue
         SET status = 'pending', retry_count = ?, error_message = ?, next_retry_at = ?
         WHERE id = ?`,
        [retryCount, error.message, nextRetryAt, job.id]
      );
    } else {
      await DB.query(
        `UPDATE truth_stream_processing_queue
         SET status = 'failed', retry_count = ?, error_message = ?, completed_at = NOW()
         WHERE id = ?`,
        [retryCount, error.message, job.id]
      );

      // For classification failures, set classification to NULL (review still visible)
      if (job.job_type === 'classify_review') {
        this.logger.warn('Classification failed permanently, review remains unclassified', {
          reviewId: job.reference_id,
        });
      }
    }
  }

  private isRetryableError(error: any): boolean {
    const message = error.message?.toLowerCase() || '';
    if (error.name === 'TypeError' && message.includes('fetch')) return true;
    if (message.includes('timeout') || message.includes('aborted')) return true;
    if (message.match(/\b5\d{2}\b/)) return true;
    if (message.includes('429') || message.includes('rate limit')) return true;
    if (message.includes('econnrefused') || message.includes('enotfound')) return true;
    if (message.match(/\b4\d{2}\b/)) return false; // Client errors not retryable
    return true; // Default: retry
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
  console.log('╚══════════════════════════════════════════════════════╝');

  const processor = new TruthStreamQueueProcessor();
  processor.start().then(() => {
    console.log('TruthStream Queue Processor is running...');
    console.log('Press Ctrl+C to stop.');
  }).catch(error => {
    console.error('Failed to start:', error);
    process.exit(1);
  });
}
