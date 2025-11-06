// ============================================================================
// MIRRORGROUPS PHASE 2: Public Assessment Aggregator (PROPERLY TYPED)
// ============================================================================
// File: /var/www/mirror-server/managers/PublicAssessmentAggregator.ts
// ----------------------------------------------------------------------------
// Uses IntakeDataManager with CORRECT property access based on IntakeDataStructure
// ============================================================================

import { DB } from '../db';
import { mirrorRedis } from '../config/redis';
import { IntakeDataManager } from '../controllers/intakeController';
import { DataAccessContext } from '../controllers/directoryController';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// TYPES
// ============================================================================

interface PublicProfile {
  userId: number;
  timestamp: string;
  personality: {
    bigFive?: any;
    mbti?: string | null;
    emotionalIntelligence?: number | null;
    dominantTraits?: string[];
  };
  emotional?: {
    dominantEmotion?: any;
    emotionalSpectrum?: any[];
  } | null;
  communication?: {
    style?: string;
    pace?: string;
  } | null;
  cognitive?: {
    iqScore?: number;
    category?: string;
    strengths?: string[];
  } | null;
  collaboration: {
    teamworkScore?: number | null;
    empathyLevel?: string;
    conflictStyle?: string;
  };
  astrology?: {
    sunSign?: string;
    moonSign?: string;
    dominantElement?: string;
  } | null;
  sharingLevel: 'minimal' | 'standard' | 'comprehensive';
}

interface AggregationResult {
  success: boolean;
  data?: PublicProfile;
  cached?: boolean;
  error?: string;
}

// ============================================================================
// PUBLIC ASSESSMENT AGGREGATOR - CORRECTLY TYPED
// ============================================================================

export class PublicAssessmentAggregator {
  private readonly CACHE_TTL = 3600; // 1 hour cache

  /**
   * Aggregate all public-facing assessments for a user
   * Uses correct property access from IntakeDataStructure
   */
  async aggregateForUser(userId: number): Promise<AggregationResult> {
    try {
      console.log(`📊 Aggregating public assessments for user ${userId}`);

      // 1. Check cache first
      const cacheKey = `assessment:public:${userId}`;
      const cached = await mirrorRedis.get(cacheKey);
      if (cached) {
        console.log(`✅ Retrieved cached assessment for user ${userId}`);
        return {
          success: true,
          data: JSON.parse(cached),
          cached: true
        };
      }

      // 2. Get intake data using IntakeDataManager
      const context: DataAccessContext = {
        userId: userId,
        accessedBy: userId,
        sessionId: 'system',
        reason: 'group_data_sharing'
      };

      let intakeData = null;
      try {
        const result = await IntakeDataManager.getLatestIntakeData(
          String(userId),
          context,
          false // Don't include file contents
        );
        
        intakeData = result?.intakeData || null;
        console.log(`✅ Retrieved intake data for user ${userId}:`, {
          hasData: !!intakeData,
          hasPersonality: !!intakeData?.personalityResult,
          hasAstrology: !!intakeData?.astrologicalResult,
          hasIQ: !!intakeData?.iqResults,
          hasFace: !!intakeData?.faceAnalysis,
          hasVoice: !!intakeData?.voiceMetadata
        });
      } catch (error) {
        console.error(`❌ Failed to retrieve intake data:`, error);
        return {
          success: false,
          error: 'No assessment data available. Please complete your Mirror assessments first.'
        };
      }

      if (!intakeData) {
        console.log(`❌ No intake data found for user ${userId}`);
        return {
          success: false,
          error: 'No assessment data available. Please complete your Mirror assessments first.'
        };
      }

      // 3. Build public profile - USING CORRECT PROPERTY ACCESS
      const publicProfile: PublicProfile = {
        userId,
        timestamp: new Date().toISOString(),
        
        // Personality - big5Profile exists directly, not under scores
        personality: intakeData.personalityResult ? {
          bigFive: intakeData.personalityResult.big5Profile || {
            openness: 50,
            conscientiousness: 50,
            extraversion: 50,
            agreeableness: 50,
            neuroticism: 50
          },
          mbti: intakeData.personalityResult.mbtiType || null, // mbtiType, not mbti.type
          dominantTraits: intakeData.personalityResult.dominantTraits || [],
          emotionalIntelligence: this.calculateEQ(intakeData.personalityResult)
        } : {
          mbti: null,
          dominantTraits: []
        },

        // Emotional - derive from expressions since no dominantEmotion field
        emotional: intakeData.faceAnalysis ? {
          dominantEmotion: this.extractDominantEmotion(intakeData.faceAnalysis.expressions),
          emotionalSpectrum: this.buildEmotionalSpectrum(intakeData.faceAnalysis.expressions)
        } : null,

        // Cognitive - use iqScore (not score)
        cognitive: intakeData.iqResults ? {
          iqScore: intakeData.iqResults.iqScore || 100,
          category: intakeData.iqResults.category || 'Average',
          strengths: intakeData.iqResults.strengths || []
        } : null,

        // Astrology - sunSign is under western, not at root
        astrology: intakeData.astrologicalResult ? {
          sunSign: intakeData.astrologicalResult.western?.sunSign || null,
          moonSign: intakeData.astrologicalResult.western?.moonSign || null,
          dominantElement: intakeData.astrologicalResult.western?.dominantElement || null
        } : null,

        // Communication - from voice metadata
        communication: intakeData.voiceMetadata ? {
          style: 'balanced',
          pace: 'moderate'
        } : null,

        // Collaboration metrics
        collaboration: {
          teamworkScore: this.calculateTeamworkScore(intakeData.personalityResult),
          empathyLevel: this.assessEmpathyLevel(intakeData.personalityResult),
          conflictStyle: this.deriveConflictStyle(intakeData.personalityResult)
        },

        sharingLevel: 'standard'
      };

      // 4. Cache the aggregated profile
      await mirrorRedis.set(cacheKey, JSON.stringify(publicProfile), this.CACHE_TTL);
      console.log(`✅ Aggregated and cached assessment for user ${userId}`);

      return {
        success: true,
        data: publicProfile,
        cached: false
      };

    } catch (error) {
      console.error(`❌ Failed to aggregate assessments for user ${userId}:`, error);
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * Aggregate assessments for all active group members
   */
  async aggregateForGroup(groupId: string): Promise<any> {
    console.log(`📊 Aggregating assessments for group ${groupId}`);

    try {
      const [members] = await DB.query(
        `SELECT user_id, role FROM mirror_group_members 
         WHERE group_id = ? AND status = 'active'`,
        [groupId]
      );

      if ((members as any[]).length === 0) {
        return {
          success: false,
          error: 'No active members in group'
        };
      }

      const aggregations = await Promise.all(
        (members as any[]).map(async (member) => {
          const result = await this.aggregateForUser(member.user_id);
          return result.success ? {
            ...result.data,
            role: member.role
          } : null;
        })
      );

      const successfulAggregations = aggregations.filter(a => a !== null);

      return {
        success: true,
        groupId,
        memberCount: successfulAggregations.length,
        memberProfiles: successfulAggregations,
        aggregatedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error(`❌ Failed to aggregate group assessments:`, error);
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * Clear cached assessment for a user
   */
  async clearCache(userId: number): Promise<void> {
    const cacheKey = `assessment:public:${userId}`;
    await mirrorRedis.del(cacheKey);
    console.log(`🗑️ Cleared assessment cache for user ${userId}`);
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  /**
   * Extract dominant emotion from expressions object
   */
  private extractDominantEmotion(expressions: any): any {
    if (!expressions) return { emotion: 'neutral', confidence: 0.5 };
    
    let maxEmotion = 'neutral';
    let maxConfidence = 0;
    
    for (const [emotion, confidence] of Object.entries(expressions)) {
      if ((confidence as number) > maxConfidence) {
        maxEmotion = emotion;
        maxConfidence = confidence as number;
      }
    }
    
    return { emotion: maxEmotion, confidence: maxConfidence };
  }

  /**
   * Build emotional spectrum from expressions
   */
  private buildEmotionalSpectrum(expressions: any): any[] {
    if (!expressions) return [];
    
    return Object.entries(expressions)
      .map(([emotion, intensity]) => ({ emotion, intensity }))
      .sort((a, b) => (b.intensity as number) - (a.intensity as number));
  }

  /**
   * Calculate emotional intelligence from personality data
   */
  private calculateEQ(personalityData: any): number | null {
    if (!personalityData || !personalityData.big5Profile) return 65;
    
    const big5 = personalityData.big5Profile;
    
    // EQ calculation based on personality factors
    const factors = [
      (big5.agreeableness || 50) / 100,
      ((100 - (big5.neuroticism || 50)) / 100),
      (big5.openness || 50) / 100
    ];
    
    const average = factors.reduce((a, b) => a + b, 0) / factors.length;
    return Math.round(average * 100);
  }

  /**
   * Calculate teamwork score from personality
   */
  private calculateTeamworkScore(personalityData: any): number | null {
    if (!personalityData || !personalityData.big5Profile) return null;
    
    const big5 = personalityData.big5Profile;
    
    const score = (
      (big5.agreeableness || 50) * 0.4 + 
      (big5.conscientiousness || 50) * 0.3 + 
      (big5.extraversion || 50) * 0.2 + 
      (big5.openness || 50) * 0.1
    );
    
    return Math.round(score);
  }

  /**
   * Assess empathy level from personality
   */
  private assessEmpathyLevel(personalityData: any): string {
    if (!personalityData || !personalityData.big5Profile) return 'medium';
    
    const agreeableness = personalityData.big5Profile.agreeableness || 50;
    
    if (agreeableness > 70) return 'high';
    if (agreeableness > 40) return 'medium';
    return 'developing';
  }

  /**
   * Derive conflict style from personality
   */
  private deriveConflictStyle(personalityData: any): string {
    if (!personalityData || !personalityData.big5Profile) return 'collaborative';
    
    const big5 = personalityData.big5Profile;
    
    const agreeableness = big5.agreeableness || 50;
    const extraversion = big5.extraversion || 50;
    const conscientiousness = big5.conscientiousness || 50;
    
    if (agreeableness > 70 && conscientiousness > 70) {
      return 'collaborative';
    } else if (agreeableness > 70 && conscientiousness < 40) {
      return 'accommodating';
    } else if (agreeableness < 40 && extraversion > 60) {
      return 'competing';
    } else if (agreeableness < 40 && extraversion < 40) {
      return 'avoiding';
    }
    
    return 'compromising';
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const publicAssessmentAggregator = new PublicAssessmentAggregator();
