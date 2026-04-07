// ============================================================================
// DATA EXPORT CONTROLLER
// ============================================================================
// GET /user/export — Returns all user data as structured JSON
// The frontend renders this into a styled HTML report and converts to PDF.
// ============================================================================

import { Request, Response } from 'express';
import { DB } from '../db';

interface ExportSection {
  title: string;
  data: any;
  count?: number;
}

export async function exportUserData(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const sections: Record<string, ExportSection> = {};

    // ====================================================================
    // 1. PROFILE
    // ====================================================================
    const [userRows] = await DB.query(
      `SELECT id, username, email, intake_completed, email_verified,
              created_at, last_login, last_active
       FROM users WHERE id = ?`,
      [userId]
    );
    const user = (userRows as any[])[0];
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    sections.profile = {
      title: 'Profile',
      data: {
        username: user.username,
        email: user.email,
        intakeCompleted: !!user.intake_completed,
        emailVerified: !!user.email_verified,
        memberSince: user.created_at,
        lastLogin: user.last_login,
        lastActive: user.last_active,
      },
    };

    // ====================================================================
    // 2. SUBSCRIPTION
    // ====================================================================
    const [subRows] = await DB.query(
      `SELECT tier, status, provider, trial_start, trial_end,
              current_period_start, current_period_end,
              cancelled_at, cancel_reason, created_at
       FROM user_subscriptions WHERE user_id = ?`,
      [userId]
    );
    sections.subscription = {
      title: 'Subscription',
      data: (subRows as any[])[0] || { tier: 'free', status: 'free' },
    };

    // ====================================================================
    // 3. JOURNAL ENTRIES
    // ====================================================================
    const [journalRows] = await DB.query(
      `SELECT id, entry_date, time_of_day, mood_rating, primary_emotion,
              emotion_intensity, energy_level, prompt_responses,
              free_form_entry, tags, category, word_count,
              sentiment_score, created_at
       FROM mirror_journal_entries
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY entry_date DESC`,
      [userId]
    );
    const journals = (journalRows as any[]).map(row => ({
      ...row,
      prompt_responses: safeJsonParse(row.prompt_responses),
      tags: safeJsonParse(row.tags),
    }));
    sections.journal = {
      title: 'Journal Entries',
      data: journals,
      count: journals.length,
    };

    // ====================================================================
    // 4. INTAKE ASSESSMENTS
    // ====================================================================
    const [intakeRows] = await DB.query(
      `SELECT intake_id, submission_date, data_version, has_photo, has_voice
       FROM intake_metadata
       WHERE user_id = ?
       ORDER BY submission_date DESC`,
      [userId]
    );
    sections.intake = {
      title: 'Intake Assessments',
      data: intakeRows,
      count: (intakeRows as any[]).length,
    };

    // ====================================================================
    // 5. PERSONAL ANALYSIS REPORTS
    // ====================================================================
    const [analysisRows] = await DB.query(
      `SELECT id, analysis_type, analysis_data, overall_score,
              confidence_level, journal_entries_analyzed,
              intake_sections_available, created_at
       FROM personal_analyses
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );
    const analyses = (analysisRows as any[]).map(row => ({
      ...row,
      analysis_data: safeJsonParse(row.analysis_data),
    }));
    sections.personalAnalysis = {
      title: 'Personal Analysis Reports',
      data: analyses,
      count: analyses.length,
    };

    // ====================================================================
    // 6. TRUTHSTREAM PROFILE
    // ====================================================================
    try {
      const [tsProfileRows] = await DB.query(
        `SELECT display_alias, age_range, gender_display, pronouns,
                goal, goal_category, self_statement, feedback_areas,
                shared_data_types, total_reviews_received, total_reviews_given,
                review_quality_score, perception_gap_score, profile_completeness,
                created_at
         FROM truth_stream_profiles WHERE user_id = ?`,
        [userId]
      );
      const tsProfile = (tsProfileRows as any[])[0];
      if (tsProfile) {
        tsProfile.feedback_areas = safeJsonParse(tsProfile.feedback_areas);
        tsProfile.shared_data_types = safeJsonParse(tsProfile.shared_data_types);
      }
      sections.truthStreamProfile = {
        title: 'TruthStream Profile',
        data: tsProfile || null,
      };
    } catch { /* table may not exist */ }

    // ====================================================================
    // 7. TRUTHSTREAM REVIEWS RECEIVED
    // ====================================================================
    try {
      const [receivedRows] = await DB.query(
        `SELECT id, responses, classification, classification_confidence,
                completeness_score, depth_score, quality_score,
                time_spent_seconds, helpful_count, created_at
         FROM truth_stream_reviews
         WHERE reviewee_id = ?
         ORDER BY created_at DESC`,
        [userId]
      );
      const received = (receivedRows as any[]).map(row => ({
        ...row,
        responses: safeJsonParse(row.responses),
      }));
      sections.reviewsReceived = {
        title: 'TruthStream Reviews Received',
        data: received,
        count: received.length,
      };
    } catch { /* table may not exist */ }

    // ====================================================================
    // 8. TRUTHSTREAM REVIEWS GIVEN
    // ====================================================================
    try {
      const [givenRows] = await DB.query(
        `SELECT id, responses, classification, completeness_score,
                quality_score, created_at
         FROM truth_stream_reviews
         WHERE reviewer_id = ?
         ORDER BY created_at DESC`,
        [userId]
      );
      const given = (givenRows as any[]).map(row => ({
        ...row,
        responses: safeJsonParse(row.responses),
      }));
      sections.reviewsGiven = {
        title: 'TruthStream Reviews Given',
        data: given,
        count: given.length,
      };
    } catch { /* table may not exist */ }

    // ====================================================================
    // 9. TRUTHSTREAM ANALYSIS REPORTS
    // ====================================================================
    try {
      const [tsAnalysisRows] = await DB.query(
        `SELECT id, analysis_type, analysis_data, perception_gap_score,
                confidence_level, review_count_at_generation, created_at
         FROM truth_stream_analyses
         WHERE user_id = ?
         ORDER BY created_at DESC`,
        [userId]
      );
      const tsAnalyses = (tsAnalysisRows as any[]).map(row => ({
        ...row,
        analysis_data: safeJsonParse(row.analysis_data),
      }));
      sections.truthStreamAnalysis = {
        title: 'TruthStream Analysis Reports',
        data: tsAnalyses,
        count: tsAnalyses.length,
      };
    } catch { /* table may not exist */ }

    // ====================================================================
    // 10. TRUTHSTREAM MILESTONES
    // ====================================================================
    try {
      const [milestoneRows] = await DB.query(
        `SELECT milestone_type, milestone_name, milestone_description,
                milestone_data, achieved_at
         FROM truth_stream_milestones
         WHERE user_id = ?
         ORDER BY achieved_at DESC`,
        [userId]
      );
      sections.milestones = {
        title: 'TruthStream Milestones',
        data: (milestoneRows as any[]).map(row => ({
          ...row,
          milestone_data: safeJsonParse(row.milestone_data),
        })),
        count: (milestoneRows as any[]).length,
      };
    } catch { /* table may not exist */ }

    // ====================================================================
    // 11. GROUP MEMBERSHIPS
    // ====================================================================
    const [groupRows] = await DB.query(
      `SELECT g.id, g.name, g.type, g.privacy, gm.role, gm.status, gm.joined_at
       FROM mirror_group_members gm
       JOIN mirror_groups g ON gm.group_id = g.id
       WHERE gm.user_id = ? AND gm.status = 'active'
       ORDER BY gm.joined_at DESC`,
      [userId]
    );
    sections.groups = {
      title: 'Group Memberships',
      data: groupRows,
      count: (groupRows as any[]).length,
    };

    // ====================================================================
    // 12. USAGE TRACKING
    // ====================================================================
    const [usageRows] = await DB.query(
      `SELECT feature_key, period_type, period_start, count, limit_value
       FROM usage_tracking
       WHERE user_id = ?
       ORDER BY period_start DESC`,
      [userId]
    );
    sections.usage = {
      title: 'Feature Usage History',
      data: usageRows,
    };

    // ====================================================================
    // 13. SUBSCRIPTION EVENTS
    // ====================================================================
    const [eventRows] = await DB.query(
      `SELECT event_type, metadata, created_at
       FROM subscription_events
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 100`,
      [userId]
    );
    sections.subscriptionEvents = {
      title: 'Subscription History',
      data: (eventRows as any[]).map(row => ({
        ...row,
        metadata: safeJsonParse(row.metadata),
      })),
      count: (eventRows as any[]).length,
    };

    // ====================================================================
    // RESPONSE
    // ====================================================================
    res.json({
      success: true,
      exportDate: new Date().toISOString(),
      userId,
      username: user.username,
      sections,
    });

  } catch (error) {
    console.error('Export failed:', error);
    res.status(500).json({ error: 'Failed to generate export' });
  }
}

function safeJsonParse(value: any): any {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}
