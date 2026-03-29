// ============================================================================
// PERSONAL ANALYSIS ROUTES - Mirror-Server
// ============================================================================
// File: routes/personalAnalysis.ts
// ----------------------------------------------------------------------------
// Provides endpoints for personal analysis:
//   POST /mirror/api/personal-analysis/generate — Queue personal analysis job
//   GET  /mirror/api/personal-analysis/latest    — Get latest analysis
//   GET  /mirror/api/personal-analysis/history   — Get analysis history
//
// Data flow (follows TruthStream pattern exactly):
//   1. Frontend → POST /mirror/api/personal-analysis/generate
//   2. Controller validates + gathers data (intake, journal)
//   3. Queues job in personal_analysis_queue table
//   4. PersonalAnalysisQueueProcessor picks up job
//   5. Processor calls dina-server POST /mirror/personal-analysis/generate
//   6. Dina routes through DUMP → mirrorModule.handlePersonalAnalysis()
//   7. personalAnalysisSynthesizer generates LLM analysis
//   8. Response stored in personal_analyses table
//   9. Frontend polls GET /latest until new analysis appears
//
// INTEGRATION: In index.ts, add:
//   import personalAnalysisRouter from './routes/personalAnalysis';
//   app.use('/mirror/api/personal-analysis', personalAnalysisRouter);
// ============================================================================

import express, { RequestHandler, Request, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { DB } from '../db';
import AuthMiddleware from '../middleware/authMiddleware';

const router = express.Router();

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

function getUserIdFromToken(req: Request): string | null {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const decoded = jwt.verify(token, secret) as any;
    return decoded?.id != null ? String(decoded.id) : null;
  } catch {
    return null;
  }
}

// ============================================================================
// RATE LIMIT (simple in-memory, same pattern as truthstreamController)
// ============================================================================

const rateLimits = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_MAX_REQUESTS = 500;
const RATE_LIMIT_WINDOW_MS = 600000; // 10 minutes

function checkAnalysisRateLimit(userId: string): boolean {
  const key = `personal_analysis:${userId}`;
  const now = Date.now();
  const entry = rateLimits.get(key);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  entry.count++;
  return true;
}

// ============================================================================
// POST /generate — Queue personal analysis job
// ============================================================================
// Follows TruthStream's generateAnalysis pattern exactly:
// 1. Validate user
// 2. Rate limit
// 3. Gather intake data + journal entries from DB
// 4. Queue job in personal_analysis_queue
// 5. Return 202 with jobId
// ============================================================================

const generatePersonalAnalysis: RequestHandler = async (req, res) => {
  try {
    const userId = getUserIdFromToken(req);
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const analysisType = req.body.analysisType || 'comprehensive';

    // Rate limit
    if (!checkAnalysisRateLimit(userId)) {
      res.status(429).json({
        success: false,
        error: 'Too many analysis requests. Please wait before requesting another.',
        code: 'RATE_LIMITED',
      });
      return;
    }

    // Validate analysis type
    const validTypes = new Set(['personal_mirror_report', 'journal_trend_analysis', 'growth_trajectory', 'comprehensive']);
    if (!validTypes.has(analysisType)) {
      res.status(400).json({
        success: false,
        error: `Invalid analysis type. Valid: ${[...validTypes].join(', ')}`,
        code: 'INVALID_ANALYSIS_TYPE',
      });
      return;
    }

    // Check for existing pending/processing jobs (prevent duplicates — same as TruthStream)
    const STALE_JOB_MINUTES = 10;
    const connection = await DB.getConnection();
    let jobId: string | null = null;

    try {
      await connection.beginTransaction();

      // Auto-fail stale jobs
      const [staleJobs] = await connection.query(
        `SELECT id FROM personal_analysis_queue
         WHERE user_id = ? AND status = 'processing'
           AND started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
         FOR UPDATE`,
        [userId, STALE_JOB_MINUTES]
      ) as any[];

      if (staleJobs && staleJobs.length > 0) {
        const staleIds = staleJobs.map((j: any) => j.id);
        await connection.query(
          `UPDATE personal_analysis_queue
           SET status = 'failed', error_message = 'Auto-failed: exceeded processing timeout', completed_at = NOW()
           WHERE id IN (${staleIds.map(() => '?').join(',')})`,
          staleIds
        );
      }

      // Check for active jobs
      const [pendingJobs] = await connection.query(
        `SELECT id FROM personal_analysis_queue
         WHERE user_id = ? AND status IN ('pending', 'processing')
         FOR UPDATE`,
        [userId]
      ) as any[];

      if (pendingJobs && pendingJobs.length > 0) {
        await connection.commit();
        res.status(409).json({
          success: false,
          error: 'Analysis is already in progress',
          code: 'ALREADY_PROCESSING',
          data: { jobId: pendingJobs[0].id },
        });
        return;
      }

      // Queue the job
      jobId = crypto.randomUUID();
      await connection.query(
        `INSERT INTO personal_analysis_queue
         (id, user_id, analysis_type, status, priority, input_data, created_at)
         VALUES (?, ?, ?, 'pending', 2, ?, NOW())`,
        [jobId, userId, analysisType, JSON.stringify({ analysisType })]
      );

      await connection.commit();
    } catch (txError) {
      await connection.rollback();
      throw txError;
    } finally {
      connection.release();
    }

    res.status(202).json({
      success: true,
      data: {
        jobId,
        message: 'Personal analysis queued for processing',
        analysisType,
      },
    });

  } catch (error: any) {
    console.error('❌ Error queuing personal analysis:', error.message);
    res.status(500).json({ success: false, error: 'Failed to queue analysis', code: 'SERVER_ERROR' });
  }
};

// ============================================================================
// GET /latest — Get latest personal analysis for current user
// ============================================================================

const getLatestAnalysis: RequestHandler = async (req, res) => {
  try {
    const userId = getUserIdFromToken(req);
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const [rows] = await DB.query(
      `SELECT id, user_id, analysis_type, analysis_data, overall_score,
              confidence_level, journal_entries_analyzed, intake_sections_available,
              created_at
       FROM personal_analyses
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    ) as any[];

    if (!rows || rows.length === 0) {
      res.json({ success: true, data: null });
      return;
    }

    const row = rows[0];
    res.json({
      success: true,
      data: {
        id: row.id,
        analysisType: row.analysis_type,
        analysisData: safeJsonParse(row.analysis_data, {}),
        overallScore: row.overall_score,
        confidenceLevel: row.confidence_level,
        journalEntriesAnalyzed: row.journal_entries_analyzed,
        intakeSectionsAvailable: row.intake_sections_available,
        createdAt: row.created_at,
      },
    });

  } catch (error: any) {
    console.error('❌ Error fetching latest analysis:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch analysis', code: 'SERVER_ERROR' });
  }
};

// ============================================================================
// GET /history — Get analysis history for current user
// ============================================================================

const getAnalysisHistory: RequestHandler = async (req, res) => {
  try {
    const userId = getUserIdFromToken(req);
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 10, 1), 50);

    const [rows] = await DB.query(
      `SELECT id, analysis_type, overall_score, confidence_level,
              journal_entries_analyzed, intake_sections_available, created_at
       FROM personal_analyses
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, limit]
    ) as any[];

    res.json({
      success: true,
      data: (rows || []).map((row: any) => ({
        id: row.id,
        analysisType: row.analysis_type,
        overallScore: row.overall_score,
        confidenceLevel: row.confidence_level,
        journalEntriesAnalyzed: row.journal_entries_analyzed,
        intakeSectionsAvailable: row.intake_sections_available,
        createdAt: row.created_at,
      })),
    });

  } catch (error: any) {
    console.error('❌ Error fetching analysis history:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch history', code: 'SERVER_ERROR' });
  }
};

// ============================================================================
// ROUTE REGISTRATION
// ============================================================================

router.post('/generate',
  AuthMiddleware.rateLimit(5, 3600000) as RequestHandler,
  generatePersonalAnalysis
);

router.get('/latest',
  AuthMiddleware.rateLimit(30, 60000) as RequestHandler,
  getLatestAnalysis
);

router.get('/history',
  AuthMiddleware.rateLimit(20, 60000) as RequestHandler,
  getAnalysisHistory
);

export default router;
