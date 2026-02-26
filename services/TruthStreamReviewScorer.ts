// ============================================================================
// TRUTHSTREAM REVIEW SCORER - Mirror-Server Service
// ============================================================================
// File: services/TruthStreamReviewScorer.ts
// Description: Calculates review quality scores locally and via Dina mirror module.
//              Manages reviewer quality aggregation and quality-gated features.
//
// Quality formula:
//   quality = (completeness * 0.3) + (depth * 0.4) + (constructiveness * 0.3)
//
// Completeness: % of questionnaire fields filled
// Depth: Free-form text length + explanation quality + categories addressed
// Constructiveness: criticism + tips + honest opinion with reasoning + actionable advice
// ============================================================================

import { DB } from '../db';
import { Logger } from '../utils/logger';

// ============================================================================
// TYPES
// ============================================================================

interface ReviewScoreResult {
  completenessScore: number;
  depthScore: number;
  qualityScore: number;
  breakdown: {
    fieldsCompleted: number;
    totalFields: number;
    freeFormLength: number;
    hasAdvice: boolean;
    hasCriticism: boolean;
    hasTipsForOvercoming: boolean;
    timeAdequate: boolean;
  };
}

interface QuestionnaireSection {
  id: string;
  title: string;
  required: boolean;
  questions: Array<{
    id: string;
    type: string;
    text: string;
    config: Record<string, any>;
  }>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MIN_REVIEW_TIME_SECONDS = parseInt(process.env.TRUTHSTREAM_MIN_REVIEW_TIME || '45', 10);
const QUALITY_WEIGHT_COMPLETENESS = parseFloat(process.env.TRUTHSTREAM_QUALITY_WEIGHT_COMPLETENESS || '0.3');
const QUALITY_WEIGHT_DEPTH = parseFloat(process.env.TRUTHSTREAM_QUALITY_WEIGHT_DEPTH || '0.4');
const QUALITY_WEIGHT_CONSTRUCTIVENESS = parseFloat(process.env.TRUTHSTREAM_QUALITY_WEIGHT_CONSTRUCTIVENESS || '0.3');
const REVIEWER_QUALITY_WINDOW = 50; // Rolling average of last N reviews

// ============================================================================
// REVIEW SCORER CLASS
// ============================================================================

export class TruthStreamReviewScorer {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('TruthStreamReviewScorer');
  }

  // ==========================================================================
  // LOCAL QUALITY SCORING (fast, no LLM)
  // ==========================================================================

  /**
   * Calculate review quality scores locally.
   * Used immediately at submission time — no network call needed.
   */
  scoreReview(
    responses: Record<string, any>,
    questionnaireSections: QuestionnaireSection[],
    timeSpentSeconds: number
  ): ReviewScoreResult {
    // ---- Completeness Score ----
    let totalFields = 0;
    let filledFields = 0;

    for (const section of questionnaireSections) {
      for (const question of section.questions || []) {
        totalFields++;
        const sectionResp = responses[section.id];
        if (sectionResp && sectionResp[question.id] !== undefined && sectionResp[question.id] !== null) {
          const answer = sectionResp[question.id];
          if (typeof answer === 'string' && answer.trim().length === 0) continue;
          if (typeof answer === 'object' && answer !== null && 'score' in answer && answer.score === null) continue;
          filledFields++;
        }
      }
    }

    const completenessScore = totalFields > 0 ? filledFields / totalFields : 0;

    // ---- Depth Score ----
    let totalTextLength = 0;
    let explanationCount = 0;
    let explanationsWithSubstance = 0;

    for (const section of questionnaireSections) {
      const sectionResp = responses[section.id];
      if (!sectionResp) continue;

      for (const question of section.questions || []) {
        const answer = sectionResp[question.id];
        if (!answer) continue;

        if (question.type === 'free_text' || question.type === 'category_explain') {
          explanationCount++;
          const text = typeof answer === 'string' ? answer : (answer?.explanation || answer?.text || '');
          if (typeof text === 'string') {
            totalTextLength += text.length;
            if (text.length >= 30) explanationsWithSubstance++;
          }
        }
      }
    }

    // Extract free-form text
    const freeFormText = responses.free_form?.open_reflection || '';
    if (typeof freeFormText === 'string') {
      totalTextLength += freeFormText.length;
    }

    const textDepth = Math.min(totalTextLength / 2000, 1.0);
    const explanationDepth = explanationCount > 0
      ? explanationsWithSubstance / explanationCount
      : 0;
    const depthScore = (textDepth * 0.6) + (explanationDepth * 0.4);

    // ---- Constructiveness Score ----
    let constructiveness = 0;
    const responseText = JSON.stringify(responses).toLowerCase();

    const hasCriticism = this.containsCriticism(responseText);
    const hasTips = this.containsTips(responseText);
    const hasAdvice = this.containsAdvice(responseText);
    const timeAdequate = timeSpentSeconds >= MIN_REVIEW_TIME_SECONDS;

    if (hasCriticism && hasTips) constructiveness += 0.3;
    if (hasAdvice) constructiveness += 0.3;
    if (typeof freeFormText === 'string' && freeFormText.length >= 100) constructiveness += 0.2;
    if (timeAdequate) constructiveness += 0.2;

    constructiveness = Math.min(constructiveness, 1.0);

    // ---- Combined Quality ----
    const qualityScore = Math.round(
      ((completenessScore * QUALITY_WEIGHT_COMPLETENESS) +
       (depthScore * QUALITY_WEIGHT_DEPTH) +
       (constructiveness * QUALITY_WEIGHT_CONSTRUCTIVENESS)) * 100
    ) / 100;

    return {
      completenessScore: Math.round(completenessScore * 100) / 100,
      depthScore: Math.round(depthScore * 100) / 100,
      qualityScore,
      breakdown: {
        fieldsCompleted: filledFields,
        totalFields,
        freeFormLength: totalTextLength,
        hasAdvice,
        hasCriticism,
        hasTipsForOvercoming: hasTips,
        timeAdequate,
      },
    };
  }

  // ==========================================================================
  // REVIEWER QUALITY AGGREGATION
  // ==========================================================================

  /**
   * Update a reviewer's aggregate quality score based on their recent reviews.
   * Uses a rolling average of the last N reviews.
   */
  async updateReviewerQualityScore(reviewerId: number): Promise<number> {
    try {
      const [rows] = await DB.query(
        `SELECT quality_score FROM truth_stream_reviews
         WHERE reviewer_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [reviewerId, REVIEWER_QUALITY_WINDOW]
      ) as any[];

      if (!rows || rows.length === 0) return 0.5;

      const avgQuality = rows.reduce((sum: number, r: any) => sum + (r.quality_score || 0), 0) / rows.length;
      const roundedAvg = Math.round(avgQuality * 100) / 100;

      // Update the profile
      await DB.query(
        `UPDATE truth_stream_profiles
         SET review_quality_score = ?
         WHERE user_id = ?`,
        [roundedAvg, reviewerId]
      );

      this.logger.debug('Updated reviewer quality score', {
        reviewerId,
        newScore: roundedAvg,
        reviewCount: rows.length,
      });

      return roundedAvg;
    } catch (error: any) {
      this.logger.error('Failed to update reviewer quality score', {
        reviewerId,
        error: error.message,
      });
      return 0.5; // Default on error
    }
  }

  // ==========================================================================
  // VALIDATION
  // ==========================================================================

  /**
   * Validate that review responses match the expected questionnaire structure.
   * Returns array of validation errors (empty = valid).
   */
  validateResponses(
    responses: Record<string, any>,
    questionnaireSections: QuestionnaireSection[]
  ): string[] {
    const errors: string[] = [];

    if (!responses || typeof responses !== 'object') {
      errors.push('Responses must be a non-null object');
      return errors;
    }

    for (const section of questionnaireSections) {
      if (!section.required) continue;

      const sectionResp = responses[section.id];
      if (!sectionResp || typeof sectionResp !== 'object') {
        errors.push(`Missing required section: ${section.title} (${section.id})`);
        continue;
      }

      for (const question of section.questions || []) {
        const answer = sectionResp[question.id];

        // Check required questions have answers
        if (answer === undefined || answer === null) {
          // Only flag if section is required
          if (section.required) {
            // Allow individual questions to be optional
            continue;
          }
        }

        // Type-specific validation
        if (answer !== undefined && answer !== null) {
          switch (question.type) {
            case 'scale': {
              const score = typeof answer === 'object' ? answer.score : answer;
              if (typeof score === 'number') {
                const min = question.config?.min || 1;
                const max = question.config?.max || 10;
                if (score < min || score > max) {
                  errors.push(`${section.id}.${question.id}: Score must be between ${min} and ${max}`);
                }
              }
              break;
            }
            case 'select_words': {
              const words = Array.isArray(answer) ? answer : [];
              const min = question.config?.min || 1;
              const max = question.config?.max || 5;
              if (words.length < min || words.length > max) {
                errors.push(`${section.id}.${question.id}: Select ${min}-${max} words (got ${words.length})`);
              }
              break;
            }
            case 'free_text': {
              const text = typeof answer === 'string' ? answer : '';
              const maxLen = question.config?.maxLength || 5000;
              if (text.length > maxLen) {
                errors.push(`${section.id}.${question.id}: Text exceeds maximum length of ${maxLen}`);
              }
              break;
            }
            case 'multi_choice': {
              const options = question.config?.options || [];
              if (typeof answer === 'string' && options.length > 0 && !options.includes(answer)) {
                errors.push(`${section.id}.${question.id}: Invalid option selected`);
              }
              break;
            }
          }
        }
      }
    }

    return errors;
  }

  /**
   * Extract the free-form text from review responses for quick access.
   */
  extractFreeFormText(responses: Record<string, any>): string {
    const freeForm = responses?.free_form;
    if (!freeForm) return '';
    return typeof freeForm.open_reflection === 'string' ? freeForm.open_reflection : '';
  }

  /**
   * Extract the self-tagged tone from review responses.
   */
  extractSelfTaggedTone(responses: Record<string, any>): string | undefined {
    return responses?.free_form?.self_tagged_tone || undefined;
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private containsCriticism(text: string): boolean {
    const keywords = [
      'struggle', 'weakness', 'improve', 'growth', 'blind spot',
      'concern', 'issue', 'challenge', 'difficult', 'lack',
      'missing', 'needs work', 'could be better', 'not great',
    ];
    return keywords.some(kw => text.includes(kw));
  }

  private containsTips(text: string): boolean {
    const keywords = [
      'try', 'suggest', 'recommend', 'consider', 'advice',
      'tip', 'should', 'could try', 'practice', 'work on',
      'focus on', 'start', 'develop', 'build', 'learn',
    ];
    return keywords.some(kw => text.includes(kw));
  }

  private containsAdvice(text: string): boolean {
    const keywords = [
      'advice', 'recommend', 'suggest', 'should', 'could',
      'would help', 'try to', 'consider', 'practice',
    ];
    const matchCount = keywords.filter(kw => text.includes(kw)).length;
    return matchCount >= 2;
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const truthStreamReviewScorer = new TruthStreamReviewScorer();
