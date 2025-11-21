// ============================================================================
// DINA LLM CONNECTOR - Production Implementation
// ============================================================================
// File: integrations/DINALLMConnector.ts
// ----------------------------------------------------------------------------
// Production-ready DINA integration with robust error handling, security,
// retry logic, and intelligent fallback to stub synthesis
// ============================================================================

import { Logger } from '../utils/logger';

/**
 * DINA Universal Messaging Protocol (DUMP) Message Structure
 */
export interface DUMPMessage {
  version: string;
  type: 'request' | 'response' | 'event';
  id: string;
  timestamp: string;
  payload: any;
  metadata?: {
    sender?: string;
    recipient?: string;
    priority?: number;
  };
}

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
 * DINA LLM Connector Class
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
  private circuitBreakerResetTime: number = 60000; // 60 seconds

  constructor() {
    this.logger = new Logger('DINALLMConnector');
    this.dinaEndpoint = process.env.DINA_ENDPOINT || 'http://localhost:7777';
    this.useStubData = process.env.USE_DINA_STUB === 'true' || !process.env.DINA_ENDPOINT;

    // Validate and sanitize endpoint
    this.validateEndpoint();

    if (this.useStubData) {
      this.logger.warn('DINA connector running in STUB mode - using mock synthesis');
    } else {
      this.logger.info('DINA connector initialized', {
        endpoint: this.dinaEndpoint,
        endpointSanitized: this.sanitizeEndpointForLogging(this.dinaEndpoint)
      });
    }
  }

  /**
   * Validate endpoint URL for security
   */
  private validateEndpoint(): void {
    try {
      const url = new URL(this.dinaEndpoint);

      // Security: Only allow http and https protocols
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error(`Invalid protocol: ${url.protocol}. Only http and https are allowed.`);
      }

      // Security: Warn if using localhost in production
      if (process.env.NODE_ENV === 'production' &&
          (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
        this.logger.warn('Using localhost endpoint in production environment', {
          hostname: url.hostname
        });
      }

      // Security: Validate hostname is not empty
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

  /**
   * Sanitize endpoint for logging (remove sensitive info)
   */
  private sanitizeEndpointForLogging(endpoint: string): string {
    try {
      const url = new URL(endpoint);
      // Remove any auth credentials from URL before logging
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return '[invalid-url]';
    }
  }

  /**
   * Initialize (stub for compatibility with server startup)
   */
  async initialize(): Promise<void> {
    this.logger.info('DINA connector initialized');
    return Promise.resolve();
  }

  /**
   * Shutdown (stub for compatibility with server shutdown)
   */
  async shutdown(): Promise<void> {
    this.logger.info('DINA connector shutdown', {
      totalFailures: this.failureCount
    });
    return Promise.resolve();
  }

  /**
   * Synthesize insights using DINA LLM
   * Throws errors on failure - no stub fallback
   */
  async synthesizeInsights(
    analysisResult: GroupAnalysisResult
  ): Promise<LLMSynthesis> {
    // Input validation
    this.validateAnalysisInput(analysisResult);

    this.logger.info('Synthesizing insights', {
      groupId: analysisResult.groupId,
      analysisId: analysisResult.analysisId,
      mode: this.useStubData ? 'stub' : 'live',
      memberCount: analysisResult.memberCount
    });

    // Check circuit breaker
    if (this.isCircuitOpen()) {
      const error = new Error(
        `DINA service unavailable: Circuit breaker OPEN after ${this.failureCount} failures. ` +
        `Will retry in ${Math.ceil((this.circuitBreakerResetTime - (Date.now() - this.lastFailureTime)) / 1000)}s`
      );
      this.logger.error('Circuit breaker OPEN - refusing request', {
        failureCount: this.failureCount,
        timeSinceLastFailure: Date.now() - this.lastFailureTime,
        resetTime: this.circuitBreakerResetTime
      });
      throw error;
    }

    try {
      if (this.useStubData) {
        return await this.generateStubSynthesis(analysisResult);
      } else {
        const synthesis = await this.synthesizeWithDINA(analysisResult);
        this.onSuccess();
        return synthesis;
      }
    } catch (error: any) {
      this.onFailure(error);

      this.logger.error('DINA synthesis failed - throwing error', {
        error: error.message,
        errorType: error.name,
        errorStack: error.stack?.split('\n').slice(0, 3).join('\n'),
        groupId: analysisResult.groupId,
        analysisId: analysisResult.analysisId,
        failureCount: this.failureCount
      });

      // Rethrow with additional context
      const enhancedError = new Error(
        `DINA LLM synthesis failed: ${error.message}. ` +
        `This is failure ${this.failureCount}/${this.circuitBreakerThreshold}. ` +
        `Check DINA server connectivity and response format.`
      );
      enhancedError.name = 'DINASynthesisError';
      enhancedError.stack = error.stack;

      throw enhancedError;
    }
  }

  /**
   * Validate analysis input
   */
  private validateAnalysisInput(result: GroupAnalysisResult): void {
    if (!result) {
      throw new Error('Analysis result is required');
    }
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

  /**
   * Circuit breaker: check if circuit is open
   */
  private isCircuitOpen(): boolean {
    if (this.failureCount < this.circuitBreakerThreshold) {
      return false;
    }

    const timeSinceFailure = Date.now() - this.lastFailureTime;
    if (timeSinceFailure >= this.circuitBreakerResetTime) {
      this.logger.info('Circuit breaker reset time elapsed - attempting recovery');
      return false;
    }

    return true;
  }

  /**
   * Circuit breaker: handle successful request
   */
  private onSuccess(): void {
    if (this.failureCount > 0) {
      this.logger.info('DINA service recovered', {
        previousFailures: this.failureCount
      });
      this.failureCount = 0;
    }
  }

  /**
   * Circuit breaker: handle failed request
   */
  private onFailure(error: any): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.circuitBreakerThreshold) {
      this.logger.error('Circuit breaker threshold reached - circuit OPEN', {
        failureCount: this.failureCount,
        threshold: this.circuitBreakerThreshold,
        error: error.message
      });
    }
  }

  /**
   * Synthesize insights by calling DINA server
   * Uses DINA's native API format (query + options)
   */
  private async synthesizeWithDINA(
    analysisResult: GroupAnalysisResult
  ): Promise<LLMSynthesis> {
    this.logger.info('Requesting synthesis from DINA', {
      groupId: analysisResult.groupId,
      analysisId: analysisResult.analysisId,
      protocol: 'DINA-API'
    });

    const maxRetries = 3;
    const retryDelays = [1000, 2000, 4000]; // Exponential backoff: 1s, 2s, 4s
    let lastError: any = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Prepare analysis summary for LLM
        const analysisContext = this.buildAnalysisContext(analysisResult);

        // Build combined prompt (DINA uses single query field)
        const systemPrompt = 'You are an expert group dynamics analyst. Provide clear, actionable insights about group compatibility, strengths, challenges, and opportunities. Format all responses as valid JSON.';

        const userPrompt = `Analyze this ${analysisResult.memberCount}-member group and provide insights.

${analysisContext}

Respond with JSON in this exact format:
{
  "overview": "2-3 sentence summary",
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "recommendations": ["recommendation 1", "recommendation 2"],
  "narratives": {
    "compatibility": "brief narrative",
    "strengths": "brief narrative",
    "challenges": "brief narrative",
    "opportunities": "brief narrative"
  }
}`;

        // DINA API format (from actual server logs)
        const chatRequest = {
          query: `${systemPrompt}\n\n${userPrompt}`,
          options: {
            max_tokens: 1500,
            temperature: 0.7
          }
        };

        // Construct endpoint with smart path handling
        const endpoint = this.buildEndpointURL();

        this.logger.debug('DINA request', {
          attempt: attempt + 1,
          maxRetries,
          baseUrl: this.sanitizeEndpointForLogging(this.dinaEndpoint),
          endpoint: this.sanitizeEndpointForLogging(endpoint),
          queryLength: chatRequest.query.length
        });

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'MirrorGroups/3.0',
            'X-Group-ID': analysisResult.groupId,
            'X-Analysis-ID': analysisResult.analysisId,
            'X-Request-Attempt': String(attempt + 1)
          },
          body: JSON.stringify(chatRequest),
          signal: AbortSignal.timeout(120000) // 120 second timeout
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');

          this.logger.error('DINA API error response', {
            status: response.status,
            statusText: response.statusText,
            errorPreview: errorText.substring(0, 500),
            endpoint: this.sanitizeEndpointForLogging(endpoint),
            attempt: attempt + 1
          });

          throw new Error(`DINA server error: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();

        this.logger.debug('DINA response received', {
          hasResponse: !!result.response,
          hasContent: !!result.content,
          hasChoices: !!result.choices,
          resultKeys: Object.keys(result).join(', ')
        });

        // Extract content from DINA response format (response field is primary)
        let content = result.response                         // DINA format (primary)
          || result.choices?.[0]?.message?.content            // OpenAI format (fallback)
          || result.content                                   // Direct content (fallback)
          || result.message?.content;                         // Another variant (fallback)

        if (!content) {
          this.logger.error('No content field found in DINA response', {
            resultKeys: Object.keys(result).join(', '),
            hasResponse: !!result.response,
            hasChoices: !!result.choices,
            hasContent: !!result.content,
            hasMessage: !!result.message,
            resultStructure: JSON.stringify(result).substring(0, 500)
          });
          throw new Error(
            `No content field found in DINA response. ` +
            `Available fields: ${Object.keys(result).join(', ')}. ` +
            `Check DINA server response format.`
          );
        }

        this.logger.debug('Extracted content from DINA response', {
          contentType: typeof content,
          contentLength: typeof content === 'string' ? content.length : 'N/A',
          sourceField: result.response ? 'response' : result.choices ? 'choices' : result.content ? 'content' : 'message',
          contentPreview: typeof content === 'string' ? content.substring(0, 200) : JSON.stringify(content).substring(0, 200)
        });

        // Parse JSON response
        const synthesis = this.parseDINAResponse(content);

        this.logger.info('DINA synthesis successful', {
          overviewLength: synthesis.overview?.length || 0,
          insightsCount: synthesis.keyInsights?.length || 0,
          recommendationsCount: synthesis.recommendations?.length || 0,
          attempt: attempt + 1
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
            errorType: error.name,
            isRetryable
          });

          await this.sleep(delay);
        } else {
          if (!isRetryable) {
            this.logger.error('Non-retryable error - aborting retries', {
              error: error.message,
              errorType: error.name
            });
          }
          break;
        }
      }
    }

    // All retries failed
    this.logger.error(`All ${maxRetries} retry attempts failed`, {
      lastError: lastError?.message
    });

    throw lastError;
  }

  /**
   * Build complete endpoint URL with robust path handling
   * Handles various endpoint formats without duplicating paths
   */
  private buildEndpointURL(): string {
    const baseUrl = this.dinaEndpoint.replace(/\/$/, ''); // Remove trailing slash

    let endpoint: string;

    // Parse URL to safely extract components
    try {
      const url = new URL(baseUrl);
      const pathname = url.pathname;

      // Case 1: Already a complete chat endpoint
      // e.g., https://example.com/dina/api/v1/models/mistral:7b/chat
      if (pathname.endsWith('/chat')) {
        endpoint = baseUrl;
        this.logger.debug('Endpoint already complete (ends with /chat)', {
          endpoint: this.sanitizeEndpointForLogging(endpoint)
        });
      }
      // Case 2: Contains model specification without /chat
      // e.g., https://example.com/dina/api/v1/models/mistral:7b
      else if (pathname.match(/\/models\/[^\/]+$/)) {
        endpoint = `${baseUrl}/chat`;
        this.logger.debug('Appending /chat to model endpoint', {
          endpoint: this.sanitizeEndpointForLogging(endpoint)
        });
      }
      // Case 3: Ends with /api/v1 (user's case)
      // e.g., https://www.theundergroundrailroad.world/dina/api/v1
      else if (pathname.endsWith('/api/v1')) {
        endpoint = `${baseUrl}/models/mistral:7b/chat`;
        this.logger.debug('Appending model path to API base', {
          endpoint: this.sanitizeEndpointForLogging(endpoint)
        });
      }
      // Case 4: Ends with /dina or contains /dina/ but not full path
      // e.g., https://example.com/dina
      else if (pathname.endsWith('/dina') || pathname.includes('/dina')) {
        endpoint = `${baseUrl}/api/v1/models/mistral:7b/chat`;
        this.logger.debug('Appending API path to DINA base', {
          endpoint: this.sanitizeEndpointForLogging(endpoint)
        });
      }
      // Case 5: Base domain only
      // e.g., https://example.com
      else if (pathname === '' || pathname === '/') {
        endpoint = `${baseUrl}/dina/api/v1/models/mistral:7b/chat`;
        this.logger.debug('Appending full path to base domain', {
          endpoint: this.sanitizeEndpointForLogging(endpoint)
        });
      }
      // Case 6: Unknown format - append full path but log warning
      else {
        endpoint = `${baseUrl}/dina/api/v1/models/mistral:7b/chat`;
        this.logger.warn('Unknown endpoint format - using default path construction', {
          originalPath: pathname,
          endpoint: this.sanitizeEndpointForLogging(endpoint)
        });
      }

      // Validate final endpoint
      new URL(endpoint);

      return endpoint;

    } catch (error: any) {
      this.logger.error('Failed to construct valid endpoint URL', {
        baseUrl: this.sanitizeEndpointForLogging(baseUrl),
        error: error.message
      });
      throw new Error(`Invalid endpoint URL construction: ${error.message}`);
    }
  }

  /**
   * Parse DINA response content into LLMSynthesis
   */
  private parseDINAResponse(content: any): LLMSynthesis {
    let synthesis: LLMSynthesis;

    try {
      if (typeof content === 'string') {
        // Remove leading/trailing whitespace (DINA often adds a leading space)
        let cleanContent = content.trim();

        // Try to extract JSON from markdown code blocks if present
        const jsonMatch = cleanContent.match(/```json\s*([\s\S]*?)\s*```/) || cleanContent.match(/```\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          cleanContent = jsonMatch[1].trim();
        }

        this.logger.debug('Parsing DINA response', {
          originalLength: content.length,
          cleanedLength: cleanContent.length,
          startsWithBrace: cleanContent.startsWith('{'),
          preview: cleanContent.substring(0, 100)
        });

        synthesis = JSON.parse(cleanContent);
      } else {
        synthesis = content;
      }

      // Validate required fields
      const missingFields: string[] = [];
      if (!synthesis.overview) missingFields.push('overview');
      if (!synthesis.keyInsights || !Array.isArray(synthesis.keyInsights)) missingFields.push('keyInsights');
      if (!synthesis.recommendations || !Array.isArray(synthesis.recommendations)) missingFields.push('recommendations');
      if (!synthesis.narratives || typeof synthesis.narratives !== 'object') missingFields.push('narratives');

      if (missingFields.length > 0) {
        this.logger.error('Synthesis missing required fields', {
          missingFields,
          hasOverview: !!synthesis.overview,
          hasInsights: !!synthesis.keyInsights,
          hasRecommendations: !!synthesis.recommendations,
          hasNarratives: !!synthesis.narratives,
          synthesisStructure: Object.keys(synthesis || {}).join(', ')
        });
        throw new Error(`Missing required fields in synthesis: ${missingFields.join(', ')}`);
      }

      this.logger.debug('Synthesis parsed successfully', {
        overviewLength: synthesis.overview.length,
        insightsCount: synthesis.keyInsights.length,
        recommendationsCount: synthesis.recommendations.length,
        narrativeKeys: Object.keys(synthesis.narratives).join(', ')
      });

      return synthesis;

    } catch (parseError: any) {
      this.logger.error('Failed to parse DINA response as JSON', {
        error: parseError.message,
        contentType: typeof content,
        contentLength: typeof content === 'string' ? content.length : 'N/A',
        contentPreview: typeof content === 'string' ? content.substring(0, 300) : JSON.stringify(content).substring(0, 300),
        startsWithSpace: typeof content === 'string' && content.startsWith(' '),
        firstChar: typeof content === 'string' ? `"${content[0]}" (code: ${content.charCodeAt(0)})` : 'N/A'
      });

      // Don't fallback - throw error
      throw new Error(
        `Failed to parse DINA response: ${parseError.message}. ` +
        `Content type: ${typeof content}, Length: ${typeof content === 'string' ? content.length : 'N/A'}. ` +
        `Preview: ${typeof content === 'string' ? content.substring(0, 100) : JSON.stringify(content).substring(0, 100)}`
      );
    }
  }

  /**
   * Determine if error is retryable
   */
  private isRetryableError(error: any): boolean {
    const message = error.message?.toLowerCase() || '';

    // Network errors are retryable
    if (error.name === 'TypeError' && message.includes('fetch')) {
      return true;
    }

    // Timeout errors are retryable
    if (message.includes('timeout') || message.includes('aborted')) {
      return true;
    }

    // 5xx server errors are retryable
    if (message.match(/5[0-9][0-9]/)) {
      return true;
    }

    // 429 rate limit is retryable
    if (message.includes('429') || message.includes('rate limit')) {
      return true;
    }

    // 503 service unavailable is retryable
    if (message.includes('503') || message.includes('unavailable')) {
      return true;
    }

    // 4xx client errors (except 429) are generally not retryable
    if (message.match(/4[0-9][0-9]/)) {
      return false;
    }

    // Connection errors are retryable
    if (message.includes('econnrefused') || message.includes('enotfound') ||
        message.includes('econnreset') || message.includes('etimedout')) {
      return true;
    }

    // Unknown errors - retry by default for resilience
    return true;
  }

  /**
   * Build analysis context string for LLM
   */
  private buildAnalysisContext(result: GroupAnalysisResult): string {
    const parts: string[] = [];

    parts.push(`Group Size: ${result.memberCount} members`);
    parts.push(`Data Completeness: ${Math.round(result.dataCompleteness * 100)}%`);

    // Compatibility
    if (result.insights.compatibilityMatrix) {
      const avg = result.insights.compatibilityMatrix.averageCompatibility;
      const level = avg >= 0.7 ? 'strong' : avg >= 0.5 ? 'moderate' : 'developing';
      parts.push(`Compatibility: ${Math.round(avg * 100)}% average (${level})`);
    }

    // Strengths
    if (result.insights.collectiveStrengths && result.insights.collectiveStrengths.length > 0) {
      const strengthNames = result.insights.collectiveStrengths
        .slice(0, 3)
        .map((s: any) => s.name)
        .join(', ');
      parts.push(`Collective Strengths: ${strengthNames}`);
    }

    // Risks
    if (result.insights.conflictRisks && result.insights.conflictRisks.length > 0) {
      const riskSummary = result.insights.conflictRisks
        .slice(0, 3)
        .map((r: any) => `${r.type.replace(/_/g, ' ')} (${r.severity})`)
        .join(', ');
      parts.push(`Conflict Risks: ${riskSummary}`);
    }

    // Goal alignment
    if (result.insights.goalAlignment) {
      parts.push(`Goal Alignment: ${Math.round((result.insights.goalAlignment.overallAlignment || 0) * 100)}%`);
    }

    return parts.join('\n');
  }

  /**
   * Sleep helper for retries
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Generate intelligent stub synthesis based on analysis results
   * Production-quality fallback when DINA is offline
   */
  private async generateStubSynthesis(
    analysisResult: GroupAnalysisResult
  ): Promise<LLMSynthesis> {
    const { memberCount, dataCompleteness, insights } = analysisResult;

    this.logger.debug('Generating intelligent stub synthesis', {
      groupId: analysisResult.groupId,
      memberCount,
      dataCompleteness: Math.round(dataCompleteness * 100)
    });

    // Generate context-aware overview
    const overview = this.generateOverview(analysisResult);
    const keyInsights = this.generateKeyInsights(analysisResult);
    const recommendations = this.generateRecommendations(analysisResult);
    const narratives = this.generateNarratives(analysisResult);

    this.logger.debug('Generated stub synthesis', {
      overviewLength: overview.length,
      insightsCount: keyInsights.length,
      recommendationsCount: recommendations.length
    });

    return {
      overview,
      keyInsights,
      recommendations,
      narratives
    };
  }

  /**
   * Generate contextual overview
   */
  private generateOverview(result: GroupAnalysisResult): string {
    const { memberCount, dataCompleteness, insights, metadata } = result;
    const completeness = Math.round(dataCompleteness * 100);
    const confidence = Math.round(metadata.overallConfidence * 100);

    const avgCompatibility = insights.compatibilityMatrix?.averageCompatibility || 0;
    const compatibilityLevel = avgCompatibility >= 0.7 ? 'strong' : avgCompatibility >= 0.5 ? 'moderate' : 'developing';

    const strengthsCount = insights.collectiveStrengths?.length || 0;
    const risksCount = insights.conflictRisks?.length || 0;
    const criticalRisks = insights.conflictRisks?.filter((r: any) => r.severity === 'critical').length || 0;

    let overview = `This ${memberCount}-member group analysis reveals ${compatibilityLevel} interpersonal compatibility`;

    if (strengthsCount > 0) {
      overview += ` with ${strengthsCount} identified collective strength${strengthsCount > 1 ? 's' : ''}`;
    }

    if (risksCount > 0) {
      overview += ` and ${risksCount} potential conflict area${risksCount > 1 ? 's' : ''}`;
      if (criticalRisks > 0) {
        overview += ` (${criticalRisks} requiring immediate attention)`;
      }
    } else {
      overview += ' and healthy group dynamics with no significant conflict risks detected';
    }

    overview += `. Analysis confidence: ${confidence}% based on ${completeness}% data completeness.`;

    return overview;
  }

  /**
   * Generate key insights
   */
  private generateKeyInsights(result: GroupAnalysisResult): string[] {
    const insights: string[] = [];
    const { insights: data } = result;

    // Compatibility insights
    if (data.compatibilityMatrix) {
      const avg = data.compatibilityMatrix.averageCompatibility;
      if (avg >= 0.7) {
        insights.push(`High group compatibility (${Math.round(avg * 100)}%) creates strong foundation for collaboration`);
      } else if (avg < 0.5) {
        insights.push(`Moderate compatibility challenges suggest need for structured communication protocols`);
      }
    }

    // Strength insights
    if (data.collectiveStrengths && data.collectiveStrengths.length > 0) {
      const topStrength = data.collectiveStrengths[0];
      insights.push(`Collective strength in "${topStrength.name}" present in ${Math.round(topStrength.prevalence * 100)}% of members`);
    }

    // Risk insights
    if (data.conflictRisks && data.conflictRisks.length > 0) {
      const topRisk = data.conflictRisks[0];
      insights.push(`Primary conflict risk: ${topRisk.type.replace(/_/g, ' ')} (${topRisk.severity} severity)`);
    }

    // Goal alignment
    if (data.goalAlignment) {
      const alignment = Math.round((data.goalAlignment.overallAlignment || 0) * 100);
      if (alignment >= 70) {
        insights.push(`Strong goal alignment (${alignment}%) indicates shared vision and purpose`);
      } else if (alignment < 40) {
        insights.push(`Goal alignment needs attention (${alignment}%) - clarify shared objectives`);
      }
    }

    // Ensure at least one insight
    if (insights.length === 0) {
      insights.push('Group analysis complete - review detailed sections for specific insights');
    }

    return insights;
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(result: GroupAnalysisResult): string[] {
    const recommendations: string[] = [];
    const { insights } = result;

    // Recommendations based on risks
    if (insights.conflictRisks && insights.conflictRisks.length > 0) {
      const critical = insights.conflictRisks.filter((r: any) => r.severity === 'critical');
      if (critical.length > 0) {
        recommendations.push('Address critical conflict risks immediately through facilitated group discussion');
      }

      // Add top mitigation strategy
      const topRisk = insights.conflictRisks[0];
      if (topRisk.mitigationStrategies && topRisk.mitigationStrategies.length > 0) {
        recommendations.push(topRisk.mitigationStrategies[0]);
      }
    }

    // Recommendations based on compatibility
    if (insights.compatibilityMatrix) {
      const avg = insights.compatibilityMatrix.averageCompatibility;
      if (avg < 0.6) {
        recommendations.push('Invest in team-building activities to improve interpersonal compatibility');
      }
    }

    // Recommendations based on strengths
    if (insights.collectiveStrengths && insights.collectiveStrengths.length > 0) {
      const topStrength = insights.collectiveStrengths[0];
      recommendations.push(`Leverage collective strength in "${topStrength.name}" for ${topStrength.applications?.[0] || 'group success'}`);
    }

    // Default recommendations
    if (recommendations.length === 0) {
      recommendations.push('Continue fostering open communication and mutual understanding');
      recommendations.push('Schedule regular group check-ins to maintain healthy dynamics');
    }

    return recommendations;
  }

  /**
   * Generate narrative sections
   */
  private generateNarratives(result: GroupAnalysisResult): {
    compatibility?: string;
    strengths?: string;
    challenges?: string;
    opportunities?: string;
  } {
    return {
      compatibility: this.generateCompatibilityNarrative(result),
      strengths: this.generateStrengthsNarrative(result),
      challenges: this.generateChallengesNarrative(result),
      opportunities: this.generateOpportunitiesNarrative(result)
    };
  }

  private generateCompatibilityNarrative(result: GroupAnalysisResult): string {
    const matrix = result.insights.compatibilityMatrix;
    if (!matrix) return 'Compatibility analysis pending - awaiting member data.';

    const avg = matrix.averageCompatibility;
    const pairCount = matrix.pairCount || 0;

    return `Compatibility analysis across ${pairCount} member pair${pairCount !== 1 ? 's' : ''} reveals an average compatibility score of ${Math.round(avg * 100)}%. This ${
      avg >= 0.7 ? 'strong' : avg >= 0.5 ? 'moderate' : 'developing'
    } compatibility level suggests ${
      avg >= 0.7
        ? 'natural alignment that will facilitate smooth collaboration and mutual understanding.'
        : avg >= 0.5
        ? 'solid foundation with some areas requiring conscious effort to bridge differences.'
        : 'significant differences that will benefit from structured communication and team-building efforts.'
    }`;
  }

  private generateStrengthsNarrative(result: GroupAnalysisResult): string {
    const strengths = result.insights.collectiveStrengths;
    if (!strengths || strengths.length === 0) {
      return 'Collective strength analysis pending - awaiting sufficient member data.';
    }

    const topStrength = strengths[0];
    return `The group demonstrates notable collective strength in ${topStrength.name}, present in ${Math.round(topStrength.prevalence * 100)}% of members. This shared capability creates opportunities for ${
      topStrength.applications?.slice(0, 2).join(' and ') || 'collaborative success'
    }. ${
      strengths.length > 1
        ? `Additional strengths include ${strengths.slice(1, 3).map((s: any) => s.name).join(' and ')}.`
        : ''
    }`;
  }

  private generateChallengesNarrative(result: GroupAnalysisResult): string {
    const risks = result.insights.conflictRisks;
    if (!risks || risks.length === 0) {
      return 'No significant conflict risks identified - group shows healthy dynamics.';
    }

    const topRisk = risks[0];
    return `The primary challenge area involves ${topRisk.type.replace(/_/g, ' ')} with ${topRisk.severity} severity. This affects ${topRisk.affectedMembers?.length || 'multiple'} member${
      (topRisk.affectedMembers?.length || 0) !== 1 ? 's' : ''
    } and may surface during ${topRisk.triggers?.[0] || 'group activities'}. ${
      topRisk.mitigationStrategies?.[0]
        ? `Recommended approach: ${topRisk.mitigationStrategies[0]}`
        : 'Proactive intervention recommended.'
    }`;
  }

  private generateOpportunitiesNarrative(result: GroupAnalysisResult): string {
    const strengths = result.insights.collectiveStrengths || [];
    const alignment = result.insights.goalAlignment;

    if (strengths.length === 0 && !alignment) {
      return 'Opportunities analysis pending - awaiting comprehensive member data.';
    }

    let narrative = '';

    if (alignment && alignment.overallAlignment >= 0.6) {
      narrative += `Strong goal alignment (${Math.round(alignment.overallAlignment * 100)}%) presents opportunities for unified action toward shared objectives. `;
    }

    if (strengths.length > 0) {
      const applications = new Set(strengths.flatMap((s: any) => s.applications || []));
      const uniqueApps = Array.from(applications).slice(0, 3);
      narrative += `The group's collective strengths create natural opportunities in ${uniqueApps.join(', ')}. `;
    }

    if (!narrative) {
      narrative = 'The group shows potential for growth through continued collaboration and mutual support.';
    }

    return narrative.trim();
  }

  /**
   * Helper methods for DUMP message preparation
   */
  private summarizeCompatibility(result: GroupAnalysisResult): any {
    const matrix = result.insights.compatibilityMatrix;
    if (!matrix) return null;

    return {
      average: matrix.averageCompatibility,
      pairCount: matrix.pairCount,
      hasHighCompatibility: matrix.averageCompatibility >= 0.7
    };
  }

  private summarizeStrengths(result: GroupAnalysisResult): any {
    const strengths = result.insights.collectiveStrengths;
    if (!strengths) return null;

    return {
      count: strengths.length,
      top: strengths.slice(0, 3).map((s: any) => ({
        name: s.name,
        type: s.type,
        prevalence: s.prevalence
      }))
    };
  }

  private summarizeRisks(result: GroupAnalysisResult): any {
    const risks = result.insights.conflictRisks;
    if (!risks) return null;

    return {
      count: risks.length,
      criticalCount: risks.filter((r: any) => r.severity === 'critical').length,
      top: risks.slice(0, 3).map((r: any) => ({
        type: r.type,
        severity: r.severity,
        probability: r.probability
      }))
    };
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    mode: string;
    failureCount: number;
    circuitOpen: boolean;
  }> {
    const circuitOpen = this.isCircuitOpen();

    return {
      healthy: !circuitOpen,
      mode: this.useStubData ? 'stub' : 'live',
      failureCount: this.failureCount,
      circuitOpen
    };
  }
}

// Export singleton
export const dinaLLMConnector = new DINALLMConnector();
