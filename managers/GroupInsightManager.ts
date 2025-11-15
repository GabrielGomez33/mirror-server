/**
 * GroupInsightManager - Storage and Retrieval for Group Insights
 * 
 * Manages persistence and caching of group analysis results including:
 * - Compatibility matrices
 * - Collective strengths
 * - Conflict risks
 * - LLM syntheses
 * 
 * @module managers/GroupInsightManager
 */

import { v4 as uuidv4 } from 'uuid';
import { Database } from '../config/database';
import { RedisManager } from '../config/redis';
import { Logger } from '../utils/logger';
import { GroupEncryptionManager } from './GroupEncryptionManager';
import {
  GroupAnalysisResult,
  CompatibilityMatrix,
  CollectiveStrength,
  ConflictRisk,
  LLMSynthesis
} from '../analyzers/GroupAnalyzer';

/**
 * Insight retrieval options
 */
export interface InsightQueryOptions {
  insightTypes?: string[];
  includeExpired?: boolean;
  limit?: number;
  offset?: number;
  sortBy?: 'generated_at' | 'confidence' | 'priority';
  sortOrder?: 'ASC' | 'DESC';
}

/**
 * Insight update payload
 */
export interface InsightUpdate {
  confidence?: number;
  priority?: number;
  expiresAt?: Date;
  metadata?: Record<string, any>;
}

export class GroupInsightManager {
  private db: Database;
  private redis: RedisManager;
  private logger: Logger;
  private encryptionManager: GroupEncryptionManager;
  private readonly CACHE_TTL = 3600; // 1 hour
  private readonly INSIGHT_EXPIRY_DAYS = 30;

  constructor() {
    this.logger = new Logger('GroupInsightManager');
    this.db = Database.getInstance();
    this.redis = RedisManager.getInstance();
    this.encryptionManager = new GroupEncryptionManager();
  }

  /**
   * Store a complete analysis result
   */
  public async storeAnalysis(result: GroupAnalysisResult): Promise<void> {
    const transaction = await this.db.beginTransaction();

    try {
      // Store main insight record
      const insightId = result.analysisId || uuidv4();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + this.INSIGHT_EXPIRY_DAYS);

      await transaction.query(`
        INSERT INTO mirror_group_insights (
          id, group_id, insight_type, data, confidence_score,
          priority, generated_at, expires_at, metadata, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          data = VALUES(data),
          confidence_score = VALUES(confidence_score),
          updated_at = CURRENT_TIMESTAMP
      `, [
        insightId,
        result.groupId,
        'full_analysis',
        JSON.stringify(result.insights),
        result.metadata.overallConfidence,
        10, // High priority for full analysis
        result.timestamp,
        expiresAt,
        JSON.stringify(result.metadata),
        1
      ]);

      // Store individual insight types
      const insightPromises: Promise<any>[] = [];

      if (result.insights.compatibilityMatrix) {
        insightPromises.push(
          this.storeCompatibilityMatrix(
            result.groupId,
            result.insights.compatibilityMatrix,
            transaction
          )
        );
      }

      if (result.insights.collectiveStrengths) {
        insightPromises.push(
          this.storeCollectiveStrengths(
            result.groupId,
            result.insights.collectiveStrengths,
            transaction
          )
        );
      }

      if (result.insights.conflictRisks) {
        insightPromises.push(
          this.storeConflictRisks(
            result.groupId,
            result.insights.conflictRisks,
            transaction
          )
        );
      }

      if (result.insights.llmSynthesis) {
        insightPromises.push(
          this.storeLLMSynthesis(
            result.groupId,
            result.insights.llmSynthesis,
            transaction
          )
        );
      }

      await Promise.all(insightPromises);
      await transaction.commit();

      // Cache the result
      await this.cacheInsight(result.groupId, 'full_analysis', result);

      this.logger.info('Analysis stored successfully', {
        groupId: result.groupId,
        analysisId: insightId
      });

    } catch (error) {
      await transaction.rollback();
      this.logger.error('Failed to store analysis', error);
      throw error;
    }
  }

  /**
   * Retrieve insights for a group
   */
  public async getInsights(
    groupId: string,
    options: InsightQueryOptions = {}
  ): Promise<any[]> {
    try {
      // Check cache first
      const cacheKey = this.getCacheKey(groupId, options);
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // Build query
      const conditions = ['group_id = ?'];
      const params = [groupId];

      if (!options.includeExpired) {
        conditions.push('(expires_at IS NULL OR expires_at > NOW())');
      }

      if (options.insightTypes && options.insightTypes.length > 0) {
        conditions.push(`insight_type IN (${options.insightTypes.map(() => '?').join(',')})`);
        params.push(...options.insightTypes);
      }

      conditions.push('is_active = 1');

      const sortBy = options.sortBy || 'generated_at';
      const sortOrder = options.sortOrder || 'DESC';
      const limit = options.limit || 100;
      const offset = options.offset || 0;

      const query = `
        SELECT * FROM mirror_group_insights
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${sortBy} ${sortOrder}
        LIMIT ? OFFSET ?
      `;
      params.push(limit, offset);

      const results = await this.db.query(query, params);

      // Parse JSON fields
      const insights = results.map((row: any) => ({
        ...row,
        data: JSON.parse(row.data),
        metadata: row.metadata ? JSON.parse(row.metadata) : null
      }));

      // Cache results
      await this.redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify(insights));

      return insights;

    } catch (error) {
      this.logger.error('Failed to retrieve insights', error);
      throw error;
    }
  }

  /**
   * Get latest compatibility matrix
   */
  public async getCompatibilityMatrix(groupId: string): Promise<CompatibilityMatrix | null> {
    try {
      // Try cache first
      const cached = await this.getCachedInsight(groupId, 'compatibility_matrix');
      if (cached) return cached;

      // Fetch from database
      const result = await this.db.query(`
        SELECT data, confidence_score, generated_at
        FROM mirror_group_insights
        WHERE group_id = ? 
          AND insight_type = 'compatibility_matrix'
          AND is_active = 1
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY generated_at DESC
        LIMIT 1
      `, [groupId]);

      if (result.length === 0) return null;

      const matrix = JSON.parse(result[0].data);
      
      // Cache for future use
      await this.cacheInsight(groupId, 'compatibility_matrix', matrix);

      return matrix;

    } catch (error) {
      this.logger.error('Failed to get compatibility matrix', error);
      throw error;
    }
  }

  /**
   * Get pairwise compatibility score
   */
  public async getPairwiseCompatibility(
    groupId: string,
    memberAId: string,
    memberBId: string
  ): Promise<number | null> {
    try {
      // Ensure consistent ordering
      const [member1, member2] = memberAId < memberBId 
        ? [memberAId, memberBId]
        : [memberBId, memberAId];

      const result = await this.db.query(`
        SELECT compatibility_score
        FROM mirror_group_compatibility
        WHERE group_id = ?
          AND member_a_id = ?
          AND member_b_id = ?
        LIMIT 1
      `, [groupId, member1, member2]);

      return result.length > 0 ? result[0].compatibility_score : null;

    } catch (error) {
      this.logger.error('Failed to get pairwise compatibility', error);
      throw error;
    }
  }

  /**
   * Update insight metadata
   */
  public async updateInsight(
    insightId: string,
    updates: InsightUpdate
  ): Promise<void> {
    try {
      const setClauses: string[] = [];
      const params: any[] = [];

      if (updates.confidence !== undefined) {
        setClauses.push('confidence_score = ?');
        params.push(updates.confidence);
      }

      if (updates.priority !== undefined) {
        setClauses.push('priority = ?');
        params.push(updates.priority);
      }

      if (updates.expiresAt !== undefined) {
        setClauses.push('expires_at = ?');
        params.push(updates.expiresAt);
      }

      if (updates.metadata !== undefined) {
        setClauses.push('metadata = ?');
        params.push(JSON.stringify(updates.metadata));
      }

      if (setClauses.length === 0) return;

      setClauses.push('updated_at = CURRENT_TIMESTAMP');
      params.push(insightId);

      await this.db.query(`
        UPDATE mirror_group_insights
        SET ${setClauses.join(', ')}
        WHERE id = ?
      `, params);

      // Invalidate cache
      await this.invalidateCache(insightId);

    } catch (error) {
      this.logger.error('Failed to update insight', error);
      throw error;
    }
  }

  /**
   * Mark insights as expired
   */
  public async expireInsights(groupId: string): Promise<void> {
    try {
      await this.db.query(`
        UPDATE mirror_group_insights
        SET is_active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE group_id = ? AND is_active = 1
      `, [groupId]);

      // Clear all caches for this group
      await this.clearGroupCache(groupId);

      this.logger.info('Expired insights for group', { groupId });

    } catch (error) {
      this.logger.error('Failed to expire insights', error);
      throw error;
    }
  }

  /**
   * Delete old insights
   */
  public async cleanupOldInsights(daysOld: number = 90): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      const result = await this.db.query(`
        DELETE FROM mirror_group_insights
        WHERE generated_at < ? OR (expires_at IS NOT NULL AND expires_at < NOW())
      `, [cutoffDate]);

      const deletedCount = result.affectedRows || 0;
      
      this.logger.info('Cleaned up old insights', {
        deletedCount,
        daysOld
      });

      return deletedCount;

    } catch (error) {
      this.logger.error('Failed to cleanup old insights', error);
      throw error;
    }
  }

  /**
   * Store compatibility matrix details
   */
  private async storeCompatibilityMatrix(
    groupId: string,
    matrix: CompatibilityMatrix,
    transaction: any
  ): Promise<void> {
    // Store as separate insight
    await transaction.query(`
      INSERT INTO mirror_group_insights (
        id, group_id, insight_type, data, confidence_score,
        priority, generated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        data = VALUES(data),
        confidence_score = VALUES(confidence_score),
        updated_at = CURRENT_TIMESTAMP
    `, [
      uuidv4(),
      groupId,
      'compatibility_matrix',
      JSON.stringify(matrix),
      matrix.averageCompatibility,
      8,
      new Date(),
      1
    ]);

    // Store individual compatibility scores
    const batch: any[] = [];
    matrix.pairwiseDetails.forEach((detail, key) => {
      batch.push([
        uuidv4(),
        groupId,
        detail.memberA,
        detail.memberB,
        detail.score,
        detail.confidence,
        detail.factors.personality,
        detail.factors.communication,
        detail.factors.conflict,
        detail.factors.energy,
        JSON.stringify(detail.factors),
        JSON.stringify(detail.strengths),
        JSON.stringify(detail.challenges),
        JSON.stringify(detail.recommendations),
        detail.strengths.join('. ')
      ]);
    });

    if (batch.length > 0) {
      await transaction.query(`
        INSERT INTO mirror_group_compatibility (
          id, group_id, member_a_id, member_b_id, compatibility_score,
          confidence_score, personality_similarity, communication_alignment,
          conflict_compatibility, energy_balance, factors, strengths,
          challenges, recommendations, explanation
        ) VALUES ?
        ON DUPLICATE KEY UPDATE
          compatibility_score = VALUES(compatibility_score),
          confidence_score = VALUES(confidence_score),
          calculated_at = CURRENT_TIMESTAMP
      `, [batch]);
    }
  }

  /**
   * Store collective strengths
   */
  private async storeCollectiveStrengths(
    groupId: string,
    strengths: CollectiveStrength[],
    transaction: any
  ): Promise<void> {
    await transaction.query(`
      INSERT INTO mirror_group_insights (
        id, group_id, insight_type, data, confidence_score,
        priority, generated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      uuidv4(),
      groupId,
      'collective_strengths',
      JSON.stringify(strengths),
      strengths.length > 0 ? 
        strengths.reduce((sum, s) => sum + s.confidence, 0) / strengths.length : 0,
      7,
      new Date(),
      1
    ]);

    // Store individual patterns
    const batch = strengths.map(strength => [
      uuidv4(),
      groupId,
      'strength',
      strength.name,
      strength.prevalence,
      strength.strength,
      strength.memberCount,
      Math.round(strength.memberCount / strength.prevalence),
      strength.description,
      JSON.stringify(strength.applications),
      JSON.stringify({ type: strength.type }),
      strength.confidence,
      true
    ]);

    if (batch.length > 0) {
      await transaction.query(`
        INSERT INTO mirror_group_collective_patterns (
          id, group_id, pattern_type, pattern_name, prevalence,
          average_likelihood, member_count, total_members, description,
          contexts, implications, confidence, is_significant
        ) VALUES ?
      `, [batch]);
    }
  }

  /**
   * Store conflict risks
   */
  private async storeConflictRisks(
    groupId: string,
    risks: ConflictRisk[],
    transaction: any
  ): Promise<void> {
    await transaction.query(`
      INSERT INTO mirror_group_insights (
        id, group_id, insight_type, data, confidence_score,
        priority, generated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      uuidv4(),
      groupId,
      'conflict_risks',
      JSON.stringify(risks),
      0.8, // Default confidence for risk assessment
      risks.some(r => r.severity === 'critical') ? 10 : 6,
      new Date(),
      1
    ]);

    // Store individual risks
    const batch = risks.map(risk => [
      risk.id,
      groupId,
      risk.type,
      risk.severity,
      JSON.stringify(risk.affectedMembers),
      risk.description,
      JSON.stringify(risk.triggers),
      JSON.stringify(risk.mitigationStrategies),
      risk.probability,
      risk.impact
    ]);

    if (batch.length > 0) {
      await transaction.query(`
        INSERT INTO mirror_group_conflict_risks (
          id, group_id, risk_type, severity, affected_members,
          description, triggers, mitigation_strategies, probability, impact_score
        ) VALUES ?
      `, [batch]);
    }
  }

  /**
   * Store LLM synthesis
   */
  private async storeLLMSynthesis(
    groupId: string,
    synthesis: LLMSynthesis,
    transaction: any
  ): Promise<void> {
    const syntheses = [
      {
        type: 'overview',
        title: 'Group Analysis Overview',
        content: synthesis.overview,
        keyPoints: synthesis.keyInsights
      },
      {
        type: 'compatibility_narrative',
        title: 'Compatibility Analysis',
        content: synthesis.narratives.compatibility || '',
        keyPoints: []
      },
      {
        type: 'strength_story',
        title: 'Collective Strengths',
        content: synthesis.narratives.strengths || '',
        keyPoints: []
      },
      {
        type: 'growth_opportunities',
        title: 'Growth Opportunities',
        content: synthesis.narratives.opportunities || '',
        keyPoints: synthesis.recommendations
      }
    ];

    for (const syn of syntheses) {
      if (syn.content) {
        await transaction.query(`
          INSERT INTO mirror_group_llm_synthesis (
            id, group_id, synthesis_type, title, content,
            key_points, llm_model, generated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          uuidv4(),
          groupId,
          syn.type,
          syn.title,
          syn.content,
          JSON.stringify(syn.keyPoints),
          'gpt-4',
          new Date()
        ]);
      }
    }
  }

  /**
   * Cache insight
   */
  private async cacheInsight(
    groupId: string,
    insightType: string,
    data: any
  ): Promise<void> {
    const key = `mirror:group:${groupId}:insight:${insightType}`;
    await this.redis.setex(key, this.CACHE_TTL, JSON.stringify(data));
  }

  /**
   * Get cached insight
   */
  private async getCachedInsight(
    groupId: string,
    insightType: string
  ): Promise<any | null> {
    const key = `mirror:group:${groupId}:insight:${insightType}`;
    const cached = await this.redis.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  /**
   * Generate cache key
   */
  private getCacheKey(groupId: string, options: InsightQueryOptions): string {
    const optionsHash = Buffer.from(JSON.stringify(options)).toString('base64');
    return `mirror:group:${groupId}:insights:${optionsHash}`;
  }

  /**
   * Invalidate cache
   */
  private async invalidateCache(insightId: string): Promise<void> {
    // Get group ID for this insight
    const result = await this.db.query(
      'SELECT group_id FROM mirror_group_insights WHERE id = ?',
      [insightId]
    );

    if (result.length > 0) {
      await this.clearGroupCache(result[0].group_id);
    }
  }

  /**
   * Clear all cache for a group
   */
  private async clearGroupCache(groupId: string): Promise<void> {
    const pattern = `mirror:group:${groupId}:*`;
    const keys = await this.redis.keys(pattern);
    
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  /**
   * Get insight statistics for a group
   */
  public async getInsightStats(groupId: string): Promise<{
    totalInsights: number;
    averageConfidence: number;
    lastAnalysis: Date | null;
    insightTypes: string[];
    criticalRisks: number;
  }> {
    try {
      const stats = await this.db.query(`
        SELECT 
          COUNT(*) as total,
          AVG(confidence_score) as avg_confidence,
          MAX(generated_at) as last_analysis,
          GROUP_CONCAT(DISTINCT insight_type) as types
        FROM mirror_group_insights
        WHERE group_id = ? AND is_active = 1
      `, [groupId]);

      const risks = await this.db.query(`
        SELECT COUNT(*) as critical_count
        FROM mirror_group_conflict_risks
        WHERE group_id = ? AND severity = 'critical' AND is_active = 1
      `, [groupId]);

      return {
        totalInsights: stats[0].total || 0,
        averageConfidence: stats[0].avg_confidence || 0,
        lastAnalysis: stats[0].last_analysis,
        insightTypes: stats[0].types ? stats[0].types.split(',') : [],
        criticalRisks: risks[0].critical_count || 0
      };

    } catch (error) {
      this.logger.error('Failed to get insight stats', error);
      throw error;
    }
  }
}

// Export singleton instance
export default new GroupInsightManager();
