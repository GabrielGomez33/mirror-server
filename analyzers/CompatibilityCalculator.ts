/**
 * CompatibilityCalculator - Pairwise Member Compatibility Analysis
 * 
 * Calculates compatibility scores between group members based on:
 * - Personality embedding similarity (40% weight)
 * - Communication style alignment (30% weight)  
 * - Conflict resolution compatibility (20% weight)
 * - Energy balance (10% weight)
 * 
 * @module analyzers/CompatibilityCalculator
 */

import { v4 as uuidv4 } from 'uuid';
import { MemberData, CompatibilityMatrix, CompatibilityDetail } from './GroupAnalyzer';
import { Logger } from '../utils/logger';

/**
 * Conflict resolution style compatibility matrix
 * Based on Thomas-Kilmann conflict modes
 */
const CONFLICT_COMPATIBILITY_MATRIX: Record<string, Record<string, number>> = {
  'competing': {
    'competing': 0.3,      // Two competitors = high friction
    'collaborating': 0.8,  // Competitor + Collaborator = productive
    'compromising': 0.6,   // Competitor + Compromiser = moderate
    'avoiding': 0.2,       // Competitor + Avoider = frustration
    'accommodating': 0.7   // Competitor + Accommodator = works
  },
  'collaborating': {
    'competing': 0.8,
    'collaborating': 0.9,  // Two collaborators = excellent
    'compromising': 0.7,
    'avoiding': 0.4,
    'accommodating': 0.6
  },
  'compromising': {
    'competing': 0.6,
    'collaborating': 0.7,
    'compromising': 0.8,   // Two compromisers = stable
    'avoiding': 0.5,
    'accommodating': 0.7
  },
  'avoiding': {
    'competing': 0.2,
    'collaborating': 0.4,
    'compromising': 0.5,
    'avoiding': 0.3,       // Two avoiders = unresolved issues
    'accommodating': 0.5
  },
  'accommodating': {
    'competing': 0.7,
    'collaborating': 0.6,
    'compromising': 0.7,
    'avoiding': 0.5,
    'accommodating': 0.4   // Two accommodators = lack direction
  }
};

/**
 * Communication style alignment scoring
 */
const COMMUNICATION_ALIGNMENT_SCORES: Record<string, Record<string, number>> = {
  'direct': {
    'direct': 1.0,        // Same style = perfect alignment
    'supportive': 0.8,
    'analytical': 0.7,
    'indirect': 0.5
  },
  'supportive': {
    'direct': 0.8,
    'supportive': 1.0,
    'analytical': 0.7,
    'indirect': 0.6
  },
  'analytical': {
    'direct': 0.7,
    'supportive': 0.7,
    'analytical': 1.0,
    'indirect': 0.4
  },
  'indirect': {
    'direct': 0.5,
    'supportive': 0.6,
    'analytical': 0.4,
    'indirect': 1.0
  }
};

export class CompatibilityCalculator {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('CompatibilityCalculator');
  }

  /**
   * Initialize calculator (for server startup)
   */
  public async initialize(): Promise<void> {
    this.logger.info('CompatibilityCalculator initialized');
    return Promise.resolve();
  }

  /**
   * Shutdown calculator (for server shutdown)
   */
  public async shutdown(): Promise<void> {
    this.logger.info('CompatibilityCalculator shutdown');
    return Promise.resolve();
  }

  /**
   * Calculate full compatibility matrix for all group members
   */
  public async calculateMatrix(memberData: MemberData[]): Promise<CompatibilityMatrix> {
    const startTime = Date.now();
    const memberIds = memberData.map(m => m.userId);
    const n = memberIds.length;
    
    // Initialize matrix (n x n)
    const matrix: number[][] = Array(n).fill(0).map(() => Array(n).fill(0));
    const pairwiseDetails = new Map<string, CompatibilityDetail>();
    
    // Calculate pairwise compatibility
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        if (i === j) {
          matrix[i][j] = 1.0; // Perfect self-compatibility
        } else {
          const compatibility = await this.calculatePairwiseCompatibility(
            memberData[i],
            memberData[j]
          );
          
          // Store symmetrically
          matrix[i][j] = compatibility.score;
          matrix[j][i] = compatibility.score;
          
          // Store details with ordered key
          const key = this.getPairKey(memberIds[i], memberIds[j]);
          pairwiseDetails.set(key, compatibility);
        }
      }
    }
    
    // Calculate average compatibility
    let totalScore = 0;
    let pairCount = 0;
    
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        totalScore += matrix[i][j];
        pairCount++;
      }
    }
    
    const averageCompatibility = pairCount > 0 ? totalScore / pairCount : 0;
    
    // Generate heatmap data
    const heatmapData = this.generateHeatmapData(matrix, memberIds);
    
    // Detect clusters (groups of highly compatible members)
    const clusterGroups = this.detectClusters(matrix, memberIds);
    
    const processingTime = Date.now() - startTime;

    // Calculate data completeness statistics
    const dataStats = {
      totalPairs: pairCount,
      avgScore: averageCompatibility.toFixed(2),
      scoreDistribution: {
        low: 0,      // < 0.4
        medium: 0,   // 0.4 - 0.7
        high: 0,     // > 0.7
        neutral: 0   // exactly 0.5 (likely missing data)
      }
    };

    for (const [key, detail] of pairwiseDetails.entries()) {
      if (Math.abs(detail.score - 0.5) < 0.001) {
        dataStats.scoreDistribution.neutral++;
      } else if (detail.score < 0.4) {
        dataStats.scoreDistribution.low++;
      } else if (detail.score <= 0.7) {
        dataStats.scoreDistribution.medium++;
      } else {
        dataStats.scoreDistribution.high++;
      }
    }

    this.logger.info(`Matrix calculation completed`, {
      members: n,
      pairs: pairCount,
      avgCompatibility: averageCompatibility.toFixed(2),
      processingTime,
      distribution: dataStats.scoreDistribution,
      potentialDataIssues: dataStats.scoreDistribution.neutral > 0 ?
        `${dataStats.scoreDistribution.neutral} pairs have neutral score (0.5) - likely missing data` : null
    });
    
    return {
      matrix,
      memberIds,
      pairwiseDetails,
      averageCompatibility,
      visualization: {
        heatmapData,
        clusterGroups
      }
    };
  }

  /**
   * Calculate compatibility between two members
   */
  private async calculatePairwiseCompatibility(
    memberA: MemberData,
    memberB: MemberData
  ): Promise<CompatibilityDetail> {
    // Calculate individual factors
    const personality = this.calculatePersonalitySimilarity(memberA, memberB);
    const communication = this.calculateCommunicationAlignment(memberA, memberB);
    const conflict = this.calculateConflictCompatibility(memberA, memberB);
    const energy = this.calculateEnergyBalance(memberA, memberB);
    
    // Apply weights
    const weights = {
      personality: 0.4,
      communication: 0.3,
      conflict: 0.2,
      energy: 0.1
    };
    
    // Calculate weighted score
    const score = Math.min(1.0, 
      personality.score * weights.personality +
      communication.score * weights.communication +
      conflict.score * weights.conflict +
      energy.score * weights.energy
    );
    
    // Calculate confidence based on data completeness
    const dataPoints = [
      personality.hasData,
      communication.hasData,
      conflict.hasData,
      energy.hasData
    ];
    const confidence = dataPoints.filter(Boolean).length / dataPoints.length;

    // Log low confidence scores for debugging
    if (confidence < 0.75) {
      this.logger.warn('Low data completeness for compatibility calculation', {
        memberPair: `${memberA.userId.substring(0, 8)} - ${memberB.userId.substring(0, 8)}`,
        confidence: confidence.toFixed(2),
        score: score.toFixed(2),
        missingData: {
          personality: !personality.hasData,
          communication: !communication.hasData,
          conflict: !conflict.hasData,
          energy: !energy.hasData
        },
        factors: {
          personality: personality.score.toFixed(2),
          communication: communication.score.toFixed(2),
          conflict: conflict.score.toFixed(2),
          energy: energy.score.toFixed(2)
        }
      });
    }
    
    // Generate insights
    const strengths: string[] = [];
    const challenges: string[] = [];
    const recommendations: string[] = [];
    
    // Analyze personality
    if (personality.score > 0.7) {
      strengths.push('Strong personality alignment creates natural understanding');
    } else if (personality.score < 0.4) {
      challenges.push('Significant personality differences may require extra effort to understand each other');
      recommendations.push('Focus on finding common ground and appreciating diverse perspectives');
    }
    
    // Analyze communication
    if (communication.score > 0.8) {
      strengths.push(`Both prefer ${memberA.personality?.communicationStyle || 'similar'} communication styles`);
    } else if (communication.score < 0.6) {
      challenges.push('Different communication styles may lead to misunderstandings');
      recommendations.push('Be explicit about communication preferences and check for understanding frequently');
    }
    
    // Analyze conflict
    if (conflict.score > 0.7) {
      strengths.push('Compatible conflict resolution styles support healthy disagreements');
    } else if (conflict.score < 0.4) {
      challenges.push('Mismatched conflict styles could escalate disagreements');
      recommendations.push('Establish ground rules for handling conflicts before they arise');
    }
    
    // Analyze energy
    if (energy.score > 0.8) {
      strengths.push('Well-balanced social energy levels');
    } else if (energy.score < 0.5) {
      challenges.push('Different energy levels may cause friction in social situations');
      recommendations.push('Respect each other\'s need for social interaction or solitude');
    }
    
    return {
      memberA: memberA.userId,
      memberB: memberB.userId,
      score,
      confidence,
      factors: {
        personality: personality.score,
        communication: communication.score,
        conflict: conflict.score,
        energy: energy.score
      },
      strengths,
      challenges,
      recommendations
    };
  }

  /**
   * Calculate personality similarity using cosine similarity
   */
  private calculatePersonalitySimilarity(
    memberA: MemberData,
    memberB: MemberData
  ): { score: number; hasData: boolean } {
    if (!memberA.personality?.embedding || !memberB.personality?.embedding) {
      return { score: 0.5, hasData: false }; // Neutral if no data
    }
    
    const embedA = memberA.personality.embedding;
    const embedB = memberB.personality.embedding;
    
    // Cosine similarity
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < Math.min(embedA.length, embedB.length); i++) {
      dotProduct += embedA[i] * embedB[i];
      normA += embedA[i] * embedA[i];
      normB += embedB[i] * embedB[i];
    }
    
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);
    
    const cosineSimilarity = normA && normB ? dotProduct / (normA * normB) : 0;
    
    // Normalize to 0-1 range (cosine similarity is -1 to 1)
    const score = (cosineSimilarity + 1) / 2;
    
    return { score, hasData: true };
  }

  /**
   * Calculate communication style alignment
   */
  private calculateCommunicationAlignment(
    memberA: MemberData,
    memberB: MemberData
  ): { score: number; hasData: boolean } {
    const styleA = memberA.personality?.communicationStyle;
    const styleB = memberB.personality?.communicationStyle;
    
    if (!styleA || !styleB) {
      return { score: 0.5, hasData: false };
    }
    
    // Look up alignment score
    const score = COMMUNICATION_ALIGNMENT_SCORES[styleA]?.[styleB] || 0.5;
    
    return { score, hasData: true };
  }

  /**
   * Calculate conflict resolution compatibility
   */
  private calculateConflictCompatibility(
    memberA: MemberData,
    memberB: MemberData
  ): { score: number; hasData: boolean } {
    const styleA = memberA.personality?.conflictResolutionStyle;
    const styleB = memberB.personality?.conflictResolutionStyle;
    
    if (!styleA || !styleB) {
      return { score: 0.5, hasData: false };
    }
    
    // Look up compatibility score
    const score = CONFLICT_COMPATIBILITY_MATRIX[styleA]?.[styleB] || 0.5;
    
    return { score, hasData: true };
  }

  /**
   * Calculate energy balance compatibility
   */
  private calculateEnergyBalance(
    memberA: MemberData,
    memberB: MemberData
  ): { score: number; hasData: boolean } {
    const energyA = memberA.behavioral?.socialEnergy;
    const energyB = memberB.behavioral?.socialEnergy;
    
    if (energyA === undefined || energyB === undefined) {
      return { score: 0.5, hasData: false };
    }
    
    // Calculate difference (both on 0-100 scale)
    const difference = Math.abs(energyA - energyB);
    
    // Convert to compatibility score (smaller difference = higher compatibility)
    // But some difference can be complementary
    let score: number;
    
    if (difference < 20) {
      score = 1.0; // Very similar - excellent
    } else if (difference < 40) {
      score = 0.8; // Moderately similar - good  
    } else if (difference < 60) {
      score = 0.6; // Some difference - can be complementary
    } else {
      score = 0.4; // Large difference - may cause friction
    }
    
    return { score, hasData: true };
  }

  /**
   * Generate heatmap data for visualization
   */
  private generateHeatmapData(
    matrix: number[][],
    memberIds: string[]
  ): any {
    const data: any[] = [];
    
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix[i].length; j++) {
        data.push({
          x: memberIds[j],
          y: memberIds[i],
          value: matrix[i][j],
          color: this.getHeatmapColor(matrix[i][j])
        });
      }
    }
    
    return {
      data,
      min: 0,
      max: 1,
      colorScale: [
        { value: 0, color: '#ff4444' },     // Red - Poor
        { value: 0.4, color: '#ff9944' },   // Orange - Needs attention
        { value: 0.6, color: '#ffdd44' },   // Yellow - Moderate  
        { value: 0.8, color: '#44ff44' },   // Light green - Good
        { value: 1, color: '#00aa00' }      // Dark green - Excellent
      ]
    };
  }

  /**
   * Detect clusters of highly compatible members
   */
  private detectClusters(
    matrix: number[][],
    memberIds: string[],
    threshold: number = 0.75
  ): string[][] {
    const clusters: string[][] = [];
    const visited = new Set<number>();
    
    // Simple clustering: group members with high mutual compatibility
    for (let i = 0; i < matrix.length; i++) {
      if (visited.has(i)) continue;
      
      const cluster = [memberIds[i]];
      visited.add(i);
      
      for (let j = i + 1; j < matrix.length; j++) {
        if (visited.has(j)) continue;
        
        // Check if j is compatible with all current cluster members
        let compatible = true;
        for (const memberIndex of Array.from(visited)) {
          if (matrix[memberIndex][j] < threshold) {
            compatible = false;
            break;
          }
        }
        
        if (compatible) {
          cluster.push(memberIds[j]);
          visited.add(j);
        }
      }
      
      if (cluster.length > 1) {
        clusters.push(cluster);
      }
    }
    
    return clusters;
  }

  /**
   * Get color for heatmap based on score
   */
  private getHeatmapColor(score: number): string {
    if (score >= 0.8) return '#00aa00';      // Dark green
    if (score >= 0.6) return '#44ff44';      // Light green
    if (score >= 0.4) return '#ffdd44';      // Yellow
    if (score >= 0.2) return '#ff9944';      // Orange
    return '#ff4444';                        // Red
  }

  /**
   * Generate ordered pair key for consistency
   */
  private getPairKey(memberA: string, memberB: string): string {
    return memberA < memberB 
      ? `${memberA}-${memberB}`
      : `${memberB}-${memberA}`;
  }

  /**
   * Get compatibility interpretation
   */
  public getCompatibilityInterpretation(score: number): string {
    if (score >= 0.8) return 'High compatibility';
    if (score >= 0.6) return 'Moderate compatibility';
    if (score >= 0.4) return 'Needs attention';
    return 'High friction risk';
  }

  /**
   * Calculate group cohesion score
   */
  public calculateGroupCohesion(matrix: CompatibilityMatrix): number {
    const scores = Array.from(matrix.pairwiseDetails.values())
      .map(d => d.score);
    
    if (scores.length === 0) return 0;
    
    // Calculate standard deviation to measure variance
    const avg = matrix.averageCompatibility;
    const variance = scores.reduce((sum, score) => 
      sum + Math.pow(score - avg, 2), 0
    ) / scores.length;
    const stdDev = Math.sqrt(variance);
    
    // High average + low variance = high cohesion
    // Scale standard deviation (0-0.5 range typically)
    const cohesion = avg * (1 - Math.min(stdDev * 2, 1));

    return Math.max(0, Math.min(1, cohesion));
  }
}

// Export singleton instance
export const compatibilityCalculator = new CompatibilityCalculator();

