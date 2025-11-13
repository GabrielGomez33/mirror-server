// ============================================================================
// GROUP INSIGHTS API ROUTES - PHASE 3
// ============================================================================
// File: server/routes/groupInsights.ts
// ----------------------------------------------------------------------------
// - Group analysis and insights endpoints
// - Compatibility matrix, strengths, conflict risks
// - JWT validation via AuthMiddleware.verifyToken
// - Follows same pattern as groups.ts
// ============================================================================

import express, { RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DB } from '../db';
import AuthMiddleware, { SecurityLevel } from '../middleware/authMiddleware';

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

async function verifyGroupMembership(groupId: string, userId: string | number): Promise<boolean> {
  try {
    const [rows] = await DB.query(
      `SELECT id FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, String(userId)]
    );
    return (rows as any[]).length > 0;
  } catch (error) {
    console.error('❌ Error verifying group membership:', error);
    return false;
  }
}

/* ============================================================================
   ANALYZE GROUP - Trigger full group analysis
============================================================================ */

const analyzeGroupHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

    const { groupId } = req.params;
    const { forceRefresh = false } = req.body;

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Queue analysis job
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
        'user_request',
        JSON.stringify({ requestedBy: user.id, forceRefresh })
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
   GET GROUP INSIGHTS - Retrieve cached or generate new insights
============================================================================ */

const getGroupInsightsHandler: RequestHandler = async (req, res) => {
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

    // Get group info
    const [groupRows] = await DB.query(
      `SELECT name, description, goal, current_member_count FROM mirror_groups WHERE id = ?`,
      [groupId]
    );

    if ((groupRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }

    const group = (groupRows as any[])[0];

    // Get compatibility data
    const [compatibilityRows] = await DB.query(
      `SELECT * FROM mirror_group_compatibility
       WHERE group_id = ?
       ORDER BY compatibility_score DESC`,
      [groupId]
    );

    // Get collective patterns
    const [patternRows] = await DB.query(
      `SELECT * FROM mirror_group_collective_patterns
       WHERE group_id = ? AND is_significant = TRUE
       ORDER BY prevalence DESC
       LIMIT 20`,
      [groupId]
    );

    // Get conflict risks
    const [riskRows] = await DB.query(
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

    // Format compatibility matrix
    const compatibilityMatrix = (compatibilityRows as any[]).map(row => ({
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
    const collectivePatterns = (patternRows as any[]).map(row => ({
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
    const conflictRisks = (riskRows as any[]).map(row => ({
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
              ? compatibilityMatrix.reduce((sum, c) => sum + c.overallScore, 0) / compatibilityMatrix.length
              : 0,
            pairCount: compatibilityMatrix.length
          },
          collectivePatterns: {
            patterns: collectivePatterns,
            strengths: collectivePatterns.filter(p => p.type === 'strength'),
            weaknesses: collectivePatterns.filter(p => p.type === 'weakness'),
            opportunities: collectivePatterns.filter(p => p.type === 'opportunity'),
            threats: collectivePatterns.filter(p => p.type === 'threat')
          },
          conflictRisks: {
            risks: conflictRisks,
            critical: conflictRisks.filter(r => r.severity === 'critical'),
            high: conflictRisks.filter(r => r.severity === 'high'),
            medium: conflictRisks.filter(r => r.severity === 'medium'),
            low: conflictRisks.filter(r => r.severity === 'low')
          }
        },
        meta: {
          hasData: compatibilityMatrix.length > 0 || collectivePatterns.length > 0 || conflictRisks.length > 0,
          lastUpdated: new Date().toISOString(),
          dataVersion: '1.0'
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
    const [rows] = await DB.query(
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

    const compatibility = (rows as any[]).map(row => ({
      memberA: {
        id: row.member_a_id,
        username: row.member_a_username
      },
      memberB: {
        id: row.member_b_id,
        username: row.member_b_username
      },
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
            ? compatibility.reduce((sum, c) => sum + c.scores.overall, 0) / compatibility.length
            : 0,
          highCompatibility: compatibility.filter(c => c.scores.overall >= 0.75).length,
          mediumCompatibility: compatibility.filter(c => c.scores.overall >= 0.5 && c.scores.overall < 0.75).length,
          lowCompatibility: compatibility.filter(c => c.scores.overall < 0.5).length
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
    const [rows] = await DB.query(
      `SELECT * FROM mirror_group_collective_patterns
       WHERE group_id = ? AND is_significant = TRUE
       ORDER BY prevalence DESC`,
      [groupId]
    );

    const patterns = (rows as any[]).map(row => ({
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
      strengths: patterns.filter(p => p.type === 'strength'),
      weaknesses: patterns.filter(p => p.type === 'weakness'),
      opportunities: patterns.filter(p => p.type === 'opportunity'),
      threats: patterns.filter(p => p.type === 'threat'),
      behavioral: patterns.filter(p => p.type === 'behavioral_tendency'),
      communication: patterns.filter(p => p.type === 'communication_style'),
      decision: patterns.filter(p => p.type === 'decision_pattern')
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
    const [rows] = await DB.query(
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

    const risks = (rows as any[]).map(row => ({
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
      critical: risks.filter(r => r.severity === 'critical'),
      high: risks.filter(r => r.severity === 'high'),
      medium: risks.filter(r => r.severity === 'medium'),
      low: risks.filter(r => r.severity === 'low')
    };

    // Group by status
    const byStatus = {
      unaddressed: risks.filter(r => r.status === 'unaddressed'),
      acknowledged: risks.filter(r => r.status === 'acknowledged'),
      inProgress: risks.filter(r => r.status === 'in_progress'),
      resolved: risks.filter(r => r.status === 'resolved')
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
            ? risks.reduce((sum, r) => sum + r.riskScore, 0) / risks.length
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
   ROUTE REGISTRATION
============================================================================ */

// Cast middleware for Express 5 typing
const verified = AuthMiddleware.verifyToken as unknown as RequestHandler;

// Register routes
router.post('/groups/:groupId/analyze', verified, analyzeGroupHandler);
router.get('/groups/:groupId/insights', verified, getGroupInsightsHandler);
router.get('/groups/:groupId/compatibility', verified, getCompatibilityMatrixHandler);
router.get('/groups/:groupId/patterns', verified, getCollectivePatternsHandler);
router.get('/groups/:groupId/risks', verified, getConflictRisksHandler);

export default router;
