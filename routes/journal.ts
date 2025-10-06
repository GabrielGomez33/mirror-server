// routes/journal.ts
// Journal routes following EXACT pattern from routes/intake.ts

import express, { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import {DB} from '../db';

const router = express.Router();

// ============================================================================
// TYPES
// ============================================================================

interface JournalEntry {
  id: string;
  userId: string;
  entryDate: string;
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
  moodRating: number;
  primaryEmotion: string;
  emotionIntensity: number;
  energyLevel: number;
  promptResponses?: any;
  freeFormEntry?: string;
  tags?: string[];
  category?: string;
}

// ============================================================================
// HELPER: Verify JWT and Get User ID
// ============================================================================

function getUserFromToken(req: express.Request): string | null {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return null;
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_KEY!) as any;
    return String(decoded.id);
  } catch {
    return null;
  }
}

// ============================================================================
// CREATE JOURNAL ENTRY
// ============================================================================

export const createJournalEntryHandler: RequestHandler = async (req, res) => {
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
    } = req.body;

    // Validation
    if (!entryDate || !timeOfDay || !moodRating || !primaryEmotion) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['entryDate', 'timeOfDay', 'moodRating', 'primaryEmotion']
      });
      return;
    }

    // Check for existing entry
    const [existing] = await DB.query(
      `SELECT id FROM mirror_journal_entries 
       WHERE user_id = ? AND entry_date = ? AND time_of_day = ? AND deleted_at IS NULL`,
      [userId, entryDate, timeOfDay]
    );

    if ((existing as any[]).length > 0) {
      res.status(409).json({
        success: false,
        error: 'Entry already exists for this date/time',
        existingEntryId: (existing as any[])[0].id
      });
      return;
    }

    // Calculate word count and sentiment
    const wordCount = freeFormEntry ? freeFormEntry.split(/\s+/).length : 0;
    const sentimentScore = 0; // TODO: Implement sentiment analysis

    // Create entry
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
        JSON.stringify(promptResponses || {}),
        freeFormEntry || null,
        JSON.stringify(tags || []),
        category || null,
        wordCount,
        sentimentScore
      ]
    );

    console.log(`✅ Journal entry created: ${entryId} for user ${userId}`);

    res.status(201).json({
      success: true,
      data: {
        entryId,
        message: 'Journal entry created successfully'
      }
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

// ============================================================================
// GET ENTRY BY DATE
// ============================================================================

export const getEntryByDateHandler: RequestHandler = async (req, res) => {
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

    const { date } = req.params;
    const { timeOfDay } = req.query;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({
        success: false,
        error: 'Invalid date format. Use YYYY-MM-DD'
      });
      return;
    }

    let query = `
      SELECT 
        id, entry_date, time_of_day, mood_rating, primary_emotion,
        emotion_intensity, energy_level, prompt_responses, free_form_entry,
        tags, category, word_count, sentiment_score, created_at, updated_at
      FROM mirror_journal_entries
      WHERE user_id = ? AND entry_date = ? AND deleted_at IS NULL
    `;

    const params: any[] = [userId, date];

    if (timeOfDay) {
      query += ` AND time_of_day = ?`;
      params.push(timeOfDay);
    }

    query += ` ORDER BY time_of_day ASC`;

    const [entries] = await DB.query(query, params);

    if ((entries as any[]).length === 0) {
      res.status(404).json({
        success: false,
        error: 'No journal entries found for this date'
      });
      return;
    }

    // Parse JSON fields
    const parsedEntries = (entries as any[]).map((entry: any) => ({
      ...entry,
      promptResponses: JSON.parse(entry.prompt_responses || '{}'),
      tags: JSON.parse(entry.tags || '[]')
    }));

    res.json({
      success: true,
      data: {
        date,
        entries: parsedEntries,
        count: parsedEntries.length
      }
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

// ============================================================================
// GET ALL ENTRIES (with filters)
// ============================================================================

export const getAllEntriesHandler: RequestHandler = async (req, res) => {
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

    const {
      startDate,
      endDate,
      limit = '50',
      offset = '0'
    } = req.query;

    let query = `
      SELECT 
        id, entry_date, time_of_day, mood_rating, primary_emotion,
        emotion_intensity, energy_level, word_count, sentiment_score,
        created_at
      FROM mirror_journal_entries
      WHERE user_id = ? AND deleted_at IS NULL
    `;

    const params: any[] = [userId];

    if (startDate) {
      query += ` AND entry_date >= ?`;
      params.push(startDate);
    }

    if (endDate) {
      query += ` AND entry_date <= ?`;
      params.push(endDate);
    }

    query += ` ORDER BY entry_date DESC, time_of_day ASC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit as string), parseInt(offset as string));

    const [entries] = await DB.query(query, params);

    res.json({
      success: true,
      data: {
        entries,
        count: (entries as any[]).length
      }
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

// ============================================================================
// GET MOOD TREND
// ============================================================================

export const getMoodTrendHandler: RequestHandler = async (req, res) => {
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

    const { startDate, endDate } = req.query;

    // Default to last 30 days
    const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const end = endDate || new Date().toISOString().split('T')[0];

    const [results] = await DB.query(
      `SELECT 
        entry_date,
        AVG(mood_rating) as avg_mood,
        AVG(energy_level) as avg_energy,
        AVG(emotion_intensity) as avg_intensity,
        COUNT(*) as entry_count
      FROM mirror_journal_entries
      WHERE user_id = ? 
        AND entry_date BETWEEN ? AND ?
        AND deleted_at IS NULL
      GROUP BY entry_date
      ORDER BY entry_date ASC`,
      [userId, start, end]
    );

    const trendData = (results as any[]).map((row: any) => ({
      date: row.entry_date,
      avgMood: parseFloat(row.avg_mood).toFixed(2),
      avgEnergy: parseFloat(row.avg_energy).toFixed(2),
      avgIntensity: parseFloat(row.avg_intensity).toFixed(2),
      entryCount: row.entry_count
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
      details: (error as Error).message
    });
  }
};

// ============================================================================
// ROUTE REGISTRATION (No middleware, following existing pattern)
// ============================================================================

router.post('/entry', createJournalEntryHandler);
router.get('/entry/date/:date', getEntryByDateHandler);
router.get('/entries', getAllEntriesHandler);
router.get('/analytics/mood-trend', getMoodTrendHandler);

export default router;
