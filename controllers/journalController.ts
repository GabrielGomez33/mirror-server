// ============================================================================
// MIRROR JOURNAL CONTROLLER
// Business logic for journal entries, analytics, and data retrieval
// ============================================================================

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import DB from '../config/database/db';
import { validateJournalEntry, calculateSentiment, extractThemes } from '../utils/journalHelpers';

// ============================================================================
// TYPES
// ============================================================================

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
  };
}

// ============================================================================
// CREATE ENTRY
// ============================================================================

export class JournalController {
  
  /**
   * Create a new journal entry
   * @route POST /mirror/api/journal/entry
   */
  static async createEntry(req: AuthenticatedRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
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
        isPrivate,
        attachments,
        linkedMirrorSubmission,
        mirrorInsightsReflection
      } = req.body;

      // Validation
      const validationError = validateJournalEntry(req.body);
      if (validationError) {
        return res.status(400).json({ success: false, error: validationError });
      }

      // Check if entry already exists for this date/time
      const existingEntry = await DB.query(`
        SELECT id FROM mirror_journal_entries 
        WHERE user_id = ? AND entry_date = ? AND time_of_day = ? AND deleted_at IS NULL
      `, [userId, entryDate, timeOfDay]);

      if (existingEntry.length > 0) {
        return res.status(409).json({ 
          success: false, 
          error: 'Entry already exists for this date and time of day. Use PUT to update.',
          existingEntryId: existingEntry[0].id
        });
      }

      // Generate analytics
      const combinedText = `${JSON.stringify(promptResponses || {})} ${freeFormEntry || ''}`;
      const wordCount = freeFormEntry ? freeFormEntry.split(/\s+/).length : 0;
      const sentimentScore = await calculateSentiment(combinedText);
      const dominantThemes = await extractThemes(combinedText, tags || []);

      // Create entry
      const entryId = uuidv4();
      await DB.query(`
        INSERT INTO mirror_journal_entries (
          id, user_id, entry_date, time_of_day, 
          mood_rating, primary_emotion, emotion_intensity, energy_level,
          prompt_responses, free_form_entry, tags, category,
          is_private, attachments, linked_mirror_submission, mirror_insights_reflection,
          word_count, sentiment_score, dominant_themes,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `, [
        entryId, userId, entryDate, timeOfDay,
        moodRating, primaryEmotion, emotionIntensity, energyLevel,
        JSON.stringify(promptResponses || {}), freeFormEntry || null, 
        JSON.stringify(tags || []), category || null,
        isPrivate !== false, // Default to true
        JSON.stringify(attachments || []), linkedMirrorSubmission || null, 
        mirrorInsightsReflection || null,
        wordCount, sentimentScore, JSON.stringify(dominantThemes)
      ]);

      // Invalidate analytics cache
      await JournalController.invalidateAnalyticsCache(userId);

      console.log(`✅ Journal entry created: ${entryId} for user ${userId}`);

      return res.status(201).json({
        success: true,
        data: {
          entryId,
          message: 'Journal entry created successfully'
        }
      });

    } catch (error) {
      console.error('❌ Error creating journal entry:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to create journal entry' 
      });
    }
  }

  // ============================================================================
  // RETRIEVE ENTRY BY DATE (Key Method for Date-Based Retrieval)
  // ============================================================================

  /**
   * Get journal entry for a specific date
   * @route GET /mirror/api/journal/entry/date/:date
   * 
   * CRITICAL: This is the primary method for date-based retrieval
   * Supports queries like:
   * - GET /entry/date/2025-09-04
   * - GET /entry/date/2025-09-04?timeOfDay=morning
   */
  static async getEntryByDate(req: AuthenticatedRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    const { date } = req.params;
    const { timeOfDay } = req.query;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
      // Validate date format (YYYY-MM-DD)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid date format. Use YYYY-MM-DD (e.g., 2025-09-04)' 
        });
      }

      // Build query
      let query = `
        SELECT 
          id, entry_date, time_of_day, mood_rating, primary_emotion,
          emotion_intensity, energy_level, prompt_responses, free_form_entry,
          tags, category, attachments, linked_mirror_submission, 
          mirror_insights_reflection, word_count, sentiment_score, 
          dominant_themes, created_at, updated_at
        FROM mirror_journal_entries
        WHERE user_id = ? AND entry_date = ? AND deleted_at IS NULL
      `;

      const params: any[] = [userId, date];

      // Optional time filter
      if (timeOfDay) {
        query += ` AND time_of_day = ?`;
        params.push(timeOfDay);
      }

      query += ` ORDER BY time_of_day ASC`;

      const entries = await DB.query(query, params);

      if (entries.length === 0) {
        return res.status(404).json({ 
          success: false, 
          error: 'No journal entries found for this date',
          date,
          timeOfDay: timeOfDay || 'any'
        });
      }

      // Parse JSON fields
      const parsedEntries = entries.map((entry: any) => ({
        ...entry,
        promptResponses: JSON.parse(entry.prompt_responses || '{}'),
        tags: JSON.parse(entry.tags || '[]'),
        attachments: JSON.parse(entry.attachments || '[]'),
        dominantThemes: JSON.parse(entry.dominant_themes || '[]')
      }));

      console.log(`✅ Retrieved ${parsedEntries.length} entry(ies) for date ${date}`);

      return res.status(200).json({
        success: true,
        data: {
          date,
          entries: parsedEntries,
          count: parsedEntries.length
        }
      });

    } catch (error) {
      console.error('❌ Error retrieving entry by date:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to retrieve journal entry' 
      });
    }
  }

  // ============================================================================
  // RETRIEVE ENTRIES WITH FILTERS (Date Range, Mood, Tags)
  // ============================================================================

  /**
   * Get all entries with optional filters
   * @route GET /mirror/api/journal/entries
   * 
   * Examples:
   * - GET /entries?startDate=2025-09-01&endDate=2025-09-30
   * - GET /entries?minMood=7&tags=work,health
   * - GET /entries?limit=10&offset=0&sortBy=mood&sortOrder=desc
   */
  static async getEntries(req: AuthenticatedRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
      const {
        startDate,
        endDate,
        limit = 50,
        offset = 0,
        sortBy = 'entry_date',
        sortOrder = 'desc',
        tags,
        category,
        minMood,
        maxMood
      } = req.query;

      // Build dynamic query
      let query = `
        SELECT 
          id, entry_date, time_of_day, mood_rating, primary_emotion,
          emotion_intensity, energy_level, prompt_responses, free_form_entry,
          tags, category, word_count, sentiment_score, dominant_themes,
          created_at, updated_at
        FROM mirror_journal_entries
        WHERE user_id = ? AND deleted_at IS NULL
      `;

      const params: any[] = [userId];

      // Date range filter
      if (startDate) {
        query += ` AND entry_date >= ?`;
        params.push(startDate);
      }
      if (endDate) {
        query += ` AND entry_date <= ?`;
        params.push(endDate);
      }

      // Mood filter
      if (minMood) {
        query += ` AND mood_rating >= ?`;
        params.push(minMood);
      }
      if (maxMood) {
        query += ` AND mood_rating <= ?`;
        params.push(maxMood);
      }

      // Category filter
      if (category) {
        query += ` AND category = ?`;
        params.push(category);
      }

      // Tags filter (matches ANY of the provided tags)
      if (tags) {
        const tagArray = (tags as string).split(',').map(t => t.trim());
        const tagConditions = tagArray.map(() => `JSON_CONTAINS(tags, ?)`).join(' OR ');
        query += ` AND (${tagConditions})`;
        tagArray.forEach(tag => params.push(`"${tag}"`));
      }

      // Sorting
      const allowedSortFields = ['entry_date', 'mood_rating', 'created_at', 'word_count', 'sentiment_score'];
      const sortField = allowedSortFields.includes(sortBy as string) ? sortBy : 'entry_date';
      const sortDir = sortOrder === 'asc' ? 'ASC' : 'DESC';
      query += ` ORDER BY ${sortField} ${sortDir}`;

      // Pagination
      query += ` LIMIT ? OFFSET ?`;
      params.push(parseInt(limit as string), parseInt(offset as string));

      const entries = await DB.query(query, params);

      // Parse JSON fields
      const parsedEntries = entries.map((entry: any) => ({
        ...entry,
        promptResponses: JSON.parse(entry.prompt_responses || '{}'),
        tags: JSON.parse(entry.tags || '[]'),
        dominantThemes: JSON.parse(entry.dominant_themes || '[]')
      }));

      // Get total count for pagination
      const countQuery = `
        SELECT COUNT(*) as total 
        FROM mirror_journal_entries 
        WHERE user_id = ? AND deleted_at IS NULL
      `;
      const countResult = await DB.query(countQuery, [userId]);
      const totalEntries = countResult[0].total;

      console.log(`✅ Retrieved ${parsedEntries.length} entries for user ${userId}`);

      return res.status(200).json({
        success: true,
        data: {
          entries: parsedEntries,
          pagination: {
            total: totalEntries,
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            hasMore: (parseInt(offset as string) + parsedEntries.length) < totalEntries
          }
        }
      });

    } catch (error) {
      console.error('❌ Error retrieving journal entries:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to retrieve journal entries' 
      });
    }
  }

  // ============================================================================
  // UPDATE ENTRY
  // ============================================================================

  static async updateEntry(req: AuthenticatedRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    const { entryId } = req.params;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
      // Check ownership and edit window (24 hours)
      const existing = await DB.query(`
        SELECT id, created_at FROM mirror_journal_entries 
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
      `, [entryId, userId]);

      if (existing.length === 0) {
        return res.status(404).json({ 
          success: false, 
          error: 'Journal entry not found' 
        });
      }

      const createdAt = new Date(existing[0].created_at);
      const now = new Date();
      const hoursSinceCreation = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);

      if (hoursSinceCreation > 24) {
        return res.status(403).json({ 
          success: false, 
          error: 'Cannot edit entries older than 24 hours' 
        });
      }

      // Build update query dynamically
      const {
        moodRating,
        primaryEmotion,
        emotionIntensity,
        energyLevel,
        promptResponses,
        freeFormEntry,
        tags,
        category,
        mirrorInsightsReflection
      } = req.body;

      const updates: string[] = [];
      const params: any[] = [];

      if (moodRating !== undefined) {
        updates.push('mood_rating = ?');
        params.push(moodRating);
      }
      if (primaryEmotion) {
        updates.push('primary_emotion = ?');
        params.push(primaryEmotion);
      }
      if (emotionIntensity !== undefined) {
        updates.push('emotion_intensity = ?');
        params.push(emotionIntensity);
      }
      if (energyLevel !== undefined) {
        updates.push('energy_level = ?');
        params.push(energyLevel);
      }
      if (promptResponses) {
        updates.push('prompt_responses = ?');
        params.push(JSON.stringify(promptResponses));
      }
      if (freeFormEntry !== undefined) {
        updates.push('free_form_entry = ?');
        params.push(freeFormEntry);
        
        // Recalculate word count
        const newWordCount = freeFormEntry ? freeFormEntry.split(/\s+/).length : 0;
        updates.push('word_count = ?');
        params.push(newWordCount);
        
        // Recalculate sentiment
        const combinedText = `${JSON.stringify(promptResponses || {})} ${freeFormEntry}`;
        const sentimentScore = await calculateSentiment(combinedText);
        updates.push('sentiment_score = ?');
        params.push(sentimentScore);
        
        // Recalculate themes
        const dominantThemes = await extractThemes(combinedText, tags || []);
        updates.push('dominant_themes = ?');
        params.push(JSON.stringify(dominantThemes));
      }
      if (tags) {
        updates.push('tags = ?');
        params.push(JSON.stringify(tags));
      }
      if (category) {
        updates.push('category = ?');
        params.push(category);
      }
      if (mirrorInsightsReflection !== undefined) {
        updates.push('mirror_insights_reflection = ?');
        params.push(mirrorInsightsReflection);
      }

      if (updates.length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'No fields to update' 
        });
      }

      // Add updated_at
      updates.push('updated_at = NOW()');

      // Execute update
      params.push(entryId, userId);
      const query = `
        UPDATE mirror_journal_entries 
        SET ${updates.join(', ')}
        WHERE id = ? AND user_id = ?
      `;

      await DB.query(query, params);

      // Invalidate analytics cache
      await JournalController.invalidateAnalyticsCache(userId);

      console.log(`✅ Journal entry updated: ${entryId}`);

      return res.status(200).json({
        success: true,
        data: {
          entryId,
          message: 'Journal entry updated successfully'
        }
      });

    } catch (error) {
      console.error('❌ Error updating journal entry:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to update journal entry' 
      });
    }
  }

  // ============================================================================
  // ANALYTICS: MOOD TREND
  // ============================================================================

  /**
   * Get mood trend over time
   * @route GET /mirror/api/journal/analytics/mood-trend
   */
  static async getMoodTrend(req: AuthenticatedRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    const { startDate, endDate, granularity = 'day' } = req.query;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
      // Default to last 30 days if not specified
      const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const end = endDate || new Date().toISOString().split('T')[0];

      const query = `
        SELECT 
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
        ORDER BY entry_date ASC
      `;

      const results = await DB.query(query, [userId, start, end]);

      const trendData = results.map((row: any) => ({
        date: row.entry_date,
        avgMood: parseFloat(row.avg_mood).toFixed(2),
        avgEnergy: parseFloat(row.avg_energy).toFixed(2),
        avgIntensity: parseFloat(row.avg_intensity).toFixed(2),
        entryCount: row.entry_count
      }));

      return res.status(200).json({
        success: true,
        data: {
          trend: trendData,
          period: { start, end },
          dataPoints: trendData.length
        }
      });

    } catch (error) {
      console.error('❌ Error getting mood trend:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to retrieve mood trend' 
      });
    }
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  /**
   * Invalidate analytics cache for a user
   */
  private static async invalidateAnalyticsCache(userId: string): Promise<void> {
    try {
      await DB.query(`
        DELETE FROM mirror_journal_analytics 
        WHERE user_id = ?
      `, [userId]);
      
      console.log(`🗑️ Analytics cache invalidated for user ${userId}`);
    } catch (error) {
      console.error('❌ Error invalidating analytics cache:', error);
    }
  }

  // Placeholder methods (implement as needed)
  static async getEntryById(req: AuthenticatedRequest, res: Response): Promise<Response> {
    // Similar to getEntryByDate but using entry ID
    return res.status(501).json({ success: false, error: 'Not implemented yet' });
  }

  static async deleteEntry(req: AuthenticatedRequest, res: Response): Promise<Response> {
    // Soft delete: UPDATE deleted_at = NOW()
    return res.status(501).json({ success: false, error: 'Not implemented yet' });
  }

  static async searchEntries(req: AuthenticatedRequest, res: Response): Promise<Response> {
    // Full-text search using MySQL MATCH or LIKE
    return res.status(501).json({ success: false, error: 'Not implemented yet' });
  }

  static async getAnalyticsOverview(req: AuthenticatedRequest, res: Response): Promise<Response> {
    return res.status(501).json({ success: false, error: 'Not implemented yet' });
  }

  static async getEmotionBreakdown(req: AuthenticatedRequest, res: Response): Promise<Response> {
    return res.status(501).json({ success: false, error: 'Not implemented yet' });
  }

  static async getPatterns(req: AuthenticatedRequest, res: Response): Promise<Response> {
    return res.status(501).json({ success: false, error: 'Not implemented yet' });
  }

  static async getWordCloudData(req: AuthenticatedRequest, res: Response): Promise<Response> {
    return res.status(501).json({ success: false, error: 'Not implemented yet' });
  }

  static async getOnThisDay(req: AuthenticatedRequest, res: Response): Promise<Response> {
    return res.status(501).json({ success: false, error: 'Not implemented yet' });
  }

  static async getStreak(req: AuthenticatedRequest, res: Response): Promise<Response> {
    return res.status(501).json({ success: false, error: 'Not implemented yet' });
  }

  static async exportEntries(req: AuthenticatedRequest, res: Response): Promise<Response> {
    return res.status(501).json({ success: false, error: 'Not implemented yet' });
  }

  static async getTemplates(req: AuthenticatedRequest, res: Response): Promise<Response> {
    return res.status(501).json({ success: false, error: 'Not implemented yet' });
  }

  static async getTemplateById(req: AuthenticatedRequest, res: Response): Promise<Response> {
    return res.status(501).json({ success: false, error: 'Not implemented yet' });
  }

  static async getMirrorCorrelation(req: AuthenticatedRequest, res: Response): Promise<Response> {
    return res.status(501).json({ success: false, error: 'Not implemented yet' });
  }
}
