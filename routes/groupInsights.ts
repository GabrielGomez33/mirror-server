// ============================================================================
// GROUP INSIGHTS API ROUTES - PHASE 3 (Updated with Owner-Only Generation)
// ============================================================================
// File: server/routes/groupInsights.ts
// ----------------------------------------------------------------------------
// - Group analysis and insights endpoints
// - Compatibility matrix, strengths, conflict risks
// - UPDATED: Generate insights is now owner-only
// - ENHANCED: Added /generate-insights route (same handler as /analyze)
//   to match frontend's groupsApi.generateInsights() calls
// - JWT validation via authenticateToken middleware
// ============================================================================

import express, { RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DB } from '../db';
import AuthMiddleware from '../middleware/authMiddleware';

const router = express.Router();

/* ============================================================================
   TYPE DEFINITIONS
============================================================================ */

interface CompatibilityRow {
  member_a_id: number;
  member_b_id: number;
  member_a_username?: string;
  member_b_username?: string;
  compatibility_score: string;
  personality_similarity: string | null;
  communication_alignment: string | null;
  conflict_compatibility: string | null;
  energy_balance: string | null;
  strengths: string | null;
  challenges: string | null;
  recommendations: string | null;
  explanation: string | null;
  confidence_score: string;
  calculated_at: Date;
}

interface PatternRow {
  id: string;
  pattern_type: string;
  pattern_name: string;
  prevalence: string;
  average_likelihood: string | null;
  member_count: number;
  total_members: number;
  description: string;
  contexts: string | null;
  implications: string | null;
  confidence: string;
  detected_at: Date;
}

interface RiskRow {
  id: string;
  risk_type: string;
  severity: string;
  affected_members: string | null;
  description: string;
  triggers: string | null;
  mitigation_strategies: string | null;
  probability: string;
  impact_score: string;
  resolution_status: string;
  detected_at: Date;
  last_assessed: Date;
}

interface FormattedCompatibility {
  memberA: { id: number; username?: string } | number;
  memberB: { id: number; username?: string } | number;
  overallScore: number;
  scores?: {
    overall: number;
    personality: number | null;
    communication: number | null;
    conflict: number | null;
    energy: number | null;
  };
  factors?: {
    personality: number | null;
    communication: number | null;
    conflict: number | null;
    energy: number | null;
  };
  strengths: any[];
  challenges: any[];
  recommendations: any[];
  explanation: string | null;
  confidence: number;
  analysis?: {
    strengths: any[];
    challenges: any[];
    recommendations: any[];
    explanation: string | null;
  };
  calculatedAt?: Date;
}

interface FormattedPattern {
  id: string;
  type: string;
  name: string;
  prevalence: number;
  averageLikelihood: number | null;
  memberCount?: number;
  totalMembers?: number;
  affectedMembers?: { count: number; percentage: number };
  description: string;
  contexts: any[];
  implications: any[];
  confidence: number;
  detectedAt?: Date;
}

interface FormattedRisk {
  id: string;
  type: string;
  severity: string;
  affectedMembers: any[];
  description: string;
  triggers: any[];
  mitigationStrategies: any[];
  probability: number;
  impact: number;
  riskScore?: number;
  status: string;
  detectedAt?: Date;
  lastAssessed?: Date;
}

interface SharedDataRow {
  user_id: number;
  data_type: string;
  shared_at: Date;
  data_version?: string;
}

interface SharedDataItem {
  dataType: string;
  sharedAt: Date;
  dataVersion?: string;
}

interface MemberRow {
  id: string;
  user_id: number;
  role: string;
  status: string;
  joined_at: Date;
  username: string;
  email?: string;
  user_created_at: Date;
  display_name: string | null;
  avatar_url: string | null;
  bio?: string | null;
  birthdate?: string | null;
  phone?: string | null;
  location?: string | null;
  timezone?: string | null;
}

interface InsightHistoryRow {
  id: string;
  title: string;
  synthesis_type: string;
  content: string;
  key_points: string | null;
  llm_model: string;
  quality_score: string | null;
  generated_at: Date;
}

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

async function verifyGroupMembership(groupId: string, userId: string | number): Promise<boolean> {
  try {
    const [rows]: any = await DB.query(
      `SELECT id FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, String(userId)]
    );
    return rows.length > 0;
  } catch (error) {
    console.error('❌ Error verifying group membership:', error);
    return false;
  }
}

/**
 * Check if a user is the owner of a group
 */
async function verifyGroupOwnership(groupId: string, userId: string | number): Promise<boolean> {
  try {
    const [rows]: any = await DB.query(
      `SELECT id FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND role = 'owner' AND status = 'active'`,
      [groupId, String(userId)]
    );
    return rows.length > 0;
  } catch (error) {
    console.error('❌ Error verifying group ownership:', error);
    return false;
  }
}

/**
 * Get user's role in the group
 */
async function getUserGroupRole(groupId: string, userId: string | number): Promise<string | null> {
  try {
    const [rows]: any = await DB.query(
      `SELECT role FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, String(userId)]
    );
    return rows.length > 0 ? rows[0].role : null;
  } catch (error) {
    console.error('❌ Error getting user group role:', error);
    return null;
  }
}

/* ============================================================================
   ANALYZE GROUP - Trigger full group analysis (OWNER ONLY)
============================================================================ */

const analyzeGroupHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

    const { groupId } = req.params;
    const { forceRefresh = false, userContext } = req.body;

    // Sanitize userContext (max 2000 chars, defense-in-depth prompt injection stripping)
    const sanitizedUserContext = userContext
      ? String(userContext)
          .slice(0, 2000)
          .trim()
          .replace(/\b(system|assistant|user)\s*:/gi, '$1 -')
          .replace(/```/g, "'''")
          .replace(/\[INST\]|\[\/INST\]|<<SYS>>|<<\/SYS>>|<\/s>|<s>/gi, '')
          .replace(/<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>/gi, '')
        || undefined
      : undefined;

    // Verify membership first
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // ========== OWNER-ONLY CHECK ==========
    // Only group owners can generate new insights
    const isOwner = await verifyGroupOwnership(groupId, user.id);
    if (!isOwner) {
      res.status(403).json({
        success: false,
        error: 'Only group owners can generate insights',
        code: 'OWNER_REQUIRED',
      });
      return;
    }
    // ========== END OWNER-ONLY CHECK ==========

    // Queue analysis job with optional user context
    const jobId = uuidv4();
    await DB.query(
      `INSERT INTO mirror_group_analysis_queue
       (id, group_id, analysis_type, priority, status, trigger_event, parameters, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        jobId,
        groupId,
        'full_analysis',
        forceRefresh ? 10 : 5,
        'pending',
        'owner_request',
        JSON.stringify({
          requestedBy: user.id,
          forceRefresh,
          isOwner: true,
          userContext: sanitizedUserContext,
        })
      ]
    );

    res.json({
      success: true,
      data: {
        jobId,
        message: 'Analysis queued successfully',
        estimatedTime: '30-60 seconds'
      }
    });

  } catch (error) {
    console.error('❌ Error queueing group analysis:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to queue analysis',
      details: (error as Error).message
    });
  }
};

/* ============================================================================
   GET INSIGHTS GENERATION PERMISSION - Check if user can generate insights
============================================================================ */

const getInsightsPermissionHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Get user's role
    const role = await getUserGroupRole(groupId, user.id);
    const canGenerateInsights = role === 'owner';

    res.json({
      success: true,
      data: {
        groupId,
        userId: user.id,
        role,
        canGenerateInsights,
        canViewInsights: true, // All members can view
      }
    });

  } catch (error) {
    console.error('❌ Error checking insights permission:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check permissions',
      details: (error as Error).message
    });
  }
};

/* ============================================================================
   GET GROUP INSIGHTS - Retrieve cached or generated insights
============================================================================ */

const getGroupInsightsHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;

    // Verify membership (all members can VIEW insights)
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Get user's role for UI purposes
    const userRole = await getUserGroupRole(groupId, user.id);

    // Get group info
    const [groupRows]: any = await DB.query(
      `SELECT name, description, goal, current_member_count FROM mirror_groups WHERE id = ?`,
      [groupId]
    );

    if (groupRows.length === 0) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }

    const group = groupRows[0];

    // Get compatibility data
    const [compatibilityRows]: any = await DB.query(
      `SELECT * FROM mirror_group_compatibility
       WHERE group_id = ?
       ORDER BY compatibility_score DESC`,
      [groupId]
    );

    // Get collective patterns
    const [patternRows]: any = await DB.query(
      `SELECT * FROM mirror_group_collective_patterns
       WHERE group_id = ? AND is_significant = TRUE
       ORDER BY prevalence DESC
       LIMIT 20`,
      [groupId]
    );

    // Get conflict risks
    const [riskRows]: any = await DB.query(
      `SELECT * FROM mirror_group_conflict_risks
       WHERE group_id = ? AND is_active = TRUE
       ORDER BY
         CASE severity
           WHEN 'critical' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           ELSE 4
         END,
         probability DESC
       LIMIT 10`,
      [groupId]
    );

    // Get LLM synthesis (overview type)
    const [synthesisRows]: any = await DB.query(
      `SELECT * FROM mirror_group_llm_synthesis
       WHERE group_id = ? AND synthesis_type = 'overview'
       ORDER BY generated_at DESC
       LIMIT 1`,
      [groupId]
    );

    // Get last analysis timestamp
    const [analysisRows]: any = await DB.query(
      `SELECT completed_at FROM mirror_group_analysis_queue
       WHERE group_id = ? AND status = 'completed'
       ORDER BY completed_at DESC
       LIMIT 1`,
      [groupId]
    );

    const lastAnalyzed = analysisRows.length > 0
      ? analysisRows[0].completed_at
      : null;

    // Format compatibility matrix
    const compatibilityMatrix: FormattedCompatibility[] = compatibilityRows.map((row: CompatibilityRow) => ({
      memberA: row.member_a_id,
      memberB: row.member_b_id,
      overallScore: parseFloat(row.compatibility_score),
      factors: {
        personality: row.personality_similarity ? parseFloat(row.personality_similarity) : null,
        communication: row.communication_alignment ? parseFloat(row.communication_alignment) : null,
        conflict: row.conflict_compatibility ? parseFloat(row.conflict_compatibility) : null,
        energy: row.energy_balance ? parseFloat(row.energy_balance) : null
      },
      strengths: safeJsonParse(row.strengths, []),
      challenges: safeJsonParse(row.challenges, []),
      recommendations: safeJsonParse(row.recommendations, []),
      explanation: row.explanation,
      confidence: parseFloat(row.confidence_score)
    }));

    // Format collective patterns
    const collectivePatterns: FormattedPattern[] = patternRows.map((row: PatternRow) => ({
      id: row.id,
      type: row.pattern_type,
      name: row.pattern_name,
      prevalence: parseFloat(row.prevalence),
      averageLikelihood: row.average_likelihood ? parseFloat(row.average_likelihood) : null,
      memberCount: row.member_count,
      totalMembers: row.total_members,
      description: row.description,
      contexts: safeJsonParse(row.contexts, []),
      implications: safeJsonParse(row.implications, []),
      confidence: parseFloat(row.confidence)
    }));

    // Format conflict risks
    const conflictRisks: FormattedRisk[] = riskRows.map((row: RiskRow) => ({
      id: row.id,
      type: row.risk_type,
      severity: row.severity,
      affectedMembers: safeJsonParse(row.affected_members, []),
      description: row.description,
      triggers: safeJsonParse(row.triggers, []),
      mitigationStrategies: safeJsonParse(row.mitigation_strategies, []),
      probability: parseFloat(row.probability),
      impact: parseFloat(row.impact_score),
      status: row.resolution_status
    }));

    // Format LLM synthesis
    const llmSynthesis = synthesisRows.length > 0 ? (() => {
      const row = synthesisRows[0];
      const keyPoints: any = safeJsonParse(row.key_points, {});

      return {
        title: row.title,
        overview: (keyPoints.overview as string) || row.content,
        keyInsights: (keyPoints.keyInsights as string[]) || [],
        recommendations: (keyPoints.recommendations as string[]) || [],
        narrative: (keyPoints.narrative as any) || {},
        llmModel: row.llm_model,
        qualityScore: row.quality_score ? parseFloat(row.quality_score) : null,
        generatedAt: row.generated_at
      };
    })() : null;

    // Determine analysis status
    const hasData = compatibilityMatrix.length > 0 || collectivePatterns.length > 0 || conflictRisks.length > 0 || llmSynthesis !== null;
    const analysisStatus = hasData ? 'complete' : 'none';

    res.json({
      success: true,
      data: {
        group: {
          id: groupId,
          name: group.name,
          description: group.description,
          goal: group.goal,
          memberCount: group.current_member_count
        },
        insights: {
          compatibility: {
            matrix: compatibilityMatrix,
            averageScore: compatibilityMatrix.length > 0
              ? compatibilityMatrix.reduce((sum: number, c: FormattedCompatibility) => sum + c.overallScore, 0) / compatibilityMatrix.length
              : 0,
            pairCount: compatibilityMatrix.length
          },
          collectivePatterns: {
            patterns: collectivePatterns,
            strengths: collectivePatterns.filter((p: FormattedPattern) => p.type === 'strength'),
            weaknesses: collectivePatterns.filter((p: FormattedPattern) => p.type === 'weakness'),
            opportunities: collectivePatterns.filter((p: FormattedPattern) => p.type === 'opportunity'),
            threats: collectivePatterns.filter((p: FormattedPattern) => p.type === 'threat')
          },
          conflictRisks: {
            risks: conflictRisks,
            critical: conflictRisks.filter((r: FormattedRisk) => r.severity === 'critical'),
            high: conflictRisks.filter((r: FormattedRisk) => r.severity === 'high'),
            medium: conflictRisks.filter((r: FormattedRisk) => r.severity === 'medium'),
            low: conflictRisks.filter((r: FormattedRisk) => r.severity === 'low')
          },
          llmSynthesis: llmSynthesis
        },
        meta: {
          hasData,
          analysisStatus,
          lastAnalyzed,
          lastUpdated: new Date().toISOString(),
          dataVersion: '1.0',
          // Include user permissions
          userPermissions: {
            role: userRole,
            canGenerateInsights: userRole === 'owner',
            canViewInsights: true,
          }
        }
      }
    });

  } catch (error) {
    console.error('❌ Error getting group insights:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get insights',
      details: (error as Error).message
    });
  }
};

/* ============================================================================
   GET COMPATIBILITY MATRIX - Detailed compatibility between all members
============================================================================ */

const getCompatibilityMatrixHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Get all compatibility scores
    const [rows]: any = await DB.query(
      `SELECT
        c.*,
        ua.username as member_a_username,
        ub.username as member_b_username
       FROM mirror_group_compatibility c
       JOIN users ua ON ua.id = c.member_a_id
       JOIN users ub ON ub.id = c.member_b_id
       WHERE c.group_id = ?
       ORDER BY c.compatibility_score DESC`,
      [groupId]
    );

    const compatibility: FormattedCompatibility[] = rows.map((row: CompatibilityRow) => ({
      memberA: {
        id: row.member_a_id,
        username: row.member_a_username
      },
      memberB: {
        id: row.member_b_id,
        username: row.member_b_username
      },
      overallScore: parseFloat(row.compatibility_score),
      scores: {
        overall: parseFloat(row.compatibility_score),
        personality: row.personality_similarity ? parseFloat(row.personality_similarity) : null,
        communication: row.communication_alignment ? parseFloat(row.communication_alignment) : null,
        conflict: row.conflict_compatibility ? parseFloat(row.conflict_compatibility) : null,
        energy: row.energy_balance ? parseFloat(row.energy_balance) : null
      },
      analysis: {
        strengths: safeJsonParse(row.strengths, []),
        challenges: safeJsonParse(row.challenges, []),
        recommendations: safeJsonParse(row.recommendations, []),
        explanation: row.explanation
      },
      strengths: safeJsonParse(row.strengths, []),
      challenges: safeJsonParse(row.challenges, []),
      recommendations: safeJsonParse(row.recommendations, []),
      explanation: row.explanation,
      confidence: parseFloat(row.confidence_score),
      calculatedAt: row.calculated_at
    }));

    res.json({
      success: true,
      data: {
        groupId,
        compatibility,
        statistics: {
          totalPairs: compatibility.length,
          averageScore: compatibility.length > 0
            ? compatibility.reduce((sum: number, c: FormattedCompatibility) => sum + (c.scores?.overall || c.overallScore), 0) / compatibility.length
            : 0,
          highCompatibility: compatibility.filter((c: FormattedCompatibility) => (c.scores?.overall || c.overallScore) >= 0.75).length,
          mediumCompatibility: compatibility.filter((c: FormattedCompatibility) => (c.scores?.overall || c.overallScore) >= 0.5 && (c.scores?.overall || c.overallScore) < 0.75).length,
          lowCompatibility: compatibility.filter((c: FormattedCompatibility) => (c.scores?.overall || c.overallScore) < 0.5).length
        }
      }
    });

  } catch (error) {
    console.error('❌ Error getting compatibility matrix:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get compatibility matrix',
      details: (error as Error).message
    });
  }
};

/* ============================================================================
   GET COLLECTIVE PATTERNS - Group-wide behavioral patterns
============================================================================ */

const getCollectivePatternsHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Get patterns
    const [rows]: any = await DB.query(
      `SELECT * FROM mirror_group_collective_patterns
       WHERE group_id = ? AND is_significant = TRUE
       ORDER BY prevalence DESC`,
      [groupId]
    );

    const patterns: FormattedPattern[] = rows.map((row: PatternRow) => ({
      id: row.id,
      type: row.pattern_type,
      name: row.pattern_name,
      prevalence: parseFloat(row.prevalence),
      averageLikelihood: row.average_likelihood ? parseFloat(row.average_likelihood) : null,
      affectedMembers: {
        count: row.member_count,
        percentage: (row.member_count / row.total_members) * 100
      },
      description: row.description,
      contexts: safeJsonParse(row.contexts, []),
      implications: safeJsonParse(row.implications, []),
      confidence: parseFloat(row.confidence),
      detectedAt: row.detected_at
    }));

    // Group by type
    const byType = {
      strengths: patterns.filter((p: FormattedPattern) => p.type === 'strength'),
      weaknesses: patterns.filter((p: FormattedPattern) => p.type === 'weakness'),
      opportunities: patterns.filter((p: FormattedPattern) => p.type === 'opportunity'),
      threats: patterns.filter((p: FormattedPattern) => p.type === 'threat'),
      behavioral: patterns.filter((p: FormattedPattern) => p.type === 'behavioral_tendency'),
      communication: patterns.filter((p: FormattedPattern) => p.type === 'communication_style'),
      decision: patterns.filter((p: FormattedPattern) => p.type === 'decision_pattern')
    };

    res.json({
      success: true,
      data: {
        groupId,
        patterns,
        byType,
        summary: {
          totalPatterns: patterns.length,
          strengthsCount: byType.strengths.length,
          weaknessesCount: byType.weaknesses.length,
          opportunitiesCount: byType.opportunities.length,
          threatsCount: byType.threats.length,
          behavioralCount: byType.behavioral.length,
          communicationCount: byType.communication.length,
          decisionCount: byType.decision.length
        }
      }
    });

  } catch (error) {
    console.error('❌ Error getting collective patterns:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get collective patterns',
      details: (error as Error).message
    });
  }
};

/* ============================================================================
   GET CONFLICT RISKS - Potential conflict areas in the group
============================================================================ */

const getConflictRisksHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Get active risks
    const [rows]: any = await DB.query(
      `SELECT * FROM mirror_group_conflict_risks
       WHERE group_id = ? AND is_active = TRUE
       ORDER BY
         CASE severity
           WHEN 'critical' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           ELSE 4
         END,
         probability DESC`,
      [groupId]
    );

    const risks: FormattedRisk[] = rows.map((row: RiskRow) => ({
      id: row.id,
      type: row.risk_type,
      severity: row.severity,
      affectedMembers: safeJsonParse(row.affected_members, []),
      description: row.description,
      triggers: safeJsonParse(row.triggers, []),
      mitigationStrategies: safeJsonParse(row.mitigation_strategies, []),
      probability: parseFloat(row.probability),
      impact: parseFloat(row.impact_score),
      riskScore: parseFloat(row.probability) * parseFloat(row.impact_score),
      status: row.resolution_status,
      detectedAt: row.detected_at,
      lastAssessed: row.last_assessed
    }));

    // Group by severity
    const bySeverity = {
      critical: risks.filter((r: FormattedRisk) => r.severity === 'critical'),
      high: risks.filter((r: FormattedRisk) => r.severity === 'high'),
      medium: risks.filter((r: FormattedRisk) => r.severity === 'medium'),
      low: risks.filter((r: FormattedRisk) => r.severity === 'low')
    };

    // Group by status
    const byStatus = {
      unaddressed: risks.filter((r: FormattedRisk) => r.status === 'unaddressed'),
      acknowledged: risks.filter((r: FormattedRisk) => r.status === 'acknowledged'),
      inProgress: risks.filter((r: FormattedRisk) => r.status === 'in_progress'),
      resolved: risks.filter((r: FormattedRisk) => r.status === 'resolved')
    };

    res.json({
      success: true,
      data: {
        groupId,
        risks,
        bySeverity,
        byStatus,
        summary: {
          totalRisks: risks.length,
          criticalCount: bySeverity.critical.length,
          highCount: bySeverity.high.length,
          mediumCount: bySeverity.medium.length,
          lowCount: bySeverity.low.length,
          unaddressedCount: byStatus.unaddressed.length,
          averageRiskScore: risks.length > 0
            ? risks.reduce((sum: number, r: FormattedRisk) => sum + (r.riskScore || 0), 0) / risks.length
            : 0
        }
      }
    });

  } catch (error) {
    console.error('❌ Error getting conflict risks:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get conflict risks',
      details: (error as Error).message
    });
  }
};

/* ============================================================================
   GET INSIGHTS HISTORY - All past insights/syntheses for the group
============================================================================ */

const getInsightsHistoryHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Get all LLM syntheses for this group (history)
    const [rows]: any = await DB.query(
      `SELECT * FROM mirror_group_llm_synthesis
       WHERE group_id = ?
       ORDER BY generated_at DESC
       LIMIT ? OFFSET ?`,
      [groupId, limit, offset]
    );

    // Get total count
    const [countRows]: any = await DB.query(
      `SELECT COUNT(*) as total FROM mirror_group_llm_synthesis WHERE group_id = ?`,
      [groupId]
    );
    const total = countRows[0]?.total || 0;

    const insightsHistory = rows.map((row: InsightHistoryRow) => {
      const keyPoints: any = safeJsonParse(row.key_points, {});
      return {
        id: row.id,
        title: row.title,
        synthesisType: row.synthesis_type,
        overview: (keyPoints.overview as string) || row.content,
        keyInsights: (keyPoints.keyInsights as string[]) || [],
        recommendations: (keyPoints.recommendations as string[]) || [],
        narrative: (keyPoints.narrative as any) || {},
        llmModel: row.llm_model,
        qualityScore: row.quality_score ? parseFloat(row.quality_score) : null,
        generatedAt: row.generated_at
      };
    });

    res.json({
      success: true,
      data: {
        groupId,
        insights: insightsHistory,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + insightsHistory.length < total
        }
      }
    });

  } catch (error) {
    console.error('❌ Error getting insights history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get insights history',
      details: (error as Error).message
    });
  }
};

/* ============================================================================
   GET MEMBER DETAILS - Extended member information
============================================================================ */

const getMemberDetailsHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId, memberId } = req.params;

    // Verify requester is a member
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Get shared data types for this member FIRST to check consent
    const [sharedDataRows]: any = await DB.query(
      `SELECT data_type, shared_at, data_version
       FROM mirror_group_shared_data
       WHERE group_id = ? AND user_id = ?
       ORDER BY shared_at DESC`,
      [groupId, memberId]
    );

    const sharedData: SharedDataItem[] = sharedDataRows.map((row: SharedDataRow) => ({
      dataType: row.data_type,
      sharedAt: row.shared_at,
      dataVersion: row.data_version
    }));

    // Check if user has consented to share profile data
    const hasSharedProfile = sharedData.some((sd: SharedDataItem) => sd.dataType === 'profile');

    // Get member details - only fetch extended info if profile is shared
    const [memberRows]: any = await DB.query(
      `SELECT
        gm.id, gm.user_id, gm.role, gm.status, gm.joined_at,
        u.username, u.created_at as user_created_at,
        ${hasSharedProfile ? `u.email` : `NULL as email`}
       FROM mirror_group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = ? AND gm.user_id = ? AND gm.status = 'active'`,
      [groupId, memberId]
    );

    if (memberRows.length === 0) {
      res.status(404).json({ success: false, error: 'Member not found' });
      return;
    }

    const member = memberRows[0];

    // Count shared data items per type for the data sharing stats
    const dataTypeCounts: Record<string, number> = {};
    for (const sd of sharedData) {
      dataTypeCounts[sd.dataType] = (dataTypeCounts[sd.dataType] || 0) + 1;
    }

    res.json({
      success: true,
      data: {
        member: {
          id: member.id,
          userId: member.user_id,
          username: member.username,
          displayName: member.username,
          role: member.role,
          status: member.status,
          joinedAt: member.joined_at,
          userCreatedAt: member.user_created_at,
          ...(hasSharedProfile && {
            email: member.email,
          })
        },
        sharedData,
        sharedDataSummary: {
          totalShared: sharedData.length,
          dataTypes: dataTypeCounts,
        },
        hasSharedData: sharedData.length > 0,
        hasSharedProfile
      }
    });

  } catch (error) {
    console.error('❌ Error getting member details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get member details',
      details: (error as Error).message
    });
  }
};

/* ============================================================================
   GET ALL MEMBERS WITH DETAILS - Enhanced member list for group
============================================================================ */

const getMembersWithDetailsHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Get shared data for all members FIRST to check consent
    const [sharedDataRows]: any = await DB.query(
      `SELECT user_id, data_type, shared_at
       FROM mirror_group_shared_data
       WHERE group_id = ?`,
      [groupId]
    );

    // Group shared data by user and check who has shared profile
    const sharedDataByUser: Record<string, any[]> = {};
    const profileSharedByUser: Record<string, boolean> = {};
    for (const row of sharedDataRows) {
      const odUserId = String(row.user_id);
      if (!sharedDataByUser[odUserId]) {
        sharedDataByUser[odUserId] = [];
      }
      sharedDataByUser[odUserId].push({
        dataType: row.data_type,
        sharedAt: row.shared_at
      });
      if (row.data_type === 'profile') {
        profileSharedByUser[odUserId] = true;
      }
    }

    // Get all members with basic details
    const [memberRows]: any = await DB.query(
      `SELECT
        gm.id, gm.user_id, gm.role, gm.status, gm.joined_at,
        u.username, u.email, u.created_at as user_created_at
       FROM mirror_group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = ? AND gm.status = 'active'
       ORDER BY
         CASE gm.role
           WHEN 'owner' THEN 1
           WHEN 'admin' THEN 2
           ELSE 3
         END,
         gm.joined_at ASC`,
      [groupId]
    );

    const members = memberRows.map((member: MemberRow) => {
      const odUserId = String(member.user_id);
      const memberSharedData = sharedDataByUser[odUserId] || [];
      const hasSharedProfile = profileSharedByUser[odUserId] || false;

      // Count shared data items per type for data sharing stats
      const dataTypeCounts: Record<string, number> = {};
      for (const sd of memberSharedData) {
        dataTypeCounts[sd.dataType] = (dataTypeCounts[sd.dataType] || 0) + 1;
      }

      return {
        id: member.id,
        userId: member.user_id,
        username: member.username,
        displayName: member.username,
        role: member.role,
        status: member.status,
        joinedAt: member.joined_at,
        hasSharedData: memberSharedData.length > 0,
        sharedDataTypes: memberSharedData.map((sd: { dataType: string }) => sd.dataType),
        sharedData: memberSharedData,
        sharedDataSummary: {
          totalShared: memberSharedData.length,
          dataTypes: dataTypeCounts,
        },
        hasSharedProfile,
        ...(hasSharedProfile && {
          email: member.email,
        })
      };
    });

    res.json({
      success: true,
      data: {
        groupId,
        members,
        total: members.length
      }
    });

  } catch (error) {
    console.error('❌ Error getting members with details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get members',
      details: (error as Error).message
    });
  }
};

/* ============================================================================
   ROUTE REGISTRATION
============================================================================ */

// Cast middleware for Express 5 typing
const verified = AuthMiddleware.verifyToken as unknown as RequestHandler;

// Register routes with authentication
router.post('/groups/:groupId/analyze', verified, analyzeGroupHandler);
router.post('/groups/:groupId/generate-insights', verified, analyzeGroupHandler); // Same handler - frontend calls this endpoint
router.get('/groups/:groupId/insights', verified, getGroupInsightsHandler);
router.get('/groups/:groupId/insights/permission', verified, getInsightsPermissionHandler);
router.get('/groups/:groupId/insights/history', verified, getInsightsHistoryHandler);
router.get('/groups/:groupId/compatibility', verified, getCompatibilityMatrixHandler);
router.get('/groups/:groupId/patterns', verified, getCollectivePatternsHandler);
router.get('/groups/:groupId/risks', verified, getConflictRisksHandler);
router.get('/groups/:groupId/members-details', verified, getMembersWithDetailsHandler);
router.get('/groups/:groupId/members/:memberId', verified, getMemberDetailsHandler);

export default router;
