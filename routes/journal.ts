// server/routes/journal.ts
// Enhanced journal routes with production-ready security

import express, { RequestHandler, Request } from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { DB } from '../db';
import AuthMiddleware from '../middleware/authMiddleware';
import {
  validateJournalEntry,
  sanitizeJournalEntry,
  sanitizeTags,
  checkEntryRateLimit,
  calculateEntryStats,
  generateErrorResponse,
  JOURNAL_CONSTANTS
} from '../utils/journalSecurityHelpers';

const router = express.Router();

/* ============================================================================
   HELPERS
============================================================================ */

function safeJsonParse<T = any>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

function getUserFromToken(req: express.Request): string | null {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;

    const token = authHeader.slice(7);
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error('❌ JWT_SECRET is not set');
      return null;
    }
    const decoded = jwt.verify(token, secret) as any;
    return decoded?.id != null ? String(decoded.id) : null;
  } catch (error) {
    console.error('❌ JWT verification error:', error);
    return null;
  }
}

function isISODate(dateStr: unknown): dateStr is string {
  return typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
    return Number(value);
  }
  return fallback;
}

function sanitizeLimit(value: unknown, fallback = 50, max = 500): number {
  const n = Math.max(0, Math.min(max, Math.floor(toNumber(value, fallback))));
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeOffset(value: unknown, fallback = 0): number {
  const n = Math.max(0, Math.floor(toNumber(value, fallback)));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Get count of entries created today by user
 * Used for rate limiting
 */
async function getEntriesCreatedToday(userId: string): Promise<number> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [rows] = await DB.query(
      `SELECT COUNT(*) as count FROM mirror_journal_entries 
       WHERE user_id = ? AND DATE(created_at) = ? AND deleted_at IS NULL`,
      [userId, today]
    );
    return (rows as any)[0]?.count || 0;
  } catch (error) {
    console.error('❌ Error counting today\'s entries:', error);
    return 0;
  }
}

/* ============================================================================
   CREATE JOURNAL ENTRY (PRODUCTION-HARDENED)
============================================================================ */

export const createJournalEntryHandler: RequestHandler = async (req, res) => {
  const startTime = Date.now();
  
  try {
    const userId = getUserFromToken(req);
    if (!userId) {
      res.status(401).json({ 
        success: false, 
        error: 'Unauthorized', 
        code: 'NO_AUTH' 
      });
      return;
    }

    console.log(`📝 Creating journal entry for user ${userId}`);

    // SECURITY: Rate limiting check
    const entriesToday = await getEntriesCreatedToday(userId);
    const rateCheck = checkEntryRateLimit(entriesToday, 20);
    
    if (!rateCheck.allowed) {
      console.warn(`⚠️ Rate limit exceeded for user ${userId}: ${entriesToday} entries today`);
      res.status(429).json({
        success: false,
        error: rateCheck.message,
        code: 'RATE_LIMIT_EXCEEDED',
        details: {
          entriesCreatedToday: entriesToday,
          maxEntriesPerDay: 20
        }
      });
      return;
    }

    // SECURITY: Comprehensive validation
    const validationResult = validateJournalEntry(req.body);
    
    if (!validationResult.valid) {
      console.warn(`⚠️ Validation failed for user ${userId}:`, validationResult.errors);
      const errorResponse = generateErrorResponse(validationResult);
      res.status(400).json({
        success: false,
        ...errorResponse,
        code: 'VALIDATION_FAILED'
      });
      return;
    }

    // SECURITY: Sanitize all inputs
    const sanitizedData = sanitizeJournalEntry(req.body);
    
    const {
      entryDate,
      timeOfDay,
      moodRating,
      primaryEmotion,
      emotionIntensity,
      energyLevel,
      promptResponses,
      freeFormEntry,
      tags,
      category,
    } = sanitizedData;

    // Check for duplicate (date + timeOfDay)
    const [existing] = await DB.query(
      `SELECT id FROM mirror_journal_entries 
       WHERE user_id = ? AND entry_date = ? AND time_of_day = ? AND deleted_at IS NULL`,
      [userId, entryDate, timeOfDay]
    );
    
    const existingRows = existing as Array<{ id: string }>;
    if (existingRows.length > 0) {
      res.status(409).json({
        success: false,
        error: 'Entry already exists for this date/time',
        code: 'DUPLICATE_ENTRY',
        existingEntryId: existingRows[0].id
      });
      return;
    }

    // Calculate analytics
    const { wordCount, sentimentScore } = calculateEntryStats(freeFormEntry);

    // Create entry with sanitized data
    const entryId = uuidv4();
    
    await DB.query(
      `INSERT INTO mirror_journal_entries (
        id, user_id, entry_date, time_of_day,
        mood_rating, primary_emotion, emotion_intensity, energy_level,
        prompt_responses, free_form_entry, tags, category,
        is_private, word_count, sentiment_score, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?, NOW())`,
      [
        entryId, userId, entryDate, timeOfDay,
        moodRating, primaryEmotion, emotionIntensity, energyLevel,
        JSON.stringify(promptResponses),
        freeFormEntry,
        JSON.stringify(tags),
        category,
        wordCount,
        sentimentScore
      ]
    );

    const duration = Date.now() - startTime;
    console.log(`✅ Journal entry created: ${entryId} for user ${userId} (${duration}ms)`);

    res.status(201).json({
      success: true,
      data: { 
        entryId, 
        message: 'Journal entry created successfully' 
      },
      meta: {
        processingTimeMs: duration,
        entriesCreatedToday: entriesToday + 1,
        remainingToday: 20 - (entriesToday + 1)
      }
    });
    
  } catch (error) {
    console.error('❌ Error creating journal entry:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create journal entry',
      code: 'INTERNAL_ERROR',
      details: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined
    });
  }
};

/* ============================================================================
   GET ENTRY BY DATE
============================================================================ */

export const getEntryByDateHandler: RequestHandler = async (req, res) => {
  try {
    const userId = getUserFromToken(req);
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

    const { date } = req.params;
    const timeOfDayRaw = (req.query?.timeOfDay ?? null);
    const timeOfDay = Array.isArray(timeOfDayRaw) ? timeOfDayRaw[0] : timeOfDayRaw;

    // SECURITY: Validate date format
    if (!isISODate(date)) {
      res.status(400).json({ 
        success: false, 
        error: 'Invalid date format. Use YYYY-MM-DD',
        code: 'INVALID_DATE_FORMAT'
      });
      return;
    }

    // SECURITY: Validate timeOfDay if provided
    if (timeOfDay && typeof timeOfDay === 'string' && 
        !JOURNAL_CONSTANTS.VALID_TIMES_OF_DAY.includes(timeOfDay as any)) {
      res.status(400).json({
        success: false,
        error: `Invalid time of day. Must be one of: ${JOURNAL_CONSTANTS.VALID_TIMES_OF_DAY.join(', ')}`,
        code: 'INVALID_TIME_OF_DAY'
      });
      return;
    }

    let sql = `
      SELECT 
        id, entry_date, time_of_day, mood_rating, primary_emotion,
        emotion_intensity, energy_level, prompt_responses, free_form_entry,
        tags, category, word_count, sentiment_score, created_at, updated_at
      FROM mirror_journal_entries
      WHERE user_id = ? AND entry_date = ? AND deleted_at IS NULL
    `;
    const params: any[] = [userId, date];

    if (typeof timeOfDay === 'string' && timeOfDay.trim()) {
      sql += ` AND time_of_day = ?`;
      params.push(timeOfDay);
    }
    sql += ` ORDER BY time_of_day ASC`;

    const [rows] = await DB.query(sql, params);
    const entries = rows as any[];

    if (entries.length === 0) {
      res.status(404).json({
        success: false,
        error: 'No journal entries found for this date',
        code: 'NOT_FOUND',
        date,
        timeOfDay: typeof timeOfDay === 'string' ? timeOfDay : 'any'
      });
      return;
    }

    // SECURITY: Sanitize output (parse JSON fields safely)
    const parsedEntries = entries.map((e) => ({
      id: e.id,
      entryDate: e.entry_date,
      timeOfDay: e.time_of_day,
      moodRating: e.mood_rating,
      primaryEmotion: e.primary_emotion,
      emotionIntensity: e.emotion_intensity,
      energyLevel: e.energy_level,
      promptResponses: safeJsonParse(e.prompt_responses, {}),
      freeFormEntry: e.free_form_entry,
      tags: safeJsonParse<string[]>(e.tags, []),
      category: e.category,
      wordCount: e.word_count,
      sentimentScore: e.sentiment_score,
      createdAt: e.created_at,
      updatedAt: e.updated_at
    }));

    console.log(`✅ Retrieved ${parsedEntries.length} entry(ies) for date ${date}`);

    res.json({
      success: true,
      data: { date, entries: parsedEntries, count: parsedEntries.length }
    });
    
  } catch (error) {
    console.error('❌ Error retrieving entry by date:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve journal entry',
      code: 'INTERNAL_ERROR',
      details: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined
    });
  }
};

/* ============================================================================
   GET ALL ENTRIES (WITH FILTERS)
============================================================================ */

export const getAllEntriesHandler: RequestHandler = async (req, res) => {
  try {
    const userId = getUserFromToken(req);
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

    const { startDate, endDate } = req.query;
    const limit = sanitizeLimit(req.query.limit, 50, 500);
    const offset = sanitizeOffset(req.query.offset, 0);

    // SECURITY: Validate date formats if provided
    if (startDate && !isISODate(startDate)) {
      res.status(400).json({ 
        success: false, 
        error: 'Invalid startDate format. Use YYYY-MM-DD',
        code: 'INVALID_DATE_FORMAT' 
      });
      return;
    }
    
    if (endDate && !isISODate(endDate)) {
      res.status(400).json({ 
        success: false, 
        error: 'Invalid endDate format. Use YYYY-MM-DD',
        code: 'INVALID_DATE_FORMAT'
      });
      return;
    }

    let sql = `
      SELECT 
        id, entry_date, time_of_day, mood_rating, primary_emotion,
        emotion_intensity, energy_level, word_count, sentiment_score,
        tags, created_at
      FROM mirror_journal_entries
      WHERE user_id = ? AND deleted_at IS NULL
    `;
    const params: any[] = [userId];

    if (isISODate(startDate)) { 
      sql += ` AND entry_date >= ?`; 
      params.push(startDate); 
    }
    
    if (isISODate(endDate)) { 
      sql += ` AND entry_date <= ?`; 
      params.push(endDate); 
    }

    sql += ` ORDER BY entry_date DESC, time_of_day ASC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await DB.query(sql, params);
    const entries = rows as any[];

    // SECURITY: Sanitize output
    const parsedEntries = entries.map((e) => ({
      id: e.id,
      entryDate: e.entry_date,
      timeOfDay: e.time_of_day,
      moodRating: e.mood_rating,
      primaryEmotion: e.primary_emotion,
      emotionIntensity: e.emotion_intensity,
      energyLevel: e.energy_level,
      wordCount: e.word_count,
      sentimentScore: e.sentiment_score,
      tags: safeJsonParse<string[]>(e.tags, []),
      createdAt: e.created_at
    }));

    // Get total count for pagination
    const [countRows] = await DB.query(
      `SELECT COUNT(*) as total FROM mirror_journal_entries 
       WHERE user_id = ? AND deleted_at IS NULL`,
      [userId]
    );
    const total = (countRows as any)[0]?.total || 0;

    console.log(`✅ Retrieved ${parsedEntries.length} entries for user ${userId}`);

    res.json({
      success: true,
      data: { 
        entries: parsedEntries,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + parsedEntries.length < total
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Error retrieving journal entries:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve journal entries',
      code: 'INTERNAL_ERROR',
      details: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined
    });
  }
};

/* ============================================================================
   SEARCH ENTRIES
============================================================================ */

export const searchEntriesHandler: RequestHandler = async (req, res) => {
  try {
    const userId = getUserFromToken(req);
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

    const { q } = req.query;
    const query = typeof q === 'string' ? q.trim() : '';
    
    // SECURITY: Require minimum query length
    if (query.length < 2) {
      res.status(400).json({
        success: false,
        error: 'Search query must be at least 2 characters',
        code: 'QUERY_TOO_SHORT'
      });
      return;
    }

    // SECURITY: Limit query length
    if (query.length > 200) {
      res.status(400).json({
        success: false,
        error: 'Search query too long (max 200 characters)',
        code: 'QUERY_TOO_LONG'
      });
      return;
    }

    const limit = sanitizeLimit(req.query.limit, 20, 100);

    // Search in free_form_entry and tags
    const sql = `
      SELECT 
        id, entry_date, time_of_day, mood_rating, primary_emotion,
        emotion_intensity, energy_level, free_form_entry, tags, created_at
      FROM mirror_journal_entries
      WHERE user_id = ? AND deleted_at IS NULL
        AND (free_form_entry LIKE ? OR tags LIKE ?)
      ORDER BY entry_date DESC
      LIMIT ?
    `;
    
    const searchPattern = `%${query}%`;
    const [rows] = await DB.query(sql, [userId, searchPattern, searchPattern, limit]);
    const entries = rows as any[];

    const parsedEntries = entries.map((e) => ({
      id: e.id,
      entryDate: e.entry_date,
      timeOfDay: e.time_of_day,
      moodRating: e.mood_rating,
      primaryEmotion: e.primary_emotion,
      emotionIntensity: e.emotion_intensity,
      energyLevel: e.energy_level,
      freeFormEntry: e.free_form_entry,
      tags: safeJsonParse<string[]>(e.tags, []),
      createdAt: e.created_at
    }));

    console.log(`✅ Search "${query}" returned ${parsedEntries.length} results for user ${userId}`);

    res.json({
      success: true,
      data: { 
        entries: parsedEntries,
        query,
        count: parsedEntries.length
      }
    });
    
  } catch (error) {
    console.error('❌ Error searching entries:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search journal entries',
      code: 'INTERNAL_ERROR',
      details: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined
    });
  }
};

/* ============================================================================
   ANALYTICS: MOOD TREND
============================================================================ */

export const getMoodTrendHandler: RequestHandler = async (req, res) => {
  try {
    const userId = getUserFromToken(req);
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

    // Default to last 30 days
    const endDefault = new Date().toISOString().split('T')[0];
    const startDefault = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const start = isISODate(req.query.startDate) ? (req.query.startDate as string) : startDefault;
    const end = isISODate(req.query.endDate) ? (req.query.endDate as string) : endDefault;

    const [rows] = await DB.query(
      `SELECT 
        entry_date,
        AVG(mood_rating) AS avg_mood,
        AVG(energy_level) AS avg_energy,
        AVG(emotion_intensity) AS avg_intensity,
        COUNT(*) AS entry_count
       FROM mirror_journal_entries
       WHERE user_id = ?
         AND entry_date BETWEEN ? AND ?
         AND deleted_at IS NULL
       GROUP BY entry_date
       ORDER BY entry_date ASC`,
      [userId, start, end]
    );

    const results = rows as Array<{
      entry_date: string;
      avg_mood: number | string;
      avg_energy: number | string;
      avg_intensity: number | string;
      entry_count: number;
    }>;

    const trendData = results.map(r => ({
      date: r.entry_date,
      avgMood: Number.parseFloat(String(r.avg_mood)),
      avgEnergy: Number.parseFloat(String(r.avg_energy)),
      avgIntensity: Number.parseFloat(String(r.avg_intensity)),
      entryCount: r.entry_count
    }));

    res.json({
      success: true,
      data: { 
        trend: trendData, 
        period: { start, end }, 
        dataPoints: trendData.length 
      }
    });
    
  } catch (error) {
    console.error('❌ Error getting mood trend:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve mood trend',
      code: 'INTERNAL_ERROR',
      details: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined
    });
  }
};

/* ============================================================================
   ROUTE REGISTRATION WITH AUTHENTICATION
============================================================================ */

// Create entry (with rate limiting at route level)
router.post('/entry', 
  createJournalEntryHandler
);

// Read operations
router.get('/entry/date/:date', 
  getEntryByDateHandler
);

router.get('/entries', 
  getAllEntriesHandler
);

router.get('/search',
  searchEntriesHandler
);

router.get('/analytics/mood-trend', 
  getMoodTrendHandler
);

export default router;
