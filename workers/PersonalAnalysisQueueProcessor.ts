// ============================================================================
// PERSONAL ANALYSIS QUEUE PROCESSOR - Separate Worker Process
// ============================================================================
// File: workers/PersonalAnalysisQueueProcessor.ts
// Description: Background worker that processes personal analysis jobs.
//   Follows the EXACT same architecture as TruthStreamQueueProcessor.ts:
//     - Polls personal_analysis_queue table for pending jobs
//     - Gathers intake data + journal entries from database
//     - Calls Dina mirror module via POST /mirror/personal-analysis/generate
//     - Stores results in personal_analyses table
//     - Notifies user via WebSocket
//
// Start: npx ts-node workers/PersonalAnalysisQueueProcessor.ts
// Or via PM2: pm2 start workers/PersonalAnalysisQueueProcessor.ts --name pa-processor
//
// Enterprise features (matching TruthStreamQueueProcessor):
//   - 3-state circuit breaker (closed/open/half-open)
//   - Retry with exponential backoff + jitter
//   - Input sanitization
//   - Graceful shutdown
//   - Stats logging
// ============================================================================

import crypto from 'crypto';
import { DB } from '../db';
import { IntakeDataManager } from '../controllers/intakeController';
import { DataAccessContext } from '../controllers/directoryController';

// ============================================================================
// TYPES
// ============================================================================

interface ProcessingJob {
  id: string;
  user_id: number;
  analysis_type: string;
  status: string;
  retry_count: number;
  max_retries: number;
  input_data: string | Record<string, any>;
  created_at: Date;
}

interface ProcessorConfig {
  pollInterval: number;
  maxRetries: number;
  dinaEndpoint: string;
  dinaServiceKey: string;
  dinaLLMTimeoutMs: number;
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

function extractErrorMessage(error: unknown): string {
  if (error === null || error === undefined) return 'Unknown error';
  if (error instanceof Error) return error.message || 'Error with no message';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const obj = error as any;
    if (obj.message) return String(obj.message);
    if (obj.error) return String(obj.error);
  }
  return String(error);
}

// ============================================================================
// CIRCUIT BREAKER (same as TruthStreamQueueProcessor)
// ============================================================================

class CircuitBreaker {
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private readonly threshold: number;
  private readonly resetTimeMs: number;

  constructor(threshold: number = 5, resetTimeMs: number = 60000) {
    this.threshold = threshold;
    this.resetTimeMs = resetTimeMs;
  }

  canExecute(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeMs) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    return true; // half-open allows one probe
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.threshold) {
      this.state = 'open';
    }
  }

  getState(): string { return this.state; }
}

// ============================================================================
// MAIN PROCESSOR CLASS
// ============================================================================

class PersonalAnalysisQueueProcessor {
  private config: ProcessorConfig;
  private circuitBreaker: CircuitBreaker;
  private isShuttingDown: boolean = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.config = {
      pollInterval: parseInt(process.env.PA_POLL_INTERVAL || '5000', 10),
      maxRetries: parseInt(process.env.PA_MAX_RETRIES || '3', 10),
      dinaEndpoint: process.env.DINA_ENDPOINT || 'http://localhost:8445/dina/api/v1',
      dinaServiceKey: process.env.DINA_SERVICE_KEY || process.env.DINA_API_KEY || '',
      dinaLLMTimeoutMs: parseInt(process.env.PA_DINA_LLM_TIMEOUT || '280000', 10),
    };

    this.circuitBreaker = new CircuitBreaker(
      parseInt(process.env.PA_CIRCUIT_BREAKER_THRESHOLD || '5', 10),
      parseInt(process.env.PA_CIRCUIT_BREAKER_RESET || '60000', 10)
    );
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  async start(): Promise<void> {
    console.log('[PersonalAnalysis] Queue Processor starting...');
    console.log('[PersonalAnalysis] Config:', {
      pollInterval: this.config.pollInterval,
      maxRetries: this.config.maxRetries,
      dinaEndpoint: this.config.dinaEndpoint.replace(/key.*$/i, 'key=***'),
      dinaLLMTimeoutMs: this.config.dinaLLMTimeoutMs,
    });

    // Ensure tables exist
    await this.ensureTablesExist();

    // Start polling
    this.pollTimer = setInterval(() => this.poll(), this.config.pollInterval);
    console.log('[PersonalAnalysis] Queue Processor started');
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[PersonalAnalysis] Queue Processor stopped');
  }

  // ==========================================================================
  // TABLE CREATION
  // ==========================================================================

  private async ensureTablesExist(): Promise<void> {
    // Job queue table
    await DB.query(`
      CREATE TABLE IF NOT EXISTS personal_analysis_queue (
        id VARCHAR(36) PRIMARY KEY,
        user_id INT NOT NULL,
        analysis_type VARCHAR(50) NOT NULL DEFAULT 'comprehensive',
        status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
        priority INT DEFAULT 2,
        retry_count INT DEFAULT 0,
        max_retries INT DEFAULT 3,
        input_data JSON,
        output_data JSON,
        error_message TEXT,
        started_at TIMESTAMP NULL,
        completed_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_status_priority (status, priority DESC),
        INDEX idx_user_id (user_id),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Results table
    await DB.query(`
      CREATE TABLE IF NOT EXISTS personal_analyses (
        id VARCHAR(36) PRIMARY KEY,
        user_id INT NOT NULL,
        analysis_type VARCHAR(50) NOT NULL,
        analysis_data JSON NOT NULL,
        overall_score FLOAT,
        confidence_level FLOAT,
        journal_entries_analyzed INT DEFAULT 0,
        intake_sections_available INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_type (user_id, analysis_type),
        INDEX idx_user_created (user_id, created_at DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('[PersonalAnalysis] Tables verified');
  }

  // ==========================================================================
  // POLL LOOP
  // ==========================================================================

  private async poll(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      // Atomic claim using transaction + FOR UPDATE SKIP LOCKED
      // (matches TruthStreamQueueProcessor pattern exactly)
      const connection = await DB.getConnection();
      let job: ProcessingJob | null = null;

      try {
        await connection.beginTransaction();

        const [rows] = await connection.query(
          `SELECT * FROM personal_analysis_queue
           WHERE status = 'pending'
           ORDER BY priority DESC, created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED`
        ) as any[];

        if (!rows || rows.length === 0) {
          await connection.commit();
          return;
        }

        job = rows[0] as ProcessingJob;

        // Mark as processing within the same transaction
        await connection.query(
          `UPDATE personal_analysis_queue
           SET status = 'processing', started_at = NOW()
           WHERE id = ?`,
          [job.id]
        );

        await connection.commit();
      } catch (txError) {
        await connection.rollback();
        throw txError;
      } finally {
        connection.release();
      }

      if (!job) return;

      console.log(`[PersonalAnalysis] Processing job ${job.id} for user ${job.user_id}`);

      try {
        await this.processJob(job);
        await this.handleJobSuccess(job);
      } catch (error) {
        await this.handleJobFailure(job, error);
      }
    } catch (error) {
      console.error('[PersonalAnalysis] Poll error:', extractErrorMessage(error));
    }
  }

  // ==========================================================================
  // JOB PROCESSING — Gathers data and calls Dina
  // ==========================================================================

  private async processJob(job: ProcessingJob): Promise<void> {
    const inputData = safeJsonParse<Record<string, any>>(job.input_data, {});
    const analysisType = inputData.analysisType || job.analysis_type || 'comprehensive';
    const userId = job.user_id;

    // === 1. GATHER INTAKE DATA (via IntakeDataManager — same as dashboard.ts) ===
    let intakeData: any = {};
    try {
      const context: DataAccessContext = {
        userId: Number(userId),
        accessedBy: Number(userId),
        sessionId: '',
        ipAddress: '',
        userAgent: 'PersonalAnalysisQueueProcessor/1.0',
        reason: 'personal_analysis_queue_processing',
      };

      const result = await IntakeDataManager.getLatestIntakeData(
        String(userId),
        context,
        false // Don't include file contents
      );

      const rawIntake = result?.intakeData || null;

      if (rawIntake) {
        intakeData = {
          personality: rawIntake.personalityResult ? {
            mbtiType: rawIntake.personalityResult.mbtiType,
            big5Profile: rawIntake.personalityResult.big5Profile,
            dominantTraits: rawIntake.personalityResult.dominantTraits,
            description: rawIntake.personalityResult.description,
          } : undefined,

          astrological: rawIntake.astrologicalResult ? {
            sunSign: rawIntake.astrologicalResult?.western?.sunSign,
            moonSign: rawIntake.astrologicalResult?.western?.moonSign,
            risingSign: rawIntake.astrologicalResult?.western?.risingSign,
            dominantElement: rawIntake.astrologicalResult?.western?.dominantElement,
            lifePathNumber: rawIntake.astrologicalResult?.numerology?.lifePathNumber,
            synthesisHighlights: rawIntake.astrologicalResult?.synthesis?.lifeDirection
              || rawIntake.astrologicalResult?.synthesis?.spiritualPath
              || '',
          } : undefined,

          cognitive: rawIntake.iqResults ? {
            iqScore: rawIntake.iqResults.iqScore,
            category: rawIntake.iqResults.category,
            strengths: rawIntake.iqResults.strengths,
          } : undefined,

          emotional: rawIntake.faceAnalysis ? {
            dominantEmotion: getDominantEmotion(rawIntake.faceAnalysis.expressions),
            expressions: rawIntake.faceAnalysis.expressions,
            emotionalStability: rawIntake.personalityResult?.big5Profile?.neuroticism
              ? Math.round(100 - rawIntake.personalityResult.big5Profile.neuroticism)
              : undefined,
          } : undefined,

          voice: rawIntake.voiceMetadata ? {
            quality: assessVoiceQuality(rawIntake.voiceMetadata),
            duration: rawIntake.voiceMetadata.duration,
          } : undefined,

          completionPercentage: (() => {
            let completed = 0;
            if (rawIntake.personalityResult) completed++;
            if (rawIntake.astrologicalResult) completed++;
            if (rawIntake.iqResults) completed++;
            if (rawIntake.faceAnalysis) completed++;
            if (rawIntake.voiceMetadata) completed++;
            return Math.round((completed / 5) * 100);
          })(),
        };

        console.log('[PersonalAnalysis] Intake data loaded via IntakeDataManager:', {
          hasPersonality: !!rawIntake.personalityResult,
          hasAstrology: !!rawIntake.astrologicalResult,
          hasIQ: !!rawIntake.iqResults,
          hasFace: !!rawIntake.faceAnalysis,
          hasVoice: !!rawIntake.voiceMetadata,
        });
      }
    } catch (error) {
      console.warn('[PersonalAnalysis] Failed to load intake data:', extractErrorMessage(error));
    }

    // === 2. GATHER JOURNAL ENTRIES ===
    let journalEntries: any[] = [];
    try {
      const [journalRows] = await DB.query(
        `SELECT entry_date, time_of_day, mood_rating, primary_emotion,
                emotion_intensity, energy_level, free_form_entry, tags,
                sentiment_score, dominant_themes, word_count
         FROM mirror_journal_entries
         WHERE user_id = ? AND deleted_at IS NULL
         ORDER BY entry_date DESC, created_at DESC
         LIMIT 100`,
        [userId]
      ) as any[];

      if (journalRows && journalRows.length > 0) {
        journalEntries = journalRows.map((r: any) => ({
          entryDate: r.entry_date,
          timeOfDay: r.time_of_day,
          moodRating: r.mood_rating,
          primaryEmotion: r.primary_emotion,
          emotionIntensity: r.emotion_intensity,
          energyLevel: r.energy_level,
          freeFormEntry: r.free_form_entry ? String(r.free_form_entry).substring(0, 500) : undefined,
          tags: safeJsonParse(r.tags, []),
          sentimentScore: r.sentiment_score,
          dominantThemes: safeJsonParse(r.dominant_themes, []),
          wordCount: r.word_count,
        }));
      }
    } catch (error) {
      console.warn('[PersonalAnalysis] Failed to load journal entries:', extractErrorMessage(error));
    }

    // === 3. GET PREVIOUS ANALYSIS ===
    let previousAnalysis: any = null;
    try {
      const [prevRows] = await DB.query(
        `SELECT overall_score, created_at, analysis_data
         FROM personal_analyses
         WHERE user_id = ? AND analysis_type = ?
         ORDER BY created_at DESC LIMIT 1`,
        [userId, analysisType]
      ) as any[];

      if (prevRows && prevRows.length > 0) {
        const prevData = safeJsonParse<any>(prevRows[0].analysis_data, {});
        previousAnalysis = {
          overallScore: prevRows[0].overall_score,
          generatedAt: prevRows[0].created_at,
          keyInsights: prevData.growthRecommendations?.map((r: any) => r.recommendation)?.slice(0, 5) || [],
          dimensionScores: prevData.dimensionScores || {},
        };
      }
    } catch {
      // Non-critical
    }

    // === 4. CALL DINA MIRROR MODULE ===
    console.log(`[PersonalAnalysis] Calling Dina for user ${userId}: ${journalEntries.length} journal entries, intake sections: ${Object.keys(intakeData).filter(k => intakeData[k]).length}`);

    const result = await this.callDinaEndpoint('/mirror/personal-analysis/generate', {
      userId: String(userId),
      analysisType,
      intakeData,
      journalEntries,
      previousAnalysis,
    });

    if (!result.success || !result.data) {
      throw new Error(result.error || result.message || 'Analysis returned unsuccessful response');
    }

    const analysis = result.data;

    // === 5. STORE RESULTS ===
    const analysisId = crypto.randomUUID();

    await DB.query(
      `INSERT INTO personal_analyses
       (id, user_id, analysis_type, analysis_data, overall_score,
        confidence_level, journal_entries_analyzed, intake_sections_available, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        analysisId,
        userId,
        analysis.analysisType || analysisType,
        JSON.stringify(analysis.analysisData),
        analysis.overallScore || null,
        analysis.confidenceLevel || null,
        analysis.metadata?.journalEntriesAnalyzed || journalEntries.length,
        analysis.metadata?.intakeSectionsAvailable || 0,
      ]
    );

    // Update queue job with output
    await DB.query(
      `UPDATE personal_analysis_queue SET output_data = ? WHERE id = ?`,
      [JSON.stringify({ analysisId, type: analysis.analysisType }), job.id]
    );

    // Notify user via WebSocket (best-effort)
    try {
      const notifModule = require('../systems/mirrorGroupNotifications');
      if (notifModule?.mirrorGroupNotifications?.notify) {
        await notifModule.mirrorGroupNotifications.notify(userId, {
          type: 'personal_analysis_complete',
          payload: { analysisId, analysisType: analysis.analysisType },
        });
      }
    } catch {
      // Non-critical
    }

    console.log(`[PersonalAnalysis] Analysis ${analysisId} saved for user ${userId}`);
  }

  // ==========================================================================
  // DINA ENDPOINT CALL (matches TruthStreamQueueProcessor.callDinaEndpoint)
  // ==========================================================================

  private async callDinaEndpoint(path: string, body: any): Promise<any> {
    if (!this.circuitBreaker.canExecute()) {
      throw new Error(`Dina service unavailable: Circuit breaker ${this.circuitBreaker.getState().toUpperCase()}`);
    }

    const maxRetries = 3;
    const baseDelays = [1000, 2000, 4000];
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const url = this.buildDinaEndpointUrl(path);

        console.log(`[PersonalAnalysis] Calling Dina: ${url} (attempt ${attempt + 1})`);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.dinaServiceKey}`,
            'User-Agent': 'MirrorPersonalAnalysis/1.0',
            'X-Request-Attempt': String(attempt + 1),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.dinaLLMTimeoutMs),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          throw new Error(`Dina error: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`);
        }

        const result = await response.json();

        if (!result.success) {
          throw new Error(`Dina returned error: ${result.error || result.message || 'unsuccessful response'}`);
        }

        this.circuitBreaker.recordSuccess();
        return result;

      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(extractErrorMessage(error));

        if (attempt < maxRetries - 1) {
          const delay = baseDelays[attempt] + Math.floor(Math.random() * baseDelays[attempt] * 0.3);
          console.warn(`[PersonalAnalysis] Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${lastError.message}`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    this.circuitBreaker.recordFailure();
    throw lastError || new Error(`All ${maxRetries} retries exhausted for ${path}`);
  }

  private buildDinaEndpointUrl(path: string): string {
    const baseUrl = this.config.dinaEndpoint.replace(/\/$/, '');
    try {
      const parsed = new URL(baseUrl);
      if (parsed.pathname.endsWith('/api/v1')) {
        return baseUrl.replace(/\/api\/v1$/, '') + '/api/v1' + path;
      }
      return baseUrl + path;
    } catch {
      return baseUrl + path;
    }
  }

  // ==========================================================================
  // JOB LIFECYCLE
  // ==========================================================================

  private async handleJobSuccess(job: ProcessingJob): Promise<void> {
    await DB.query(
      `UPDATE personal_analysis_queue SET status = 'completed', completed_at = NOW() WHERE id = ?`,
      [job.id]
    );
    console.log(`[PersonalAnalysis] Job ${job.id} completed`);
  }

  private async handleJobFailure(job: ProcessingJob, error: unknown): Promise<void> {
    const errorMsg = extractErrorMessage(error);
    const retryCount = (job.retry_count || 0) + 1;
    const maxRetries = job.max_retries || this.config.maxRetries;

    if (retryCount < maxRetries) {
      await DB.query(
        `UPDATE personal_analysis_queue
         SET status = 'pending', retry_count = ?, error_message = ?, started_at = NULL
         WHERE id = ?`,
        [retryCount, errorMsg, job.id]
      );
      console.warn(`[PersonalAnalysis] Job ${job.id} failed, retry ${retryCount}/${maxRetries}: ${errorMsg}`);
    } else {
      await DB.query(
        `UPDATE personal_analysis_queue
         SET status = 'failed', retry_count = ?, error_message = ?, completed_at = NOW()
         WHERE id = ?`,
        [retryCount, errorMsg, job.id]
      );
      console.error(`[PersonalAnalysis] Job ${job.id} permanently failed: ${errorMsg}`);
    }
  }
}

// ============================================================================
// HELPER FUNCTIONS (same as dashboard.ts)
// ============================================================================

function getDominantEmotion(expressions: any): { emotion: string; confidence: number } {
  if (!expressions) return { emotion: 'neutral', confidence: 0 };
  const entries = Object.entries(expressions);
  return entries.reduce((max, [emotion, value]) =>
    (value as number) > max.confidence ? { emotion, confidence: value as number } : max,
    { emotion: 'neutral', confidence: 0 }
  );
}

function assessVoiceQuality(voice: any): string {
  const duration = voice?.duration || 0;
  if (duration > 5) return 'Excellent';
  if (duration > 3) return 'Good';
  if (duration > 1) return 'Fair';
  return 'Minimal';
}

// ============================================================================
// ENTRY POINT (when run as standalone worker)
// ============================================================================

if (require.main === module) {
  const processor = new PersonalAnalysisQueueProcessor();

  process.on('SIGTERM', async () => {
    console.log('[PersonalAnalysis] SIGTERM received, shutting down...');
    await processor.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[PersonalAnalysis] SIGINT received, shutting down...');
    await processor.stop();
    process.exit(0);
  });

  processor.start().catch((err) => {
    console.error('[PersonalAnalysis] Failed to start:', err);
    process.exit(1);
  });
}

export { PersonalAnalysisQueueProcessor };
