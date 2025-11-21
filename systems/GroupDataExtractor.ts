// ============================================================================
// GROUP DATA EXTRACTOR - PHASE 2
// ============================================================================
// File: systems/GroupDataExtractor.ts
// ----------------------------------------------------------------------------
// Facade/wrapper for extracting and preparing Mirror assessment data for
// group sharing. Uses PublicAssessmentAggregator under the hood.
// ============================================================================

import { publicAssessmentAggregator } from '../managers/PublicAssessmentAggregator';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Supported data types for group sharing
 */
export type ShareableDataType =
  | 'personality'    // Big Five, MBTI, traits
  | 'cognitive'      // IQ scores, cognitive patterns
  | 'facial'         // Facial analysis, emotional spectrum
  | 'voice'          // Voice patterns, communication style
  | 'astrological'   // Sun/moon signs, astrology data
  | 'full_profile';  // Everything combined

/**
 * Structure of shareable data for a specific type
 */
export interface ShareableData {
  userId: number;
  dataType: ShareableDataType;
  data: any;
  timestamp: string;
  dataVersion: string;
}

/**
 * Result of data extraction
 */
export interface ExtractionResult {
  success: boolean;
  data?: ShareableData[];
  error?: string;
  cached?: boolean;
}

/**
 * Options for data extraction
 */
export interface ExtractionOptions {
  userId: number;
  dataTypes: ShareableDataType[];
  includeTimestamp?: boolean;
}

// ============================================================================
// GROUP DATA EXTRACTOR CLASS
// ============================================================================

export class GroupDataExtractor {
  /**
   * Extract shareable data from user's Mirror assessments
   *
   * @param options - Extraction options including userId and data types
   * @returns ExtractionResult with success status and data
   *
   * @example
   * ```typescript
   * const result = await extractor.extractData({
   *   userId: 48,
   *   dataTypes: ['personality', 'cognitive']
   * });
   * ```
   */
  async extractData(options: ExtractionOptions): Promise<ExtractionResult> {
    try {
      const { userId, dataTypes, includeTimestamp = true } = options;

      console.log(`📦 Extracting data for user ${userId}: ${dataTypes.join(', ')}`);

      // 1. Get aggregated assessment data
      const aggregationResult = await publicAssessmentAggregator.aggregateForUser(userId);

      if (!aggregationResult.success || !aggregationResult.data) {
        return {
          success: false,
          error: 'No assessment data available. Please complete your Mirror assessments first.'
        };
      }

      const fullProfile = aggregationResult.data;
      const timestamp = includeTimestamp ? new Date().toISOString() : undefined;

      // 2. Extract requested data types
      const extractedData: ShareableData[] = [];

      for (const dataType of dataTypes) {
        const shareableData = this.extractDataType(
          userId,
          dataType,
          fullProfile,
          timestamp || new Date().toISOString()
        );

        if (shareableData.data) {
          extractedData.push(shareableData);
        } else {
          console.warn(`⚠️ No ${dataType} data available for user ${userId}`);
        }
      }

      if (extractedData.length === 0) {
        return {
          success: false,
          error: `No data available for requested types: ${dataTypes.join(', ')}`
        };
      }

      console.log(`✅ Extracted ${extractedData.length} data types for user ${userId}`);

      return {
        success: true,
        data: extractedData,
        cached: aggregationResult.cached
      };

    } catch (error) {
      console.error(`❌ Failed to extract data:`, error);
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * Extract a specific data type from the full profile
   *
   * @param userId - User ID
   * @param dataType - Type of data to extract
   * @param fullProfile - Complete user profile from aggregator
   * @param timestamp - Timestamp for the extraction
   * @returns ShareableData object
   *
   * @private
   */
  private extractDataType(
    userId: number,
    dataType: ShareableDataType,
    fullProfile: any,
    timestamp: string
  ): ShareableData {
    let data: any = null;

    switch (dataType) {
      case 'personality':
        // Transform PublicProfile format to MemberData format
        data = this.transformPersonalityData(fullProfile);
        break;

      case 'cognitive':
        // Transform PublicProfile format to MemberData format
        data = this.transformCognitiveData(fullProfile);
        break;

      case 'facial':
        data = fullProfile.emotional || null;
        break;

      case 'voice':
        data = fullProfile.communication || null;
        break;

      case 'astrological':
        data = fullProfile.astrology || null;
        break;

      case 'full_profile':
        // Transform entire profile with all sections mapped correctly
        data = this.transformFullProfile(fullProfile);
        break;

      default:
        console.warn(`Unknown data type: ${dataType}`);
        data = null;
    }

    return {
      userId,
      dataType,
      data,
      timestamp,
      dataVersion: '2.0'
    };
  }

  /**
   * Transform PublicProfile personality data to MemberData personality format
   */
  private transformPersonalityData(fullProfile: any): any {
    const personality = fullProfile.personality || {};
    const collaboration = fullProfile.collaboration || {};
    const communication = fullProfile.communication || {};
    const bigFive = personality.bigFive || {};

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
      interpersonalStyle: personality.mbti || 'unknown',
      communicationStyle: communication.style || 'balanced',
      conflictResolutionStyle: collaboration.conflictStyle || 'compromising'
    };
  }

  /**
   * Transform PublicProfile cognitive data to MemberData cognitive format
   */
  private transformCognitiveData(fullProfile: any): any {
    const cognitive = fullProfile.cognitive || {};
    const personality = fullProfile.personality || {};
    const bigFive = personality.bigFive || {};

    // Infer cognitive styles from Big Five and IQ data
    const problemSolvingStyle = this.inferProblemSolvingStyle(bigFive, cognitive);
    const decisionMakingStyle = this.inferDecisionMakingStyle(bigFive);
    const learningStyle = this.inferLearningStyle(bigFive);

    return {
      iqScore: cognitive.iqScore,
      category: cognitive.category,
      strengths: cognitive.strengths || [],
      problemSolvingStyle,
      decisionMakingStyle,
      learningStyle
    };
  }

  /**
   * Transform full profile with all sections properly mapped
   */
  private transformFullProfile(fullProfile: any): any {
    const personality = fullProfile.personality || {};
    const collaboration = fullProfile.collaboration || {};
    const bigFive = personality.bigFive || {};

    return {
      personality: this.transformPersonalityData(fullProfile),
      cognitive: this.transformCognitiveData(fullProfile),
      behavioral: {
        tendencies: [],
        socialEnergy: (bigFive.extraversion || 50) / 100,
        empathyLevel: this.parseEmpathyLevel(collaboration.empathyLevel)
      },
      values: {
        core: personality.dominantTraits || [],
        motivationDrivers: this.inferMotivationDrivers(bigFive)
      }
    };
  }

  /**
   * Infer problem-solving style from Big Five traits
   */
  private inferProblemSolvingStyle(bigFive: any, cognitive: any): string {
    const openness = bigFive.openness || 50;
    const conscientiousness = bigFive.conscientiousness || 50;

    if (openness > 65 && conscientiousness > 65) return 'analytical-creative';
    if (openness > 65) return 'intuitive';
    if (conscientiousness > 65) return 'systematic';
    return 'practical';
  }

  /**
   * Infer decision-making style from Big Five traits
   */
  private inferDecisionMakingStyle(bigFive: any): string {
    const neuroticism = bigFive.neuroticism || 50;
    const conscientiousness = bigFive.conscientiousness || 50;

    if (neuroticism < 40 && conscientiousness > 60) return 'decisive';
    if (neuroticism > 60) return 'cautious';
    if (conscientiousness > 60) return 'methodical';
    return 'balanced';
  }

  /**
   * Infer learning style from Big Five traits
   */
  private inferLearningStyle(bigFive: any): string {
    const openness = bigFive.openness || 50;
    const extraversion = bigFive.extraversion || 50;

    if (openness > 60 && extraversion > 60) return 'experiential';
    if (openness > 60) return 'theoretical';
    if (extraversion > 60) return 'collaborative';
    return 'structured';
  }

  /**
   * Parse empathy level to numeric 0-1 scale
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

  /**
   * Infer motivation drivers from Big Five traits
   */
  private inferMotivationDrivers(bigFive: any): Array<{ driver: string; strength: number }> {
    const drivers: Array<{ driver: string; strength: number }> = [];

    const openness = (bigFive.openness || 50) / 100;
    const conscientiousness = (bigFive.conscientiousness || 50) / 100;
    const extraversion = (bigFive.extraversion || 50) / 100;
    const agreeableness = (bigFive.agreeableness || 50) / 100;

    if (openness > 0.6) drivers.push({ driver: 'growth', strength: openness });
    if (conscientiousness > 0.6) drivers.push({ driver: 'achievement', strength: conscientiousness });
    if (extraversion > 0.6) drivers.push({ driver: 'connection', strength: extraversion });
    if (agreeableness > 0.6) drivers.push({ driver: 'contribution', strength: agreeableness });

    return drivers;
  }

  /**
   * Validate that a user has required data types before sharing
   *
   * @param userId - User ID to check
   * @param requiredTypes - Data types that must be present
   * @returns Object with validation result and missing types
   *
   * @example
   * ```typescript
   * const validation = await extractor.validateUserData(48, ['personality', 'cognitive']);
   * if (!validation.valid) {
   *   console.log('Missing:', validation.missingTypes);
   * }
   * ```
   */
  async validateUserData(
    userId: number,
    requiredTypes: ShareableDataType[]
  ): Promise<{ valid: boolean; missingTypes: ShareableDataType[] }> {
    try {
      const aggregationResult = await publicAssessmentAggregator.aggregateForUser(userId);

      if (!aggregationResult.success || !aggregationResult.data) {
        return {
          valid: false,
          missingTypes: requiredTypes
        };
      }

      const profile = aggregationResult.data;
      const missingTypes: ShareableDataType[] = [];

      for (const type of requiredTypes) {
        const hasData = this.hasDataForType(profile, type);
        if (!hasData) {
          missingTypes.push(type);
        }
      }

      return {
        valid: missingTypes.length === 0,
        missingTypes
      };

    } catch (error) {
      console.error(`❌ Validation failed:`, error);
      return {
        valid: false,
        missingTypes: requiredTypes
      };
    }
  }

  /**
   * Check if profile has data for a specific type
   *
   * @param profile - User profile
   * @param dataType - Data type to check
   * @returns true if data exists
   *
   * @private
   */
  private hasDataForType(profile: any, dataType: ShareableDataType): boolean {
    switch (dataType) {
      case 'personality':
        return !!profile.personality && Object.keys(profile.personality).length > 0;

      case 'cognitive':
        return !!profile.cognitive;

      case 'facial':
        return !!profile.emotional;

      case 'voice':
        return !!profile.communication;

      case 'astrological':
        return !!profile.astrology;

      case 'full_profile':
        return true; // Always available if we have a profile

      default:
        return false;
    }
  }

  /**
   * Get a summary of available data types for a user
   *
   * @param userId - User ID to check
   * @returns Object with available and unavailable data types
   *
   * @example
   * ```typescript
   * const summary = await extractor.getDataSummary(48);
   * console.log('Available:', summary.available);
   * console.log('Unavailable:', summary.unavailable);
   * ```
   */
  async getDataSummary(userId: number): Promise<{
    success: boolean;
    available: ShareableDataType[];
    unavailable: ShareableDataType[];
    details?: any;
  }> {
    try {
      const aggregationResult = await publicAssessmentAggregator.aggregateForUser(userId);

      if (!aggregationResult.success || !aggregationResult.data) {
        return {
          success: false,
          available: [],
          unavailable: ['personality', 'cognitive', 'facial', 'voice', 'astrological', 'full_profile']
        };
      }

      const profile = aggregationResult.data;
      const allTypes: ShareableDataType[] = [
        'personality',
        'cognitive',
        'facial',
        'voice',
        'astrological',
        'full_profile'
      ];

      const available: ShareableDataType[] = [];
      const unavailable: ShareableDataType[] = [];

      for (const type of allTypes) {
        if (this.hasDataForType(profile, type)) {
          available.push(type);
        } else {
          unavailable.push(type);
        }
      }

      return {
        success: true,
        available,
        unavailable,
        details: {
          hasPersonality: !!profile.personality,
          hasCognitive: !!profile.cognitive,
          hasEmotional: !!profile.emotional,
          hasCommunication: !!profile.communication,
          hasAstrology: !!profile.astrology
        }
      };

    } catch (error) {
      console.error(`❌ Failed to get data summary:`, error);
      return {
        success: false,
        available: [],
        unavailable: ['personality', 'cognitive', 'facial', 'voice', 'astrological', 'full_profile']
      };
    }
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const groupDataExtractor = new GroupDataExtractor();
