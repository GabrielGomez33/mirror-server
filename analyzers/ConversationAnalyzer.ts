// ============================================================================
// CONVERSATION ANALYZER - PHASE 4 AI INTELLIGENCE
// ============================================================================
// File: analyzers/ConversationAnalyzer.ts
// ----------------------------------------------------------------------------
// Analyzes group conversations to generate actionable insights
// Uses DINA LLM for natural language understanding
// Integrates with Phase 3 compatibility data for context
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import { DB } from '../db';
import { Logger } from '../utils/logger';
import { mirrorRedis } from '../config/redis';
import { groupEncryptionManager } from '../systems/GroupEncryptionManager';

// ============================================================================
// TYPES AND INTERFACES
// ============================================================================

export interface ConversationInsight {
  id: string;
  groupId: string;
  sessionId: string;
  insightType: 'periodic' | 'post_session' | 'on_demand';
  keyObservations: string[];
  recommendations: string[];
  dynamicsAssessment?: DynamicsAssessment;
  compatibilityNotes?: string[];
  confidenceScore: number;
  relevanceScore: number;
  generatedAt: Date;
}

export interface DynamicsAssessment {
  participationBalance: number;      // 0-1: How evenly distributed is speaking time
  engagementLevel: number;           // 0-1: Overall group engagement
  topicCoherence: number;            // 0-1: How focused the discussion is
  emotionalTone: 'positive' | 'neutral' | 'tense' | 'constructive';
  interactionPatterns: string[];     // Notable patterns observed
}

export interface TranscriptSegment {
  id: string;
  speakerUserId: number;
  speakerUsername?: string;
  text: string;
  timestamp: Date;
  durationSeconds?: number;
}

export interface AnalysisContext {
  groupId: string;
  sessionId: string;
  memberCount: number;
  sessionDuration: number;           // Minutes
  transcriptCount: number;
  compatibilityData?: {
    averageScore: number;
    keyStrengths: string[];
    potentialTensions: string[];
  };
}

export interface AnalysisOptions {
  includeCompatibilityContext?: boolean;
  minTranscriptLength?: number;
  insightType?: 'periodic' | 'post_session' | 'on_demand';
  focusAreas?: string[];             // Specific aspects to analyze
}

// ============================================================================
// CONVERSATION ANALYZER CLASS
// ============================================================================

export class ConversationAnalyzer {
  private logger: Logger;
  private dinaEndpoint: string;
  private useStubMode: boolean;

  // Analysis thresholds
  private readonly MIN_TRANSCRIPT_LENGTH = 500;     // Characters
  private readonly MIN_SEGMENTS_FOR_ANALYSIS = 3;   // Minimum speech segments
  private readonly CHECK_IN_INTERVAL = 1800000;     // 30 minutes in ms

  constructor() {
    this.logger = new Logger('ConversationAnalyzer');
    this.dinaEndpoint = process.env.DINA_ENDPOINT || 'http://localhost:7777';
    this.useStubMode = process.env.USE_DINA_STUB === 'true' || !process.env.DINA_ENDPOINT;

    this.logger.info('ConversationAnalyzer initialized', {
      mode: this.useStubMode ? 'stub' : 'live',
      minTranscriptLength: this.MIN_TRANSCRIPT_LENGTH,
      checkInInterval: `${this.CHECK_IN_INTERVAL / 60000} minutes`
    });
  }

  /**
   * Initialize analyzer (for server startup)
   */
  async initialize(): Promise<void> {
    this.logger.info('ConversationAnalyzer starting up');
    return Promise.resolve();
  }

  /**
   * Shutdown analyzer (for server shutdown)
   */
  async shutdown(): Promise<void> {
    this.logger.info('ConversationAnalyzer shutting down');
    return Promise.resolve();
  }

  // ==========================================================================
  // MAIN ANALYSIS METHODS
  // ==========================================================================

  /**
   * Analyze conversation transcripts and generate insights
   * Main entry point for conversation analysis
   */
  async analyzeConversation(
    groupId: string,
    sessionId: string,
    options: AnalysisOptions = {}
  ): Promise<ConversationInsight> {
    const startTime = Date.now();
    const insightId = uuidv4();

    this.logger.info('Starting conversation analysis', {
      groupId,
      sessionId,
      insightId,
      options
    });

    try {
      // Fetch transcripts for this session
      const transcripts = await this.fetchSessionTranscripts(groupId, sessionId);

      // Validate we have enough data
      const totalLength = transcripts.reduce((sum, t) => sum + t.text.length, 0);
      const minLength = options.minTranscriptLength || this.MIN_TRANSCRIPT_LENGTH;

      if (transcripts.length < this.MIN_SEGMENTS_FOR_ANALYSIS || totalLength < minLength) {
        this.logger.warn('Insufficient transcript data for analysis', {
          segmentCount: transcripts.length,
          totalLength,
          minRequired: minLength
        });

        // Return minimal insight indicating insufficient data
        return this.createMinimalInsight(groupId, sessionId, insightId, 'insufficient_data');
      }

      // Build analysis context
      const context = await this.buildAnalysisContext(
        groupId,
        sessionId,
        transcripts,
        options.includeCompatibilityContext !== false
      );

      // Generate insights using DINA LLM
      const insight = await this.generateInsights(context, transcripts, options);

      // Store the insight
      await this.storeInsight(insight);

      // Cache for quick access
      await this.cacheInsight(insight);

      const processingTime = Date.now() - startTime;
      this.logger.info('Conversation analysis completed', {
        insightId: insight.id,
        processingTime: `${processingTime}ms`,
        observationsCount: insight.keyObservations.length,
        confidence: insight.confidenceScore
      });

      return insight;

    } catch (error) {
      this.logger.error('Conversation analysis failed', error);
      throw error;
    }
  }

  /**
   * Generate periodic check-in insight (non-intrusive)
   * Called every 20-30 minutes during active sessions
   */
  async generatePeriodicCheckIn(
    groupId: string,
    sessionId: string
  ): Promise<ConversationInsight | null> {
    this.logger.info('Generating periodic check-in', { groupId, sessionId });

    try {
      // Get recent transcripts (last 20 minutes)
      const recentTranscripts = await this.fetchRecentTranscripts(groupId, sessionId, 20);

      if (recentTranscripts.length < 2) {
        this.logger.debug('Not enough recent activity for check-in');
        return null;
      }

      return await this.analyzeConversation(groupId, sessionId, {
        insightType: 'periodic',
        minTranscriptLength: 200,    // Lower threshold for periodic
        includeCompatibilityContext: true,
        focusAreas: ['engagement', 'dynamics', 'participation']
      });

    } catch (error) {
      this.logger.error('Periodic check-in failed', error);
      return null;
    }
  }

  /**
   * Generate post-session summary
   * Called when a session ends
   */
  async generatePostSessionSummary(
    groupId: string,
    sessionId: string
  ): Promise<ConversationInsight> {
    this.logger.info('Generating post-session summary', { groupId, sessionId });

    return await this.analyzeConversation(groupId, sessionId, {
      insightType: 'post_session',
      includeCompatibilityContext: true,
      focusAreas: ['summary', 'outcomes', 'action_items', 'dynamics']
    });
  }

  // ==========================================================================
  // DATA FETCHING METHODS
  // ==========================================================================

  /**
   * Fetch all transcripts for a session
   */
  private async fetchSessionTranscripts(
    groupId: string,
    sessionId: string
  ): Promise<TranscriptSegment[]> {
    try {
      const [rows] = await DB.query(`
        SELECT
          t.id,
          t.speaker_user_id,
          u.username as speaker_username,
          t.transcript_text,
          t.timestamp,
          t.duration_seconds
        FROM mirror_group_session_transcripts t
        JOIN users u ON t.speaker_user_id = u.id
        WHERE t.group_id = ? AND t.session_id = ?
        ORDER BY t.timestamp ASC
      `, [groupId, sessionId]);

      const transcripts: TranscriptSegment[] = [];

      for (const row of rows as any[]) {
        // Decrypt transcript text
        let decryptedText = row.transcript_text;
        try {
          const decrypted = await groupEncryptionManager.decryptForUser(
            row.transcript_text,
            String(row.speaker_user_id),
            groupId
          );
          decryptedText = decrypted.data.toString('utf-8');
        } catch {
          // If decryption fails, text might be unencrypted (legacy)
          this.logger.warn('Transcript decryption failed, using raw text');
        }

        transcripts.push({
          id: row.id,
          speakerUserId: row.speaker_user_id,
          speakerUsername: row.speaker_username,
          text: decryptedText,
          timestamp: new Date(row.timestamp),
          durationSeconds: row.duration_seconds
        });
      }

      this.logger.debug('Fetched transcripts', {
        groupId,
        sessionId,
        count: transcripts.length
      });

      return transcripts;

    } catch (error) {
      this.logger.error('Failed to fetch transcripts', error);
      throw error;
    }
  }

  /**
   * Fetch recent transcripts (last N minutes)
   */
  private async fetchRecentTranscripts(
    groupId: string,
    sessionId: string,
    minutesAgo: number
  ): Promise<TranscriptSegment[]> {
    try {
      const [rows] = await DB.query(`
        SELECT
          t.id,
          t.speaker_user_id,
          u.username as speaker_username,
          t.transcript_text,
          t.timestamp,
          t.duration_seconds
        FROM mirror_group_session_transcripts t
        JOIN users u ON t.speaker_user_id = u.id
        WHERE t.group_id = ?
          AND t.session_id = ?
          AND t.timestamp > DATE_SUB(NOW(), INTERVAL ? MINUTE)
        ORDER BY t.timestamp ASC
      `, [groupId, sessionId, minutesAgo]);

      const transcripts: TranscriptSegment[] = [];

      for (const row of rows as any[]) {
        transcripts.push({
          id: row.id,
          speakerUserId: row.speaker_user_id,
          speakerUsername: row.speaker_username,
          text: row.transcript_text,
          timestamp: new Date(row.timestamp),
          durationSeconds: row.duration_seconds
        });
      }

      return transcripts;

    } catch (error) {
      this.logger.error('Failed to fetch recent transcripts', error);
      return [];
    }
  }

  /**
   * Fetch compatibility data from Phase 3 analysis
   */
  private async fetchCompatibilityContext(groupId: string): Promise<any | null> {
    try {
      // Get average compatibility
      const [compatRows] = await DB.query(`
        SELECT
          AVG(compatibility_score) as avg_score,
          GROUP_CONCAT(DISTINCT strengths) as all_strengths,
          GROUP_CONCAT(DISTINCT challenges) as all_challenges
        FROM mirror_group_compatibility
        WHERE group_id = ?
      `, [groupId]);

      if ((compatRows as any[]).length === 0) {
        return null;
      }

      const row = (compatRows as any[])[0];

      // Get conflict risks
      const [riskRows] = await DB.query(`
        SELECT description, severity
        FROM mirror_group_conflict_risks
        WHERE group_id = ? AND is_active = TRUE
        ORDER BY CASE severity
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          ELSE 4
        END
        LIMIT 3
      `, [groupId]);

      // Parse strengths and challenges
      const strengths = this.parseJsonArray(row.all_strengths);
      const challenges = this.parseJsonArray(row.all_challenges);
      const tensions = (riskRows as any[]).map(r => r.description);

      return {
        averageScore: parseFloat(row.avg_score) || 0,
        keyStrengths: strengths.slice(0, 5),
        potentialTensions: tensions.slice(0, 3)
      };

    } catch (error) {
      this.logger.error('Failed to fetch compatibility context', error);
      return null;
    }
  }

  // ==========================================================================
  // ANALYSIS GENERATION METHODS
  // ==========================================================================

  /**
   * Build analysis context from transcripts and group data
   */
  private async buildAnalysisContext(
    groupId: string,
    sessionId: string,
    transcripts: TranscriptSegment[],
    includeCompatibility: boolean
  ): Promise<AnalysisContext> {
    // Get group info
    const [groupRows] = await DB.query(`
      SELECT current_member_count FROM mirror_groups WHERE id = ?
    `, [groupId]);

    const memberCount = (groupRows as any[])[0]?.current_member_count || 0;

    // Calculate session duration
    let sessionDuration = 0;
    if (transcripts.length > 0) {
      const firstTimestamp = transcripts[0].timestamp.getTime();
      const lastTimestamp = transcripts[transcripts.length - 1].timestamp.getTime();
      sessionDuration = Math.round((lastTimestamp - firstTimestamp) / 60000); // Minutes
    }

    const context: AnalysisContext = {
      groupId,
      sessionId,
      memberCount,
      sessionDuration,
      transcriptCount: transcripts.length
    };

    // Add compatibility context if requested
    if (includeCompatibility) {
      context.compatibilityData = await this.fetchCompatibilityContext(groupId);
    }

    return context;
  }

  /**
   * Generate insights using DINA LLM or stub mode
   */
  private async generateInsights(
    context: AnalysisContext,
    transcripts: TranscriptSegment[],
    options: AnalysisOptions
  ): Promise<ConversationInsight> {
    if (this.useStubMode) {
      return this.generateStubInsights(context, transcripts, options);
    }

    return this.generateLLMInsights(context, transcripts, options);
  }

  /**
   * Generate insights using DINA LLM
   */
  private async generateLLMInsights(
    context: AnalysisContext,
    transcripts: TranscriptSegment[],
    options: AnalysisOptions
  ): Promise<ConversationInsight> {
    const insightId = uuidv4();

    try {
      // Build conversation summary for LLM
      const conversationSummary = this.buildConversationSummary(transcripts);

      // Build prompt
      const prompt = this.buildAnalysisPrompt(context, conversationSummary, options);

      // Call DINA LLM
      const endpoint = this.buildEndpointURL();

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'MirrorGroups/4.0',
          'X-Group-ID': context.groupId,
          'X-Session-ID': context.sessionId
        },
        body: JSON.stringify({
          query: prompt,
          options: {
            max_tokens: 1200,
            temperature: 0.7
          }
        }),
        signal: AbortSignal.timeout(60000)
      });

      if (!response.ok) {
        throw new Error(`DINA API error: ${response.status}`);
      }

      const result = await response.json();
      const content = result.response || result.choices?.[0]?.message?.content || result.content;

      if (!content) {
        throw new Error('No content in DINA response');
      }

      // Parse LLM response
      const parsed = this.parseLLMResponse(content);

      return {
        id: insightId,
        groupId: context.groupId,
        sessionId: context.sessionId,
        insightType: options.insightType || 'periodic',
        keyObservations: parsed.keyObservations,
        recommendations: parsed.recommendations,
        dynamicsAssessment: parsed.dynamicsAssessment,
        compatibilityNotes: parsed.compatibilityNotes,
        confidenceScore: parsed.confidenceScore || 0.8,
        relevanceScore: parsed.relevanceScore || 0.8,
        generatedAt: new Date()
      };

    } catch (error) {
      this.logger.error('LLM insight generation failed, falling back to stub', error);
      return this.generateStubInsights(context, transcripts, options);
    }
  }

  /**
   * Generate intelligent stub insights (offline fallback)
   */
  private generateStubInsights(
    context: AnalysisContext,
    transcripts: TranscriptSegment[],
    options: AnalysisOptions
  ): ConversationInsight {
    const insightId = uuidv4();

    // Analyze participation
    const participationData = this.analyzeParticipation(transcripts);

    // Generate observations based on data
    const keyObservations: string[] = [];
    const recommendations: string[] = [];

    // Participation-based observations
    if (participationData.balance < 0.5) {
      keyObservations.push(
        `Conversation participation is uneven - ${participationData.dominantSpeaker} has contributed ${Math.round(participationData.maxShare * 100)}% of the discussion.`
      );
      recommendations.push(
        'Consider using round-robin speaking or direct questions to encourage more balanced participation.'
      );
    } else {
      keyObservations.push(
        'Group discussion shows healthy participation balance across members.'
      );
    }

    // Engagement observations
    const avgSegmentLength = transcripts.reduce((sum, t) => sum + t.text.length, 0) / transcripts.length;
    if (avgSegmentLength > 200) {
      keyObservations.push(
        'Members are engaging deeply with longer, more detailed contributions.'
      );
    } else if (avgSegmentLength < 50) {
      keyObservations.push(
        'Short exchanges dominate - consider exploring topics in more depth.'
      );
      recommendations.push(
        'Try asking follow-up questions to encourage deeper exploration of ideas.'
      );
    }

    // Add compatibility context if available
    const compatibilityNotes: string[] = [];
    if (context.compatibilityData) {
      const avgScore = context.compatibilityData.averageScore;
      if (avgScore >= 0.7) {
        compatibilityNotes.push(
          `High group compatibility (${Math.round(avgScore * 100)}%) is evident in collaborative discussion style.`
        );
      } else if (avgScore < 0.5) {
        compatibilityNotes.push(
          `Given moderate compatibility levels, be mindful of different communication preferences.`
        );
      }

      if (context.compatibilityData.keyStrengths.length > 0) {
        compatibilityNotes.push(
          `Leverage shared strengths: ${context.compatibilityData.keyStrengths.slice(0, 2).join(', ')}.`
        );
      }
    }

    // Session duration observations
    if (context.sessionDuration > 45) {
      keyObservations.push(
        `Extended session (${context.sessionDuration} minutes) - consider taking breaks.`
      );
      recommendations.push(
        'Long sessions benefit from brief breaks every 45-60 minutes.'
      );
    }

    // Type-specific observations
    if (options.insightType === 'post_session') {
      keyObservations.push(
        `Session concluded after ${context.sessionDuration} minutes with ${context.transcriptCount} contributions.`
      );
      recommendations.push(
        'Review key takeaways and assign action items from today\'s discussion.'
      );
    }

    // Build dynamics assessment
    const dynamicsAssessment: DynamicsAssessment = {
      participationBalance: participationData.balance,
      engagementLevel: this.calculateEngagementLevel(transcripts),
      topicCoherence: 0.7, // Simplified without NLP
      emotionalTone: 'constructive',
      interactionPatterns: participationData.patterns
    };

    return {
      id: insightId,
      groupId: context.groupId,
      sessionId: context.sessionId,
      insightType: options.insightType || 'periodic',
      keyObservations,
      recommendations,
      dynamicsAssessment,
      compatibilityNotes,
      confidenceScore: 0.75, // Stub mode has lower confidence
      relevanceScore: 0.8,
      generatedAt: new Date()
    };
  }

  // ==========================================================================
  // HELPER METHODS
  // ==========================================================================

  /**
   * Build conversation summary for LLM
   */
  private buildConversationSummary(transcripts: TranscriptSegment[]): string {
    // Group by speaker and summarize
    const bySpeaker = new Map<string, string[]>();

    for (const t of transcripts) {
      const speaker = t.speakerUsername || `User ${t.speakerUserId}`;
      if (!bySpeaker.has(speaker)) {
        bySpeaker.set(speaker, []);
      }
      bySpeaker.get(speaker)!.push(t.text);
    }

    // Build summary
    let summary = 'Conversation participants and highlights:\n\n';

    for (const [speaker, contributions] of bySpeaker.entries()) {
      const totalWords = contributions.join(' ').split(/\s+/).length;
      const sample = contributions.slice(0, 2).join(' | ').substring(0, 200);
      summary += `${speaker} (${contributions.length} contributions, ~${totalWords} words):\n  "${sample}..."\n\n`;
    }

    return summary;
  }

  /**
   * Build analysis prompt for LLM
   */
  private buildAnalysisPrompt(
    context: AnalysisContext,
    conversationSummary: string,
    options: AnalysisOptions
  ): string {
    const focusAreas = options.focusAreas || ['engagement', 'dynamics', 'actionable'];

    let prompt = `You are an expert in group dynamics and communication analysis. Analyze this ${context.memberCount}-person group conversation.

${conversationSummary}

Session Context:
- Duration: ${context.sessionDuration} minutes
- Contributions: ${context.transcriptCount} speech segments`;

    if (context.compatibilityData) {
      prompt += `
- Group Compatibility: ${Math.round(context.compatibilityData.averageScore * 100)}%
- Strengths: ${context.compatibilityData.keyStrengths.join(', ')}`;
    }

    prompt += `

Focus Areas: ${focusAreas.join(', ')}

${options.insightType === 'post_session'
  ? 'Provide a comprehensive post-session summary with action items.'
  : 'Provide brief, non-intrusive insights for an ongoing conversation.'}

Respond with JSON:
{
  "keyObservations": ["observation1", "observation2"],
  "recommendations": ["recommendation1"],
  "dynamicsAssessment": {
    "participationBalance": 0.8,
    "engagementLevel": 0.7,
    "topicCoherence": 0.9,
    "emotionalTone": "constructive",
    "interactionPatterns": ["pattern1"]
  },
  "compatibilityNotes": ["note1"],
  "confidenceScore": 0.8,
  "relevanceScore": 0.85
}`;

    return prompt;
  }

  /**
   * Parse LLM response into structured insight
   */
  private parseLLMResponse(content: any): any {
    try {
      if (typeof content === 'string') {
        // Try to extract JSON from markdown code blocks
        const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) ||
                         content.match(/```\s*([\s\S]*?)\s*```/);

        if (jsonMatch) {
          content = jsonMatch[1].trim();
        }

        return JSON.parse(content.trim());
      }

      return content;

    } catch (error) {
      this.logger.warn('Failed to parse LLM response as JSON', { error });

      // Return default structure
      return {
        keyObservations: ['Analysis completed - see detailed results.'],
        recommendations: ['Continue the productive discussion.'],
        confidenceScore: 0.6,
        relevanceScore: 0.6
      };
    }
  }

  /**
   * Analyze participation distribution
   */
  private analyzeParticipation(transcripts: TranscriptSegment[]): {
    balance: number;
    dominantSpeaker: string;
    maxShare: number;
    patterns: string[];
  } {
    const contributions = new Map<string, number>();

    for (const t of transcripts) {
      const speaker = t.speakerUsername || `User ${t.speakerUserId}`;
      contributions.set(speaker, (contributions.get(speaker) || 0) + t.text.length);
    }

    const total = Array.from(contributions.values()).reduce((a, b) => a + b, 0);
    const shares = Array.from(contributions.entries()).map(([speaker, chars]) => ({
      speaker,
      share: chars / total
    }));

    // Find dominant speaker
    shares.sort((a, b) => b.share - a.share);
    const dominant = shares[0] || { speaker: 'Unknown', share: 0 };

    // Calculate balance (1 = perfectly equal, 0 = one person dominates)
    const idealShare = 1 / contributions.size;
    const variance = shares.reduce((sum, s) => sum + Math.pow(s.share - idealShare, 2), 0) / shares.length;
    const balance = Math.max(0, 1 - variance * 4); // Normalize

    // Identify patterns
    const patterns: string[] = [];
    if (balance > 0.7) patterns.push('balanced_discussion');
    if (dominant.share > 0.5) patterns.push('single_dominant_speaker');
    if (shares.length >= 3 && shares[shares.length - 1].share < 0.1) {
      patterns.push('quiet_members_present');
    }

    return {
      balance,
      dominantSpeaker: dominant.speaker,
      maxShare: dominant.share,
      patterns
    };
  }

  /**
   * Calculate engagement level from transcript data
   */
  private calculateEngagementLevel(transcripts: TranscriptSegment[]): number {
    if (transcripts.length < 2) return 0.5;

    // Calculate average response time between segments
    let totalResponseTime = 0;
    for (let i = 1; i < transcripts.length; i++) {
      const gap = transcripts[i].timestamp.getTime() - transcripts[i - 1].timestamp.getTime();
      totalResponseTime += gap;
    }
    const avgResponseTime = totalResponseTime / (transcripts.length - 1);

    // Fast responses indicate high engagement
    // < 30s = high, 30-60s = medium, > 60s = low
    if (avgResponseTime < 30000) return 0.9;
    if (avgResponseTime < 60000) return 0.7;
    if (avgResponseTime < 120000) return 0.5;
    return 0.3;
  }

  /**
   * Build DINA endpoint URL
   */
  private buildEndpointURL(): string {
    const baseUrl = this.dinaEndpoint.replace(/\/$/, '');

    try {
      const url = new URL(baseUrl);
      const pathname = url.pathname;

      if (pathname.endsWith('/chat')) return baseUrl;
      if (pathname.match(/\/models\/[^\/]+$/)) return `${baseUrl}/chat`;
      if (pathname.endsWith('/api/v1')) return `${baseUrl}/models/mistral:7b/chat`;
      return `${baseUrl}/dina/api/v1/models/mistral:7b/chat`;

    } catch {
      return `${baseUrl}/dina/api/v1/models/mistral:7b/chat`;
    }
  }

  /**
   * Create minimal insight for insufficient data
   */
  private createMinimalInsight(
    groupId: string,
    sessionId: string,
    insightId: string,
    reason: string
  ): ConversationInsight {
    return {
      id: insightId,
      groupId,
      sessionId,
      insightType: 'periodic',
      keyObservations: [
        reason === 'insufficient_data'
          ? 'Not enough conversation data yet for meaningful insights.'
          : 'Analysis pending - conversation insights will be available shortly.'
      ],
      recommendations: [
        'Continue the discussion - insights will be generated as the conversation develops.'
      ],
      confidenceScore: 0.3,
      relevanceScore: 0.3,
      generatedAt: new Date()
    };
  }

  /**
   * Store insight to database
   */
  private async storeInsight(insight: ConversationInsight): Promise<void> {
    try {
      await DB.query(`
        INSERT INTO mirror_group_session_insights (
          id, group_id, session_id, insight_type,
          key_observations, recommendations, dynamics_assessment,
          compatibility_notes, confidence_score, relevance_score,
          generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        insight.id,
        insight.groupId,
        insight.sessionId,
        insight.insightType,
        JSON.stringify(insight.keyObservations),
        JSON.stringify(insight.recommendations),
        JSON.stringify(insight.dynamicsAssessment || {}),
        JSON.stringify(insight.compatibilityNotes || []),
        insight.confidenceScore,
        insight.relevanceScore,
        insight.generatedAt
      ]);

      this.logger.debug('Stored insight', { insightId: insight.id });

    } catch (error) {
      this.logger.error('Failed to store insight', error);
      // Non-fatal - don't throw
    }
  }

  /**
   * Cache insight in Redis
   */
  private async cacheInsight(insight: ConversationInsight): Promise<void> {
    try {
      const key = `mirror:session:insight:${insight.sessionId}:latest`;
      await mirrorRedis.set(key, insight, 3600); // 1 hour TTL

    } catch (error) {
      this.logger.error('Failed to cache insight', error);
    }
  }

  /**
   * Get cached insight
   */
  async getCachedInsight(sessionId: string): Promise<ConversationInsight | null> {
    try {
      const key = `mirror:session:insight:${sessionId}:latest`;
      return await mirrorRedis.get(key);
    } catch {
      return null;
    }
  }

  /**
   * Parse JSON array from concatenated strings
   */
  private parseJsonArray(str: string | null): string[] {
    if (!str) return [];

    try {
      // Try to parse concatenated JSON arrays
      const items: string[] = [];
      const parts = str.split('],[');

      for (const part of parts) {
        let cleaned = part.replace(/^\[|\]$/g, '');
        try {
          const parsed = JSON.parse(`[${cleaned}]`);
          items.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        } catch {
          // Skip malformed parts
        }
      }

      return [...new Set(items)].filter(Boolean);

    } catch {
      return [];
    }
  }

  /**
   * Queue a conversation for analysis
   */
  async queueAnalysis(
    groupId: string,
    sessionId: string,
    type: 'periodic' | 'on_demand' | 'post_session',
    priority: number = 5
  ): Promise<string> {
    const queueId = uuidv4();

    await DB.query(`
      INSERT INTO mirror_group_conversation_queue (
        id, group_id, session_id, analysis_type, priority
      ) VALUES (?, ?, ?, ?, ?)
    `, [queueId, groupId, sessionId, type, priority]);

    // Notify via Redis pub/sub
    await mirrorRedis.publish('mirror:conversation:queue', JSON.stringify({
      queueId,
      groupId,
      sessionId,
      type,
      priority
    }));

    return queueId;
  }

  /**
   * Get session insights history
   */
  async getSessionInsights(
    groupId: string,
    sessionId: string,
    limit: number = 10
  ): Promise<ConversationInsight[]> {
    try {
      const [rows] = await DB.query(`
        SELECT *
        FROM mirror_group_session_insights
        WHERE group_id = ? AND session_id = ?
        ORDER BY generated_at DESC
        LIMIT ?
      `, [groupId, sessionId, limit]);

      return (rows as any[]).map(row => ({
        id: row.id,
        groupId: row.group_id,
        sessionId: row.session_id,
        insightType: row.insight_type,
        keyObservations: this.safeJsonParse(row.key_observations, []),
        recommendations: this.safeJsonParse(row.recommendations, []),
        dynamicsAssessment: this.safeJsonParse(row.dynamics_assessment, undefined),
        compatibilityNotes: this.safeJsonParse(row.compatibility_notes, []),
        confidenceScore: parseFloat(row.confidence_score) || 0,
        relevanceScore: parseFloat(row.relevance_score) || 0,
        generatedAt: new Date(row.generated_at)
      }));

    } catch (error) {
      this.logger.error('Failed to get session insights', error);
      return [];
    }
  }

  /**
   * Safe JSON parse helper
   */
  private safeJsonParse<T>(value: any, fallback: T): T {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') {
      try { return JSON.parse(value) as T; } catch { return fallback; }
    }
    return value as T;
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const conversationAnalyzer = new ConversationAnalyzer();
