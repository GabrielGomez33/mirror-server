/**
 * DINALLMConnector - Integration with DINA using DUMP Protocol
 * 
 * Full-featured connector with synthesis templates for group analysis
 * Uses DINA Universal Messaging Protocol (DUMP) for cross-platform communication
 * 
 * @module integrations/DINALLMConnector
 */

import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger';
import { GroupAnalysisResult, LLMSynthesis } from '../analyzers/GroupAnalyzer';

/**
 * DUMP Protocol Message Structure
 */
interface DUMPMessage {
  version: '1.0';
  messageId: string;
  timestamp: string;
  sender: {
    service: 'mirror';
    instance: string;
  };
  recipient: {
    service: 'dina';
    endpoint: string;
  };
  messageType: 'REQUEST' | 'RESPONSE' | 'EVENT';
  action: string;
  payload: any;
  metadata?: {
    priority?: number;
    timeout?: number;
    retryCount?: number;
  };
}

interface DUMPResponse {
  version: '1.0';
  messageId: string;
  correlationId: string;
  timestamp: string;
  status: 'SUCCESS' | 'ERROR' | 'PENDING';
  payload: any;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

/**
 * LLM request configuration
 */
export interface LLMRequest {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  context?: Record<string, any>;
}

/**
 * LLM response structure
 */
export interface LLMResponse {
  content: string;
  model: string;
  tokensUsed: number;
  requestId: string;
}

/**
 * Synthesis templates for different insight types
 */
const SYNTHESIS_TEMPLATES = {
  overview: {
    system: `You are an expert group dynamics analyst. Your role is to synthesize complex analytical data into clear, actionable insights for groups. Focus on practical implications and positive framing while being honest about challenges.`,
    prompt: `Analyze the following group assessment data and provide a comprehensive overview:

Group Size: {memberCount} members
Data Completeness: {dataCompleteness}%
Overall Confidence: {overallConfidence}%
Average Compatibility: {avgCompatibility}%
Collective Strengths: {strengthCount}
Risk Areas: {riskCount}

Key Data Points:
{dataPoints}

Please provide:
1. A 2-3 paragraph executive summary of the group's dynamics
2. The most significant insight about this group
3. The group's superpower (greatest collective strength)
4. The primary area for growth
5. A motivating message for the group

Keep the tone professional yet warm, focusing on potential and growth opportunities.`
  },

  compatibility: {
    system: `You are a relationship dynamics expert. Explain compatibility patterns in groups with empathy and practical wisdom.`,
    prompt: `Analyze this compatibility data for a {groupType} group:

Compatibility Matrix Summary:
- Average compatibility: {avgCompatibility}%
- Highest compatibility pair: {highestPair} at {highestScore}%
- Lowest compatibility pair: {lowestPair} at {lowestScore}%
- Compatibility clusters: {clusters}

Please provide:
1. A narrative explaining what these compatibility scores mean for daily interactions
2. Specific strengths in how this group connects
3. Potential friction points to be aware of
4. Practical strategies for leveraging high compatibility
5. Compassionate guidance for lower compatibility pairs`
  },

  strengths: {
    system: `You are a team development coach. Help groups understand and leverage their collective strengths.`,
    prompt: `Analyze these collective strengths for a group:

Top Collective Strengths:
{strengthsList}

Prevalence data:
{prevalenceData}

Please provide:
1. A narrative about what makes this group special
2. How these strengths complement each other
3. Real-world scenarios where these strengths shine
4. Potential blind spots from these strengths
5. Ways to maximize these collective abilities`
  },

  conflicts: {
    system: `You are a conflict resolution specialist. Help groups understand and navigate potential conflicts constructively.`,
    prompt: `Analyze these conflict risks for a group:

Identified Risks:
{risksList}

Severity Distribution:
- Critical: {criticalCount}
- High: {highCount}
- Medium: {mediumCount}
- Low: {lowCount}

Please provide:
1. A compassionate overview of the conflict landscape
2. The root causes behind the top risks
3. Early warning signs to watch for
4. Proactive strategies for each major risk
5. A framework for healthy conflict resolution`
  },

  recommendations: {
    system: `You are a group development strategist. Provide actionable recommendations for group improvement.`,
    prompt: `Based on this comprehensive group analysis:

Strengths: {topStrengths}
Challenges: {topChallenges}
Opportunities: {opportunities}
Risks: {risks}

Provide:
1. Top 5 specific, actionable recommendations
2. A 30-60-90 day improvement plan
3. Success metrics to track progress
4. Quick wins for immediate implementation
5. Long-term vision for group development`
  }
};

export class DINALLMConnector {
  private logger: Logger;
  private dinaUrl: string;
  private apiKey: string;
  private timeout: number;
  private maxRetries: number;
  private instanceId: string;

  constructor() {
    this.logger = new Logger('DINALLMConnector');
    
    // Configuration from environment
    this.dinaUrl = process.env.DINA_URL || 'https://theundergroundrailroad.world:8445';
    this.apiKey = process.env.DINA_API_KEY || '';
    this.timeout = parseInt(process.env.DINA_TIMEOUT || '30000');
    this.maxRetries = parseInt(process.env.DINA_MAX_RETRIES || '3');
    this.instanceId = `mirror-${process.env.NODE_ENV || 'prod'}-${Date.now()}`;

    this.logger.info('DINA DUMP Connector initialized', {
      url: this.dinaUrl,
      timeout: this.timeout,
      instanceId: this.instanceId
    });
  }

  /**
   * Create DUMP message wrapper
   */
  private createDUMPMessage(
    action: string,
    payload: any,
    endpoint: string = 'llm/generate'
  ): DUMPMessage {
    return {
      version: '1.0',
      messageId: uuidv4(),
      timestamp: new Date().toISOString(),
      sender: {
        service: 'mirror',
        instance: this.instanceId
      },
      recipient: {
        service: 'dina',
        endpoint
      },
      messageType: 'REQUEST',
      action,
      payload,
      metadata: {
        priority: 5,
        timeout: this.timeout,
        retryCount: 0
      }
    };
  }

  /**
   * Send DUMP message to DINA
   */
  private async sendDUMPMessage(message: DUMPMessage): Promise<DUMPResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.dinaUrl}/api/dump/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DUMP-Protocol': '1.0',
          'X-Service-ID': 'mirror',
          'X-Instance-ID': this.instanceId,
          ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
        },
        body: JSON.stringify(message),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`DINA responded with ${response.status}: ${response.statusText}`);
      }

      const dumpResponse: DUMPResponse = await response.json();

      if (dumpResponse.status === 'ERROR') {
        throw new Error(dumpResponse.error?.message || 'DUMP request failed');
      }

      return dumpResponse;

    } catch (error: any) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      
      throw error;
    }
  }

  /**
   * Synthesize insights from group analysis
   */
  public async synthesizeInsights(
    analysisResult: GroupAnalysisResult
  ): Promise<LLMSynthesis> {
    const startTime = Date.now();

    try {
      // Prepare data for synthesis
      const contextData = this.prepareContextData(analysisResult);

      // Generate different narrative sections using DUMP
      const [overview, compatibility, strengths, challenges, opportunities] = await Promise.all([
        this.generateOverview(contextData),
        this.generateCompatibilityNarrative(contextData),
        this.generateStrengthsNarrative(contextData),
        this.generateChallengesNarrative(contextData),
        this.generateRecommendations(contextData)
      ]);

      // Extract key insights
      const keyInsights = this.extractKeyInsights(analysisResult);

      // Extract recommendations
      const recommendations = this.extractRecommendations(analysisResult);

      const synthesis: LLMSynthesis = {
        overview,
        keyInsights,
        recommendations,
        narratives: {
          compatibility,
          strengths,
          challenges,
          opportunities
        }
      };

      const processingTime = Date.now() - startTime;
      this.logger.info('Synthesis completed', {
        groupId: analysisResult.groupId,
        processingTime
      });

      return synthesis;

    } catch (error) {
      this.logger.error('Synthesis failed', error);
      
      // Return fallback synthesis
      return this.generateFallbackSynthesis(analysisResult);
    }
  }

  /**
   * Generate overview narrative
   */
  private async generateOverview(contextData: any): Promise<string> {
    const template = SYNTHESIS_TEMPLATES.overview;
    
    const prompt = this.fillTemplate(template.prompt, {
      memberCount: contextData.memberCount,
      dataCompleteness: Math.round(contextData.dataCompleteness * 100),
      overallConfidence: Math.round(contextData.overallConfidence * 100),
      avgCompatibility: Math.round(contextData.avgCompatibility * 100),
      strengthCount: contextData.strengths.length,
      riskCount: contextData.risks.length,
      dataPoints: this.formatDataPoints(contextData)
    });

    const response = await this.callLLMViaDUMP({
      prompt,
      systemPrompt: template.system,
      temperature: 0.7,
      maxTokens: 500
    });

    return response.content;
  }

  /**
   * Generate compatibility narrative
   */
  private async generateCompatibilityNarrative(contextData: any): Promise<string> {
    if (!contextData.compatibilityMatrix) {
      return 'Compatibility analysis pending sufficient member data.';
    }

    const template = SYNTHESIS_TEMPLATES.compatibility;
    const matrix = contextData.compatibilityMatrix;
    
    // Find highest and lowest pairs
    let highest = { pair: '', score: 0 };
    let lowest = { pair: '', score: 1 };
    
    matrix.pairwiseDetails.forEach((detail: any, key: string) => {
      if (detail.score > highest.score) {
        highest = { pair: key, score: detail.score };
      }
      if (detail.score < lowest.score) {
        lowest = { pair: key, score: detail.score };
      }
    });

    const prompt = this.fillTemplate(template.prompt, {
      groupType: contextData.groupType || 'collaborative',
      avgCompatibility: Math.round(matrix.averageCompatibility * 100),
      highestPair: highest.pair,
      highestScore: Math.round(highest.score * 100),
      lowestPair: lowest.pair,
      lowestScore: Math.round(lowest.score * 100),
      clusters: matrix.visualization.clusterGroups?.length || 0
    });

    const response = await this.callLLMViaDUMP({
      prompt,
      systemPrompt: template.system,
      temperature: 0.7,
      maxTokens: 400
    });

    return response.content;
  }

  /**
   * Generate strengths narrative
   */
  private async generateStrengthsNarrative(contextData: any): Promise<string> {
    if (!contextData.strengths || contextData.strengths.length === 0) {
      return 'Collective strengths analysis requires more shared member data.';
    }

    const template = SYNTHESIS_TEMPLATES.strengths;
    
    const strengthsList = contextData.strengths
      .slice(0, 5)
      .map((s: any) => `- ${s.name}: ${Math.round(s.prevalence * 100)}% of group (${s.description})`)
      .join('\n');

    const prevalenceData = contextData.strengths
      .map((s: any) => `${s.name}: ${s.memberCount}/${contextData.memberCount} members`)
      .join(', ');

    const prompt = this.fillTemplate(template.prompt, {
      strengthsList,
      prevalenceData
    });

    const response = await this.callLLMViaDUMP({
      prompt,
      systemPrompt: template.system,
      temperature: 0.7,
      maxTokens: 400
    });

    return response.content;
  }

  /**
   * Generate challenges narrative
   */
  private async generateChallengesNarrative(contextData: any): Promise<string> {
    if (!contextData.risks || contextData.risks.length === 0) {
      return 'No significant conflict risks identified. The group shows healthy dynamics.';
    }

    const template = SYNTHESIS_TEMPLATES.conflicts;
    
    const risksList = contextData.risks
      .slice(0, 5)
      .map((r: any) => `- ${r.type} (${r.severity}): ${r.description}`)
      .join('\n');

    const severityCounts = {
      critical: contextData.risks.filter((r: any) => r.severity === 'critical').length,
      high: contextData.risks.filter((r: any) => r.severity === 'high').length,
      medium: contextData.risks.filter((r: any) => r.severity === 'medium').length,
      low: contextData.risks.filter((r: any) => r.severity === 'low').length
    };

    const prompt = this.fillTemplate(template.prompt, {
      risksList,
      criticalCount: severityCounts.critical,
      highCount: severityCounts.high,
      mediumCount: severityCounts.medium,
      lowCount: severityCounts.low
    });

    const response = await this.callLLMViaDUMP({
      prompt,
      systemPrompt: template.system,
      temperature: 0.7,
      maxTokens: 400
    });

    return response.content;
  }

  /**
   * Generate recommendations
   */
  private async generateRecommendations(contextData: any): Promise<string> {
    const template = SYNTHESIS_TEMPLATES.recommendations;
    
    const topStrengths = contextData.strengths
      .slice(0, 3)
      .map((s: any) => s.name)
      .join(', ');

    const topChallenges = contextData.risks
      .slice(0, 3)
      .map((r: any) => r.type)
      .join(', ');

    const opportunities = this.identifyOpportunities(contextData);
    const risks = contextData.risks.map((r: any) => r.type).join(', ');

    const prompt = this.fillTemplate(template.prompt, {
      topStrengths: topStrengths || 'Various strengths identified',
      topChallenges: topChallenges || 'Minor areas for improvement',
      opportunities,
      risks: risks || 'Minimal risks'
    });

    const response = await this.callLLMViaDUMP({
      prompt,
      systemPrompt: template.system,
      temperature: 0.8,
      maxTokens: 500
    });

    return response.content;
  }

  /**
   * Call LLM via DUMP protocol
   */
  private async callLLMViaDUMP(request: LLMRequest): Promise<LLMResponse> {
    const requestId = uuidv4();
    let attempts = 0;

    while (attempts < this.maxRetries) {
      try {
        attempts++;

        // Create DUMP message for LLM request
        const dumpMessage = this.createDUMPMessage(
          'LLM_GENERATE',
          {
            requestId,
            prompt: request.prompt,
            systemPrompt: request.systemPrompt,
            temperature: request.temperature || 0.7,
            maxTokens: request.maxTokens || 500,
            model: request.model || 'gpt-4',
            context: request.context
          },
          'llm/generate'
        );

        // Update retry count in metadata
        dumpMessage.metadata!.retryCount = attempts - 1;

        // Send via DUMP
        const response = await this.sendDUMPMessage(dumpMessage);

        // Extract content from DUMP response
        return {
          content: response.payload?.content || response.payload?.text || '',
          model: response.payload?.model || 'gpt-4',
          tokensUsed: response.payload?.tokensUsed || 0,
          requestId
        };

      } catch (error: any) {
        this.logger.warn(`LLM call attempt ${attempts} failed`, {
          requestId,
          error: error.message
        });

        if (attempts >= this.maxRetries) {
          throw error;
        }

        // Exponential backoff
        await this.delay(Math.pow(2, attempts) * 1000);
      }
    }

    throw new Error('Max retries exceeded for LLM call');
  }

  /**
   * Prepare context data for LLM
   */
  private prepareContextData(result: GroupAnalysisResult): any {
    return {
      memberCount: result.memberCount,
      dataCompleteness: result.dataCompleteness,
      overallConfidence: result.metadata.overallConfidence,
      avgCompatibility: result.insights.compatibilityMatrix?.averageCompatibility || 0,
      compatibilityMatrix: result.insights.compatibilityMatrix,
      strengths: result.insights.collectiveStrengths || [],
      risks: result.insights.conflictRisks || [],
      goalAlignment: result.insights.goalAlignment,
      groupType: this.inferGroupType(result)
    };
  }

  /**
   * Extract key insights from analysis
   */
  private extractKeyInsights(result: GroupAnalysisResult): string[] {
    const insights: string[] = [];

    // Compatibility insight
    if (result.insights.compatibilityMatrix) {
      const avg = result.insights.compatibilityMatrix.averageCompatibility;
      if (avg > 0.8) {
        insights.push(`Exceptionally high group compatibility (${Math.round(avg * 100)}%) suggests natural harmony`);
      } else if (avg < 0.5) {
        insights.push(`Lower compatibility scores indicate need for intentional relationship building`);
      }
    }

    // Strength insight
    if (result.insights.collectiveStrengths && result.insights.collectiveStrengths.length > 0) {
      const topStrength = result.insights.collectiveStrengths[0];
      insights.push(`"${topStrength.name}" is a defining group strength present in ${Math.round(topStrength.prevalence * 100)}% of members`);
    }

    // Risk insight
    if (result.insights.conflictRisks) {
      const critical = result.insights.conflictRisks.filter(r => r.severity === 'critical');
      if (critical.length > 0) {
        insights.push(`${critical.length} critical risk area${critical.length > 1 ? 's require' : ' requires'} immediate attention`);
      }
    }

    // Goal alignment insight
    if (result.insights.goalAlignment) {
      const alignment = result.insights.goalAlignment.overallAlignment;
      if (alignment > 0.7) {
        insights.push(`Strong goal alignment (${Math.round(alignment * 100)}%) provides clear direction`);
      }
    }

    // Diversity insight
    if (result.memberCount > 3) {
      insights.push(`Group size of ${result.memberCount} enables diverse perspectives while maintaining cohesion`);
    }

    return insights;
  }

  /**
   * Extract recommendations from analysis
   */
  private extractRecommendations(result: GroupAnalysisResult): string[] {
    const recommendations: string[] = [];

    // Based on compatibility
    if (result.insights.compatibilityMatrix) {
      const avg = result.insights.compatibilityMatrix.averageCompatibility;
      if (avg < 0.6) {
        recommendations.push('Schedule regular team-building activities to improve group cohesion');
      }
    }

    // Based on risks
    if (result.insights.conflictRisks) {
      const topRisk = result.insights.conflictRisks[0];
      if (topRisk && topRisk.mitigationStrategies.length > 0) {
        recommendations.push(topRisk.mitigationStrategies[0]);
      }
    }

    // Based on strengths
    if (result.insights.collectiveStrengths && result.insights.collectiveStrengths.length > 0) {
      const strength = result.insights.collectiveStrengths[0];
      recommendations.push(`Leverage your collective "${strength.name}" strength in ${strength.applications[0]}`);
    }

    // Based on goal alignment
    if (result.insights.goalAlignment) {
      if (result.insights.goalAlignment.divergentGoals.length > 3) {
        recommendations.push('Facilitate a goal-alignment workshop to find common ground');
      }
    }

    // General recommendations
    recommendations.push('Maintain regular group check-ins to track progress');
    recommendations.push('Celebrate wins together to reinforce positive dynamics');

    return recommendations.slice(0, 5);
  }

  /**
   * Generate fallback synthesis when LLM is unavailable
   */
  private generateFallbackSynthesis(result: GroupAnalysisResult): LLMSynthesis {
    const overview = `This group of ${result.memberCount} members shows ${
      result.dataCompleteness > 0.7 ? 'comprehensive' : 'developing'
    } shared data with ${Math.round(result.metadata.overallConfidence * 100)}% analysis confidence. `;

    const keyInsights = this.extractKeyInsights(result);
    const recommendations = this.extractRecommendations(result);

    let compatibilityNarrative = '';
    if (result.insights.compatibilityMatrix) {
      const avg = Math.round(result.insights.compatibilityMatrix.averageCompatibility * 100);
      compatibilityNarrative = `The group shows ${avg}% average compatibility, indicating ${
        avg > 70 ? 'strong natural alignment' : 'opportunities for relationship building'
      }.`;
    }

    let strengthsNarrative = '';
    if (result.insights.collectiveStrengths && result.insights.collectiveStrengths.length > 0) {
      const strengths = result.insights.collectiveStrengths
        .slice(0, 3)
        .map(s => s.name)
        .join(', ');
      strengthsNarrative = `Key collective strengths include: ${strengths}.`;
    }

    let challengesNarrative = '';
    if (result.insights.conflictRisks && result.insights.conflictRisks.length > 0) {
      const riskCount = result.insights.conflictRisks.length;
      challengesNarrative = `${riskCount} potential conflict area${
        riskCount > 1 ? 's have' : ' has'
      } been identified for proactive management.`;
    }

    return {
      overview,
      keyInsights,
      recommendations,
      narratives: {
        compatibility: compatibilityNarrative,
        strengths: strengthsNarrative,
        challenges: challengesNarrative,
        opportunities: 'Focus on building trust and leveraging collective strengths.'
      }
    };
  }

  /**
   * Infer group type from metadata
   */
  private inferGroupType(result: GroupAnalysisResult): string {
    // This would normally come from the group's type field
    // For now, infer based on size and patterns
    if (result.memberCount <= 5) return 'family';
    if (result.memberCount <= 10) return 'team';
    return 'organization';
  }

  /**
   * Fill template with data
   */
  private fillTemplate(template: string, data: Record<string, any>): string {
    let filled = template;
    
    Object.keys(data).forEach(key => {
      const regex = new RegExp(`{${key}}`, 'g');
      filled = filled.replace(regex, String(data[key]));
    });
    
    return filled;
  }

  /**
   * Format data points for LLM consumption
   */
  private formatDataPoints(contextData: any): string {
    const points: string[] = [];

    if (contextData.strengths.length > 0) {
      points.push(`Top strengths: ${contextData.strengths.slice(0, 3).map((s: any) => s.name).join(', ')}`);
    }

    if (contextData.risks.length > 0) {
      points.push(`Risk areas: ${contextData.risks.slice(0, 3).map((r: any) => r.type).join(', ')}`);
    }

    if (contextData.goalAlignment) {
      points.push(`Goal alignment: ${Math.round(contextData.goalAlignment.overallAlignment * 100)}%`);
    }

    return points.join('\n');
  }

  /**
   * Identify opportunities from analysis
   */
  private identifyOpportunities(contextData: any): string {
    const opportunities: string[] = [];

    // High compatibility = collaboration opportunity
    if (contextData.avgCompatibility > 0.8) {
      opportunities.push('Deep collaboration potential');
    }

    // Strong strengths = leverage opportunity
    if (contextData.strengths.length > 5) {
      opportunities.push('Multiple strength areas to leverage');
    }

    // Low risks = growth opportunity  
    if (contextData.risks.filter((r: any) => r.severity === 'high' || r.severity === 'critical').length === 0) {
      opportunities.push('Stable foundation for ambitious goals');
    }

    return opportunities.join(', ') || 'Continuous improvement';
  }

  /**
   * Delay helper for retries
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Test connection to DINA
   */
  public async testConnection(): Promise<boolean> {
    try {
      const testMessage = this.createDUMPMessage(
        'HEALTH_CHECK',
        { timestamp: Date.now() },
        'health/check'
      );

      const response = await this.sendDUMPMessage(testMessage);
      return response.status === 'SUCCESS';
    } catch (error) {
      this.logger.error('DINA connection test failed', error);
      return false;
    }
  }
}

// Export singleton instance
export default new DINALLMConnector();
