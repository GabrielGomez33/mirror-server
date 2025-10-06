// routes/journal.ts
// Journal routes with FIXED JSON parsing & robust TS guards

import express, { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { DB } from '../db';

const router = express.Router();

/* ============================================================================
   HELPERS
============================================================================ */

function safeJsonParse<T = any>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T; // assume already parsed
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
    // normalize to string to avoid type mismatch in DB bindings
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

function calculateSimpleSentiment(text: string): number {
  if (!text) return 0;
  const positiveWords = [
    'happy','great','good','excellent','wonderful','amazing','love',
    'grateful','blessed','joy','excited','proud','accomplished'
  ];
  const negativeWords = [
    'sad','bad','terrible','awful','hate','angry','frustrated',
    'anxious','worried','stressed','depressed','lonely','tired'
  ];
  const lowercaseText = text.toLowerCase();
  let score = 0;
  for (const w of positiveWords) if (lowercaseText.includes(w)) score += 0.1;
  for (const w of negativeWords) if (lowercaseText.includes(w)) score -= 0.1;
  return Math.max(-1, Math.min(1, score));
}

/* ============================================================================
   CREATE JOURNAL ENTRY
============================================================================ */

export const createJournalEntryHandler: RequestHandler = async (req, res) => {
  try {
    const userId = getUserFromToken(req);
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

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
      category
    } = req.body ?? {};

    // Validation (be careful: 0 is valid for numbers)
    if (!isISODate(entryDate)) {
      res.status(400).json({ success: false, error: 'Invalid or missing entryDate (YYYY-MM-DD)' });
      return;
    }
    if (typeof timeOfDay !== 'string' || !timeOfDay.trim()) {
      res.status(400).json({ success: false, error: 'Missing or invalid timeOfDay' });
      return;
    }
    const mood = toNumber(moodRating, NaN);
    const intensity = toNumber(emotionIntensity, NaN);
    const energy = toNumber(energyLevel, NaN);
    if (!Number.isFinite(mood) || !Number.isFinite(intensity) || !Number.isFinite(energy)) {
      res.status(400).json({
        success: false,
        error: 'Invalid numeric fields',
        required: ['moodRating:number', 'emotionIntensity:number', 'energyLevel:number']
      });
      return;
    }
    if (typeof primaryEmotion !== 'string' || !primaryEmotion.trim()) {
      res.status(400).json({ success: false, error: 'Missing or invalid primaryEmotion' });
      return;
    }

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
        existingEntryId: existingRows[0].id
      });
      return;
    }

    const freeText = typeof freeFormEntry === 'string' ? freeFormEntry : '';
    const wordCount =
      freeText.trim() === '' ? 0 : freeText.trim().split(/\s+/).length;
    const sentimentScore = calculateSimpleSentiment(freeText);

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
        mood, primaryEmotion, intensity, energy,
        JSON.stringify(promptResponses ?? {}),
        freeText || null,
        JSON.stringify(tags ?? []),
        typeof category === 'string' && category.trim() ? category : null,
        wordCount,
        sentimentScore
      ]
    );

    console.log(`✅ Journal entry created: ${entryId} for user ${userId}`);

    res.status(201).json({
      success: true,
      data: { entryId, message: 'Journal entry created successfully' }
    });
  } catch (error) {
    console.error('❌ Error creating journal entry:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create journal entry',
      details: (error as Error).message
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
    const timeOfDay =
      Array.isArray(timeOfDayRaw) ? timeOfDayRaw[0] : timeOfDayRaw;

    if (!isISODate(date)) {
      res.status(400).json({ success: false, error: 'Invalid date format. Use YYYY-MM-DD' });
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
        date,
        timeOfDay: typeof timeOfDay === 'string' ? timeOfDay : 'any'
      });
      return;
    }

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
      details: (error as Error).message
    });
  }
};

/* ============================================================================
   GET ALL ENTRIES
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

    let sql = `
      SELECT 
        id, entry_date, time_of_day, mood_rating, primary_emotion,
        emotion_intensity, energy_level, word_count, sentiment_score,
        tags, created_at
      FROM mirror_journal_entries
      WHERE user_id = ? AND deleted_at IS NULL
    `;
    const params: any[] = [userId];

    if (isISODate(startDate)) { sql += ` AND entry_date >= ?`; params.push(startDate); }
    if (isISODate(endDate))   { sql += ` AND entry_date <= ?`; params.push(endDate); }

    sql += ` ORDER BY entry_date DESC, time_of_day ASC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await DB.query(sql, params);
    const entries = rows as any[];

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

    res.json({
      success: true,
      data: { entries: parsedEntries, count: parsedEntries.length }
    });
  } catch (error) {
    console.error('❌ Error retrieving journal entries:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve journal entries',
      details: (error as Error).message
    });
  }
};

/* ============================================================================
   GET MOOD TREND
============================================================================ */

export const getMoodTrendHandler: RequestHandler = async (req, res) => {
  try {
    const userId = getUserFromToken(req);
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

    const startDefault = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0];
    const endDefault = new Date().toISOString().split('T')[0];

    const start = isISODate(req.query.startDate) ? (req.query.startDate as string) : startDefault;
    const end   = isISODate(req.query.endDate)   ? (req.query.endDate as string)   : endDefault;

    const [rows] = await DB.query(
      `SELECT 
        entry_date,
        AVG(mood_rating)         AS avg_mood,
        AVG(energy_level)        AS avg_energy,
        AVG(emotion_intensity)   AS avg_intensity,
        COUNT(*)                 AS entry_count
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
      data: { trend: trendData, period: { start, end }, dataPoints: trendData.length }
    });
  } catch (error) {
    console.error('❌ Error getting mood trend:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve mood trend',
      details: (error as Error).message
    });
  }
};

/* ============================================================================
   ROUTE REGISTRATION
============================================================================ */

router.post('/entry', createJournalEntryHandler);
router.get('/entry/date/:date', getEntryByDateHandler);
router.get('/entries', getAllEntriesHandler);
router.get('/analytics/mood-trend', getMoodTrendHandler);

export default router;
