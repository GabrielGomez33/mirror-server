/**
 * GroupAnalyzer - Core Analysis Engine for MirrorGroups Phase 3
 *
 * ADAPTED FOR PRODUCTION - Uses existing Mirror infrastructure
 *
 * This class orchestrates all group analysis operations including:
 * - Compatibility matrix generation
 * - Collective strength detection
 * - Conflict risk prediction
 * - Goal alignment scoring
 * - LLM synthesis coordination
 *
 * @module analyzers/GroupAnalyzer
 * @requires Node.js 18+, TypeScript 5+
 */

import { v4 as uuidv4 } from 'uuid';
import { CompatibilityCalculator } from './CompatibilityCalculator';
import { CollectiveStrengthDetector } from './CollectiveStrengthDetector';
import { ConflictRiskPredictor } from './ConflictRiskPredictor';
import { publicAssessmentAggregator } from '../managers/PublicAssessmentAggregator';
import { dinaLLMConnector } from '../integrations/DINALLMConnector';
import { groupEncryptionManager } from '../systems/GroupEncryptionManager';
import { DB } from '../db';
import { mirrorRedis } from '../config/redis';
import { Logger } from '../utils/logger';

/**
 * Types and Interfaces
 */
export interface MemberData {
  userId: string;
  personality?: {
    embedding: number[];
    traits: Record<string, number>;
    interpersonalStyle?: string;
    communicationStyle?: string;
    conflictResolutionStyle?: string;
  };
  behavioral?: {
    tendencies: Array<{
      behavior: string;
      likelihood: number;
      contexts: string[];
    }>;
    socialEnergy?: number;
    empathyLevel?: number;
  };
  cognitive?: {
    problemSolvingStyle?: string;
    decisionMakingStyle?: string;
    learningStyle?: string;
  };
  values?: {
    core: string[];
    motivationDrivers: Array<{
      driver: string;
      strength: number;
    }>;
  };
  sharedAt: Date;
  dataTypes: string[];
}

export interface GroupAnalysisOptions {
  includeCompatibility?: boolean;
  includeStrengths?: boolean;
  includeConflicts?: boolean;
  includeGoalAlignment?: boolean;
  includeLLMSynthesis?: boolean;
  forceRefresh?: boolean;
  confidenceThreshold?: number;
}

export interface GroupAnalysisResult {
  groupId: string;
  analysisId: string;
  timestamp: Date;
  memberCount: number;
  dataCompleteness: number;
  insights: {
    compatibilityMatrix?: CompatibilityMatrix;
    collectiveStrengths?: CollectiveStrength[];
    conflictRisks?: ConflictRisk[];
    goalAlignment?: GoalAlignment;
    llmSynthesis?: LLMSynthesis;
  };
  metadata: {
    processingTime: number;
    dataVersion: string;
    algorithmsUsed: string[];
    overallConfidence: number;
  };
}

export interface CompatibilityMatrix {
  matrix: number[][];
  memberIds: string[];
  pairwiseDetails: Map<string, CompatibilityDetail>;
  averageCompatibility: number;
  pairCount?: number;
  visualization: {
    heatmapData: any;
    clusterGroups?: string[][];
  };
}

export interface CompatibilityDetail {
  memberA: string;
  memberB: string;
  score: number;
  confidence: number;
  factors: {
    personality: number;
    communication: number;
    conflict: number;
    energy: number;
  };
  strengths: string[];
  challenges: string[];
  recommendations: string[];
}

export interface CollectiveStrength {
  id: string;
  name: string;
  type: 'behavioral' | 'cognitive' | 'value' | 'skill';
  prevalence: number;
  strength: number;
  description: string;
  memberCount: number;
  applications: string[];
  confidence: number;
}

export interface ConflictRisk {
  id: string;
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedMembers: string[];
  description: string;
  triggers: string[];
  mitigationStrategies: string[];
  probability: number;
  impact: number;
  riskScore: number;
}

export interface GoalAlignment {
  overallAlignment: number;
  sharedGoals: string[];
  divergentGoals: string[];
  alignmentClusters: Array<{
    members: string[];
    goals: string[];
    strength: number;
  }>;
}

export interface LLMSynthesis {
  overview: string;
  keyInsights: string[];
  recommendations: string[];
  narratives: {
    compatibility?: string;
    strengths?: string;
    challenges?: string;
    opportunities?: string;
  };
}

/**
 * Main GroupAnalyzer Class
 */
export class GroupAnalyzer {
  private compatibilityCalculator: CompatibilityCalculator;
  private strengthDetector: CollectiveStrengthDetector;
  private conflictPredictor: ConflictRiskPredictor;
  private logger: Logger;

  constructor() {
    this.logger = new Logger('GroupAnalyzer');

    // Initialize sub-analyzers
    this.compatibilityCalculator = new CompatibilityCalculator();
    this.strengthDetector = new CollectiveStrengthDetector();
    this.conflictPredictor = new ConflictRiskPredictor();

    this.logger.info('GroupAnalyzer initialized');
  }

  /**
   * Initialize analyzer (for server startup)
   */
  public async initialize(): Promise<void> {
    this.logger.info('GroupAnalyzer starting up');
    // No async initialization needed currently
    return Promise.resolve();
  }

  /**
   * Shutdown analyzer (for server shutdown)
   */
  public async shutdown(): Promise<void> {
    this.logger.info('GroupAnalyzer shutting down');
    // No cleanup needed currently
    return Promise.resolve();
  }

  /**
   * Main analysis entry point
   */
  public async analyzeGroup(
    groupId: string,
    options: GroupAnalysisOptions = {}
  ): Promise<GroupAnalysisResult> {
    const startTime = Date.now();
    const analysisId = uuidv4();

    this.logger.info(`Starting analysis for group ${groupId}`, { analysisId, options });

    try {
      // Set default options
      const analysisOptions: GroupAnalysisOptions = {
        includeCompatibility: true,
        includeStrengths: true,
        includeConflicts: true,
        includeGoalAlignment: true,
        includeLLMSynthesis: true,
        forceRefresh: false,
        confidenceThreshold: 0.7,
        ...options
      };

      // Check cache if not forcing refresh
      if (!analysisOptions.forceRefresh) {
        const cachedResult = await this.getCachedAnalysis(groupId);
        if (cachedResult && this.isCacheValid(cachedResult)) {
          this.logger.info(`Returning cached analysis for group ${groupId}`);
          return cachedResult;
        }
      }

      // Fetch and prepare member data
      const memberData = await this.fetchMemberData(groupId);

      if (memberData.length < 2) {
        throw new Error('Insufficient member data for analysis (minimum 2 members required)');
      }

      const dataCompleteness = this.calculateDataCompleteness(memberData);

      // Initialize result structure
      const result: GroupAnalysisResult = {
        groupId,
        analysisId,
        timestamp: new Date(),
        memberCount: memberData.length,
        dataCompleteness,
        insights: {},
        metadata: {
          processingTime: 0,
          dataVersion: this.generateDataVersion(memberData),
          algorithmsUsed: [],
          overallConfidence: 0
        }
      };

      // Run analyses in parallel where possible
      const analysisPromises: Promise<void>[] = [];

      // Compatibility Matrix
      if (analysisOptions.includeCompatibility) {
        analysisPromises.push(
          this.runCompatibilityAnalysis(memberData, result)
        );
      }

      // Collective Strengths
      if (analysisOptions.includeStrengths) {
        analysisPromises.push(
          this.runStrengthAnalysis(memberData, result)
        );
      }

      // Conflict Risks
      if (analysisOptions.includeConflicts) {
        analysisPromises.push(
          this.runConflictAnalysis(memberData, result)
        );
      }

      // Goal Alignment
      if (analysisOptions.includeGoalAlignment) {
        analysisPromises.push(
          this.runGoalAlignmentAnalysis(memberData, result)
        );
      }

      // Execute parallel analyses
      await Promise.all(analysisPromises);

      // LLM Synthesis (requires other analyses to complete first)
      if (analysisOptions.includeLLMSynthesis && Object.keys(result.insights).length > 0) {
        await this.runLLMSynthesis(result);
      }

      // Calculate overall confidence
      result.metadata.overallConfidence = this.calculateOverallConfidence(result);

      // Filter by confidence threshold
      if (analysisOptions.confidenceThreshold) {
        this.filterByConfidence(result, analysisOptions.confidenceThreshold);
      }

      // Calculate processing time
      result.metadata.processingTime = Date.now() - startTime;

      // Store results
      await this.storeAnalysisResults(result);

      // Cache results
      await this.cacheAnalysis(result);

      // Queue notifications
      await this.queueNotifications(groupId, result);

      this.logger.info(`Analysis completed for group ${groupId}`, {
        analysisId,
        processingTime: result.metadata.processingTime,
        confidence: result.metadata.overallConfidence
      });

      return result;

    } catch (error) {
      this.logger.error(`Analysis failed for group ${groupId}`, error);
      throw error;
    }
  }

  /**
   * Fetch member data from shared group data
   */
  private async fetchMemberData(groupId: string): Promise<MemberData[]> {
    try {
      // Get all shared data for the group
      const [sharedDataRows] = await DB.query(`
        SELECT
          sd.*,
          u.id as user_id,
          u.username,
          u.email
        FROM mirror_group_shared_data sd
        JOIN users u ON sd.user_id = u.id
        WHERE sd.group_id = ?
        ORDER BY sd.shared_at DESC
      `, [groupId]);

      const sharedData = sharedDataRows as any[];

      // Group by member to get latest data
      const memberDataMap = new Map<string, MemberData>();

      for (const row of sharedData) {
        const userId = String(row.user_id);

        if (!memberDataMap.has(userId)) {
          memberDataMap.set(userId, {
            userId,
            sharedAt: row.shared_at,
            dataTypes: []
          });
        }

        const memberData = memberDataMap.get(userId)!;

        // Decrypt and parse data based on type
        const decryptedResult = await groupEncryptionManager.decryptForUser(
          row.encrypted_data,
          userId,
          groupId
        );

        const decryptedString = decryptedResult.data.toString('utf-8');
        let decryptedData = JSON.parse(decryptedString);

        // BACKWARD COMPATIBILITY: Transform old PublicProfile format to MemberData format
        // Old format has: { bigFive, mbti } instead of { embedding, communicationStyle }
        if (row.data_type === 'personality' && decryptedData.bigFive && !decryptedData.embedding) {
          decryptedData = this.transformLegacyPersonality(decryptedData);
        }
        if (row.data_type === 'cognitive' && decryptedData.iqScore && !decryptedData.problemSolvingStyle) {
          decryptedData = this.transformLegacyCognitive(decryptedData);
        }

        switch (row.data_type) {
          case 'personality':
            memberData.personality = decryptedData;
            memberData.dataTypes.push('personality');
            break;

          case 'cognitive':
            memberData.cognitive = decryptedData;
            memberData.dataTypes.push('cognitive');
            break;

          case 'behavioral':
            memberData.behavioral = decryptedData;
            memberData.dataTypes.push('behavioral');
            break;

          case 'full_profile':
            // Check if it's legacy format and transform if needed
            if (decryptedData.personality?.bigFive && !decryptedData.personality?.embedding) {
              decryptedData = this.transformLegacyFullProfile(decryptedData);
            }
            Object.assign(memberData, decryptedData);
            memberData.dataTypes.push('full_profile');
            break;
        }
      }

      const memberDataArray = Array.from(memberDataMap.values());

      // Log data completeness for debugging
      this.logger.info('Member data loaded', {
        memberCount: memberDataArray.length,
        dataCompleteness: memberDataArray.map(m => ({
          userId: m.userId.substring(0, 8),
          dataTypes: m.dataTypes,
          hasPersonality: !!m.personality,
          hasEmbedding: !!m.personality?.embedding,
          hasCommunicationStyle: !!m.personality?.communicationStyle,
          hasConflictStyle: !!m.personality?.conflictResolutionStyle,
          hasCognitive: !!m.cognitive,
          hasBehavioral: !!m.behavioral,
          hasSocialEnergy: m.behavioral?.socialEnergy !== undefined
        }))
      });

      return memberDataArray;

    } catch (error) {
      this.logger.error('Failed to fetch member data', error);
      throw error;
    }
  }

  /**
   * Run compatibility analysis
   */
  private async runCompatibilityAnalysis(
    memberData: MemberData[],
    result: GroupAnalysisResult
  ): Promise<void> {
    try {
      const matrix = await this.compatibilityCalculator.calculateMatrix(memberData);

      // Add pairCount for synthesis
      matrix.pairCount = matrix.pairwiseDetails.size;

      result.insights.compatibilityMatrix = matrix;
      result.metadata.algorithmsUsed.push('compatibility_matrix_v1');

      // Store individual compatibility scores
      await this.storeCompatibilityScores(result.groupId, matrix);

    } catch (error) {
      this.logger.error('Compatibility analysis failed', error);
      // Don't throw - allow other analyses to continue
    }
  }

  /**
   * Run collective strength analysis
   */
  private async runStrengthAnalysis(
    memberData: MemberData[],
    result: GroupAnalysisResult
  ): Promise<void> {
    try {
      const strengths = await this.strengthDetector.detectStrengths(memberData);

      result.insights.collectiveStrengths = strengths;
      result.metadata.algorithmsUsed.push('strength_detection_v1');

      // Store collective patterns
      await this.storeCollectivePatterns(result.groupId, strengths);

    } catch (error) {
      this.logger.error('Strength analysis failed', error);
    }
  }

  /**
   * Run conflict risk analysis
   */
  private async runConflictAnalysis(
    memberData: MemberData[],
    result: GroupAnalysisResult
  ): Promise<void> {
    try {
      const risks = await this.conflictPredictor.predictRisks(memberData);

      result.insights.conflictRisks = risks;
      result.metadata.algorithmsUsed.push('conflict_prediction_v1');

      // Store conflict risks
      await this.storeConflictRisks(result.groupId, risks);

    } catch (error) {
      this.logger.error('Conflict analysis failed', error);
    }
  }

  /**
   * Run goal alignment analysis
   */
  private async runGoalAlignmentAnalysis(
    memberData: MemberData[],
    result: GroupAnalysisResult
  ): Promise<void> {
    try {
      const alignment = await this.calculateGoalAlignment(memberData);

      result.insights.goalAlignment = alignment;
      result.metadata.algorithmsUsed.push('goal_alignment_v1');

    } catch (error) {
      this.logger.error('Goal alignment analysis failed', error);
    }
  }

  /**
   * Run LLM synthesis
   */
  private async runLLMSynthesis(result: GroupAnalysisResult): Promise<void> {
    try {
      const synthesis = await dinaLLMConnector.synthesizeInsights(result);

      result.insights.llmSynthesis = synthesis;
      result.metadata.algorithmsUsed.push('llm_synthesis_v1');

      // Store LLM synthesis
      await this.storeLLMSynthesis(result.groupId, synthesis);

    } catch (error) {
      this.logger.error('LLM synthesis failed', error);
    }
  }

  /**
   * Calculate goal alignment between members
   */
  private async calculateGoalAlignment(memberData: MemberData[]): Promise<GoalAlignment> {
    const goalClusters = new Map<string, Set<string>>();
    const allGoals = new Set<string>();

    // Extract goals from motivation drivers
    memberData.forEach(member => {
      if (member.values?.motivationDrivers) {
        member.values.motivationDrivers
          .filter(d => d.strength > 0.6)
          .forEach(driver => {
            allGoals.add(driver.driver);

            if (!goalClusters.has(driver.driver)) {
              goalClusters.set(driver.driver, new Set());
            }
            goalClusters.get(driver.driver)!.add(member.userId);
          });
      }
    });

    // Identify shared vs divergent goals
    const sharedGoals: string[] = [];
    const divergentGoals: string[] = [];
    const threshold = memberData.length * 0.6; // 60% agreement

    goalClusters.forEach((members, goal) => {
      if (members.size >= threshold) {
        sharedGoals.push(goal);
      } else if (members.size === 1) {
        divergentGoals.push(goal);
      }
    });

    // Create alignment clusters
    const alignmentClusters = Array.from(goalClusters.entries())
      .filter(([_, members]) => members.size > 1)
      .map(([goal, members]) => ({
        members: Array.from(members),
        goals: [goal],
        strength: members.size / memberData.length
      }));

    // Calculate overall alignment
    const overallAlignment = sharedGoals.length / Math.max(allGoals.size, 1);

    return {
      overallAlignment,
      sharedGoals,
      divergentGoals,
      alignmentClusters
    };
  }

  /**
   * Calculate data completeness for the group
   */
  private calculateDataCompleteness(memberData: MemberData[]): number {
    if (memberData.length === 0) return 0;

    const requiredFields = [
      'personality.embedding',
      'personality.traits',
      'behavioral.tendencies',
      'values.motivationDrivers'
    ];

    let totalFields = 0;
    let presentFields = 0;

    memberData.forEach(member => {
      requiredFields.forEach(field => {
        totalFields++;
        if (this.hasNestedProperty(member, field)) {
          presentFields++;
        }
      });
    });

    return presentFields / totalFields;
  }

  /**
   * Calculate overall confidence score
   */
  private calculateOverallConfidence(result: GroupAnalysisResult): number {
    const confidences: number[] = [];

    // Collect confidence scores from various analyses
    if (result.insights.compatibilityMatrix) {
      const avgConfidence = Array.from(
        result.insights.compatibilityMatrix.pairwiseDetails.values()
      ).reduce((sum, detail) => sum + detail.confidence, 0) /
        result.insights.compatibilityMatrix.pairwiseDetails.size;
      confidences.push(avgConfidence);
    }

    if (result.insights.collectiveStrengths) {
      const avgConfidence = result.insights.collectiveStrengths
        .reduce((sum, s) => sum + s.confidence, 0) /
        result.insights.collectiveStrengths.length;
      confidences.push(avgConfidence);
    }

    // Weight by data completeness
    const baseConfidence = confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0.5;

    return Math.min(baseConfidence * result.dataCompleteness, 1.0);
  }

  /**
   * Filter results by confidence threshold
   */
  private filterByConfidence(
    result: GroupAnalysisResult,
    threshold: number
  ): void {
    // Filter collective strengths
    if (result.insights.collectiveStrengths) {
      result.insights.collectiveStrengths = result.insights.collectiveStrengths
        .filter(s => s.confidence >= threshold);
    }

    // Filter conflict risks by probability
    if (result.insights.conflictRisks) {
      result.insights.conflictRisks = result.insights.conflictRisks
        .filter(r => r.probability >= threshold);
    }
  }

  /**
   * Store analysis results to database
   */
  private async storeAnalysisResults(result: GroupAnalysisResult): Promise<void> {
    try {
      // Update analysis queue status
      await DB.query(`
        UPDATE mirror_group_analysis_queue
        SET status = 'completed',
            completed_at = NOW()
        WHERE group_id = ? AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1
      `, [result.groupId]);

    } catch (error) {
      this.logger.error('Failed to store analysis results', error);
      // Non-fatal - don't throw
    }
  }

  /**
   * Store compatibility scores
   */
  private async storeCompatibilityScores(
    groupId: string,
    matrix: CompatibilityMatrix
  ): Promise<void> {
    try {
      // Delete existing compatibility scores for this group
      await DB.query(`
        DELETE FROM mirror_group_compatibility WHERE group_id = ?
      `, [groupId]);

      // Insert new scores
      for (const [key, detail] of matrix.pairwiseDetails.entries()) {
        // Ensure integer ordering for database constraint (member_a_id < member_b_id)
        const memberAInt = parseInt(detail.memberA);
        const memberBInt = parseInt(detail.memberB);
        const [smallerId, largerId] = memberAInt < memberBInt
          ? [memberAInt, memberBInt]
          : [memberBInt, memberAInt];

        await DB.query(`
          INSERT INTO mirror_group_compatibility (
            id, group_id, member_a_id, member_b_id, compatibility_score,
            confidence_score, personality_similarity, communication_alignment,
            conflict_compatibility, energy_balance, factors, strengths,
            challenges, recommendations, explanation
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          uuidv4(),
          groupId,
          smallerId,
          largerId,
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
          detail.strengths.join('. ') + ' ' + detail.challenges.join('. ')
        ]);
      }

      this.logger.info(`Stored ${matrix.pairwiseDetails.size} compatibility scores`);
    } catch (error) {
      this.logger.error('Failed to store compatibility scores', error);
    }
  }

  /**
   * Store collective patterns
   */
  private async storeCollectivePatterns(
    groupId: string,
    strengths: CollectiveStrength[]
  ): Promise<void> {
    try {
      // Delete existing patterns for this group
      await DB.query(`
        DELETE FROM mirror_group_collective_patterns WHERE group_id = ?
      `, [groupId]);

      // Insert new patterns
      for (const strength of strengths) {
        await DB.query(`
          INSERT INTO mirror_group_collective_patterns (
            id, group_id, pattern_type, pattern_name, prevalence,
            average_likelihood, member_count, total_members, description,
            contexts, implications, confidence, is_significant
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          strength.id,
          groupId,
          'strength',
          strength.name,
          strength.prevalence,
          strength.strength,
          strength.memberCount,
          Math.ceil(strength.memberCount / strength.prevalence), // total members
          strength.description,
          JSON.stringify(strength.applications),
          JSON.stringify({ impact: 'positive', scope: 'group-wide' }),
          strength.confidence,
          true
        ]);
      }

      this.logger.info(`Stored ${strengths.length} collective patterns`);
    } catch (error) {
      this.logger.error('Failed to store collective patterns', error);
    }
  }

  /**
   * Store conflict risks
   */
  private async storeConflictRisks(
    groupId: string,
    risks: ConflictRisk[]
  ): Promise<void> {
    try {
      // Delete existing risks for this group
      await DB.query(`
        DELETE FROM mirror_group_conflict_risks WHERE group_id = ?
      `, [groupId]);

      // Insert new risks
      for (const risk of risks) {
        await DB.query(`
          INSERT INTO mirror_group_conflict_risks (
            id, group_id, risk_type, severity, affected_members,
            description, triggers, mitigation_strategies, probability, impact_score
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
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
      }

      this.logger.info(`Stored ${risks.length} conflict risks`);
    } catch (error) {
      this.logger.error('Failed to store conflict risks', error);
    }
  }

  /**
   * Store LLM synthesis
   */
  private async storeLLMSynthesis(
    groupId: string,
    synthesis: LLMSynthesis
  ): Promise<void> {
    try {
      // Delete existing synthesis for this group
      await DB.query(`
        DELETE FROM mirror_group_llm_synthesis WHERE group_id = ?
      `, [groupId]);

      // Insert new synthesis
      await DB.query(`
        INSERT INTO mirror_group_llm_synthesis (
          id, group_id, overview, key_insights, recommendations,
          narrative_compatibility, narrative_strengths, narrative_challenges,
          narrative_opportunities, synthesis_metadata, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `, [
        uuidv4(),
        groupId,
        synthesis.overview,
        JSON.stringify(synthesis.keyInsights),
        JSON.stringify(synthesis.recommendations),
        synthesis.narrative?.compatibility || null,
        synthesis.narrative?.strengths || null,
        synthesis.narrative?.challenges || null,
        synthesis.narrative?.opportunities || null,
        JSON.stringify({
          insightCount: synthesis.keyInsights.length,
          recommendationCount: synthesis.recommendations.length,
          hasNarrative: !!synthesis.narrative
        })
      ]);

      this.logger.info('LLM synthesis stored', {
        overviewLength: synthesis.overview.length,
        keyInsightsCount: synthesis.keyInsights.length,
        recommendationsCount: synthesis.recommendations.length
      });
    } catch (error) {
      this.logger.error('Failed to store LLM synthesis', error);
    }
  }

  /**
   * Cache analysis results
   */
  private async cacheAnalysis(result: GroupAnalysisResult): Promise<void> {
    try {
      const key = `mirror:group:analysis:${result.groupId}`;
      const ttl = 3600; // 1 hour

      await mirrorRedis.set(key, result, ttl);
      this.logger.debug('Analysis cached', { groupId: result.groupId, ttl });
    } catch (error) {
      this.logger.error('Failed to cache analysis', error);
    }
  }

  /**
   * Get cached analysis
   */
  private async getCachedAnalysis(
    groupId: string
  ): Promise<GroupAnalysisResult | null> {
    try {
      const key = `mirror:group:analysis:${groupId}`;
      const cached = await mirrorRedis.get(key);

      return cached || null;
    } catch (error) {
      this.logger.error('Failed to get cached analysis', error);
      return null;
    }
  }

  /**
   * Check if cache is valid
   */
  private isCacheValid(cached: GroupAnalysisResult): boolean {
    const age = Date.now() - new Date(cached.timestamp).getTime();
    const maxAge = 3600000; // 1 hour

    return age < maxAge;
  }

  /**
   * Queue notifications for analysis completion
   */
  private async queueNotifications(
    groupId: string,
    result: GroupAnalysisResult
  ): Promise<void> {
    try {
      // Publish to Redis for notification system
      await mirrorRedis.publish(
        'mirror:notifications',
        JSON.stringify({
          type: 'group_analysis_complete',
          groupId,
          analysisId: result.analysisId,
          timestamp: result.timestamp,
          memberCount: result.memberCount,
          confidence: result.metadata.overallConfidence
        })
      );
    } catch (error) {
      this.logger.error('Failed to queue notifications', error);
    }
  }

  /**
   * Generate data version hash
   */
  private generateDataVersion(memberData: MemberData[]): string {
    const timestamps = memberData.map(m => m.sharedAt.getTime()).sort();
    const hash = timestamps.reduce((a, b) => a + b, 0).toString(36);
    return `v1_${hash}`;
  }

  /**
   * Helper to check nested properties
   */
  private hasNestedProperty(obj: any, path: string): boolean {
    return path.split('.').reduce((current, prop) =>
      current?.[prop] !== undefined ? current[prop] : undefined, obj
    ) !== undefined;
  }

  /**
   * Queue analysis for a group
   */
  public async queueAnalysis(
    groupId: string,
    trigger: string,
    priority: number = 5
  ): Promise<string> {
    const queueId = uuidv4();

    await DB.query(`
      INSERT INTO mirror_group_analysis_queue (
        id, group_id, analysis_type, priority, trigger_event
      ) VALUES (?, ?, ?, ?, ?)
    `, [queueId, groupId, 'full_analysis', priority, trigger]);

    // Notify worker
    await mirrorRedis.publish('mirror:analysis:queue', JSON.stringify({
      queueId,
      groupId,
      priority
    }));

    return queueId;
  }

  /**
   * Get analysis status
   */
  public async getAnalysisStatus(queueId: string): Promise<any> {
    const [rows] = await DB.query(`
      SELECT * FROM mirror_group_analysis_queue WHERE id = ?
    `, [queueId]);

    return (rows as any[])[0];
  }

  /**
   * Transform legacy PublicProfile personality format to MemberData format
   * Handles backward compatibility for existing database records
   */
  private transformLegacyPersonality(legacyData: any): any {
    const bigFive = legacyData.bigFive || {};

    // Generate embedding from Big Five traits (normalized 0-1)
    const embedding = [
      (bigFive.openness || 50) / 100,
      (bigFive.conscientiousness || 50) / 100,
      (bigFive.extraversion || 50) / 100,
      (bigFive.agreeableness || 50) / 100,
      (bigFive.neuroticism || 50) / 100
    ];

    return {
      embedding,
      traits: bigFive,
      interpersonalStyle: legacyData.mbti || 'unknown',
      communicationStyle: 'balanced', // Default since not in legacy format
      conflictResolutionStyle: 'compromising' // Default since not in legacy format
    };
  }

  /**
   * Transform legacy PublicProfile cognitive format to MemberData format
   */
  private transformLegacyCognitive(legacyData: any): any {
    return {
      iqScore: legacyData.iqScore,
      category: legacyData.category,
      strengths: legacyData.strengths || [],
      problemSolvingStyle: 'practical',
      decisionMakingStyle: 'balanced',
      learningStyle: 'structured'
    };
  }

  /**
   * Transform legacy full profile format
   */
  private transformLegacyFullProfile(legacyData: any): any {
    const personality = legacyData.personality || {};
    const collaboration = legacyData.collaboration || {};
    const communication = legacyData.communication || {};
    const bigFive = personality.bigFive || {};

    return {
      personality: {
        embedding: [
          (bigFive.openness || 50) / 100,
          (bigFive.conscientiousness || 50) / 100,
          (bigFive.extraversion || 50) / 100,
          (bigFive.agreeableness || 50) / 100,
          (bigFive.neuroticism || 50) / 100
        ],
        traits: bigFive,
        interpersonalStyle: personality.mbti || 'unknown',
        communicationStyle: communication?.style || 'balanced',
        conflictResolutionStyle: collaboration?.conflictStyle || 'compromising'
      },
      cognitive: {
        ...legacyData.cognitive,
        problemSolvingStyle: 'practical',
        decisionMakingStyle: 'balanced',
        learningStyle: 'structured'
      },
      behavioral: {
        tendencies: [],
        socialEnergy: (bigFive.extraversion || 50) / 100,
        empathyLevel: this.parseEmpathyLevel(collaboration?.empathyLevel)
      },
      values: {
        core: personality.dominantTraits || [],
        motivationDrivers: []
      }
    };
  }

  /**
   * Parse empathy level string to numeric value
   */
  private parseEmpathyLevel(empathyStr: string | undefined): number {
    if (!empathyStr) return 0.5;

    const levels: Record<string, number> = {
      'low': 0.3,
      'moderate': 0.5,
      'medium': 0.5,
      'high': 0.7,
      'very high': 0.9
    };

    return levels[empathyStr.toLowerCase()] || 0.5;
  }
}

// Export singleton instance
export const groupAnalyzer = new GroupAnalyzer();
