// ============================================================================
// SESSION INSIGHTS API ROUTES - PHASE 4
// ============================================================================
// File: routes/sessionInsights.ts
// ----------------------------------------------------------------------------
// Handles conversation intelligence functionality:
// - Append transcripts
// - Request AI insights
// - Get session insights
// - Post-session summaries
// ============================================================================

import express, { RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DB } from '../db';
import AuthMiddleware from '../middleware/authMiddleware';
import { conversationAnalyzer } from '../analyzers/ConversationAnalyzer';
import { groupEncryptionManager } from '../systems/GroupEncryptionManager';
import { mirrorGroupNotifications } from '../systems/mirrorGroupNotifications';
import { mirrorRedis } from '../config/redis';

const router = express.Router();

// ============================================================================
// TYPES
// ============================================================================

interface TranscriptAppend {
  sessionId: string;
  text: string;
  durationSeconds?: number;
  languageCode?: string;
}

interface InsightRequest {
  sessionId: string;
  type?: 'periodic' | 'on_demand' | 'post_session';
  focusAreas?: string[];
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

async function verifyGroupMembership(groupId: string, userId: number): Promise<boolean> {
  try {
    const [rows] = await DB.query(
      `SELECT id FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, userId]
    );
    return (rows as any[]).length > 0;
  } catch (error) {
    console.error('❌ Error verifying group membership:', error);
    return false;
  }
}

async function getGroupActiveMembers(groupId: string): Promise<number[]> {
  try {
    const [rows] = await DB.query(
      `SELECT user_id FROM mirror_group_members
       WHERE group_id = ? AND status = 'active'`,
      [groupId]
    );
    return (rows as any[]).map(r => r.user_id);
  } catch (error) {
    console.error('❌ Error getting group members:', error);
    return [];
  }
}

// ============================================================================
// APPEND TRANSCRIPT
// ============================================================================

/**
 * Append a transcript segment from the conversation
 * Typically called when speech-to-text completes for a user
 */
const appendTranscriptHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;
    const { sessionId, text, durationSeconds, languageCode }: TranscriptAppend = req.body;

    // Validate required fields
    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ success: false, error: 'Session ID is required' });
      return;
    }

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Transcript text is required' });
      return;
    }

    // Limit text length (prevent abuse)
    if (text.length > 10000) {
      res.status(400).json({
        success: false,
        error: 'Transcript too long (max 10000 characters)'
      });
      return;
    }

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Encrypt transcript text
    let encryptedText = text;
    try {
      const encrypted = await groupEncryptionManager.encryptForGroup(
        Buffer.from(text, 'utf-8'),
        groupId
      );
      encryptedText = encrypted.data.toString('base64');
    } catch (encryptError) {
      console.warn('Transcript encryption failed, storing unencrypted:', encryptError);
      // Continue with unencrypted text for now
    }

    // Store transcript
    const transcriptId = uuidv4();
    await DB.query(
      `INSERT INTO mirror_group_session_transcripts (
        id, group_id, session_id, speaker_user_id,
        transcript_text, duration_seconds, language_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        transcriptId,
        groupId,
        sessionId,
        user.id,
        encryptedText,
        durationSeconds || null,
        languageCode || 'en'
      ]
    );

    // Get transcript count for this session
    const [countRows] = await DB.query(
      `SELECT COUNT(*) as count, SUM(LENGTH(transcript_text)) as totalLength
       FROM mirror_group_session_transcripts
       WHERE group_id = ? AND session_id = ?`,
      [groupId, sessionId]
    );

    const { count, totalLength } = (countRows as any[])[0] || { count: 0, totalLength: 0 };

    // Check if we should trigger periodic analysis
    // (every 20 minutes or after significant content)
    const shouldAnalyze = await shouldTriggerPeriodicAnalysis(groupId, sessionId);

    if (shouldAnalyze) {
      // Queue periodic analysis (non-blocking)
      conversationAnalyzer.queueAnalysis(groupId, sessionId, 'periodic', 5)
        .catch(err => console.error('Failed to queue periodic analysis:', err));
    }

    res.json({
      success: true,
      data: {
        transcriptId,
        sessionStats: {
          totalSegments: count,
          approximateLength: totalLength
        }
      }
    });

  } catch (error) {
    console.error('❌ Error appending transcript:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to append transcript',
      details: (error as Error).message
    });
  }
};

/**
 * Check if periodic analysis should be triggered
 */
async function shouldTriggerPeriodicAnalysis(
  groupId: string,
  sessionId: string
): Promise<boolean> {
  try {
    // Check last analysis time
    const [insightRows] = await DB.query(
      `SELECT generated_at FROM mirror_group_session_insights
       WHERE group_id = ? AND session_id = ? AND insight_type = 'periodic'
       ORDER BY generated_at DESC
       LIMIT 1`,
      [groupId, sessionId]
    );

    const lastAnalysis = (insightRows as any[])[0]?.generated_at;

    if (!lastAnalysis) {
      // First check after minimum transcripts
      const [countRows] = await DB.query(
        `SELECT COUNT(*) as count FROM mirror_group_session_transcripts
         WHERE group_id = ? AND session_id = ?`,
        [groupId, sessionId]
      );
      const count = (countRows as any[])[0]?.count || 0;
      return count >= 5; // At least 5 segments before first analysis
    }

    // Check if enough time has passed (20 minutes)
    const timeSinceLastAnalysis = Date.now() - new Date(lastAnalysis).getTime();
    const minInterval = parseInt(process.env.AI_CHECKIN_INTERVAL_MS || '1200000'); // 20 min

    return timeSinceLastAnalysis >= minInterval;

  } catch (error) {
    console.error('Error checking analysis trigger:', error);
    return false;
  }
}

// ============================================================================
// REQUEST INSIGHT
// ============================================================================

/**
 * Request an AI insight on-demand
 */
const requestInsightHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;
    const { sessionId, type, focusAreas }: InsightRequest = req.body;

    // Validate required fields
    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ success: false, error: 'Session ID is required' });
      return;
    }

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Check rate limit (max 1 on-demand request per 5 minutes)
    const rateLimitKey = `mirror:insight:ratelimit:${groupId}:${sessionId}`;
    const lastRequest = await mirrorRedis.get(rateLimitKey);

    if (lastRequest) {
      res.status(429).json({
        success: false,
        error: 'Please wait before requesting another insight',
        code: 'RATE_LIMITED'
      });
      return;
    }

    // Set rate limit
    await mirrorRedis.set(rateLimitKey, Date.now().toString(), 300); // 5 min TTL

    // Generate insight
    const insight = await conversationAnalyzer.analyzeConversation(
      groupId,
      sessionId,
      {
        insightType: type || 'on_demand',
        includeCompatibilityContext: true,
        focusAreas: focusAreas || ['engagement', 'dynamics', 'actionable']
      }
    );

    // Broadcast insight to session participants
    const members = await getGroupActiveMembers(groupId);
    for (const memberId of members) {
      await mirrorGroupNotifications.notify(memberId, {
        type: 'conversation:insight',
        payload: {
          insightId: insight.id,
          sessionId,
          groupId,
          insightType: insight.insightType,
          observations: insight.keyObservations,
          recommendations: insight.recommendations,
          dynamics: insight.dynamicsAssessment,
          confidence: insight.confidenceScore,
          generatedAt: insight.generatedAt.toISOString()
        }
      });
    }

    // Also broadcast via Redis
    await mirrorRedis.publish('mirror:group:events', JSON.stringify({
      type: 'conversation:insight',
      groupId,
      sessionId,
      insightId: insight.id
    }));

    res.json({
      success: true,
      data: {
        insight: {
          id: insight.id,
          type: insight.insightType,
          keyObservations: insight.keyObservations,
          recommendations: insight.recommendations,
          dynamicsAssessment: insight.dynamicsAssessment,
          compatibilityNotes: insight.compatibilityNotes,
          confidence: insight.confidenceScore,
          relevance: insight.relevanceScore,
          generatedAt: insight.generatedAt.toISOString()
        }
      }
    });

  } catch (error) {
    console.error('❌ Error requesting insight:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate insight',
      details: (error as Error).message
    });
  }
};

// ============================================================================
// GET SESSION INSIGHTS
// ============================================================================

/**
 * Get all insights for a session
 */
const getSessionInsightsHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId, sessionId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const type = req.query.type as string; // Optional filter

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Build query
    let query = `
      SELECT *
      FROM mirror_group_session_insights
      WHERE group_id = ? AND session_id = ?
    `;
    const params: any[] = [groupId, sessionId];

    if (type && ['periodic', 'post_session', 'on_demand'].includes(type)) {
      query += ` AND insight_type = ?`;
      params.push(type);
    }

    query += ` ORDER BY generated_at DESC LIMIT ?`;
    params.push(limit);

    const [rows] = await DB.query(query, params);

    // Format insights
    const insights = (rows as any[]).map(row => ({
      id: row.id,
      type: row.insight_type,
      keyObservations: safeJsonParse(row.key_observations, []),
      recommendations: safeJsonParse(row.recommendations, []),
      dynamicsAssessment: safeJsonParse(row.dynamics_assessment, null),
      compatibilityNotes: safeJsonParse(row.compatibility_notes, []),
      confidence: parseFloat(row.confidence_score) || 0,
      relevance: parseFloat(row.relevance_score) || 0,
      generatedAt: row.generated_at,
      deliveredAt: row.delivered_at,
      acknowledgedAt: row.acknowledged_at
    }));

    // Get session summary stats
    const [statsRows] = await DB.query(
      `SELECT
         COUNT(*) as totalInsights,
         MIN(generated_at) as firstInsight,
         MAX(generated_at) as lastInsight,
         AVG(confidence_score) as avgConfidence
       FROM mirror_group_session_insights
       WHERE group_id = ? AND session_id = ?`,
      [groupId, sessionId]
    );

    const stats = (statsRows as any[])[0] || {};

    res.json({
      success: true,
      data: {
        insights,
        sessionStats: {
          totalInsights: stats.totalInsights || 0,
          firstInsightAt: stats.firstInsight,
          lastInsightAt: stats.lastInsight,
          averageConfidence: parseFloat(stats.avgConfidence) || 0
        }
      }
    });

  } catch (error) {
    console.error('❌ Error getting session insights:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get insights',
      details: (error as Error).message
    });
  }
};

// ============================================================================
// GET LATEST INSIGHT
// ============================================================================

/**
 * Get the most recent insight for a session
 */
const getLatestInsightHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId, sessionId } = req.params;

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Try cache first
    const cached = await conversationAnalyzer.getCachedInsight(sessionId);
    if (cached) {
      res.json({
        success: true,
        data: {
          insight: cached,
          source: 'cache'
        }
      });
      return;
    }

    // Get from database
    const [rows] = await DB.query(
      `SELECT *
       FROM mirror_group_session_insights
       WHERE group_id = ? AND session_id = ?
       ORDER BY generated_at DESC
       LIMIT 1`,
      [groupId, sessionId]
    );

    if ((rows as any[]).length === 0) {
      res.json({
        success: true,
        data: {
          insight: null,
          message: 'No insights available for this session yet'
        }
      });
      return;
    }

    const row = (rows as any[])[0];

    res.json({
      success: true,
      data: {
        insight: {
          id: row.id,
          type: row.insight_type,
          keyObservations: safeJsonParse(row.key_observations, []),
          recommendations: safeJsonParse(row.recommendations, []),
          dynamicsAssessment: safeJsonParse(row.dynamics_assessment, null),
          compatibilityNotes: safeJsonParse(row.compatibility_notes, []),
          confidence: parseFloat(row.confidence_score) || 0,
          relevance: parseFloat(row.relevance_score) || 0,
          generatedAt: row.generated_at
        },
        source: 'database'
      }
    });

  } catch (error) {
    console.error('❌ Error getting latest insight:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get insight',
      details: (error as Error).message
    });
  }
};

// ============================================================================
// GENERATE POST-SESSION SUMMARY
// ============================================================================

/**
 * Generate a comprehensive post-session summary
 * Called when ending a group session
 */
const generateSummaryHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId, sessionId } = req.params;

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Check if summary already exists
    const [existingRows] = await DB.query(
      `SELECT id FROM mirror_group_session_insights
       WHERE group_id = ? AND session_id = ? AND insight_type = 'post_session'`,
      [groupId, sessionId]
    );

    if ((existingRows as any[]).length > 0) {
      // Return existing summary
      const [rows] = await DB.query(
        `SELECT * FROM mirror_group_session_insights
         WHERE group_id = ? AND session_id = ? AND insight_type = 'post_session'
         ORDER BY generated_at DESC LIMIT 1`,
        [groupId, sessionId]
      );

      const row = (rows as any[])[0];

      res.json({
        success: true,
        data: {
          insight: {
            id: row.id,
            type: row.insight_type,
            keyObservations: safeJsonParse(row.key_observations, []),
            recommendations: safeJsonParse(row.recommendations, []),
            dynamicsAssessment: safeJsonParse(row.dynamics_assessment, null),
            compatibilityNotes: safeJsonParse(row.compatibility_notes, []),
            confidence: parseFloat(row.confidence_score) || 0,
            generatedAt: row.generated_at
          },
          message: 'Summary already exists for this session'
        }
      });
      return;
    }

    // Generate new post-session summary
    const insight = await conversationAnalyzer.generatePostSessionSummary(
      groupId,
      sessionId
    );

    // Broadcast summary to all members
    const members = await getGroupActiveMembers(groupId);
    for (const memberId of members) {
      await mirrorGroupNotifications.notify(memberId, {
        type: 'conversation:summary',
        payload: {
          insightId: insight.id,
          sessionId,
          groupId,
          observations: insight.keyObservations,
          recommendations: insight.recommendations,
          dynamics: insight.dynamicsAssessment,
          generatedAt: insight.generatedAt.toISOString()
        }
      });
    }

    res.json({
      success: true,
      data: {
        insight: {
          id: insight.id,
          type: insight.insightType,
          keyObservations: insight.keyObservations,
          recommendations: insight.recommendations,
          dynamicsAssessment: insight.dynamicsAssessment,
          compatibilityNotes: insight.compatibilityNotes,
          confidence: insight.confidenceScore,
          generatedAt: insight.generatedAt.toISOString()
        }
      }
    });

  } catch (error) {
    console.error('❌ Error generating summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate summary',
      details: (error as Error).message
    });
  }
};

// ============================================================================
// ACKNOWLEDGE INSIGHT
// ============================================================================

/**
 * Mark an insight as acknowledged/read by the user
 */
const acknowledgeInsightHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId, insightId } = req.params;

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Update acknowledged timestamp (first acknowledgment only)
    await DB.query(
      `UPDATE mirror_group_session_insights
       SET acknowledged_at = COALESCE(acknowledged_at, NOW())
       WHERE id = ? AND group_id = ?`,
      [insightId, groupId]
    );

    res.json({
      success: true,
      data: {
        message: 'Insight acknowledged',
        insightId
      }
    });

  } catch (error) {
    console.error('❌ Error acknowledging insight:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to acknowledge insight',
      details: (error as Error).message
    });
  }
};

// ============================================================================
// GET SESSION TRANSCRIPT STATS
// ============================================================================

/**
 * Get transcript statistics for a session (without exposing content)
 */
const getTranscriptStatsHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId, sessionId } = req.params;

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Get overall stats
    const [overallStats] = await DB.query(
      `SELECT
         COUNT(*) as totalSegments,
         COUNT(DISTINCT speaker_user_id) as uniqueSpeakers,
         MIN(timestamp) as sessionStart,
         MAX(timestamp) as lastActivity,
         SUM(duration_seconds) as totalDuration
       FROM mirror_group_session_transcripts
       WHERE group_id = ? AND session_id = ?`,
      [groupId, sessionId]
    );

    // Get per-speaker stats
    const [speakerStats] = await DB.query(
      `SELECT
         t.speaker_user_id,
         u.username,
         COUNT(*) as segmentCount,
         SUM(t.duration_seconds) as totalDuration
       FROM mirror_group_session_transcripts t
       JOIN users u ON t.speaker_user_id = u.id
       WHERE t.group_id = ? AND t.session_id = ?
       GROUP BY t.speaker_user_id, u.username
       ORDER BY segmentCount DESC`,
      [groupId, sessionId]
    );

    const overall = (overallStats as any[])[0] || {};

    res.json({
      success: true,
      data: {
        overall: {
          totalSegments: overall.totalSegments || 0,
          uniqueSpeakers: overall.uniqueSpeakers || 0,
          sessionStart: overall.sessionStart,
          lastActivity: overall.lastActivity,
          totalDurationSeconds: overall.totalDuration || 0
        },
        speakers: (speakerStats as any[]).map(s => ({
          userId: s.speaker_user_id,
          username: s.username,
          segments: s.segmentCount,
          durationSeconds: s.totalDuration || 0,
          percentage: overall.totalSegments > 0
            ? Math.round((s.segmentCount / overall.totalSegments) * 100)
            : 0
        }))
      }
    });

  } catch (error) {
    console.error('❌ Error getting transcript stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get stats',
      details: (error as Error).message
    });
  }
};

// ============================================================================
// ROUTE REGISTRATION
// ============================================================================

const verified = AuthMiddleware.verifyToken as unknown as RequestHandler;

// Transcript routes
router.post('/groups/:groupId/sessions/:sessionId/transcript', verified, appendTranscriptHandler);
router.get('/groups/:groupId/sessions/:sessionId/stats', verified, getTranscriptStatsHandler);

// Insight routes
router.post('/groups/:groupId/sessions/:sessionId/request-insight', verified, requestInsightHandler);
router.get('/groups/:groupId/sessions/:sessionId/insights', verified, getSessionInsightsHandler);
router.get('/groups/:groupId/sessions/:sessionId/insights/latest', verified, getLatestInsightHandler);
router.post('/groups/:groupId/sessions/:sessionId/summary', verified, generateSummaryHandler);
router.post('/groups/:groupId/insights/:insightId/acknowledge', verified, acknowledgeInsightHandler);

export default router;
