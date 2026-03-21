// ============================================================================
// TRUTHSTREAM CONTROLLER - Mirror-Server Request Handlers
// ============================================================================
// File: controllers/truthstreamController.ts
// Description: All request handlers for TruthStream API endpoints.
//              Extracted from routes for clarity and testability.
//
// Pattern follows: groupController / route handler patterns in groups.ts
// All DB access uses parameterized queries via DB.query()
// All Dina interactions route through DINALLMConnector → mirror module
// ============================================================================

import crypto from 'crypto';
import { Request, Response } from 'express';
import { DB } from '../db';
import { truthStreamQueueManager } from '../services/TruthStreamQueueManager';
import { truthStreamReviewScorer } from '../services/TruthStreamReviewScorer';
import { IntakeDataManager } from '../controllers/intakeController';
import type { DataAccessContext } from '../controllers/directoryController';

// ============================================================================
// TYPES (inline to avoid circular dependency)
// ============================================================================

interface AuthenticatedRequest extends Request {
  user?: { id: number; email: string; username: string; sessionId: string };
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

function sanitizeInput(input: unknown, maxLength: number = 500): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  return cleaned.length > 0 ? cleaned.substring(0, maxLength) : null;
}

const MIN_REVIEW_TIME = parseInt(process.env.TRUTHSTREAM_MIN_REVIEW_TIME || '45', 10);
const MIN_REVIEWS_FOR_ANALYSIS = parseInt(process.env.TRUTHSTREAM_MIN_REVIEWS_FOR_ANALYSIS || '5', 10);
const MAX_DIALOGUE_MESSAGES = parseInt(process.env.TRUTHSTREAM_MAX_DIALOGUE_MESSAGES || '50', 10);

// ============================================================================
// PROFILE / TRUTH CARD HANDLERS
// ============================================================================

/**
 * POST /profile — Create a Truth Card
 *
 * Accepts the frontend's minimal payload (selfStatement, feedbackAreas, sharedDataTypes)
 * and auto-derives remaining fields (displayAlias, goal, goalCategory) from the
 * authenticated user's existing data. This keeps the UX lightweight while the
 * database schema stays rich for future features.
 */
export async function createProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    // Check if profile already exists
    const [existing] = await DB.query(
      'SELECT id FROM truth_stream_profiles WHERE user_id = ?',
      [userId]
    ) as any[];
    if (existing && existing.length > 0) {
      res.status(409).json({ error: 'Truth Card already exists', code: 'PROFILE_EXISTS' });
      return;
    }

    // Check intake completion via users table flag (consistent with authController/intakeController)
    const [intakeCheck] = await DB.query(
      'SELECT intake_completed FROM users WHERE id = ? LIMIT 1',
      [userId]
    ) as any[];
    if (!intakeCheck || intakeCheck.length === 0 || !intakeCheck[0].intake_completed) {
      res.status(403).json({ error: 'Complete Mirror intake first', code: 'INTAKE_REQUIRED' });
      return;
    }

    const {
      displayAlias, ageRange, genderDisplay, pronouns, culturalContext,
      photoPath, vocalSalutationPath, goal, goalCategory,
      selfStatement, feedbackAreas, sharedDataTypes,
    } = req.body;

    // ---- Shared Data Types (always required from frontend) ----
    const validTypes = ['personality', 'cognitive', 'facial', 'voice', 'astrological', 'profile'];
    const validSharedTypes = Array.isArray(sharedDataTypes)
      ? sharedDataTypes.filter((t: string) => validTypes.includes(t))
      : [];
    if (validSharedTypes.length < 3) {
      res.status(400).json({
        error: 'Must share at least 3 data types',
        code: 'MINIMUM_SHARE',
        data: { current: validSharedTypes.length, minimum: 3 },
      });
      return;
    }

    // ---- Shared type data consistency: if sharing facial/voice, the data must exist ----
    if (validSharedTypes.includes('facial') && !photoPath) {
      res.status(400).json({
        error: 'Photo is required when sharing facial data',
        code: 'VALIDATION_ERROR',
      });
      return;
    }
    if (validSharedTypes.includes('voice') && !vocalSalutationPath) {
      res.status(400).json({
        error: 'Voice recording is required when sharing voice data',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    // ---- Self-Statement (required from frontend) ----
    const sanitizedStatement = sanitizeInput(selfStatement, 2000);
    if (!sanitizedStatement || sanitizedStatement.length < 20) {
      res.status(400).json({
        error: 'Self-statement must be at least 20 characters',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    // ---- Feedback Areas (required from frontend, at least 1) ----
    const validFeedbackAreas = Array.isArray(feedbackAreas)
      ? feedbackAreas.slice(0, 10).map((a: string) => sanitizeInput(a, 100)).filter(Boolean)
      : [];
    if (validFeedbackAreas.length < 1) {
      res.status(400).json({
        error: 'Select at least 1 feedback area',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    // ---- Display Alias (required) ----
    const sanitizedAlias = sanitizeInput(displayAlias, 50);
    if (!sanitizedAlias || sanitizedAlias.length < 3) {
      res.status(400).json({
        error: 'Display name is required (3-50 characters)',
        code: 'VALIDATION_ERROR',
        data: { minLength: 3, maxLength: 50 },
      });
      return;
    }
    const resolvedAlias = sanitizedAlias;

    // Check alias uniqueness in truth_stream_profiles
    const [aliasCheck] = await DB.query(
      'SELECT id FROM truth_stream_profiles WHERE display_alias = ?',
      [resolvedAlias]
    ) as any[];
    if (aliasCheck && aliasCheck.length > 0) {
      res.status(409).json({ error: 'Display name already taken', code: 'ALIAS_CONFLICT' });
      return;
    }

    // Validate alias doesn't match any real username (prevents impersonation)
    const [usernameCheck] = await DB.query(
      'SELECT id FROM users WHERE LOWER(username) = LOWER(?)',
      [resolvedAlias]
    ) as any[];
    if (usernameCheck && usernameCheck.length > 0) {
      res.status(409).json({ error: 'This display name is not available', code: 'ALIAS_CONFLICT' });
      return;
    }

    // ---- Goal Category (auto-derive from first feedback area if not provided) ----
    const validGoalCategories = [
      'personal_growth', 'dating_readiness', 'professional_image',
      'social_skills', 'first_impressions', 'leadership',
      'communication', 'authenticity', 'confidence', 'custom',
    ];
    const feedbackToGoalMap: Record<string, string> = {
      'First Impressions': 'first_impressions',
      'Communication Style': 'communication',
      'Social Presence': 'social_skills',
      'Dating Readiness': 'dating_readiness',
      'Professional Image': 'professional_image',
      'Emotional Intelligence': 'personal_growth',
      'Leadership Potential': 'leadership',
      'Authenticity': 'authenticity',
      'Confidence': 'confidence',
    };

    let resolvedGoalCategory: string;
    if (goalCategory && validGoalCategories.includes(goalCategory)) {
      resolvedGoalCategory = goalCategory;
    } else {
      // Map the first selected feedback area to a goal category
      const firstArea = validFeedbackAreas[0] as string;
      resolvedGoalCategory = feedbackToGoalMap[firstArea] || 'personal_growth';
    }

    // ---- Goal (auto-derive from selfStatement / feedbackAreas if not provided) ----
    let resolvedGoal: string;
    if (goal) {
      resolvedGoal = sanitizeInput(goal, 1000) || `Seeking honest feedback on ${validFeedbackAreas.join(', ')}`;
    } else {
      resolvedGoal = `Seeking honest feedback on ${validFeedbackAreas.join(', ')}`;
    }

    // ---- Age Range (required) ----
    const validAgeRanges = ['18-24', '25-34', '35-44', '45-54', '55+'];
    if (!ageRange || !validAgeRanges.includes(ageRange)) {
      res.status(400).json({
        error: 'Valid age range is required',
        code: 'VALIDATION_ERROR',
        data: { validRanges: validAgeRanges },
      });
      return;
    }
    const resolvedAgeRange = ageRange;

    // ---- Calculate profile completeness ----
    let completeness = 0.4; // Base (alias + goal + data types = required)
    if (photoPath) completeness += 0.2;
    if (vocalSalutationPath) completeness += 0.15;
    if (sanitizedStatement) completeness += 0.15;
    if (validFeedbackAreas.length > 0) completeness += 0.1;

    const profileId = crypto.randomUUID();

    await DB.query(
      `INSERT INTO truth_stream_profiles
       (id, user_id, display_alias, age_range, gender_display, pronouns, cultural_context,
        photo_path, vocal_salutation_path, goal, goal_category, self_statement,
        feedback_areas, shared_data_types, minimum_share_met, profile_completeness, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1)`,
      [
        profileId, userId, resolvedAlias,
        resolvedAgeRange,
        sanitizeInput(genderDisplay, 30) || null,
        sanitizeInput(pronouns, 20) || null,
        sanitizeInput(culturalContext, 200) || null,
        sanitizeInput(photoPath, 500) || null,
        sanitizeInput(vocalSalutationPath, 500) || null,
        resolvedGoal,
        resolvedGoalCategory,
        sanitizedStatement,
        JSON.stringify(validFeedbackAreas),
        JSON.stringify(validSharedTypes),
        completeness,
      ]
    );

    res.status(201).json({
      success: true,
      data: {
        id: profileId,
        displayAlias: resolvedAlias,
        ageRange: resolvedAgeRange,
        goalCategory: resolvedGoalCategory,
        goal: resolvedGoal,
        selfStatement: sanitizedStatement,
        feedbackAreas: validFeedbackAreas,
        sharedDataTypes: validSharedTypes,
        photoPath: sanitizeInput(photoPath, 500) || null,
        vocalSalutationPath: sanitizeInput(vocalSalutationPath, 500) || null,
        profileCompleteness: completeness,
        isActive: true,
        totalReviewsReceived: 0,
        totalReviewsGiven: 0,
        reviewerQualityScore: 0,
        perceptionGapScore: null,
      },
    });
  } catch (error: any) {
    console.error('Error creating Truth Card:', error.message);
    res.status(500).json({ error: 'Failed to create Truth Card', code: 'SERVER_ERROR' });
  }
}

/**
 * GET /profile — Get own Truth Card
 */
export async function getProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    const [rows] = await DB.query(
      'SELECT * FROM truth_stream_profiles WHERE user_id = ?',
      [userId]
    ) as any[];

    if (!rows || rows.length === 0) {
      res.status(404).json({ error: 'No Truth Card found', code: 'PROFILE_NOT_FOUND' });
      return;
    }

    const profile = rows[0];
    res.json({
      success: true,
      data: {
        id: profile.id,
        displayAlias: profile.display_alias,
        ageRange: profile.age_range,
        genderDisplay: profile.gender_display,
        pronouns: profile.pronouns,
        culturalContext: profile.cultural_context,
        photoPath: profile.photo_path,
        vocalSalutationPath: profile.vocal_salutation_path,
        goal: profile.goal,
        goalCategory: profile.goal_category,
        selfStatement: profile.self_statement,
        feedbackAreas: safeJsonParse(profile.feedback_areas, []),
        sharedDataTypes: safeJsonParse(profile.shared_data_types, []),
        minimumShareMet: !!profile.minimum_share_met,
        totalReviewsReceived: profile.total_reviews_received,
        totalReviewsGiven: profile.total_reviews_given,
        reviewQualityScore: profile.review_quality_score,
        perceptionGapScore: profile.perception_gap_score,
        isActive: !!profile.is_active,
        profileCompleteness: profile.profile_completeness,
        createdAt: profile.created_at,
        updatedAt: profile.updated_at,
      },
    });
  } catch (error: any) {
    console.error('Error getting profile:', error.message);
    res.status(500).json({ error: 'Failed to get profile', code: 'SERVER_ERROR' });
  }
}

/**
 * PUT /profile — Update Truth Card
 */
export async function updateProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    const [existing] = await DB.query(
      'SELECT id, display_alias FROM truth_stream_profiles WHERE user_id = ?',
      [userId]
    ) as any[];
    if (!existing || existing.length === 0) {
      res.status(404).json({ error: 'No Truth Card found', code: 'PROFILE_NOT_FOUND' });
      return;
    }

    const updates: string[] = [];
    const params: any[] = [];

    const allowedFields: Record<string, { column: string; maxLength: number }> = {
      goal: { column: 'goal', maxLength: 1000 },
      goalCategory: { column: 'goal_category', maxLength: 50 },
      selfStatement: { column: 'self_statement', maxLength: 2000 },
      photoPath: { column: 'photo_path', maxLength: 500 },
      vocalSalutationPath: { column: 'vocal_salutation_path', maxLength: 500 },
      genderDisplay: { column: 'gender_display', maxLength: 30 },
      pronouns: { column: 'pronouns', maxLength: 20 },
      culturalContext: { column: 'cultural_context', maxLength: 200 },
    };

    for (const [field, config] of Object.entries(allowedFields)) {
      if (req.body[field] !== undefined) {
        updates.push(`${config.column} = ?`);
        params.push(sanitizeInput(req.body[field], config.maxLength));
      }
    }

    // Handle display alias (requires uniqueness validation)
    if (req.body.displayAlias !== undefined) {
      const newAlias = sanitizeInput(req.body.displayAlias, 50);
      if (!newAlias || newAlias.length < 3) {
        res.status(400).json({
          error: 'Display name must be 3-50 characters',
          code: 'VALIDATION_ERROR',
          data: { minLength: 3, maxLength: 50 },
        });
        return;
      }
      // Only check uniqueness if the alias is actually changing
      if (newAlias !== existing[0].display_alias) {
        const [aliasCheck] = await DB.query(
          'SELECT id FROM truth_stream_profiles WHERE display_alias = ? AND user_id != ?',
          [newAlias, userId]
        ) as any[];
        if (aliasCheck && aliasCheck.length > 0) {
          res.status(409).json({ error: 'Display name already taken', code: 'ALIAS_CONFLICT' });
          return;
        }
        const [usernameCheck] = await DB.query(
          'SELECT id FROM users WHERE LOWER(username) = LOWER(?)',
          [newAlias]
        ) as any[];
        if (usernameCheck && usernameCheck.length > 0) {
          res.status(409).json({ error: 'This display name is not available', code: 'ALIAS_CONFLICT' });
          return;
        }
        updates.push('display_alias = ?');
        params.push(newAlias);
      }
    }

    // Handle age range (ENUM field — requires whitelist validation)
    if (req.body.ageRange !== undefined) {
      const validAgeRanges = ['18-24', '25-34', '35-44', '45-54', '55+'];
      if (validAgeRanges.includes(req.body.ageRange)) {
        updates.push('age_range = ?');
        params.push(req.body.ageRange);
      } else {
        res.status(400).json({
          error: 'Valid age range is required',
          code: 'VALIDATION_ERROR',
          data: { validRanges: validAgeRanges },
        });
        return;
      }
    }

    // Handle JSON fields
    if (req.body.feedbackAreas !== undefined) {
      updates.push('feedback_areas = ?');
      params.push(JSON.stringify(
        Array.isArray(req.body.feedbackAreas)
          ? req.body.feedbackAreas.slice(0, 10).map((a: string) => sanitizeInput(a, 100))
          : []
      ));
    }

    if (req.body.sharedDataTypes !== undefined) {
      const validTypes = ['personality', 'cognitive', 'facial', 'voice', 'astrological', 'profile'];
      const validShared = Array.isArray(req.body.sharedDataTypes)
        ? req.body.sharedDataTypes.filter((t: string) => validTypes.includes(t))
        : [];

      // Validate shared type data consistency against both payload and existing DB record
      const [currentProfile] = await DB.query(
        'SELECT photo_path, vocal_salutation_path FROM truth_stream_profiles WHERE user_id = ?',
        [userId]
      ) as any[];
      const currentPhoto = req.body.photoPath ?? currentProfile?.[0]?.photo_path;
      const currentVoice = req.body.vocalSalutationPath ?? currentProfile?.[0]?.vocal_salutation_path;

      if (validShared.includes('facial') && !currentPhoto) {
        res.status(400).json({
          error: 'Photo is required when sharing facial data',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      if (validShared.includes('voice') && !currentVoice) {
        res.status(400).json({
          error: 'Voice recording is required when sharing voice data',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      updates.push('shared_data_types = ?');
      params.push(JSON.stringify(validShared));
      updates.push('minimum_share_met = ?');
      params.push(validShared.length >= 3 ? 1 : 0);
    }

    if (req.body.isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(req.body.isActive ? 1 : 0);

      // If deactivating, expire pending queue items
      if (!req.body.isActive) {
        await DB.query(
          `UPDATE truth_stream_queue SET status = 'cancelled'
           WHERE reviewee_id = ? AND status IN ('pending', 'in_progress')`,
          [userId]
        );
      }
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No valid fields to update', code: 'VALIDATION_ERROR' });
      return;
    }

    params.push(userId);
    await DB.query(
      `UPDATE truth_stream_profiles SET ${updates.join(', ')} WHERE user_id = ?`,
      params
    );

    res.json({ success: true, message: 'Truth Card updated' });
  } catch (error: any) {
    console.error('Error updating profile:', error.message);
    res.status(500).json({ error: 'Failed to update profile', code: 'SERVER_ERROR' });
  }
}

/**
 * GET /profile/:userId/card — Get another user's Truth Card for reviewing
 */
export async function getTruthCard(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const revieweeId = parseInt(req.params.userId, 10);
    if (isNaN(revieweeId)) {
      res.status(400).json({ error: 'Invalid user ID', code: 'VALIDATION_ERROR' });
      return;
    }

    // Allow self-viewing; otherwise verify the requester has this user in their queue
    if (revieweeId !== req.user!.id) {
      const [queueCheck] = await DB.query(
        `SELECT id FROM truth_stream_queue
         WHERE reviewer_id = ? AND reviewee_id = ? AND status IN ('pending', 'in_progress')`,
        [req.user!.id, revieweeId]
      ) as any[];

      if (!queueCheck || queueCheck.length === 0) {
        res.status(403).json({ error: 'You can only view Truth Cards of users in your queue', code: 'NOT_IN_QUEUE' });
        return;
      }
    }

    const [rows] = await DB.query(
      `SELECT display_alias, age_range, gender_display, pronouns, cultural_context,
              photo_path, vocal_salutation_path, goal, goal_category,
              self_statement, feedback_areas, shared_data_types
       FROM truth_stream_profiles
       WHERE user_id = ? AND is_active = 1`,
      [revieweeId]
    ) as any[];

    if (!rows || rows.length === 0) {
      res.status(404).json({ error: 'Truth Card not found or inactive', code: 'PROFILE_NOT_FOUND' });
      return;
    }

    const profile = rows[0];

    // Build shared data from intake (only shared types)
    const sharedTypes = safeJsonParse(profile.shared_data_types, [] as string[]);
    const sharedData = await buildSharedIntakeData(revieweeId, sharedTypes);

    // Gate photo/voice paths by sharedDataTypes — only expose to reviewers if user opted in
    const isSelfView = revieweeId === req.user!.id;
    const showPhoto = isSelfView || (sharedTypes as string[]).includes('facial');
    const showVoice = isSelfView || (sharedTypes as string[]).includes('voice');

    res.json({
      success: true,
      data: {
        displayAlias: profile.display_alias,
        ageRange: profile.age_range,
        genderDisplay: profile.gender_display,
        pronouns: profile.pronouns,
        culturalContext: profile.cultural_context,
        photoPath: showPhoto ? (profile.photo_path || null) : null,
        vocalSalutationPath: showVoice ? (profile.vocal_salutation_path || null) : null,
        goal: profile.goal,
        goalCategory: profile.goal_category,
        selfStatement: profile.self_statement,
        feedbackAreas: safeJsonParse(profile.feedback_areas, []),
        sharedDataTypes: sharedTypes,
        sharedData,
      },
    });
  } catch (error: any) {
    console.error('Error getting Truth Card:', error.message);
    res.status(500).json({ error: 'Failed to get Truth Card', code: 'SERVER_ERROR' });
  }
}

// ============================================================================
// REVIEW QUEUE HANDLERS
// ============================================================================

/**
 * GET /queue — Get current review batch
 */
export async function getQueue(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    // Check if user has an active profile
    const [profileCheck] = await DB.query(
      'SELECT is_active, minimum_share_met FROM truth_stream_profiles WHERE user_id = ?',
      [userId]
    ) as any[];

    if (!profileCheck || profileCheck.length === 0) {
      res.status(403).json({ error: 'Create your Truth Card first', code: 'PROFILE_REQUIRED' });
      return;
    }
    if (!profileCheck[0].is_active) {
      res.status(403).json({ error: 'Activate your Truth Card first', code: 'PROFILE_INACTIVE' });
      return;
    }

    const batch = await truthStreamQueueManager.getCurrentBatch(userId);

    if (!batch) {
      // No active batch — generate one
      const newBatch = await truthStreamQueueManager.generateBatch(userId);
      res.json({ success: true, data: newBatch });
      return;
    }

    res.json({ success: true, data: batch });
  } catch (error: any) {
    console.error('Error getting queue:', error.message);
    res.status(500).json({ error: 'Failed to get review queue', code: 'SERVER_ERROR' });
  }
}

/**
 * POST /queue/:queueId/start — Start reviewing a queue item
 */
export async function startQueueItem(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const queueId = req.params.queueId;

    const item = await truthStreamQueueManager.startQueueItem(queueId, userId);

    res.json({ success: true, data: item });
  } catch (error: any) {
    const statusCode = (error as any).statusCode || 500;
    const code = (error as any).code || 'SERVER_ERROR';
    res.status(statusCode).json({ error: error.message, code });
  }
}

/**
 * POST /queue/:queueId/complete — Submit a review
 */
export async function completeQueueItem(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const queueId = req.params.queueId;
    const { responses, timeSpentSeconds } = req.body;

    if (!responses || typeof responses !== 'object') {
      res.status(400).json({ error: 'Responses are required', code: 'VALIDATION_ERROR' });
      return;
    }

    // Validate time spent
    const time = typeof timeSpentSeconds === 'number' ? timeSpentSeconds : 0;
    if (time < MIN_REVIEW_TIME) {
      res.status(400).json({
        error: `Please spend more time reviewing this person's Truth Card (minimum ${MIN_REVIEW_TIME}s)`,
        code: 'TOO_FAST',
        data: { timeSpent: time, minimum: MIN_REVIEW_TIME },
      });
      return;
    }

    // Get queue item details
    const [queueRows] = await DB.query(
      `SELECT q.*, p.goal_category
       FROM truth_stream_queue q
       JOIN truth_stream_profiles p ON p.user_id = q.reviewee_id
       WHERE q.id = ? AND q.reviewer_id = ?`,
      [queueId, userId]
    ) as any[];

    if (!queueRows || queueRows.length === 0) {
      res.status(403).json({ error: 'Queue item not found or unauthorized', code: 'NOT_YOUR_QUEUE' });
      return;
    }

    const queueItem = queueRows[0];

    if (queueItem.status === 'completed') {
      res.status(409).json({ error: 'Review already submitted', code: 'DUPLICATE' });
      return;
    }

    if (queueItem.status !== 'in_progress') {
      res.status(409).json({ error: 'Queue item must be started first', code: 'INVALID_STATE' });
      return;
    }

    // Get questionnaire for validation
    const [questRows] = await DB.query(
      `SELECT id, sections FROM truth_stream_questionnaires
       WHERE goal_category = ? AND is_active = 1
       ORDER BY version DESC LIMIT 1`,
      [queueItem.goal_category]
    ) as any[];

    if (!questRows || questRows.length === 0) {
      res.status(500).json({ error: 'Questionnaire not found for goal category', code: 'SERVER_ERROR' });
      return;
    }

    const questionnaire = questRows[0];
    const sections = safeJsonParse(questionnaire.sections, []);

    // Validate responses against questionnaire
    const validationErrors = truthStreamReviewScorer.validateResponses(responses, sections);
    if (validationErrors.length > 0) {
      res.status(400).json({
        error: 'Invalid review responses',
        code: 'INVALID_RESPONSES',
        data: { errors: validationErrors },
      });
      return;
    }

    // Score the review locally
    const scoreResult = truthStreamReviewScorer.scoreReview(responses, sections, time);

    // Extract free-form text and tone
    const freeFormText = truthStreamReviewScorer.extractFreeFormText(responses);
    const selfTaggedTone = truthStreamReviewScorer.extractSelfTaggedTone(responses);

    // Use a transaction to ensure atomicity
    const connection = await DB.getConnection();
    try {
      await connection.beginTransaction();

      const reviewId = crypto.randomUUID();

      // Insert the review
      await connection.query(
        `INSERT INTO truth_stream_reviews
         (id, queue_id, reviewer_id, reviewee_id, questionnaire_id, responses,
          completeness_score, depth_score, quality_score, time_spent_seconds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reviewId, queueId, userId, queueItem.reviewee_id, questionnaire.id,
          JSON.stringify(responses),
          scoreResult.completenessScore, scoreResult.depthScore,
          scoreResult.qualityScore, time,
        ]
      );

      // Mark queue item as completed
      await connection.query(
        `UPDATE truth_stream_queue
         SET status = 'completed', completed_at = NOW(), time_spent_seconds = ?
         WHERE id = ?`,
        [time, queueId]
      );

      // Update reviewer stats
      await connection.query(
        `UPDATE truth_stream_profiles
         SET total_reviews_given = total_reviews_given + 1
         WHERE user_id = ?`,
        [userId]
      );

      // Update reviewee stats
      await connection.query(
        `UPDATE truth_stream_profiles
         SET total_reviews_received = total_reviews_received + 1
         WHERE user_id = ?`,
        [queueItem.reviewee_id]
      );

      // Queue classification job for async processing
      const jobId = crypto.randomUUID();
      await connection.query(
        `INSERT INTO truth_stream_processing_queue
         (id, job_type, reference_id, user_id, priority, input_data)
         VALUES (?, 'classify_review', ?, ?, 1, ?)`,
        [
          jobId, reviewId, queueItem.reviewee_id,
          JSON.stringify({
            reviewId,
            reviewText: freeFormText,
            responses,
            reviewTone: selfTaggedTone,
            revieweeGoal: queueItem.goal_category,
            qualityMetrics: scoreResult,
          }),
        ]
      );

      await connection.commit();

      res.status(201).json({
        success: true,
        data: {
          reviewId,
          qualityScore: scoreResult.qualityScore,
          completenessScore: scoreResult.completenessScore,
          depthScore: scoreResult.depthScore,
          breakdown: scoreResult.breakdown,
          classificationPending: true,
        },
      });
    } catch (txError) {
      await connection.rollback();
      throw txError;
    } finally {
      connection.release();
    }
  } catch (error: any) {
    console.error('Error submitting review:', error.message);
    const statusCode = (error as any).statusCode || 500;
    const code = (error as any).code || 'SERVER_ERROR';
    res.status(statusCode).json({ error: error.message, code });
  }
}

// ============================================================================
// REVIEW HANDLERS
// ============================================================================

/**
 * GET /reviews/received — Get reviews the user has received (paginated)
 */
export async function getReceivedReviews(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const offset = (page - 1) * limit;

    // Check if user has completed their batch (earn by giving)
    const batchComplete = await truthStreamQueueManager.isBatchComplete(userId);
    if (!batchComplete) {
      res.status(403).json({
        error: 'Complete your current review batch to see your reviews',
        code: 'BATCH_INCOMPLETE',
      });
      return;
    }

    const [countRows] = await DB.query(
      'SELECT COUNT(*) as total FROM truth_stream_reviews WHERE reviewee_id = ?',
      [userId]
    ) as any[];

    const total = countRows[0]?.total || 0;

    const [rows] = await DB.query(
      `SELECT id, responses, classification, classification_confidence,
              classification_reasoning, dina_counter_analysis,
              completeness_score, depth_score, quality_score,
              helpful_count, is_flagged, time_spent_seconds,
              created_at
       FROM truth_stream_reviews
       WHERE reviewee_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    ) as any[];

    // Anonymize timestamps (round to nearest hour)
    const reviews = (rows || []).map((r: any) => ({
      id: r.id,
      responses: safeJsonParse(r.responses, {}),
      classification: r.classification,
      classificationConfidence: r.classification_confidence,
      classificationReasoning: r.classification_reasoning,
      dinaCounterAnalysis: r.dina_counter_analysis,
      completenessScore: r.completeness_score,
      depthScore: r.depth_score,
      qualityScore: r.quality_score,
      helpfulCount: r.helpful_count,
      isFlagged: !!r.is_flagged,
      timeSpentSeconds: r.time_spent_seconds,
      // Round timestamp to nearest hour for anonymity
      createdAt: roundToNearestHour(r.created_at),
    }));

    res.json({
      success: true,
      data: {
        items: reviews,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('Error getting received reviews:', error.message);
    res.status(500).json({ error: 'Failed to get reviews', code: 'SERVER_ERROR' });
  }
}

/**
 * GET /reviews/given — Get reviews the user has given (paginated)
 */
export async function getGivenReviews(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const offset = (page - 1) * limit;

    const [countRows] = await DB.query(
      'SELECT COUNT(*) as total FROM truth_stream_reviews WHERE reviewer_id = ?',
      [userId]
    ) as any[];

    const total = countRows[0]?.total || 0;

    // Only return the review content, NOT the reviewee identity (edge case #54)
    const [rows] = await DB.query(
      `SELECT id, responses, classification, completeness_score, depth_score,
              quality_score, time_spent_seconds, created_at
       FROM truth_stream_reviews
       WHERE reviewer_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    ) as any[];

    const reviews = (rows || []).map((r: any) => ({
      id: r.id,
      responses: safeJsonParse(r.responses, {}),
      classification: r.classification,
      completenessScore: r.completeness_score,
      depthScore: r.depth_score,
      qualityScore: r.quality_score,
      timeSpentSeconds: r.time_spent_seconds,
      createdAt: r.created_at,
    }));

    res.json({
      success: true,
      data: { items: reviews, total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    console.error('Error getting given reviews:', error.message);
    res.status(500).json({ error: 'Failed to get reviews', code: 'SERVER_ERROR' });
  }
}

/**
 * POST /reviews/:reviewId/helpful — Mark a review as helpful
 */
export async function markHelpful(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const reviewId = req.params.reviewId;

    // Verify the review belongs to this user (is the reviewee)
    const [reviewCheck] = await DB.query(
      'SELECT id FROM truth_stream_reviews WHERE id = ? AND reviewee_id = ?',
      [reviewId, userId]
    ) as any[];

    if (!reviewCheck || reviewCheck.length === 0) {
      res.status(403).json({ error: 'Unauthorized', code: 'NOT_YOUR_REVIEW' });
      return;
    }

    const voteId = crypto.randomUUID();
    try {
      await DB.query(
        'INSERT INTO truth_stream_helpful_votes (id, review_id, user_id) VALUES (?, ?, ?)',
        [voteId, reviewId, userId]
      );
      await DB.query(
        'UPDATE truth_stream_reviews SET helpful_count = helpful_count + 1 WHERE id = ?',
        [reviewId]
      );
      res.json({ success: true, message: 'Marked as helpful' });
    } catch (err: any) {
      if (err.code === 'ER_DUP_ENTRY') {
        res.status(409).json({ error: 'Already marked as helpful', code: 'DUPLICATE' });
      } else {
        throw err;
      }
    }
  } catch (error: any) {
    console.error('Error marking helpful:', error.message);
    res.status(500).json({ error: 'Failed to mark helpful', code: 'SERVER_ERROR' });
  }
}

/**
 * DELETE /reviews/:reviewId/helpful — Unmark helpful
 */
export async function unmarkHelpful(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const reviewId = req.params.reviewId;

    const [result] = await DB.query(
      'DELETE FROM truth_stream_helpful_votes WHERE review_id = ? AND user_id = ?',
      [reviewId, userId]
    ) as any[];

    if (result.affectedRows > 0) {
      await DB.query(
        'UPDATE truth_stream_reviews SET helpful_count = GREATEST(helpful_count - 1, 0) WHERE id = ?',
        [reviewId]
      );
    }

    res.json({ success: true, message: 'Unmarked helpful' });
  } catch (error: any) {
    console.error('Error unmarking helpful:', error.message);
    res.status(500).json({ error: 'Failed to unmark helpful', code: 'SERVER_ERROR' });
  }
}

// ============================================================================
// ANONYMOUS DIALOGUE HANDLERS
// ============================================================================

/**
 * POST /reviews/:reviewId/respond — Add to anonymous dialogue
 */
export async function addDialogueMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const reviewId = req.params.reviewId;
    const { content } = req.body;

    const sanitizedContent = sanitizeInput(content, 2000);
    if (!sanitizedContent || sanitizedContent.length < 5) {
      res.status(400).json({ error: 'Message must be at least 5 characters', code: 'VALIDATION_ERROR' });
      return;
    }

    // Determine role
    const [reviewRows] = await DB.query(
      'SELECT reviewer_id, reviewee_id FROM truth_stream_reviews WHERE id = ?',
      [reviewId]
    ) as any[];

    if (!reviewRows || reviewRows.length === 0) {
      res.status(404).json({ error: 'Review not found', code: 'NOT_FOUND' });
      return;
    }

    const review = reviewRows[0];
    let authorRole: 'reviewee' | 'reviewer';

    if (review.reviewee_id === userId) {
      authorRole = 'reviewee';
    } else if (review.reviewer_id === userId) {
      authorRole = 'reviewer';
    } else {
      res.status(403).json({ error: 'Unauthorized', code: 'NOT_PARTICIPANT' });
      return;
    }

    // Check message count limit
    const [countRows] = await DB.query(
      'SELECT COUNT(*) as count FROM truth_stream_dialogues WHERE review_id = ?',
      [reviewId]
    ) as any[];

    if (countRows[0].count >= MAX_DIALOGUE_MESSAGES) {
      res.status(403).json({
        error: 'This conversation has reached its limit. Consider what you have learned.',
        code: 'THREAD_CLOSED',
      });
      return;
    }

    const messageId = crypto.randomUUID();
    await DB.query(
      `INSERT INTO truth_stream_dialogues (id, review_id, author_role, author_user_id, content)
       VALUES (?, ?, ?, ?, ?)`,
      [messageId, reviewId, authorRole, userId, sanitizedContent]
    );

    res.status(201).json({
      success: true,
      data: {
        id: messageId,
        authorRole,
        content: sanitizedContent,
        createdAt: new Date(),
      },
    });
  } catch (error: any) {
    console.error('Error adding dialogue message:', error.message);
    res.status(500).json({ error: 'Failed to add message', code: 'SERVER_ERROR' });
  }
}

/**
 * GET /reviews/:reviewId/dialogue — Get dialogue thread
 */
export async function getDialogue(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const reviewId = req.params.reviewId;

    // Verify participant
    const [reviewRows] = await DB.query(
      'SELECT reviewer_id, reviewee_id FROM truth_stream_reviews WHERE id = ?',
      [reviewId]
    ) as any[];

    if (!reviewRows || reviewRows.length === 0) {
      res.status(404).json({ error: 'Review not found', code: 'NOT_FOUND' });
      return;
    }

    const review = reviewRows[0];
    if (review.reviewee_id !== userId && review.reviewer_id !== userId) {
      res.status(403).json({ error: 'Unauthorized', code: 'NOT_PARTICIPANT' });
      return;
    }

    const [rows] = await DB.query(
      `SELECT id, author_role, content, is_system_message, created_at
       FROM truth_stream_dialogues
       WHERE review_id = ?
       ORDER BY created_at ASC`,
      [reviewId]
    ) as any[];

    res.json({
      success: true,
      data: {
        reviewId,
        messages: (rows || []).map((m: any) => ({
          id: m.id,
          authorRole: m.author_role,
          content: m.content,
          isSystemMessage: !!m.is_system_message,
          createdAt: m.created_at,
        })),
        messageCount: rows?.length || 0,
        maxMessages: MAX_DIALOGUE_MESSAGES,
      },
    });
  } catch (error: any) {
    console.error('Error getting dialogue:', error.message);
    res.status(500).json({ error: 'Failed to get dialogue', code: 'SERVER_ERROR' });
  }
}

/**
 * POST /reviews/:reviewId/flag — Flag a review
 */
export async function flagReview(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const reviewId = req.params.reviewId;
    const { reason } = req.body;

    // Verify the review is for this user
    const [reviewCheck] = await DB.query(
      'SELECT id FROM truth_stream_reviews WHERE id = ? AND reviewee_id = ?',
      [reviewId, userId]
    ) as any[];

    if (!reviewCheck || reviewCheck.length === 0) {
      res.status(403).json({ error: 'Unauthorized', code: 'NOT_YOUR_REVIEW' });
      return;
    }

    await DB.query(
      'UPDATE truth_stream_reviews SET is_flagged = 1, flag_reason = ? WHERE id = ?',
      [sanitizeInput(reason, 500) || 'Flagged by reviewee', reviewId]
    );

    res.json({ success: true, message: 'Review flagged for review' });
  } catch (error: any) {
    console.error('Error flagging review:', error.message);
    res.status(500).json({ error: 'Failed to flag review', code: 'SERVER_ERROR' });
  }
}

// ============================================================================
// ANALYSIS HANDLERS
// ============================================================================

/**
 * GET /analysis — Get latest analysis
 */
export async function getAnalysis(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const type = req.query.type as string || 'truth_mirror_report';

    const [rows] = await DB.query(
      `SELECT id, analysis_type, review_count_at_generation, analysis_data,
              perception_gap_score, confidence_level, created_at
       FROM truth_stream_analyses
       WHERE user_id = ? AND analysis_type = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, type]
    ) as any[];

    if (!rows || rows.length === 0) {
      res.json({ success: true, data: null, message: 'No analysis generated yet' });
      return;
    }

    const analysis = rows[0];
    res.json({
      success: true,
      data: {
        id: analysis.id,
        analysisType: analysis.analysis_type,
        reviewCountAtGeneration: analysis.review_count_at_generation,
        analysisData: safeJsonParse(analysis.analysis_data, {}),
        perceptionGapScore: analysis.perception_gap_score,
        confidenceLevel: analysis.confidence_level,
        createdAt: analysis.created_at,
      },
    });
  } catch (error: any) {
    console.error('Error getting analysis:', error.message);
    res.status(500).json({ error: 'Failed to get analysis', code: 'SERVER_ERROR' });
  }
}

/**
 * POST /analysis/generate — Request new analysis from Dina
 */
export async function generateAnalysis(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const analysisType = req.body.analysisType || 'truth_mirror_report';

    // Check review count
    const [countRows] = await DB.query(
      'SELECT COUNT(*) as count FROM truth_stream_reviews WHERE reviewee_id = ?',
      [userId]
    ) as any[];

    const reviewCount = countRows[0]?.count || 0;
    if (reviewCount < MIN_REVIEWS_FOR_ANALYSIS) {
      res.status(400).json({
        error: `Need ${MIN_REVIEWS_FOR_ANALYSIS}+ reviews for meaningful analysis`,
        code: 'INSUFFICIENT_REVIEWS',
        data: { current: reviewCount, minimum: MIN_REVIEWS_FOR_ANALYSIS },
      });
      return;
    }

    // Check if analysis is already processing
    // First, auto-fail any stale jobs stuck in 'processing' for over 5 minutes
    // This prevents a failed queue processor from permanently blocking new requests
    const STALE_JOB_MINUTES = 5;
    const [staleJobs] = await DB.query(
      `SELECT id FROM truth_stream_processing_queue
       WHERE user_id = ? AND job_type = 'generate_analysis' AND status = 'processing'
         AND started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [userId, STALE_JOB_MINUTES]
    ) as any[];

    if (staleJobs && staleJobs.length > 0) {
      const staleIds = staleJobs.map((j: any) => j.id);
      console.warn(`Auto-failing ${staleIds.length} stale generate_analysis job(s) for user ${userId}:`, staleIds);
      await DB.query(
        `UPDATE truth_stream_processing_queue
         SET status = 'failed', error_message = 'Auto-failed: exceeded ${STALE_JOB_MINUTES}min processing timeout', completed_at = NOW()
         WHERE id IN (${staleIds.map(() => '?').join(',')})`,
        staleIds
      );
    }

    // Now check for legitimately active jobs (pending or recently-started processing)
    const [pendingJobs] = await DB.query(
      `SELECT id FROM truth_stream_processing_queue
       WHERE user_id = ? AND job_type = 'generate_analysis' AND status IN ('pending', 'processing')`,
      [userId]
    ) as any[];

    if (pendingJobs && pendingJobs.length > 0) {
      res.status(409).json({
        error: 'Analysis is already in progress',
        code: 'ALREADY_PROCESSING',
        data: { jobId: pendingJobs[0].id },
      });
      return;
    }

    // Queue the analysis job
    const jobId = crypto.randomUUID();
    await DB.query(
      `INSERT INTO truth_stream_processing_queue
       (id, job_type, reference_id, user_id, priority, input_data)
       VALUES (?, 'generate_analysis', ?, ?, 2, ?)`,
      [
        jobId, String(userId), userId,
        JSON.stringify({ analysisType, reviewCount }),
      ]
    );

    res.status(202).json({
      success: true,
      data: {
        jobId,
        message: 'Analysis queued for processing',
        analysisType,
      },
    });
  } catch (error: any) {
    console.error('Error generating analysis:', error.message);
    res.status(500).json({ error: 'Failed to queue analysis', code: 'SERVER_ERROR' });
  }
}

/**
 * GET /analysis/perception-gap — Get perception gap score
 */
export async function getPerceptionGap(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    const [rows] = await DB.query(
      'SELECT perception_gap_score FROM truth_stream_profiles WHERE user_id = ?',
      [userId]
    ) as any[];

    if (!rows || rows.length === 0) {
      res.status(404).json({ error: 'Profile not found', code: 'PROFILE_NOT_FOUND' });
      return;
    }

    res.json({
      success: true,
      data: { perceptionGapScore: rows[0].perception_gap_score },
    });
  } catch (error: any) {
    console.error('Error getting perception gap:', error.message);
    res.status(500).json({ error: 'Failed to get perception gap', code: 'SERVER_ERROR' });
  }
}

// ============================================================================
// FEEDBACK REQUEST HANDLERS
// ============================================================================

/**
 * POST /feedback-requests — Create feedback request
 */
export async function createFeedbackRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { question, context } = req.body;

    const sanitizedQuestion = sanitizeInput(question, 500);
    if (!sanitizedQuestion || sanitizedQuestion.length < 10) {
      res.status(400).json({ error: 'Question must be at least 10 characters', code: 'VALIDATION_ERROR' });
      return;
    }

    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600000); // 7 days

    await DB.query(
      `INSERT INTO truth_stream_feedback_requests (id, user_id, question, context, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, userId, sanitizedQuestion, sanitizeInput(context, 1000), expiresAt]
    );

    res.status(201).json({
      success: true,
      data: { id, question: sanitizedQuestion, expiresAt },
    });
  } catch (error: any) {
    console.error('Error creating feedback request:', error.message);
    res.status(500).json({ error: 'Failed to create feedback request', code: 'SERVER_ERROR' });
  }
}

/**
 * GET /feedback-requests — Get my feedback requests
 */
export async function getMyFeedbackRequests(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    const [rows] = await DB.query(
      `SELECT id, question, context, is_active, response_count, created_at, expires_at
       FROM truth_stream_feedback_requests
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    ) as any[];

    res.json({ success: true, data: { items: rows || [] } });
  } catch (error: any) {
    console.error('Error getting feedback requests:', error.message);
    res.status(500).json({ error: 'Failed to get feedback requests', code: 'SERVER_ERROR' });
  }
}

/**
 * GET /feedback-requests/feed — Get others' active feedback requests
 */
export async function getFeedbackRequestsFeed(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    const [rows] = await DB.query(
      `SELECT fr.id, fr.question, fr.context, fr.response_count, fr.created_at,
              p.display_alias, p.goal_category
       FROM truth_stream_feedback_requests fr
       JOIN truth_stream_profiles p ON p.user_id = fr.user_id
       WHERE fr.user_id != ? AND fr.is_active = 1
         AND (fr.expires_at IS NULL OR fr.expires_at > NOW())
       ORDER BY fr.created_at DESC
       LIMIT 20`,
      [userId]
    ) as any[];

    res.json({ success: true, data: { items: rows || [] } });
  } catch (error: any) {
    console.error('Error getting feedback feed:', error.message);
    res.status(500).json({ error: 'Failed to get feedback feed', code: 'SERVER_ERROR' });
  }
}

// ============================================================================
// STATS & MILESTONES HANDLERS
// ============================================================================

/**
 * GET /stats — Get TruthStream statistics
 */
export async function getStats(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    const [profileRows] = await DB.query(
      `SELECT total_reviews_received, total_reviews_given, review_quality_score,
              perception_gap_score, profile_completeness
       FROM truth_stream_profiles WHERE user_id = ?`,
      [userId]
    ) as any[];

    if (!profileRows || profileRows.length === 0) {
      res.json({ success: true, data: null });
      return;
    }

    const profile = profileRows[0];

    // Get classification distribution
    const [classRows] = await DB.query(
      `SELECT classification, COUNT(*) as count
       FROM truth_stream_reviews
       WHERE reviewee_id = ? AND classification IS NOT NULL
       GROUP BY classification`,
      [userId]
    ) as any[];

    const classificationDistribution: Record<string, number> = {};
    for (const row of classRows || []) {
      classificationDistribution[row.classification] = row.count;
    }

    res.json({
      success: true,
      data: {
        totalReviewsReceived: profile.total_reviews_received,
        totalReviewsGiven: profile.total_reviews_given,
        reviewQualityScore: profile.review_quality_score,
        perceptionGapScore: profile.perception_gap_score,
        profileCompleteness: profile.profile_completeness,
        classificationDistribution,
      },
    });
  } catch (error: any) {
    console.error('Error getting stats:', error.message);
    res.status(500).json({ error: 'Failed to get stats', code: 'SERVER_ERROR' });
  }
}

/**
 * GET /milestones — Get earned milestones
 */
export async function getMilestones(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    const [rows] = await DB.query(
      `SELECT id, milestone_type, milestone_name, milestone_description, milestone_data, achieved_at
       FROM truth_stream_milestones
       WHERE user_id = ?
       ORDER BY achieved_at DESC`,
      [userId]
    ) as any[];

    res.json({
      success: true,
      data: {
        items: (rows || []).map((m: any) => ({
          ...m,
          milestoneData: safeJsonParse(m.milestone_data, null),
        })),
      },
    });
  } catch (error: any) {
    console.error('Error getting milestones:', error.message);
    res.status(500).json({ error: 'Failed to get milestones', code: 'SERVER_ERROR' });
  }
}

/**
 * GET /questionnaire/:goalCategory — Get the questionnaire for a goal category
 */
export async function getQuestionnaire(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const goalCategory = req.params.goalCategory;

    const validCategories = [
      'personal_growth', 'dating_readiness', 'professional_image',
      'social_skills', 'first_impressions', 'leadership',
      'communication', 'authenticity', 'confidence', 'custom',
    ];

    if (!validCategories.includes(goalCategory)) {
      res.status(400).json({
        error: `Invalid goal category. Valid: ${validCategories.join(', ')}`,
        code: 'INVALID_CATEGORY',
      });
      return;
    }

    const [rows] = await DB.query(
      `SELECT id, goal_category, version, sections
       FROM truth_stream_questionnaires
       WHERE goal_category = ? AND is_active = 1
       ORDER BY version DESC
       LIMIT 1`,
      [goalCategory]
    ) as any[];

    if (!rows || rows.length === 0) {
      res.status(404).json({ error: 'Questionnaire not found', code: 'NOT_FOUND' });
      return;
    }

    const quest = rows[0];
    res.json({
      success: true,
      data: {
        id: quest.id,
        goalCategory: quest.goal_category,
        version: quest.version,
        sections: safeJsonParse(quest.sections, []),
      },
    });
  } catch (error: any) {
    console.error('Error getting questionnaire:', error.message);
    res.status(500).json({ error: 'Failed to get questionnaire', code: 'SERVER_ERROR' });
  }
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

/**
 * Build shared intake data for a Truth Card.
 * Only includes data types the user has chosen to share.
 */
async function buildSharedIntakeData(userId: number, sharedTypes: string[]): Promise<Record<string, any>> {
  const shared: Record<string, any> = {};

  try {
    // Retrieve intake data via IntakeDataManager (file-based tiered storage)
    const context: DataAccessContext = {
      userId,
      accessedBy: userId,
      sessionId: 'truthstream',
      reason: 'truth_card_shared_data',
    };

    const result = await IntakeDataManager.getLatestIntakeData(
      String(userId),
      context,
      false
    );

    const intakeData: Record<string, any> = result?.intakeData || {};
    if (!intakeData || Object.keys(intakeData).length === 0) return shared;

    if (sharedTypes.includes('personality') && intakeData.personalityResult) {
      shared.personality = {
        mbtiType: intakeData.personalityResult.mbtiType,
        dominantTraits: intakeData.personalityResult.dominantTraits,
        description: intakeData.personalityResult.description,
        // Expose Big 5 as radar chart data
        big5: intakeData.personalityResult.big5Profile,
      };
    }

    if (sharedTypes.includes('cognitive') && intakeData.iqResults) {
      // Share cognitive style, NOT raw IQ score
      shared.cognitive = {
        category: intakeData.iqResults.category,
        strengths: intakeData.iqResults.strengths,
      };
    }

    if (sharedTypes.includes('facial') && intakeData.faceAnalysis) {
      // face-api.js stores expressions as a flat record: { happy: 0.9, sad: 0.1, ... }
      // Compute dominant expression from the raw scores
      const expressions = intakeData.faceAnalysis.expressions;
      let dominantExpression = 'neutral';
      if (expressions && typeof expressions === 'object') {
        const entries = Object.entries(expressions)
          .filter(([, v]) => typeof v === 'number') as [string, number][];
        if (entries.length > 0) {
          entries.sort((a, b) => b[1] - a[1]);
          dominantExpression = entries[0][0];
        }
      }
      shared.facial = {
        dominantExpression,
        expressionProfile: expressions || {},
      };
    }

    if (sharedTypes.includes('voice') && intakeData.voiceMetadata) {
      shared.voice = {
        duration: intakeData.voiceMetadata.duration,
      };
    }

    // Support both legacy key "astrologicalResult" (client submit) and
    // stored key "astrologicalData" (intake file section name)
    const astroData = intakeData.astrologicalResult || intakeData.astrologicalData;
    if (sharedTypes.includes('astrological') && astroData) {
      shared.astrological = {
        westernSign: astroData.western?.sunSign,
        chineseSign: astroData.chinese?.animal || astroData.chinese?.animalSign,
        synthesis: astroData.synthesis?.summary || astroData.synthesis?.lifeDirection,
        // Full western data
        western: astroData.western ? {
          sunSign: astroData.western.sunSign,
          moonSign: astroData.western.moonSign,
          risingSign: astroData.western.risingSign,
          dominantElement: astroData.western.dominantElement,
          modality: astroData.western.modality,
          chartRuler: astroData.western.chartRuler,
          houses: astroData.western.houses || null,
          planetaryPlacements: astroData.western.planetaryPlacements || null,
        } : null,
        // Full chinese data
        chinese: astroData.chinese ? {
          animalSign: astroData.chinese.animalSign || astroData.chinese.animal,
          element: astroData.chinese.element,
          yinYang: astroData.chinese.yinYang,
          innerAnimal: astroData.chinese.innerAnimal,
          secretAnimal: astroData.chinese.secretAnimal,
          luckyNumbers: astroData.chinese.luckyNumbers,
          luckyColors: astroData.chinese.luckyColors,
          personality: astroData.chinese.personality,
          compatibility: astroData.chinese.compatibility,
          lifePhase: astroData.chinese.lifePhase,
        } : null,
        // Full african data
        african: astroData.african ? {
          orishaGuardian: astroData.african.orishaGuardian,
          ancestralSpirit: astroData.african.ancestralSpirit,
          elementalForce: astroData.african.elementalForce,
          sacredAnimal: astroData.african.sacredAnimal,
          lifeDestiny: astroData.african.lifeDestiny,
          spiritualGifts: astroData.african.spiritualGifts,
          challenges: astroData.african.challenges,
          ceremonies: astroData.african.ceremonies,
          seasons: astroData.african.seasons,
        } : null,
        // Full numerology data
        numerology: astroData.numerology ? {
          lifePathNumber: astroData.numerology.lifePathNumber,
          destinyNumber: astroData.numerology.destinyNumber,
          soulUrgeNumber: astroData.numerology.soulUrgeNumber,
          personalityNumber: astroData.numerology.personalityNumber,
          birthDayNumber: astroData.numerology.birthDayNumber,
          meanings: astroData.numerology.meanings,
        } : null,
        // Full synthesis
        synthesisData: astroData.synthesis ? {
          coreThemes: astroData.synthesis.coreThemes,
          lifeDirection: astroData.synthesis.lifeDirection,
          spiritualPath: astroData.synthesis.spiritualPath,
          relationships: astroData.synthesis.relationships,
          career: astroData.synthesis.career,
          wellness: astroData.synthesis.wellness,
        } : null,
      };
    }

    if (sharedTypes.includes('profile')) {
      const [userRows] = await DB.query(
        'SELECT created_at FROM users WHERE id = ?',
        [userId]
      ) as any[];
      if (userRows && userRows.length > 0) {
        shared.profile = {
          memberSince: userRows[0].created_at,
        };
      }
    }
  } catch (error: any) {
    console.error('Error building shared intake data:', error.message);
  }

  return shared;
}

/**
 * Round a date to the nearest hour for anonymity protection.
 */
function roundToNearestHour(date: Date | string): Date {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
}

// ============================================================================
// ANALYSIS TRENDS HANDLER
// ============================================================================

/**
 * GET /analysis/trends — Get temporal trend analysis
 * Returns the most recent temporal_trend analysis for the user.
 */
export async function getAnalysisTrends(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;

    const [rows] = await DB.query(
      `SELECT id, analysis_type, analysis_data, confidence_level, created_at
       FROM truth_stream_analyses
       WHERE user_id = ? AND analysis_type = 'temporal_trend'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    ) as any[];

    if (!rows || rows.length === 0) {
      res.json({ success: true, data: null, message: 'No trend analysis generated yet' });
      return;
    }

    const analysis = rows[0];
    res.json({
      success: true,
      data: {
        id: analysis.id,
        userId,
        analysisType: analysis.analysis_type,
        analysisData: safeJsonParse(analysis.analysis_data, {}),
        confidenceLevel: analysis.confidence_level,
        createdAt: analysis.created_at,
      },
    });
  } catch (error: any) {
    console.error('Error getting analysis trends:', error.message);
    res.status(500).json({ error: 'Failed to get trend analysis', code: 'SERVER_ERROR' });
  }
}

// ============================================================================
// USER DELETION CASCADE
// ============================================================================
// This is the PRIMARY mechanism for cleaning up TruthStream data when a user
// deletes their account. The DB trigger (009b_truthstream_trigger_admin.sql)
// is a safety net — this function handles the nuanced logic.
//
// Call this BEFORE deleting the user row from the users table.
// The CASCADE foreign keys on user_id will handle the rest (profile,
// received reviews, analyses, milestones, feedback requests, etc.).
// ============================================================================

/**
 * Clean up TruthStream data for a user BEFORE their account is deleted.
 *
 * Preserves reviews this user wrote for others (sets reviewer_id to NULL)
 * so the reviewee doesn't lose valuable feedback. Everything owned by
 * this user is cleaned up by CASCADE after the users row is deleted.
 *
 * @param userId - The ID of the user being deleted
 * @returns true if cleanup succeeded, false if it failed (non-blocking)
 */
export async function cleanupUserTruthStreamData(userId: number): Promise<boolean> {
  const connection = await DB.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Preserve reviews this user wrote for other people
    //    Nullify reviewer_id so the review content remains for the reviewee
    await connection.query(
      'UPDATE truth_stream_reviews SET reviewer_id = NULL WHERE reviewer_id = ?',
      [userId]
    );

    // 2. Cancel incomplete queue assignments where this user was reviewer
    //    Completed queue items will be cleaned up by CASCADE on reviewee side
    await connection.query(
      `DELETE FROM truth_stream_queue
       WHERE reviewer_id = ? AND status IN ('pending', 'in_progress')`,
      [userId]
    );

    // 3. Mark dialogues from this user as system messages (identity removed)
    await connection.query(
      `UPDATE truth_stream_dialogues
       SET author_user_id = NULL,
           content = CONCAT('[This user has deleted their account] ', content),
           is_system_message = 1
       WHERE author_user_id = ?`,
      [userId]
    );

    // 4. Cancel any pending processing jobs for this user
    await connection.query(
      `UPDATE truth_stream_processing_queue
       SET status = 'failed', error_message = 'User account deleted'
       WHERE user_id = ? AND status IN ('pending', 'processing')`,
      [userId]
    );

    // 5. Remove hostility log entries where this user was the reviewer
    //    (audit trail for their own reviews is no longer meaningful)
    await connection.query(
      'DELETE FROM truth_stream_hostility_log WHERE reviewer_id = ?',
      [userId]
    );

    await connection.commit();
    console.log(`TruthStream cleanup completed for user ${userId}`);
    return true;
  } catch (error: any) {
    await connection.rollback();
    console.error(`TruthStream cleanup failed for user ${userId}:`, error.message);
    return false;
  } finally {
    connection.release();
  }
}


