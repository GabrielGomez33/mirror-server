// ============================================================================
// CONVERSATION ANALYZER - UPDATED: Routes through Mirror Module
// ============================================================================
// File: analyzers/ConversationAnalyzer.ts
// ----------------------------------------------------------------------------
// CHANGE SUMMARY:
// - generateLLMInsights() now routes through dina-server's mirror module
//   via /mirror/synthesize-insights instead of direct /chat endpoint
// - buildConversationSummary() now includes MORE context: up to 5 contributions
//   per speaker (up from 2) and 500 chars per sample (up from 200)
// - New: Sends full conversation history (truncated) for deeper LLM analysis
// - New: Accepts optional userContext from the request chain
// - analyzeConversation() signature updated to accept userContext
// - All existing functionality preserved; stub fallback unchanged
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
  participationBalance: number;
  engagementLevel: number;
  topicCoherence: number;
  emotionalTone: 'positive' | 'neutral' | 'tense' | 'constructive';
  interactionPatterns: string[];
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
  sessionDuration: number;
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
  focusAreas?: string[];
  /** NEW: User-provided extra context to incorporate into analysis */
  userContext?: string;
}

// ============================================================================
// CONSTANTS - UPDATED
// ============================================================================

/** Max contributions per speaker in summary (increased from 2 to 5) */
const MAX_CONTRIBUTIONS_PER_SPEAKER = 5;

/** Max chars per contribution sample (increased from 200 to 500) */
const MAX_SAMPLE_CHARS = 500;

/** Max conversation history entries to send to mirror module */
const MAX_HISTORY_ENTRIES = 50;

/** Max total chars for conversation history */
const MAX_HISTORY_CHARS = 8000;

// ============================================================================
// CONVERSATION ANALYZER CLASS
// ============================================================================

export class ConversationAnalyzer {
  private logger: Logger;
  private dinaEndpoint: string;
  private useStubMode: boolean;

  private readonly MIN_TRANSCRIPT_LENGTH = 500;
  private readonly MIN_SEGMENTS_FOR_ANALYSIS = 3;
  private readonly CHECK_IN_INTERVAL = 1800000;

  constructor() {
    this.logger = new Logger('ConversationAnalyzer');
    this.dinaEndpoint = process.env.DINA_ENDPOINT || 'http://localhost:7777';
    this.useStubMode = process.env.USE_DINA_STUB === 'true' || !process.env.DINA_ENDPOINT;

    this.logger.info('ConversationAnalyzer initialized (routing through mirror module)', {
      mode: this.useStubMode ? 'stub' : 'live',
    });
  }

  async initialize(): Promise<void> {
    this.logger.info('ConversationAnalyzer starting up');
  }

  async shutdown(): Promise<void> {
    this.logger.info('ConversationAnalyzer shutting down');
  }

  // ==========================================================================
  // MAIN ANALYSIS METHOD - UPDATED signature to accept userContext
  // ==========================================================================

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
      hasUserContext: !!options.userContext,
      options: { ...options, userContext: options.userContext ? '[provided]' : undefined },
    });

    try {
      const transcripts = await this.fetchSessionTranscripts(groupId, sessionId);

      const totalLength = transcripts.reduce((sum, t) => sum + t.text.length, 0);
      const minLength = options.minTranscriptLength || this.MIN_TRANSCRIPT_LENGTH;

      if (transcripts.length < this.MIN_SEGMENTS_FOR_ANALYSIS || totalLength < minLength) {
        return this.createMinimalInsight(groupId, sessionId, insightId, 'insufficient_data');
      }

      const context = await this.buildAnalysisContext(
        groupId, sessionId, transcripts,
        options.includeCompatibilityContext !== false
      );

      const insight = await this.generateInsights(context, transcripts, options);

      await this.storeInsight(insight);
      await this.cacheInsight(insight);

      const processingTime = Date.now() - startTime;
      this.logger.info('Conversation analysis completed', {
        insightId: insight.id,
        processingTime: `${processingTime}ms`,
        observationsCount: insight.keyObservations.length,
      });

      return insight;
    } catch (error) {
      this.logger.error('Conversation analysis failed', error);
      throw error;
    }
  }

  async generatePeriodicCheckIn(
    groupId: string,
    sessionId: string
  ): Promise<ConversationInsight | null> {
    try {
      const recentTranscripts = await this.fetchRecentTranscripts(groupId, sessionId, 20);
      if (recentTranscripts.length < 2) return null;

      return await this.analyzeConversation(groupId, sessionId, {
        insightType: 'periodic',
        minTranscriptLength: 200,
        includeCompatibilityContext: true,
        focusAreas: ['engagement', 'dynamics', 'participation'],
      });
    } catch (error) {
      this.logger.error('Periodic check-in failed', error);
      return null;
    }
  }

  async generatePostSessionSummary(
    groupId: string,
    sessionId: string
  ): Promise<ConversationInsight> {
    return await this.analyzeConversation(groupId, sessionId, {
      insightType: 'post_session',
      includeCompatibilityContext: true,
      focusAreas: ['summary', 'outcomes', 'action_items', 'dynamics'],
    });
  }

  // ==========================================================================
  // DATA FETCHING (unchanged)
  // ==========================================================================

  private async fetchSessionTranscripts(
    groupId: string, sessionId: string
  ): Promise<TranscriptSegment[]> {
    try {
      const [rows] = await DB.query(`
        SELECT t.id, t.speaker_user_id, u.username as speaker_username,
               t.transcript_text, t.timestamp, t.duration_seconds
        FROM mirror_group_session_transcripts t
        JOIN users u ON t.speaker_user_id = u.id
        WHERE t.group_id = ? AND t.session_id = ?
        ORDER BY t.timestamp ASC
      `, [groupId, sessionId]);

      const transcripts: TranscriptSegment[] = [];
      for (const row of rows as any[]) {
        let decryptedText = row.transcript_text;
        try {
          const decrypted = await groupEncryptionManager.decryptForUser(
            row.transcript_text, String(row.speaker_user_id), groupId
          );
          decryptedText = decrypted.data.toString('utf-8');
        } catch {
          // Legacy unencrypted text
        }

        transcripts.push({
          id: row.id,
          speakerUserId: row.speaker_user_id,
          speakerUsername: row.speaker_username,
          text: decryptedText,
          timestamp: new Date(row.timestamp),
          durationSeconds: row.duration_seconds,
        });
      }
      return transcripts;
    } catch (error) {
      this.logger.error('Failed to fetch transcripts', error);
      throw error;
    }
  }

  private async fetchRecentTranscripts(
    groupId: string, sessionId: string, minutesAgo: number
  ): Promise<TranscriptSegment[]> {
    try {
      const [rows] = await DB.query(`
        SELECT t.id, t.speaker_user_id, u.username as speaker_username,
               t.transcript_text, t.timestamp, t.duration_seconds
        FROM mirror_group_session_transcripts t
        JOIN users u ON t.speaker_user_id = u.id
        WHERE t.group_id = ? AND t.session_id = ?
          AND t.timestamp > DATE_SUB(NOW(), INTERVAL ? MINUTE)
        ORDER BY t.timestamp ASC
      `, [groupId, sessionId, minutesAgo]);

      return (rows as any[]).map(row => ({
        id: row.id,
        speakerUserId: row.speaker_user_id,
        speakerUsername: row.speaker_username,
        text: row.transcript_text,
        timestamp: new Date(row.timestamp),
        durationSeconds: row.duration_seconds,
      }));
    } catch (error) {
      this.logger.error('Failed to fetch recent transcripts', error);
      return [];
    }
  }

  private async fetchCompatibilityContext(groupId: string): Promise<any | null> {
    try {
      const [compatRows] = await DB.query(`
        SELECT AVG(compatibility_score) as avg_score,
               GROUP_CONCAT(DISTINCT strengths) as all_strengths,
               GROUP_CONCAT(DISTINCT challenges) as all_challenges
        FROM mirror_group_compatibility WHERE group_id = ?
      `, [groupId]);

      if ((compatRows as any[]).length === 0) return null;
      const row = (compatRows as any[])[0];

      const [riskRows] = await DB.query(`
        SELECT description, severity FROM mirror_group_conflict_risks
        WHERE group_id = ? AND is_active = TRUE
        ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END
        LIMIT 3
      `, [groupId]);

      const strengths = this.parseJsonArray(row.all_strengths);
      const tensions = (riskRows as any[]).map(r => r.description);

      return {
        averageScore: parseFloat(row.avg_score) || 0,
        keyStrengths: strengths.slice(0, 5),
        potentialTensions: tensions.slice(0, 3),
      };
    } catch (error) {
      this.logger.error('Failed to fetch compatibility context', error);
      return null;
    }
  }

  // ==========================================================================
  // ANALYSIS CONTEXT BUILDING (unchanged)
  // ==========================================================================

  private async buildAnalysisContext(
    groupId: string, sessionId: string,
    transcripts: TranscriptSegment[], includeCompatibility: boolean
  ): Promise<AnalysisContext> {
    const [groupRows] = await DB.query(
      'SELECT current_member_count FROM mirror_groups WHERE id = ?', [groupId]
    );
    const memberCount = (groupRows as any[])[0]?.current_member_count || 0;

    let sessionDuration = 0;
    if (transcripts.length > 0) {
      const firstTs = transcripts[0].timestamp.getTime();
      const lastTs = transcripts[transcripts.length - 1].timestamp.getTime();
      sessionDuration = Math.round((lastTs - firstTs) / 60000);
    }

    const context: AnalysisContext = {
      groupId, sessionId, memberCount, sessionDuration,
      transcriptCount: transcripts.length,
    };

    if (includeCompatibility) {
      context.compatibilityData = await this.fetchCompatibilityContext(groupId);
    }

    return context;
  }

  // ==========================================================================
  // INSIGHT GENERATION - UPDATED TO ROUTE THROUGH MIRROR MODULE
  // ==========================================================================

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
   * UPDATED: Routes through dina-server mirror module instead of direct /chat
   */
  private async generateLLMInsights(
    context: AnalysisContext,
    transcripts: TranscriptSegment[],
    options: AnalysisOptions
  ): Promise<ConversationInsight> {
    const insightId = uuidv4();

    try {
      // Build enhanced conversation summary (more context than before)
      const conversationSummary = this.buildConversationSummary(transcripts);

      // Build conversation history entries for the mirror module
      const conversationHistory = this.buildConversationHistory(transcripts);

      // Call mirror module synthesis endpoint instead of direct chat
      const endpoint = this.buildMirrorSynthesisEndpoint();

      const requestBody = {
        synthesisType: options.insightType === 'post_session'
          ? 'post_session_summary'
          : 'conversation_analysis',
        groupId: context.groupId,
        sessionId: context.sessionId,
        analysisData: {
          conversationSummary,
          participationData: this.analyzeParticipation(transcripts),
          sessionDuration: context.sessionDuration,
          transcriptCount: context.transcriptCount,
          compatibilityContext: context.compatibilityData,
        },
        userContext: options.userContext,
        conversationHistory,
        options: {
          maxTokens: 1200,
          temperature: 0.7,
          focusAreas: options.focusAreas || ['engagement', 'dynamics', 'actionable'],
          insightType: options.insightType || 'periodic',
          memberCount: context.memberCount,
        },
      };

      this.logger.debug('Calling mirror synthesize-insights for conversation', {
        endpoint: this.sanitizeEndpoint(endpoint),
        hasUserContext: !!options.userContext,
        historyEntries: conversationHistory.length,
      });

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DINA_SERVICE_KEY || process.env.DINA_API_KEY || ''}`,
          'User-Agent': 'MirrorGroups/4.0',
          'X-Group-ID': context.groupId,
          'X-Session-ID': context.sessionId,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        throw new Error(`Mirror synthesis error: ${response.status}`);
      }

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || 'Mirror synthesis returned unsuccessful response');
      }

      const parsed = result.data;

      return {
        id: insightId,
        groupId: context.groupId,
        sessionId: context.sessionId,
        insightType: options.insightType || 'periodic',
        keyObservations: parsed.keyObservations || ['Analysis completed.'],
        recommendations: parsed.recommendations || ['Continue the discussion.'],
        dynamicsAssessment: parsed.dynamicsAssessment,
        compatibilityNotes: parsed.compatibilityNotes,
        confidenceScore: parsed.confidenceScore || 0.8,
        relevanceScore: parsed.relevanceScore || 0.8,
        generatedAt: new Date(),
      };

    } catch (error) {
      this.logger.error('Mirror module insight generation failed, falling back to stub', error);
      const stubInsight = this.generateStubInsights(context, transcripts, options);
      // Mark fallback so callers/frontend can distinguish from real insights
      (stubInsight as any).isFallback = true;
      return stubInsight;
    }
  }

  // ==========================================================================
  // UPDATED: Enhanced conversation summary (more context)
  // ==========================================================================

  /**
   * UPDATED: Now includes up to 5 contributions per speaker (was 2)
   * and 500 chars per sample (was 200) for richer context.
   */
  private buildConversationSummary(transcripts: TranscriptSegment[]): string {
    const bySpeaker = new Map<string, string[]>();

    for (const t of transcripts) {
      const speaker = t.speakerUsername || `User ${t.speakerUserId}`;
      if (!bySpeaker.has(speaker)) bySpeaker.set(speaker, []);
      bySpeaker.get(speaker)!.push(t.text);
    }

    let summary = 'Conversation participants and highlights:\n\n';

    for (const [speaker, contributions] of bySpeaker.entries()) {
      const totalWords = contributions.join(' ').split(/\s+/).length;
      // UPDATED: 5 samples at 500 chars each (was 2 at 200)
      const sample = contributions
        .slice(0, MAX_CONTRIBUTIONS_PER_SPEAKER)
        .join(' | ')
        .substring(0, MAX_SAMPLE_CHARS);
      summary += `${speaker} (${contributions.length} contributions, ~${totalWords} words):\n  "${sample}..."\n\n`;
    }

    return summary;
  }

  // ==========================================================================
  // NEW: Build conversation history for mirror module
  // ==========================================================================

  /**
   * Build structured conversation history to send to the mirror module.
   * Includes as much context as possible within performance limits.
   */
  private buildConversationHistory(
    transcripts: TranscriptSegment[]
  ): Array<{ speaker: string; text: string; timestamp?: string }> {
    // Take most recent entries up to limit
    const recent = transcripts.slice(-MAX_HISTORY_ENTRIES);

    // Enforce character limit (keep most recent)
    let totalChars = 0;
    const withinLimit: Array<{ speaker: string; text: string; timestamp?: string }> = [];

    for (let i = recent.length - 1; i >= 0; i--) {
      const entry = recent[i];
      const entryChars = (entry.speakerUsername?.length || 10) + entry.text.length;

      if (totalChars + entryChars > MAX_HISTORY_CHARS) break;
      totalChars += entryChars;

      withinLimit.unshift({
        speaker: entry.speakerUsername || `User ${entry.speakerUserId}`,
        text: entry.text,
        timestamp: entry.timestamp?.toISOString(),
      });
    }

    this.logger.debug('Built conversation history', {
      totalTranscripts: transcripts.length,
      includedEntries: withinLimit.length,
      totalChars,
    });

    return withinLimit;
  }

  // ==========================================================================
  // NEW: Mirror module endpoint builder
  // ==========================================================================

  private buildMirrorSynthesisEndpoint(): string {
    const baseUrl = this.dinaEndpoint.replace(/\/$/, '');
    try {
      const url = new URL(baseUrl);
      const pathname = url.pathname;

      if (pathname.endsWith('/api/v1')) {
        return baseUrl.replace(/\/api\/v1$/, '') + '/api/v1/mirror/synthesize-insights';
      } else if (pathname.includes('/dina')) {
        return baseUrl + '/api/v1/mirror/synthesize-insights';
      } else if (pathname === '' || pathname === '/') {
        return baseUrl + '/dina/api/v1/mirror/synthesize-insights';
      }
      return baseUrl + '/mirror/synthesize-insights';
    } catch {
      return `${baseUrl}/dina/api/v1/mirror/synthesize-insights`;
    }
  }

  private sanitizeEndpoint(endpoint: string): string {
    try {
      const url = new URL(endpoint);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return '[invalid]';
    }
  }

  // ==========================================================================
  // STUB INSIGHTS (unchanged from original)
  // ==========================================================================

  private generateStubInsights(
    context: AnalysisContext,
    transcripts: TranscriptSegment[],
    options: AnalysisOptions
  ): ConversationInsight {
    const insightId = uuidv4();
    const participationData = this.analyzeParticipation(transcripts);

    const keyObservations: string[] = [];
    const recommendations: string[] = [];

    if (participationData.balance < 0.5) {
      keyObservations.push(
        `Conversation participation is uneven - ${participationData.dominantSpeaker} has contributed ${Math.round(participationData.maxShare * 100)}% of the discussion.`
      );
      recommendations.push('Consider round-robin speaking to encourage balanced participation.');
    } else {
      keyObservations.push('Group discussion shows healthy participation balance.');
    }

    const avgLen = transcripts.reduce((sum, t) => sum + t.text.length, 0) / transcripts.length;
    if (avgLen > 200) {
      keyObservations.push('Members are engaging deeply with longer contributions.');
    } else if (avgLen < 50) {
      keyObservations.push('Short exchanges dominate - consider exploring topics in more depth.');
      recommendations.push('Try asking follow-up questions for deeper exploration.');
    }

    const compatibilityNotes: string[] = [];
    if (context.compatibilityData) {
      const avg = context.compatibilityData.averageScore;
      if (avg >= 0.7) compatibilityNotes.push(`High compatibility (${Math.round(avg * 100)}%) evident in discussion style.`);
      if (context.compatibilityData.keyStrengths.length > 0) {
        compatibilityNotes.push(`Leverage: ${context.compatibilityData.keyStrengths.slice(0, 2).join(', ')}.`);
      }
    }

    if (context.sessionDuration > 45) {
      keyObservations.push(`Extended session (${context.sessionDuration} minutes) - consider breaks.`);
    }

    if (options.insightType === 'post_session') {
      keyObservations.push(`Session concluded after ${context.sessionDuration} minutes with ${context.transcriptCount} contributions.`);
      recommendations.push('Review key takeaways and assign action items.');
    }

    return {
      id: insightId,
      groupId: context.groupId,
      sessionId: context.sessionId,
      insightType: options.insightType || 'periodic',
      keyObservations,
      recommendations,
      dynamicsAssessment: {
        participationBalance: participationData.balance,
        engagementLevel: this.calculateEngagementLevel(transcripts),
        topicCoherence: 0.7,
        emotionalTone: 'constructive',
        interactionPatterns: participationData.patterns,
      },
      compatibilityNotes,
      confidenceScore: 0.75,
      relevanceScore: 0.8,
      generatedAt: new Date(),
    };
  }

  // ==========================================================================
  // HELPERS (unchanged)
  // ==========================================================================

  private analyzeParticipation(transcripts: TranscriptSegment[]): {
    balance: number; dominantSpeaker: string; maxShare: number; patterns: string[];
  } {
    const contributions = new Map<string, number>();
    for (const t of transcripts) {
      const speaker = t.speakerUsername || `User ${t.speakerUserId}`;
      contributions.set(speaker, (contributions.get(speaker) || 0) + t.text.length);
    }

    const total = Array.from(contributions.values()).reduce((a, b) => a + b, 0);
    const shares = Array.from(contributions.entries())
      .map(([speaker, chars]) => ({ speaker, share: chars / total }))
      .sort((a, b) => b.share - a.share);

    const dominant = shares[0] || { speaker: 'Unknown', share: 0 };
    const idealShare = 1 / contributions.size;
    const variance = shares.reduce((sum, s) => sum + Math.pow(s.share - idealShare, 2), 0) / shares.length;
    const balance = Math.max(0, 1 - variance * 4);

    const patterns: string[] = [];
    if (balance > 0.7) patterns.push('balanced_discussion');
    if (dominant.share > 0.5) patterns.push('single_dominant_speaker');
    if (shares.length >= 3 && shares[shares.length - 1].share < 0.1) patterns.push('quiet_members_present');

    return { balance, dominantSpeaker: dominant.speaker, maxShare: dominant.share, patterns };
  }

  private calculateEngagementLevel(transcripts: TranscriptSegment[]): number {
    if (transcripts.length < 2) return 0.5;
    let totalResponseTime = 0;
    for (let i = 1; i < transcripts.length; i++) {
      totalResponseTime += transcripts[i].timestamp.getTime() - transcripts[i - 1].timestamp.getTime();
    }
    const avg = totalResponseTime / (transcripts.length - 1);
    if (avg < 30000) return 0.9;
    if (avg < 60000) return 0.7;
    if (avg < 120000) return 0.5;
    return 0.3;
  }

  private createMinimalInsight(
    groupId: string, sessionId: string, insightId: string, reason: string
  ): ConversationInsight {
    return {
      id: insightId, groupId, sessionId,
      insightType: 'periodic',
      keyObservations: [reason === 'insufficient_data'
        ? 'Not enough conversation data yet for meaningful insights.'
        : 'Analysis pending.'],
      recommendations: ['Continue the discussion - insights will be generated as conversation develops.'],
      confidenceScore: 0.3, relevanceScore: 0.3,
      generatedAt: new Date(),
    };
  }

  private async storeInsight(insight: ConversationInsight): Promise<void> {
    try {
      await DB.query(`
        INSERT INTO mirror_group_session_insights (
          id, group_id, session_id, insight_type,
          key_observations, recommendations, dynamics_assessment,
          compatibility_notes, confidence_score, relevance_score, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        insight.id, insight.groupId, insight.sessionId, insight.insightType,
        JSON.stringify(insight.keyObservations), JSON.stringify(insight.recommendations),
        JSON.stringify(insight.dynamicsAssessment || {}),
        JSON.stringify(insight.compatibilityNotes || []),
        insight.confidenceScore, insight.relevanceScore, insight.generatedAt,
      ]);
    } catch (error) {
      this.logger.error('Failed to store insight', error);
    }
  }

  private async cacheInsight(insight: ConversationInsight): Promise<void> {
    try {
      const key = `mirror:session:insight:${insight.sessionId}:latest`;
      await mirrorRedis.set(key, insight, 3600);
    } catch (error) {
      this.logger.error('Failed to cache insight', error);
    }
  }

  async getCachedInsight(sessionId: string): Promise<ConversationInsight | null> {
    try {
      return await mirrorRedis.get(`mirror:session:insight:${sessionId}:latest`);
    } catch { return null; }
  }

  private parseJsonArray(str: string | null): string[] {
    if (!str) return [];
    try {
      const items: string[] = [];
      for (const part of str.split('],[')) {
        try {
          const parsed = JSON.parse(`[${part.replace(/^\[|\]$/g, '')}]`);
          items.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        } catch { /* skip */ }
      }
      return [...new Set(items)].filter(Boolean);
    } catch { return []; }
  }

  async queueAnalysis(
    groupId: string, sessionId: string,
    type: 'periodic' | 'on_demand' | 'post_session', priority: number = 5
  ): Promise<string> {
    const queueId = uuidv4();
    await DB.query(`
      INSERT INTO mirror_group_conversation_queue (id, group_id, session_id, analysis_type, priority)
      VALUES (?, ?, ?, ?, ?)
    `, [queueId, groupId, sessionId, type, priority]);

    await mirrorRedis.publish('mirror:conversation:queue', JSON.stringify({
      queueId, groupId, sessionId, type, priority,
    }));
    return queueId;
  }

  async getSessionInsights(
    groupId: string, sessionId: string, limit: number = 10
  ): Promise<ConversationInsight[]> {
    try {
      const [rows] = await DB.query(`
        SELECT * FROM mirror_group_session_insights
        WHERE group_id = ? AND session_id = ?
        ORDER BY generated_at DESC LIMIT ?
      `, [groupId, sessionId, limit]);

      return (rows as any[]).map(row => ({
        id: row.id, groupId: row.group_id, sessionId: row.session_id,
        insightType: row.insight_type,
        keyObservations: this.safeJsonParse(row.key_observations, []),
        recommendations: this.safeJsonParse(row.recommendations, []),
        dynamicsAssessment: this.safeJsonParse(row.dynamics_assessment, undefined),
        compatibilityNotes: this.safeJsonParse(row.compatibility_notes, []),
        confidenceScore: parseFloat(row.confidence_score) || 0,
        relevanceScore: parseFloat(row.relevance_score) || 0,
        generatedAt: new Date(row.generated_at),
      }));
    } catch (error) {
      this.logger.error('Failed to get session insights', error);
      return [];
    }
  }

  private safeJsonParse<T>(value: any, fallback: T): T {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') {
      try { return JSON.parse(value) as T; } catch { return fallback; }
    }
    return value as T;
  }
}

export const conversationAnalyzer = new ConversationAnalyzer();
