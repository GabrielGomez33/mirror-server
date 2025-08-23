// utils/intakeValidation.ts
// Validation and processing utilities for hybrid intake data
// Designed for the hybrid approach with file references + structured metadata

import crypto from 'crypto';

// ============================================================================
// TYPE DEFINITIONS FOR HYBRID INTAKE DATA
// ============================================================================

export type TierType = 'tier1' | 'tier2' | 'tier3';

export interface FileReference {
  filename: string;
  tier: TierType;
  size: number;
  mimetype: string;
  uploadedAt: string;
  originalname?: string;
}

export interface VoiceFileReference extends FileReference {
  duration: number;
  deviceInfo?: {
    isMobile: boolean;
    platform: string;
    browser: string;
  };
}

export interface HybridIntakeData {
  userLoggedIn: boolean;
  name: string;

  // File references (from multipart uploads)
  photoFileRef?: FileReference;
  voiceFileRef?: VoiceFileReference;

  // Structured data
  faceAnalysis?: {
    detection: {
      _imageDims: { _width: number; _height: number };
      _score: number;
      _classScore: number;
      _className: string;
      _box: { _x: number; _y: number; _width: number; _height: number };
    };
    landmarks: {
      _imgDims: { _width: number; _height: number };
      _shift: { _x: number; _y: number };
      _positions: Array<{ _x: number; _y: number }>;
    };
    unshiftedLandmarks: {
      _imgDims: { _width: number; _height: number };
      _shift: { _x: number; _y: number };
      _positions: Array<{ _x: number; _y: number }>;
    };
    alignedRect: {
      _imageDims: { _width: number; _height: number };
      _score: number;
      _classScore: number;
      _className: string;
      _box: { _x: number; _y: number; _width: number; _height: number };
    };
    angle: { roll: number; pitch: number; yaw: number };
    expressions: {
      neutral: number;
      happy: number;
      sad: number;
      angry: number;
      fearful: number;
      disgusted: number;
      surprised: number;
      // If you extend with more keys at runtime, we'll normalize via Record<string, number>
      // but the base schema is above.
    };
  };

  progress?: {
    lastStep: string;
    completed: boolean;
    steps: Record<string, { completed: boolean; data: any }>;
  };

  voiceMetadata?: {
    mimeType: string;
    duration: number;
    size: number;
    deviceInfo: {
      isMobile: boolean;
      platform: string;
      browser: string;
    };
  };

  iqResults?: {
    rawScore: number;
    totalQuestions: number;
    iqScore: number;
    category: string;
    strengths: string[];
    description: string;
  };
  iqAnswers?: Record<string, string>;

  astrologicalResult?: {
    western: {
      sunSign: string;
      moonSign: string;
      risingSign: string;
      houses: Record<string, string>;
      planetaryPlacements: Record<string, string>;
      dominantElement: string;
      modality: string;
      chartRuler: string;
    };
    chinese: {
      animalSign: string;
      element: string;
      yinYang: string;
      innerAnimal: string;
      secretAnimal: string;
      luckyNumbers: number[];
      luckyColors: string[];
      personality: string[];
      compatibility: string[];
      lifePhase: string;
    };
    african: {
      orishaGuardian: string;
      ancestralSpirit: string;
      elementalForce: string;
      sacredAnimal: string;
      lifeDestiny: string;
      spiritualGifts: string[];
      challenges: string[];
      ceremonies: string[];
      seasons: string;
    };
    numerology: {
      lifePathNumber: number;
      destinyNumber: number;
      soulUrgeNumber: number;
      personalityNumber: number;
      birthDayNumber: number;
      meanings: Record<string, string>;
    };
    synthesis: {
      coreThemes: string[];
      lifeDirection: string;
      spiritualPath: string;
      relationships: string;
      career: string;
      wellness: string;
    };
  };

  personalityResult?: {
    big5Profile: {
      openness: number;
      conscientiousness: number;
      extraversion: number;
      agreeableness: number;
      neuroticism: number;
    };
    mbtiType: string;
    dominantTraits: string[];
    description: string;
  };
  personalityAnswers?: Record<
    string,
    {
      text: string;
      value: string;
      score: number;
    }
  >;
}

// ============================================================================
// VALIDATION FUNCTIONS FOR HYBRID APPROACH
// ============================================================================

export class IntakeDataValidator {
  /**
   * Validate the complete hybrid intake data structure
   */
  static validateIntakeData(
    data: any
  ): { isValid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields validation
    if (!('userLoggedIn' in data)) {
      errors.push('userLoggedIn field is required');
    }

    if (!data.name || typeof data.name !== 'string' || data.name.trim().length === 0) {
      errors.push('name field is required and must be a non-empty string');
    }

    // File reference validation (optional but recommended)
    if (data.photoFileRef) {
      const photoErrors = this.validateFileReference(data.photoFileRef, 'photo');
      errors.push(...photoErrors);
    } else {
      warnings.push('Photo file reference is missing - visual analysis features will be limited');
    }

    if (data.voiceFileRef) {
      const voiceErrors = this.validateFileReference(data.voiceFileRef, 'voice');
      errors.push(...voiceErrors);
    } else {
      warnings.push('Voice file reference is missing - audio analysis features will be limited');
    }

    // Face analysis validation (separate from photo file)
    if (data.faceAnalysis) {
      const faceErrors = this.validateFaceAnalysis(data.faceAnalysis);
      errors.push(...faceErrors);
    } else if (data.photoFileRef) {
      warnings.push('Face analysis data is missing despite having photo file reference');
    } else {
      warnings.push('Face analysis data is missing - biometric features will be limited');
    }

    // Voice metadata validation (separate from voice file)
    if (data.voiceMetadata) {
      const voiceErrors = this.validateVoiceMetadata(data.voiceMetadata);
      errors.push(...voiceErrors);
    } else if (data.voiceFileRef) {
      warnings.push('Voice metadata is missing despite having voice file reference');
    } else {
      warnings.push('Voice metadata is missing - voice analysis features will be limited');
    }

    // IQ results validation
    if (data.iqResults) {
      const iqErrors = this.validateIqResults(data.iqResults);
      errors.push(...iqErrors);
    } else {
      errors.push('IQ results are required');
    }

    // Personality results validation
    if (data.personalityResult) {
      const personalityErrors = this.validatePersonalityResult(data.personalityResult);
      errors.push(...personalityErrors);
    } else {
      errors.push('Personality results are required');
    }

    // Astrological results validation
    if (data.astrologicalResult) {
      const astroErrors = this.validateAstrologicalResult(data.astrologicalResult);
      errors.push(...astroErrors);
    } else {
      errors.push('Astrological results are required');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate file reference structure
   */
  private static validateFileReference(fileRef: any, type: 'photo' | 'voice'): string[] {
    const errors: string[] = [];

    if (!fileRef.filename || typeof fileRef.filename !== 'string') {
      errors.push(`${type} file reference missing filename`);
    }

    if (!fileRef.tier || typeof fileRef.tier !== 'string') {
      errors.push(`${type} file reference missing tier`);
    }

    if (typeof fileRef.size !== 'number' || fileRef.size <= 0) {
      errors.push(`${type} file reference missing or invalid size`);
    }

    if (!fileRef.mimetype || typeof fileRef.mimetype !== 'string') {
      errors.push(`${type} file reference missing mimetype`);
    }

    if (!fileRef.uploadedAt || typeof fileRef.uploadedAt !== 'string') {
      errors.push(`${type} file reference missing uploadedAt timestamp`);
    }

    // Type-specific validation
    if (type === 'voice' && typeof fileRef.duration !== 'number') {
      errors.push('Voice file reference missing duration');
    }

    // Validate expected tiers (warnings)
    if (type === 'photo' && fileRef.tier !== 'tier1') {
      console.warn('Photo files should typically be in tier1');
    }
    if (type === 'voice' && fileRef.tier !== 'tier2') {
      console.warn('Voice files should typically be in tier2');
    }

    // Validate MIME types
    if (type === 'photo') {
      const validImageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
      if (!validImageTypes.includes(fileRef.mimetype)) {
        errors.push(`Invalid photo MIME type: ${fileRef.mimetype}`);
      }
    }

    if (type === 'voice') {
      const validAudioTypes = ['audio/webm', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg'];
      if (!validAudioTypes.includes(fileRef.mimetype)) {
        errors.push(`Invalid voice MIME type: ${fileRef.mimetype}`);
      }
    }

    return errors;
  }

  /**
   * Validate face analysis data structure
   */
  private static validateFaceAnalysis(faceAnalysis: any): string[] {
    const errors: string[] = [];

    // Check detection data
    if (!faceAnalysis.detection) {
      errors.push('Face detection data is missing');
    } else {
      if (
        typeof faceAnalysis.detection._score !== 'number' ||
        faceAnalysis.detection._score < 0 ||
        faceAnalysis.detection._score > 1
      ) {
        errors.push('Face detection score must be a number between 0 and 1');
      }
    }

    // Check landmarks
    if (!faceAnalysis.landmarks || !Array.isArray(faceAnalysis.landmarks._positions)) {
      errors.push('Face landmarks data is missing or invalid');
    } else if (faceAnalysis.landmarks._positions.length < 68) {
      console.warn('Face landmarks appear incomplete (expected 68+ points)');
    }

    // Check expressions
    if (!faceAnalysis.expressions) {
      errors.push('Facial expressions data is missing');
    } else {
      const requiredExpressions = [
        'neutral',
        'happy',
        'sad',
        'angry',
        'fearful',
        'disgusted',
        'surprised',
      ] as const;

      for (const expr of requiredExpressions) {
        const v = faceAnalysis.expressions[expr];
        if (typeof v !== 'number' || v < 0 || v > 1) {
          errors.push(`Expression ${expr} must be a number between 0 and 1`);
        }
      }
    }

    return errors;
  }

  /**
   * Validate voice metadata structure
   */
  private static validateVoiceMetadata(voiceMetadata: any): string[] {
    const errors: string[] = [];

    if (typeof voiceMetadata.duration !== 'number' || voiceMetadata.duration < 0) {
      errors.push('Voice duration must be a positive number');
    }

    if (typeof voiceMetadata.size !== 'number' || voiceMetadata.size < 0) {
      errors.push('Voice file size must be a positive number');
    }

    if (!voiceMetadata.mimeType || typeof voiceMetadata.mimeType !== 'string') {
      errors.push('Voice mimeType is required');
    }

    if (!voiceMetadata.deviceInfo) {
      errors.push('Voice device info is missing');
    }

    return errors;
  }

  /**
   * Validate IQ results structure
   */
  private static validateIqResults(iqResults: any): string[] {
    const errors: string[] = [];

    if (typeof iqResults.rawScore !== 'number' || iqResults.rawScore < 0) {
      errors.push('IQ raw score must be a positive number');
    }

    if (typeof iqResults.totalQuestions !== 'number' || iqResults.totalQuestions <= 0) {
      errors.push('IQ total questions must be a positive number');
    }

    if (
      typeof iqResults.iqScore !== 'number' ||
      iqResults.iqScore < 0 ||
      iqResults.iqScore > 200
    ) {
      errors.push('IQ score must be a number between 0 and 200');
    }

    if (!iqResults.category || typeof iqResults.category !== 'string') {
      errors.push('IQ category is required');
    }

    if (!Array.isArray(iqResults.strengths)) {
      errors.push('IQ strengths must be an array');
    }

    return errors;
  }

  /**
   * Validate personality results structure
   */
  private static validatePersonalityResult(personalityResult: any): string[] {
    const errors: string[] = [];

    if (!personalityResult.big5Profile) {
      errors.push('Big Five profile is missing');
    } else {
      const big5Traits = [
        'openness',
        'conscientiousness',
        'extraversion',
        'agreeableness',
        'neuroticism',
      ] as const;
      for (const trait of big5Traits) {
        const v = personalityResult.big5Profile[trait];
        if (typeof v !== 'number' || v < 0 || v > 100) {
          errors.push(`Big Five ${trait} must be a number between 0 and 100`);
        }
      }
    }

    if (
      !personalityResult.mbtiType ||
      typeof personalityResult.mbtiType !== 'string' ||
      personalityResult.mbtiType.length !== 4
    ) {
      errors.push('MBTI type must be a 4-character string');
    }

    if (!Array.isArray(personalityResult.dominantTraits)) {
      errors.push('Dominant traits must be an array');
    }

    return errors;
  }

  /**
   * Validate astrological results structure
   */
  private static validateAstrologicalResult(astrologicalResult: any): string[] {
    const errors: string[] = [];

    // Validate Western astrology
    if (!astrologicalResult.western) {
      errors.push('Western astrology data is missing');
    } else {
      if (!astrologicalResult.western.sunSign) errors.push('Sun sign is missing');
      if (!astrologicalResult.western.moonSign) errors.push('Moon sign is missing');
      if (!astrologicalResult.western.risingSign) errors.push('Rising sign is missing');
    }

    // Validate Chinese astrology
    if (!astrologicalResult.chinese) {
      errors.push('Chinese astrology data is missing');
    } else {
      if (!astrologicalResult.chinese.animalSign) errors.push('Chinese animal sign is missing');
      if (!astrologicalResult.chinese.element) errors.push('Chinese element is missing');
    }

    // Validate numerology
    if (!astrologicalResult.numerology) {
      errors.push('Numerology data is missing');
    } else {
      if (typeof astrologicalResult.numerology.lifePathNumber !== 'number') {
        errors.push('Life path number must be a number');
      }
    }

    return errors;
  }

  /**
   * Sanitize and normalize hybrid intake data
   */
  static sanitizeIntakeData(data: any): HybridIntakeData {
    // Deep clone to avoid modifying original
    const sanitized: HybridIntakeData = JSON.parse(JSON.stringify(data));

    // Normalize name
    if (sanitized.name) {
      sanitized.name = sanitized.name.toString().trim();
    }

    // Ensure boolean values are proper booleans
    sanitized.userLoggedIn = Boolean(sanitized.userLoggedIn);

    // Normalize file references
    if (sanitized.photoFileRef) {
      sanitized.photoFileRef.size = Number(sanitized.photoFileRef.size) || 0;
      sanitized.photoFileRef.filename = String(sanitized.photoFileRef.filename).trim();
      sanitized.photoFileRef.tier = String(
        sanitized.photoFileRef.tier || ''
      ).toLowerCase() as TierType;
    }

    if (sanitized.voiceFileRef) {
      sanitized.voiceFileRef.size = Number(sanitized.voiceFileRef.size) || 0;
      sanitized.voiceFileRef.duration = Number(sanitized.voiceFileRef.duration) || 0;
      sanitized.voiceFileRef.filename = String(sanitized.voiceFileRef.filename).trim();
      sanitized.voiceFileRef.tier = String(
        sanitized.voiceFileRef.tier || ''
      ).toLowerCase() as TierType;
    }

    // Normalize expression scores to [0,1]
    if (sanitized.faceAnalysis?.expressions) {
      const exprs = sanitized.faceAnalysis.expressions as unknown as Record<string, number>;
      for (const [emotion, score] of Object.entries(exprs)) {
        const numScore = Number(score);
        if (!Number.isNaN(numScore)) {
          exprs[emotion] = Math.max(0, Math.min(1, numScore));
        }
      }
      // write back (helps TS narrowing)
      (sanitized.faceAnalysis.expressions as unknown as Record<string, number>) = exprs;
    }

    // Normalize Big Five scores to [0,100]
    if (sanitized.personalityResult?.big5Profile) {
      const big5 = sanitized.personalityResult.big5Profile as unknown as Record<string, number>;
      for (const [trait, score] of Object.entries(big5)) {
        const numScore = Number(score);
        if (!Number.isNaN(numScore)) {
          big5[trait] = Math.max(0, Math.min(100, numScore));
        }
      }
      (sanitized.personalityResult.big5Profile as unknown as Record<string, number>) = big5;
    }

    return sanitized;
  }

  /**
   * Generate data quality report for hybrid structure
   */
  static generateDataQualityReport(data: any): {
    overallQuality: 'excellent' | 'good' | 'fair' | 'poor';
    completeness: number;
    qualityMetrics: Record<string, any>;
    recommendations: string[];
  } {
    const metrics: Record<string, any> = {};
    const recommendations: string[] = [];
    let totalComponents = 0;
    let completedComponents = 0;

    // Check each component with appropriate weights
    const components = [
      { name: 'photoFileRef', data: data.photoFileRef, weight: 1 },
      { name: 'voiceFileRef', data: data.voiceFileRef, weight: 1 },
      { name: 'faceAnalysis', data: data.faceAnalysis, weight: 2 },
      { name: 'voiceMetadata', data: data.voiceMetadata, weight: 1 },
      { name: 'iqResults', data: data.iqResults, weight: 3 },
      { name: 'personalityResult', data: data.personalityResult, weight: 3 },
      { name: 'astrologicalResult', data: data.astrologicalResult, weight: 2 },
    ] as const;

    for (const component of components) {
      totalComponents += component.weight;
      if (component.data) {
        completedComponents += component.weight;
        metrics[component.name] = 'present';
      } else {
        metrics[component.name] = 'missing';
        recommendations.push(`Consider completing ${component.name} for better insights`);
      }
    }

    const completeness = (completedComponents / totalComponents) * 100;

    let overallQuality: 'excellent' | 'good' | 'fair' | 'poor';
    if (completeness >= 90) overallQuality = 'excellent';
    else if (completeness >= 75) overallQuality = 'good';
    else if (completeness >= 50) overallQuality = 'fair';
    else overallQuality = 'poor';

    // Add specific recommendations based on missing data
    if (!data.photoFileRef) {
      recommendations.push('Upload a photo for enhanced biometric profiling and face analysis');
    }
    if (!data.voiceFileRef) {
      recommendations.push('Upload a voice recording for complete multimodal assessment');
    }
    if (!data.faceAnalysis && data.photoFileRef) {
      recommendations.push('Face analysis appears incomplete despite having a photo');
    }
    if (!data.voiceMetadata && data.voiceFileRef) {
      recommendations.push('Voice analysis metadata is missing despite having a voice file');
    }

    // Consistency checks
    if (data.photoFileRef && data.faceAnalysis) {
      metrics.photoAnalysisConsistency = 'good';
    } else if (data.photoFileRef && !data.faceAnalysis) {
      metrics.photoAnalysisConsistency = 'missing_analysis';
      recommendations.push('Photo uploaded but face analysis not completed');
    } else if (!data.photoFileRef && data.faceAnalysis) {
      metrics.photoAnalysisConsistency = 'orphaned_analysis';
      recommendations.push('Face analysis present but no photo file reference found');
    }

    if (data.voiceFileRef && data.voiceMetadata) {
      metrics.voiceAnalysisConsistency = 'good';
    } else if (data.voiceFileRef && !data.voiceMetadata) {
      metrics.voiceAnalysisConsistency = 'missing_metadata';
      recommendations.push('Voice uploaded but metadata analysis not completed');
    } else if (!data.voiceFileRef && data.voiceMetadata) {
      metrics.voiceAnalysisConsistency = 'orphaned_metadata';
      recommendations.push('Voice metadata present but no voice file reference found');
    }

    return {
      overallQuality,
      completeness: Math.round(completeness),
      qualityMetrics: metrics,
      recommendations,
    };
  }

  /**
   * Calculate data fingerprint for integrity checking
   */
  static calculateDataFingerprint(data: any): string {
    // Create a deterministic representation of the data
    const sortedData = this.sortObjectKeysRecursively(data);
    const dataString = JSON.stringify(sortedData);
    return crypto.createHash('sha256').update(dataString).digest('hex');
  }

  /**
   * Recursively sort object keys for deterministic hashing
   */
  private static sortObjectKeysRecursively(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.sortObjectKeysRecursively(item));
    }

    const sortedKeys = Object.keys(obj).sort();
    const sortedObj: Record<string, any> = {};

    for (const key of sortedKeys) {
      sortedObj[key] = this.sortObjectKeysRecursively(obj[key]);
    }

    return sortedObj;
  }

  /**
   * Extract sensitive data summary for logging (without exposing actual data)
   */
  static createDataSummary(data: any): Record<string, any> {
    return {
      hasUserData: Boolean(data.name),
      hasPhotoFile: Boolean(data.photoFileRef),
      hasVoiceFile: Boolean(data.voiceFileRef),
      hasFaceAnalysis: Boolean(data.faceAnalysis),
      hasVoiceMetadata: Boolean(data.voiceMetadata),
      hasIqResults: Boolean(data.iqResults),
      hasPersonalityData: Boolean(data.personalityResult),
      hasAstrologicalData: Boolean(data.astrologicalResult),

      // File details (if available)
      photoSize: data.photoFileRef?.size || 0,
      photoType: data.photoFileRef?.mimetype || null,
      photoTier: data.photoFileRef?.tier || null,
      voiceSize: data.voiceFileRef?.size || 0,
      voiceType: data.voiceFileRef?.mimetype || null,
      voiceTier: data.voiceFileRef?.tier || null,
      voiceDuration: data.voiceFileRef?.duration || data.voiceMetadata?.duration || 0,

      // Analysis details
      faceAnalysisLandmarkCount: data.faceAnalysis?.landmarks?._positions?.length || 0,
      iqScore: data.iqResults?.iqScore || null,
      mbtiType: data.personalityResult?.mbtiType || null,
      westSunSign: data.astrologicalResult?.western?.sunSign || null,

      // Consistency checks
      photoAnalysisConsistent: Boolean(data.photoFileRef) === Boolean(data.faceAnalysis),
      voiceAnalysisConsistent: Boolean(data.voiceFileRef) === Boolean(data.voiceMetadata),

      dataFingerprint: this.calculateDataFingerprint(data).substring(0, 8), // First 8 chars for identification
    };
  }

  /**
   * Convert legacy intake data to hybrid format
   */
  static convertLegacyToHybrid(
    legacyData: any,
    uploadedFiles?: {
      photoFileRef?: FileReference;
      voiceFileRef?: VoiceFileReference;
    }
  ): HybridIntakeData {
    const hybridData: Partial<HybridIntakeData> = {
      userLoggedIn: legacyData.userLoggedIn || false,
      name: legacyData.name || '',

      // Add file references if provided
      photoFileRef: uploadedFiles?.photoFileRef,
      voiceFileRef: uploadedFiles?.voiceFileRef,

      // Copy structured data as-is
      faceAnalysis: legacyData.faceAnalysis,
      voiceMetadata: legacyData.voiceMetadata,
      progress: legacyData.progress,
      iqResults: legacyData.iqResults,
      iqAnswers: legacyData.iqAnswers,
      astrologicalResult: legacyData.astrologicalResult,
      personalityResult: legacyData.personalityResult,
      personalityAnswers: legacyData.personalityAnswers,
    };

    return hybridData as HybridIntakeData;
  }

  /**
   * Validate file reference consistency with metadata
   */
  static validateFileConsistency(
    data: HybridIntakeData
  ): { isConsistent: boolean; issues: string[] } {
    const issues: string[] = [];

    // Check photo/face analysis consistency
    if (data.photoFileRef && !data.faceAnalysis) {
      issues.push('Photo file uploaded but face analysis missing');
    }
    if (!data.photoFileRef && data.faceAnalysis) {
      issues.push('Face analysis present but photo file reference missing');
    }

    // Check voice/metadata consistency
    if (data.voiceFileRef && !data.voiceMetadata) {
      issues.push('Voice file uploaded but voice metadata missing');
    }
    if (!data.voiceFileRef && data.voiceMetadata) {
      issues.push('Voice metadata present but no voice file reference found');
    }

    // Check duration consistency (1 second tolerance)
    if (data.voiceFileRef && data.voiceMetadata) {
      const fileDuration = data.voiceFileRef.duration;
      const metaDuration = data.voiceMetadata.duration;
      if (Math.abs(fileDuration - metaDuration) > 1000) {
        issues.push(`Voice duration mismatch: file=${fileDuration}ms, metadata=${metaDuration}ms`);
      }
    }

    // Check size consistency (1KB tolerance)
    if (data.voiceFileRef && data.voiceMetadata) {
      const fileSize = data.voiceFileRef.size;
      const metaSize = data.voiceMetadata.size;
      if (Math.abs(fileSize - metaSize) > 1024) {
        issues.push(`Voice size mismatch: file=${fileSize}bytes, metadata=${metaSize}bytes`);
      }
    }

    return {
      isConsistent: issues.length === 0,
      issues,
    };
  }
}
