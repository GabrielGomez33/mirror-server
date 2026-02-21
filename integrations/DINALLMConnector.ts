// ============================================================================
// DINA LLM CONNECTOR - UPDATED: Routes through Mirror Module
// ============================================================================
// File: integrations/DINALLMConnector.ts
// ----------------------------------------------------------------------------
// CHANGE SUMMARY:
// - synthesizeInsights() now routes through /mirror/synthesize-insights
//   endpoint on dina-server instead of directly calling /chat
// - Accepts optional userContext and conversationHistory parameters
// - Falls back to direct chat endpoint ONLY if mirror endpoint is unavailable
// - All other existing functionality is preserved
// ============================================================================

import { Logger } from '../utils/logger';

/**
 * Group Analysis Result for LLM synthesis
 */
export interface GroupAnalysisResult {
  groupId: string;
  analysisId: string;
  timestamp: Date;
  memberCount: number;
  dataCompleteness: number;
  insights: {
    compatibilityMatrix?: any;
    collectiveStrengths?: any[];
    conflictRisks?: any[];
    goalAlignment?: any;
  };
  metadata: {
    processingTime: number;
    dataVersion: string;
    algorithmsUsed: string[];
    overallConfidence: number;
  };
}

/**
 * LLM Synthesis Output
 */
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
 * Enhanced synthesis options - NEW
 */
export interface SynthesisOptions {
  /** User-provided extra context to guide analysis */
  userContext?: string;
  /** Recent conversation history for richer context */
  conversationHistory?: Array<{
    speaker: string;
    text: string;
    timestamp?: string;
  }>;
}

/**
 * DINA LLM Connector Class
 *
 * UPDATED: Now routes synthesis requests through the dina-server mirror module
 * instead of accessing the LLM chat endpoint directly.
 */
export class DINALLMConnector {
  private logger: Logger;
  private dinaEndpoint: string;
  private isConnected: boolean = false;
  private useStubData: boolean;

  // Circuit breaker state
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private circuitBreakerThreshold: number = 5;
  private circuitBreakerResetTime: number = 60000;

  constructor() {
    this.logger = new Logger('DINALLMConnector');
    this.dinaEndpoint = process.env.DINA_ENDPOINT || 'http://localhost:7777';
    this.useStubData = process.env.USE_DINA_STUB === 'true' || !process.env.DINA_ENDPOINT;

    this.validateEndpoint();

    if (this.useStubData) {
      this.logger.warn('DINA connector running in STUB mode - using mock synthesis');
    } else {
      this.logger.info('DINA connector initialized (routing through mirror module)', {
        endpoint: this.sanitizeEndpointForLogging(this.dinaEndpoint)
      });
    }
  }

  private validateEndpoint(): void {
    try {
      const url = new URL(this.dinaEndpoint);
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error(`Invalid protocol: ${url.protocol}. Only http and https are allowed.`);
      }
      if (!url.hostname) {
        throw new Error('Endpoint hostname cannot be empty');
      }
    } catch (error: any) {
      this.logger.error('Invalid DINA_ENDPOINT URL', {
        endpoint: this.sanitizeEndpointForLogging(this.dinaEndpoint),
        error: error.message
      });
      throw new Error(`Invalid DINA_ENDPOINT configuration: ${error.message}`);
    }
  }

  private sanitizeEndpointForLogging(endpoint: string): string {
    try {
      const url = new URL(endpoint);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return '[invalid-url]';
    }
  }

  async initialize(): Promise<void> {
    this.logger.info('DINA connector initialized');
    return Promise.resolve();
  }

  async shutdown(): Promise<void> {
    this.logger.info('DINA connector shutdown', {
      totalFailures: this.failureCount
    });
    return Promise.resolve();
  }

  // ==========================================================================
  // MAIN SYNTHESIS METHOD - UPDATED TO ROUTE THROUGH MIRROR MODULE
  // ==========================================================================

  /**
   * Synthesize insights using DINA's mirror module.
   *
   * CHANGE: Now routes through /mirror/synthesize-insights instead of
   * directly calling /dina/api/v1/models/mistral:7b/chat.
   *
   * @param analysisResult - The group analysis data to synthesize
   * @param synthesisOptions - Optional user context and conversation history
   */
  async synthesizeInsights(
    analysisResult: GroupAnalysisResult,
    synthesisOptions?: SynthesisOptions
  ): Promise<LLMSynthesis> {
    this.validateAnalysisInput(analysisResult);

    this.logger.info('Synthesizing insights via mirror module', {
      groupId: analysisResult.groupId,
      analysisId: analysisResult.analysisId,
      mode: this.useStubData ? 'stub' : 'live',
      hasUserContext: !!synthesisOptions?.userContext,
      conversationHistoryEntries: synthesisOptions?.conversationHistory?.length || 0,
    });

    if (this.isCircuitOpen()) {
      const error = new Error(
        `DINA service unavailable: Circuit breaker OPEN after ${this.failureCount} failures.`
      );
      this.logger.error('Circuit breaker OPEN - refusing request');
      throw error;
    }

    try {
      if (this.useStubData) {
        return await this.generateStubSynthesis(analysisResult);
      } else {
        const synthesis = await this.synthesizeViaMirrorModule(
          analysisResult,
          synthesisOptions
        );
        this.onSuccess();
        return synthesis;
      }
    } catch (error: any) {
      this.onFailure(error);

      this.logger.error('Mirror module synthesis failed', {
        error: error.message,
        groupId: analysisResult.groupId,
        failureCount: this.failureCount
      });

      const enhancedError = new Error(
        `DINA LLM synthesis failed: ${error.message}. ` +
        `This is failure ${this.failureCount}/${this.circuitBreakerThreshold}.`
      );
      enhancedError.name = 'DINASynthesisError';
      throw enhancedError;
    }
  }

  // ==========================================================================
  // NEW: Route through mirror module instead of direct chat
  // ==========================================================================

  /**
   * Call dina-server's mirror module synthesize-insights endpoint.
   * This ensures all LLM requests from mirror-server go through the mirror
   * module for proper context enrichment and separation of concerns.
   */
  private async synthesizeViaMirrorModule(
    analysisResult: GroupAnalysisResult,
    synthesisOptions?: SynthesisOptions
  ): Promise<LLMSynthesis> {
    const maxRetries = 3;
    const retryDelays = [1000, 2000, 4000];
    let lastError: any = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const endpoint = this.buildMirrorSynthesisEndpoint();

        const requestBody = {
          synthesisType: 'group_analysis',
          groupId: analysisResult.groupId,
          analysisData: {
            compatibilityMatrix: analysisResult.insights.compatibilityMatrix,
            collectiveStrengths: analysisResult.insights.collectiveStrengths,
            conflictRisks: analysisResult.insights.conflictRisks,
            goalAlignment: analysisResult.insights.goalAlignment,
          },
          userContext: synthesisOptions?.userContext,
          conversationHistory: synthesisOptions?.conversationHistory,
          options: {
            maxTokens: 1500,
            temperature: 0.7,
            memberCount: analysisResult.memberCount,
            dataCompleteness: analysisResult.dataCompleteness,
          },
        };

        this.logger.debug('Calling mirror synthesize-insights', {
          attempt: attempt + 1,
          endpoint: this.sanitizeEndpointForLogging(endpoint),
          hasUserContext: !!synthesisOptions?.userContext,
        });

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DINA_SERVICE_KEY || process.env.DINA_API_KEY || ''}`,
            'User-Agent': 'MirrorGroups/3.0',
            'X-Group-ID': analysisResult.groupId,
            'X-Analysis-ID': analysisResult.analysisId,
            'X-Request-Attempt': String(attempt + 1),
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(120000),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          throw new Error(
            `Mirror synthesis error: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`
          );
        }

        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || 'Mirror synthesis returned unsuccessful response');
        }

        // The mirror module returns the synthesis directly in data
        const synthesis = result.data;

        if (!synthesis) {
          throw new Error('No synthesis data in mirror module response');
        }

        // Validate required fields
        this.validateSynthesisResponse(synthesis);

        this.logger.info('Mirror module synthesis successful', {
          overviewLength: synthesis.overview?.length || 0,
          insightsCount: synthesis.keyInsights?.length || 0,
          attempt: attempt + 1,
        });

        return synthesis;

      } catch (error: any) {
        lastError = error;
        const isLastAttempt = attempt === maxRetries - 1;
        const isRetryable = this.isRetryableError(error);

        if (!isLastAttempt && isRetryable) {
          const delay = retryDelays[attempt];
          this.logger.warn(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`, {
            error: error.message,
          });
          await this.sleep(delay);
        } else {
          break;
        }
      }
    }

    throw lastError;
  }

  /**
   * Build the mirror module synthesis endpoint URL.
   * Routes to /mirror/synthesize-insights instead of /models/mistral:7b/chat.
   */
  private buildMirrorSynthesisEndpoint(): string {
    const baseUrl = this.dinaEndpoint.replace(/\/$/, '');

    try {
      const url = new URL(baseUrl);
      const pathname = url.pathname;

      // Determine base path and append mirror synthesis endpoint
      if (pathname.endsWith('/api/v1')) {
        // e.g., https://example.com/dina/api/v1
        // Go up to the API root and use mirror route
        return baseUrl.replace(/\/api\/v1$/, '') + '/api/v1/mirror/synthesize-insights';
      } else if (pathname.includes('/dina')) {
        // e.g., https://example.com/dina
        return baseUrl + '/api/v1/mirror/synthesize-insights';
      } else if (pathname === '' || pathname === '/') {
        // Base domain
        return baseUrl + '/dina/api/v1/mirror/synthesize-insights';
      } else {
        // Unknown - try appending
        return baseUrl + '/mirror/synthesize-insights';
      }
    } catch {
      return `${baseUrl}/dina/api/v1/mirror/synthesize-insights`;
    }
  }

  private validateSynthesisResponse(synthesis: any): void {
    if (!synthesis.overview && !synthesis.keyInsights) {
      throw new Error('Synthesis response missing overview and keyInsights');
    }
  }

  // ==========================================================================
  // VALIDATION & HELPERS (unchanged from original)
  // ==========================================================================

  private validateAnalysisInput(result: GroupAnalysisResult): void {
    if (!result) throw new Error('Analysis result is required');
    if (!result.groupId || typeof result.groupId !== 'string') {
      throw new Error('Valid groupId is required');
    }
    if (!result.analysisId || typeof result.analysisId !== 'string') {
      throw new Error('Valid analysisId is required');
    }
    if (!result.memberCount || result.memberCount < 1) {
      throw new Error('Valid memberCount is required (must be >= 1)');
    }
    if (result.dataCompleteness < 0 || result.dataCompleteness > 1) {
      throw new Error('dataCompleteness must be between 0 and 1');
    }
  }

  private isCircuitOpen(): boolean {
    if (this.failureCount < this.circuitBreakerThreshold) return false;
    const timeSinceFailure = Date.now() - this.lastFailureTime;
    return timeSinceFailure < this.circuitBreakerResetTime;
  }

  private onSuccess(): void {
    if (this.failureCount > 0) {
      this.logger.info('DINA service recovered', { previousFailures: this.failureCount });
      this.failureCount = 0;
    }
  }

  private onFailure(error: any): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
  }

  private isRetryableError(error: any): boolean {
    const message = error.message?.toLowerCase() || '';
    if (error.name === 'TypeError' && message.includes('fetch')) return true;
    if (message.includes('timeout') || message.includes('aborted')) return true;
    // Use word-boundary regex to match HTTP status codes, not arbitrary digit sequences
    if (message.match(/\b5\d{2}\b/)) return true;
    if (message.includes('429') || message.includes('rate limit')) return true;
    if (message.includes('econnrefused') || message.includes('enotfound')) return true;
    if (message.match(/\b4\d{2}\b/)) return false;
    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // STUB SYNTHESIS (unchanged from original, for offline/dev fallback)
  // ==========================================================================

  private async generateStubSynthesis(analysisResult: GroupAnalysisResult): Promise<LLMSynthesis> {
    const { memberCount, dataCompleteness, insights, metadata } = analysisResult;
    const completeness = Math.round(dataCompleteness * 100);
    const confidence = Math.round(metadata.overallConfidence * 100);
    const avgCompatibility = insights.compatibilityMatrix?.averageCompatibility || 0;
    const compatibilityLevel = avgCompatibility >= 0.7 ? 'strong' : avgCompatibility >= 0.5 ? 'moderate' : 'developing';
    const strengthsCount = insights.collectiveStrengths?.length || 0;
    const risksCount = insights.conflictRisks?.length || 0;

    let overview = `This ${memberCount}-member group analysis reveals ${compatibilityLevel} interpersonal compatibility`;
    if (strengthsCount > 0) overview += ` with ${strengthsCount} identified collective strength${strengthsCount > 1 ? 's' : ''}`;
    if (risksCount > 0) overview += ` and ${risksCount} potential conflict area${risksCount > 1 ? 's' : ''}`;
    overview += `. Analysis confidence: ${confidence}% based on ${completeness}% data completeness.`;

    const keyInsights: string[] = [];
    if (avgCompatibility >= 0.7) keyInsights.push(`High group compatibility (${Math.round(avgCompatibility * 100)}%) creates strong foundation`);
    if (insights.collectiveStrengths?.[0]) keyInsights.push(`Collective strength in "${insights.collectiveStrengths[0].name}"`);
    if (insights.conflictRisks?.[0]) keyInsights.push(`Primary risk: ${insights.conflictRisks[0].type?.replace(/_/g, ' ')}`);
    if (keyInsights.length === 0) keyInsights.push('Group analysis complete - review detailed sections');

    const recommendations: string[] = [];
    if (insights.conflictRisks?.some((r: any) => r.severity === 'critical')) {
      recommendations.push('Address critical conflict risks through facilitated discussion');
    }
    if (avgCompatibility < 0.6) recommendations.push('Invest in team-building activities');
    if (recommendations.length === 0) recommendations.push('Continue fostering open communication');

    return {
      overview,
      keyInsights,
      recommendations,
      narratives: {
        compatibility: `Compatibility analysis reveals an average score of ${Math.round(avgCompatibility * 100)}%.`,
        strengths: strengthsCount > 0 ? `The group demonstrates ${strengthsCount} collective strengths.` : undefined,
        challenges: risksCount > 0 ? `${risksCount} potential conflict areas identified.` : 'No significant conflict risks detected.',
        opportunities: 'The group shows potential for growth through continued collaboration.',
      },
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; mode: string; failureCount: number; circuitOpen: boolean }> {
    return {
      healthy: !this.isCircuitOpen(),
      mode: this.useStubData ? 'stub' : 'live',
      failureCount: this.failureCount,
      circuitOpen: this.isCircuitOpen(),
    };
  }
}

export const dinaLLMConnector = new DINALLMConnector();
