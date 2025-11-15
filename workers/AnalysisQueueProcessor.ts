/**
 * AnalysisQueueProcessor - Background Worker for Group Analysis Jobs
 *
 * Processes queued group analysis requests from mirror_group_analysis_queue.
 * Handles:
 * - Redis pub/sub notifications for real-time job processing
 * - Database polling for pending jobs (fallback)
 * - Priority-based job execution
 * - Error handling with retry logic
 * - Graceful shutdown
 *
 * @module workers/AnalysisQueueProcessor
 * @requires Node.js 18+
 */

import { DB } from '../db';
import { mirrorRedis } from '../config/redis';
import { Logger } from '../utils/logger';
import { groupAnalyzer } from '../analyzers/GroupAnalyzer';

/**
 * Queue job interface
 */
interface QueueJob {
  id: string;
  group_id: string;
  analysis_type: string;
  priority: number;
  trigger_event: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  retry_count: number;
  created_at: Date;
}

/**
 * Processor configuration
 */
interface ProcessorConfig {
  pollInterval: number;          // Milliseconds between polls
  maxConcurrentJobs: number;     // Max parallel jobs
  maxRetries: number;            // Max retry attempts per job
  retryDelay: number;            // Milliseconds between retries
  shutdownTimeout: number;       // Graceful shutdown timeout
}

/**
 * AnalysisQueueProcessor Class
 */
export class AnalysisQueueProcessor {
  private logger: Logger;
  private config: ProcessorConfig;
  private isRunning: boolean = false;
  private currentJobs: Set<string> = new Set();
  private pollTimer: NodeJS.Timeout | null = null;
  private shutdownCallback: (() => void) | null = null;

  constructor(config?: Partial<ProcessorConfig>) {
    this.logger = new Logger('AnalysisQueueProcessor');

    // Default configuration
    this.config = {
      pollInterval: 5000,           // 5 seconds
      maxConcurrentJobs: 3,         // Process 3 groups in parallel
      maxRetries: 3,                // Retry failed jobs 3 times
      retryDelay: 10000,            // 10 second delay between retries
      shutdownTimeout: 30000,       // 30 second graceful shutdown
      ...config
    };

    this.logger.info('AnalysisQueueProcessor initialized', this.config);
  }

  /**
   * Start the processor
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Processor already running');
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting AnalysisQueueProcessor');

    try {
      // Subscribe to Redis pub/sub for real-time notifications
      await this.subscribeToQueue();

      // Start polling for pending jobs (fallback mechanism)
      this.startPolling();

      // Setup graceful shutdown handlers
      this.setupShutdownHandlers();

      this.logger.info('AnalysisQueueProcessor started successfully');
    } catch (error) {
      this.logger.error('Failed to start processor', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop the processor gracefully
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping AnalysisQueueProcessor', {
      currentJobs: this.currentJobs.size
    });

    this.isRunning = false;

    // Stop polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for current jobs to complete (with timeout)
    const shutdownDeadline = Date.now() + this.config.shutdownTimeout;

    while (this.currentJobs.size > 0 && Date.now() < shutdownDeadline) {
      this.logger.info('Waiting for jobs to complete', {
        remaining: this.currentJobs.size
      });
      await this.sleep(1000);
    }

    if (this.currentJobs.size > 0) {
      this.logger.warn('Shutdown timeout reached with jobs still running', {
        jobs: Array.from(this.currentJobs)
      });
    }

    // Unsubscribe from Redis
    try {
      await mirrorRedis.unsubscribe('mirror:analysis:queue');
      this.logger.info('Unsubscribed from Redis channel');
    } catch (error) {
      this.logger.error('Failed to unsubscribe from Redis', error);
    }

    this.logger.info('AnalysisQueueProcessor stopped');

    if (this.shutdownCallback) {
      this.shutdownCallback();
    }
  }

  /**
   * Subscribe to Redis pub/sub for real-time job notifications
   */
  private async subscribeToQueue(): Promise<void> {
    try {
      // Subscribe using MirrorRedisManager
      await mirrorRedis.subscribe('mirror:analysis:queue', async (message: string) => {
        try {
          const notification = JSON.parse(message);
          this.logger.debug('Received queue notification', notification);

          // Process the notified job immediately
          await this.processJobById(notification.queueId);
        } catch (error) {
          this.logger.error('Failed to handle queue notification', error);
        }
      });

      this.logger.info('Subscribed to mirror:analysis:queue channel');
    } catch (error) {
      this.logger.warn('Redis subscription failed, relying on polling only', error);
    }
  }

  /**
   * Start polling for pending jobs
   */
  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        await this.processPendingJobs();
      } catch (error) {
        this.logger.error('Polling error', error);
      }
    }, this.config.pollInterval);

    this.logger.debug('Polling started', {
      interval: this.config.pollInterval
    });
  }

  /**
   * Process all pending jobs (respecting concurrency limit)
   */
  private async processPendingJobs(): Promise<void> {
    // Check if we can process more jobs
    const availableSlots = this.config.maxConcurrentJobs - this.currentJobs.size;

    if (availableSlots <= 0) {
      this.logger.debug('Max concurrent jobs reached', {
        current: this.currentJobs.size,
        max: this.config.maxConcurrentJobs
      });
      return;
    }

    try {
      // Fetch pending jobs (prioritized)
      const [rows] = await DB.query(`
        SELECT
          id, group_id, analysis_type, priority, trigger_event,
          status, retry_count, created_at
        FROM mirror_group_analysis_queue
        WHERE status = 'pending'
          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        ORDER BY priority DESC, created_at ASC
        LIMIT ?
      `, [availableSlots]);

      const jobs = rows as QueueJob[];

      if (jobs.length === 0) {
        return; // No pending jobs
      }

      this.logger.info(`Found ${jobs.length} pending job(s)`);

      // Process jobs in parallel
      const jobPromises = jobs.map(job => this.processJob(job));
      await Promise.allSettled(jobPromises);

    } catch (error) {
      this.logger.error('Failed to fetch pending jobs', error);
    }
  }

  /**
   * Process a specific job by ID
   */
  private async processJobById(jobId: string): Promise<void> {
    try {
      const [rows] = await DB.query(`
        SELECT
          id, group_id, analysis_type, priority, trigger_event,
          status, retry_count, created_at
        FROM mirror_group_analysis_queue
        WHERE id = ? AND status = 'pending'
      `, [jobId]);

      const jobs = rows as QueueJob[];

      if (jobs.length > 0) {
        await this.processJob(jobs[0]);
      }
    } catch (error) {
      this.logger.error('Failed to process job by ID', { jobId, error });
    }
  }

  /**
   * Process a single job
   */
  private async processJob(job: QueueJob): Promise<void> {
    // Check if already processing this job
    if (this.currentJobs.has(job.id)) {
      this.logger.debug('Job already being processed', { jobId: job.id });
      return;
    }

    // Add to current jobs set
    this.currentJobs.add(job.id);

    this.logger.info('Processing job', {
      jobId: job.id,
      groupId: job.group_id,
      priority: job.priority,
      retryCount: job.retry_count
    });

    try {
      // Update status to processing
      await DB.query(`
        UPDATE mirror_group_analysis_queue
        SET status = 'processing', started_at = NOW()
        WHERE id = ?
      `, [job.id]);

      // Execute the analysis
      const result = await this.logger.time(
        `Analysis for group ${job.group_id}`,
        async () => {
          return await groupAnalyzer.analyzeGroup(job.group_id, {
            includeCompatibility: true,
            includeStrengths: true,
            includeConflicts: true,
            includeGoalAlignment: true,
            includeLLMSynthesis: true,
            forceRefresh: true
          });
        }
      );

      // Mark as completed
      await DB.query(`
        UPDATE mirror_group_analysis_queue
        SET
          status = 'completed',
          completed_at = NOW(),
          result_data = ?
        WHERE id = ?
      `, [
        JSON.stringify({
          analysisId: result.analysisId,
          confidence: result.metadata.overallConfidence,
          processingTime: result.metadata.processingTime
        }),
        job.id
      ]);

      this.logger.info('Job completed successfully', {
        jobId: job.id,
        groupId: job.group_id,
        analysisId: result.analysisId,
        confidence: result.metadata.overallConfidence,
        processingTime: result.metadata.processingTime
      });

    } catch (error) {
      this.logger.error('Job processing failed', {
        jobId: job.id,
        groupId: job.group_id,
        error
      });

      // Handle retry logic
      await this.handleJobFailure(job, error);

    } finally {
      // Remove from current jobs
      this.currentJobs.delete(job.id);
    }
  }

  /**
   * Handle job failure with retry logic
   */
  private async handleJobFailure(job: QueueJob, error: any): Promise<void> {
    const retryCount = job.retry_count + 1;

    if (retryCount < this.config.maxRetries) {
      // Schedule retry
      const nextRetryAt = new Date(Date.now() + this.config.retryDelay);

      await DB.query(`
        UPDATE mirror_group_analysis_queue
        SET
          status = 'pending',
          retry_count = ?,
          next_retry_at = ?,
          last_error = ?
        WHERE id = ?
      `, [
        retryCount,
        nextRetryAt,
        error?.message || String(error),
        job.id
      ]);

      this.logger.warn('Job scheduled for retry', {
        jobId: job.id,
        retryCount,
        nextRetryAt
      });

    } else {
      // Max retries exceeded - mark as failed
      await DB.query(`
        UPDATE mirror_group_analysis_queue
        SET
          status = 'failed',
          completed_at = NOW(),
          last_error = ?
        WHERE id = ?
      `, [
        error?.message || String(error),
        job.id
      ]);

      this.logger.error('Job failed permanently (max retries exceeded)', {
        jobId: job.id,
        groupId: job.group_id,
        retries: retryCount
      });
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    const handleShutdown = async (signal: string) => {
      this.logger.info(`Received ${signal}, shutting down gracefully`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('SIGINT', () => handleShutdown('SIGINT'));
  }

  /**
   * Get processor statistics
   */
  getStats(): {
    isRunning: boolean;
    currentJobs: number;
    config: ProcessorConfig;
  } {
    return {
      isRunning: this.isRunning,
      currentJobs: this.currentJobs.size,
      config: this.config
    };
  }

  /**
   * Helper: Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Register shutdown callback
   */
  onShutdown(callback: () => void): void {
    this.shutdownCallback = callback;
  }
}

// Export singleton instance
export const analysisQueueProcessor = new AnalysisQueueProcessor({
  pollInterval: parseInt(process.env.QUEUE_POLL_INTERVAL || '5000'),
  maxConcurrentJobs: parseInt(process.env.QUEUE_MAX_CONCURRENT || '3'),
  maxRetries: parseInt(process.env.QUEUE_MAX_RETRIES || '3')
});

/**
 * Standalone worker entry point
 * Usage: node -r ts-node/register workers/AnalysisQueueProcessor.ts
 */
if (require.main === module) {
  const logger = new Logger('WorkerMain');

  logger.info('Starting Analysis Queue Processor Worker');

  analysisQueueProcessor.start()
    .then(() => {
      logger.info('Worker started successfully');
    })
    .catch((error) => {
      logger.error('Worker failed to start', error);
      process.exit(1);
    });

  // Log stats periodically
  setInterval(() => {
    const stats = analysisQueueProcessor.getStats();
    logger.info('Worker stats', stats);
  }, 60000); // Every minute
}
