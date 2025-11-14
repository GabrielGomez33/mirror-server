// ============================================================================
// GROUP DATA EXTRACTOR - PHASE 2
// ============================================================================
// File: /var/www/mirror-server/services/GroupDataExtractor.ts
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
        data = fullProfile.personality || null;
        break;

      case 'cognitive':
        data = fullProfile.cognitive || null;
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
        data = fullProfile;
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
