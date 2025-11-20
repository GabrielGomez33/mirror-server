/**
 * CollectiveStrengthDetector - Group-wide Pattern Recognition
 * 
 * Identifies collective strengths, behavioral patterns, and shared traits
 * across group members. Detects patterns present in ≥60% of members
 * with individual likelihood >0.7.
 * 
 * @module analyzers/CollectiveStrengthDetector
 */

import { v4 as uuidv4 } from 'uuid';
import { MemberData, CollectiveStrength } from './GroupAnalyzer';
import { Logger } from '../utils/logger';

/**
 * Behavioral pattern categories and their applications
 */
const PATTERN_APPLICATIONS: Record<string, string[]> = {
  // Communication patterns
  'active_listening': ['team_meetings', 'conflict_resolution', 'customer_service', 'mentoring'],
  'clear_articulation': ['presentations', 'documentation', 'teaching', 'leadership'],
  'emotional_validation': ['support', 'team_building', 'counseling', 'relationships'],
  'constructive_feedback': ['performance_reviews', 'project_improvement', 'skill_development'],
  
  // Collaboration patterns
  'consensus_building': ['decision_making', 'project_planning', 'team_alignment'],
  'resource_sharing': ['knowledge_transfer', 'skill_development', 'efficiency'],
  'inclusive_behavior': ['team_diversity', 'innovation', 'morale'],
  'conflict_mediation': ['dispute_resolution', 'team_harmony', 'productivity'],
  
  // Leadership patterns
  'initiative_taking': ['project_kickoff', 'problem_solving', 'innovation'],
  'delegation': ['workload_management', 'team_development', 'scaling'],
  'strategic_thinking': ['planning', 'goal_setting', 'vision_development'],
  'motivating_others': ['team_performance', 'engagement', 'retention'],
  
  // Problem-solving patterns
  'analytical_thinking': ['root_cause_analysis', 'data_interpretation', 'optimization'],
  'creative_solutions': ['innovation', 'product_development', 'process_improvement'],
  'systematic_approach': ['project_management', 'quality_assurance', 'implementation'],
  'rapid_adaptation': ['crisis_management', 'agile_development', 'change_management'],
  
  // Interpersonal patterns
  'empathy': ['customer_relations', 'team_support', 'user_experience'],
  'trust_building': ['partnerships', 'client_relations', 'team_cohesion'],
  'boundary_setting': ['work_life_balance', 'professional_relationships', 'productivity'],
  'cultural_sensitivity': ['global_teams', 'diversity', 'inclusion']
};

/**
 * Strength type classifications
 */
const PATTERN_TYPES: Record<string, 'behavioral' | 'cognitive' | 'value' | 'skill'> = {
  // Behavioral
  'active_listening': 'behavioral',
  'emotional_validation': 'behavioral',
  'inclusive_behavior': 'behavioral',
  'empathy': 'behavioral',
  'trust_building': 'behavioral',
  'boundary_setting': 'behavioral',
  
  // Cognitive
  'analytical_thinking': 'cognitive',
  'strategic_thinking': 'cognitive',
  'creative_solutions': 'cognitive',
  'systematic_approach': 'cognitive',
  
  // Values
  'consensus_building': 'value',
  'resource_sharing': 'value',
  'cultural_sensitivity': 'value',
  
  // Skills
  'clear_articulation': 'skill',
  'constructive_feedback': 'skill',
  'delegation': 'skill',
  'conflict_mediation': 'skill'
};

export class CollectiveStrengthDetector {
  private logger: Logger;
  private readonly MIN_PREVALENCE = 0.6;  // 60% of group
  private readonly MIN_LIKELIHOOD = 0.7;  // 70% individual strength
  private readonly MIN_GROUP_SIZE = 2;    // Minimum members for pattern

  constructor() {
    this.logger = new Logger('CollectiveStrengthDetector');
  }

  /**
   * Detect collective strengths in the group
   */
  public async detectStrengths(memberData: MemberData[]): Promise<CollectiveStrength[]> {
    const startTime = Date.now();
    
    if (memberData.length < this.MIN_GROUP_SIZE) {
      this.logger.warn('Insufficient members for pattern detection', {
        members: memberData.length,
        required: this.MIN_GROUP_SIZE
      });
      return [];
    }
    
    // Collect all patterns
    const behavioralPatterns = this.detectBehavioralPatterns(memberData);
    const cognitivePatterns = this.detectCognitivePatterns(memberData);
    const valuePatterns = this.detectValuePatterns(memberData);
    const emergentPatterns = this.detectEmergentPatterns(memberData);
    
    // Combine and rank patterns
    const allPatterns = [
      ...behavioralPatterns,
      ...cognitivePatterns,
      ...valuePatterns,
      ...emergentPatterns
    ];
    
    // Sort by prevalence and strength
    allPatterns.sort((a, b) => {
      const scoreA = a.prevalence * a.strength * a.confidence;
      const scoreB = b.prevalence * b.strength * b.confidence;
      return scoreB - scoreA;
    });
    
    // Add descriptions and applications
    const enrichedPatterns = allPatterns.map(pattern => 
      this.enrichPattern(pattern, memberData.length)
    );
    
    const processingTime = Date.now() - startTime;
    this.logger.info('Strength detection completed', {
      members: memberData.length,
      patternsFound: enrichedPatterns.length,
      processingTime
    });
    
    return enrichedPatterns;
  }

  /**
   * Detect behavioral patterns across members
   */
  private detectBehavioralPatterns(memberData: MemberData[]): CollectiveStrength[] {
    const patternCounts = new Map<string, {
      count: number;
      totalLikelihood: number;
      members: string[];
    }>();
    
    // Count behavioral tendencies
    memberData.forEach(member => {
      if (!member.behavioral?.tendencies) return;
      
      member.behavioral.tendencies.forEach(tendency => {
        if (tendency.likelihood >= this.MIN_LIKELIHOOD) {
          const pattern = this.normalizeBehaviorName(tendency.behavior);
          
          if (!patternCounts.has(pattern)) {
            patternCounts.set(pattern, {
              count: 0,
              totalLikelihood: 0,
              members: []
            });
          }
          
          const data = patternCounts.get(pattern)!;
          data.count++;
          data.totalLikelihood += tendency.likelihood;
          data.members.push(member.userId);
        }
      });
    });
    
    // Filter by prevalence threshold
    const patterns: CollectiveStrength[] = [];
    const threshold = memberData.length * this.MIN_PREVALENCE;
    
    patternCounts.forEach((data, behavior) => {
      if (data.count >= threshold) {
        const prevalence = data.count / memberData.length;
        const avgLikelihood = data.totalLikelihood / data.count;
        
        patterns.push({
          id: uuidv4(),
          name: behavior,
          type: PATTERN_TYPES[behavior] || 'behavioral',
          prevalence,
          strength: avgLikelihood,
          description: '', // Will be enriched
          memberCount: data.count,
          applications: PATTERN_APPLICATIONS[behavior] || [],
          confidence: this.calculateConfidence(prevalence, avgLikelihood, data.count)
        });
      }
    });
    
    return patterns;
  }

  /**
   * Detect cognitive patterns
   */
  private detectCognitivePatterns(memberData: MemberData[]): CollectiveStrength[] {
    const patterns: CollectiveStrength[] = [];
    const styleCounters = new Map<string, Set<string>>();
    
    // Count cognitive styles
    memberData.forEach(member => {
      if (!member.cognitive) return;
      
      const styles = [
        member.cognitive.problemSolvingStyle,
        member.cognitive.decisionMakingStyle,
        member.cognitive.learningStyle
      ].filter(Boolean);
      
      styles.forEach(style => {
        if (!styleCounters.has(style!)) {
          styleCounters.set(style!, new Set());
        }
        styleCounters.get(style!)!.add(member.userId);
      });
    });
    
    // Check for dominant cognitive patterns
    const threshold = memberData.length * this.MIN_PREVALENCE;
    
    styleCounters.forEach((members, style) => {
      if (members.size >= threshold) {
        const prevalence = members.size / memberData.length;
        
        patterns.push({
          id: uuidv4(),
          name: `${style}_thinking`,
          type: 'cognitive',
          prevalence,
          strength: 0.8, // Default strength for style-based patterns
          description: '',
          memberCount: members.size,
          applications: this.getCognitiveApplications(style),
          confidence: this.calculateConfidence(prevalence, 0.8, members.size)
        });
      }
    });
    
    return patterns;
  }

  /**
   * Detect shared values and motivations
   */
  private detectValuePatterns(memberData: MemberData[]): CollectiveStrength[] {
    const patterns: CollectiveStrength[] = [];
    const valueCounters = new Map<string, {
      members: Set<string>;
      totalStrength: number;
    }>();
    
    // Count shared values and motivations
    memberData.forEach(member => {
      if (!member.values) return;
      
      // Core values
      member.values.core?.forEach(value => {
        if (!valueCounters.has(value)) {
          valueCounters.set(value, {
            members: new Set(),
            totalStrength: 0
          });
        }
        valueCounters.get(value)!.members.add(member.userId);
        valueCounters.get(value)!.totalStrength += 1.0;
      });
      
      // Motivation drivers
      member.values.motivationDrivers?.forEach(driver => {
        if (driver.strength >= this.MIN_LIKELIHOOD) {
          const key = `motivation_${driver.driver}`;
          if (!valueCounters.has(key)) {
            valueCounters.set(key, {
              members: new Set(),
              totalStrength: 0
            });
          }
          valueCounters.get(key)!.members.add(member.userId);
          valueCounters.get(key)!.totalStrength += driver.strength;
        }
      });
    });
    
    // Filter by threshold
    const threshold = memberData.length * this.MIN_PREVALENCE;
    
    valueCounters.forEach((data, value) => {
      if (data.members.size >= threshold) {
        const prevalence = data.members.size / memberData.length;
        const avgStrength = data.totalStrength / data.members.size;
        
        patterns.push({
          id: uuidv4(),
          name: value,
          type: 'value',
          prevalence,
          strength: avgStrength,
          description: '',
          memberCount: data.members.size,
          applications: this.getValueApplications(value),
          confidence: this.calculateConfidence(prevalence, avgStrength, data.members.size)
        });
      }
    });
    
    return patterns;
  }

  /**
   * Detect emergent patterns (combinations of traits)
   */
  private detectEmergentPatterns(memberData: MemberData[]): CollectiveStrength[] {
    const patterns: CollectiveStrength[] = [];
    
    // Detect "High Performing Team" pattern
    const highPerformers = memberData.filter(member => {
      const hasInitiative = this.memberHasTendency(member, 'initiative_taking');
      const hasAccountability = this.memberHasTendency(member, 'accountability');
      const hasCollaboration = this.memberHasTendency(member, 'collaboration');
      
      return hasInitiative && hasAccountability && hasCollaboration;
    });
    
    if (highPerformers.length >= memberData.length * this.MIN_PREVALENCE) {
      patterns.push({
        id: uuidv4(),
        name: 'high_performing_team',
        type: 'behavioral',
        prevalence: highPerformers.length / memberData.length,
        strength: 0.85,
        description: 'Group exhibits high-performance team characteristics',
        memberCount: highPerformers.length,
        applications: ['project_execution', 'goal_achievement', 'innovation'],
        confidence: 0.9
      });
    }
    
    // Detect "Creative Collective" pattern
    const creatives = memberData.filter(member => {
      const hasCreativity = this.memberHasTendency(member, 'creative_solutions');
      const hasOpenness = this.memberHasTendency(member, 'openness');
      const hasDivergent = member.cognitive?.problemSolvingStyle === 'divergent';
      
      return hasCreativity || (hasOpenness && hasDivergent);
    });
    
    if (creatives.length >= memberData.length * this.MIN_PREVALENCE) {
      patterns.push({
        id: uuidv4(),
        name: 'creative_collective',
        type: 'cognitive',
        prevalence: creatives.length / memberData.length,
        strength: 0.8,
        description: 'Group shows strong creative and innovative tendencies',
        memberCount: creatives.length,
        applications: ['brainstorming', 'product_development', 'problem_solving'],
        confidence: 0.85
      });
    }
    
    // Detect "Emotionally Intelligent" pattern
    const emotionallyIntelligent = memberData.filter(member => {
      const hasEmpathy = member.behavioral?.empathyLevel ? 
        member.behavioral.empathyLevel > 70 : false;
      const hasEmotionalValidation = this.memberHasTendency(member, 'emotional_validation');
      const hasActiveListening = this.memberHasTendency(member, 'active_listening');
      
      return hasEmpathy || (hasEmotionalValidation && hasActiveListening);
    });
    
    if (emotionallyIntelligent.length >= memberData.length * this.MIN_PREVALENCE) {
      patterns.push({
        id: uuidv4(),
        name: 'emotional_intelligence',
        type: 'behavioral',
        prevalence: emotionallyIntelligent.length / memberData.length,
        strength: 0.82,
        description: 'Group demonstrates high emotional intelligence',
        memberCount: emotionallyIntelligent.length,
        applications: ['team_support', 'client_relations', 'conflict_resolution'],
        confidence: 0.88
      });
    }
    
    return patterns;
  }

  /**
   * Check if member has a specific behavioral tendency
   */
  private memberHasTendency(
    member: MemberData,
    behavior: string,
    minLikelihood: number = this.MIN_LIKELIHOOD
  ): boolean {
    if (!member.behavioral?.tendencies) return false;
    
    return member.behavioral.tendencies.some(t => 
      this.normalizeBehaviorName(t.behavior) === behavior &&
      t.likelihood >= minLikelihood
    );
  }

  /**
   * Normalize behavior names for consistency
   */
  private normalizeBehaviorName(behavior: string): string {
    return behavior
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
  }

  /**
   * Enrich pattern with description
   */
  private enrichPattern(
    pattern: CollectiveStrength,
    totalMembers: number
  ): CollectiveStrength {
    const percentage = Math.round(pattern.prevalence * 100);
    const strengthLevel = this.getStrengthLevel(pattern.strength);
    
    // Generate description based on pattern type
    let description = '';
    
    switch (pattern.type) {
      case 'behavioral':
        description = `${percentage}% of the group consistently demonstrates ${
          this.humanizeName(pattern.name)
        } behavior (${strengthLevel} strength). This collective tendency creates a strong foundation for ${
          pattern.applications[0] || 'group activities'
        }.`;
        break;
        
      case 'cognitive':
        description = `${percentage}% of members share a ${
          this.humanizeName(pattern.name)
        } cognitive style, indicating aligned thinking patterns that enhance ${
          pattern.applications[0] || 'problem-solving'
        }.`;
        break;
        
      case 'value':
        description = `${pattern.memberCount} out of ${totalMembers} members share ${
          this.humanizeName(pattern.name)
        } as a core value or motivation, creating strong alignment in ${
          pattern.applications[0] || 'group goals'
        }.`;
        break;
        
      case 'skill':
        description = `The group shows collective competence in ${
          this.humanizeName(pattern.name)
        }, with ${percentage}% demonstrating this skill at ${
          strengthLevel
        } proficiency.`;
        break;
    }
    
    pattern.description = description;
    return pattern;
  }

  /**
   * Calculate confidence score for a pattern
   */
  private calculateConfidence(
    prevalence: number,
    strength: number,
    memberCount: number
  ): number {
    // Higher confidence with:
    // - Higher prevalence (more members have it)
    // - Higher strength (stronger when present)
    // - More members (larger sample size)
    
    const prevalenceScore = prevalence;
    const strengthScore = strength;
    const sampleSizeScore = Math.min(memberCount / 10, 1); // Cap at 10 members
    
    // Weighted average
    const confidence = (
      prevalenceScore * 0.4 +
      strengthScore * 0.4 +
      sampleSizeScore * 0.2
    );
    
    return Math.min(confidence, 0.95); // Cap at 95%
  }

  /**
   * Get cognitive applications based on style
   */
  private getCognitiveApplications(style: string): string[] {
    const applications: Record<string, string[]> = {
      'analytical': ['data_analysis', 'research', 'optimization', 'quality_control'],
      'intuitive': ['innovation', 'vision_development', 'pattern_recognition'],
      'practical': ['implementation', 'execution', 'troubleshooting'],
      'creative': ['design', 'brainstorming', 'content_creation'],
      'systematic': ['process_improvement', 'documentation', 'standardization'],
      'adaptive': ['change_management', 'crisis_response', 'agile_development']
    };
    
    return applications[style] || ['problem_solving', 'decision_making'];
  }

  /**
   * Get value applications
   */
  private getValueApplications(value: string): string[] {
    const applications: Record<string, string[]> = {
      'integrity': ['trust_building', 'ethical_decisions', 'transparency'],
      'innovation': ['product_development', 'process_improvement', 'creativity'],
      'collaboration': ['teamwork', 'partnership', 'knowledge_sharing'],
      'excellence': ['quality', 'continuous_improvement', 'high_standards'],
      'growth': ['learning', 'development', 'adaptation'],
      'motivation_achievement': ['goal_setting', 'performance', 'results'],
      'motivation_affiliation': ['team_building', 'relationships', 'culture'],
      'motivation_power': ['leadership', 'influence', 'change_driving']
    };
    
    return applications[value] || ['group_culture', 'decision_making'];
  }

  /**
   * Get strength level description
   */
  private getStrengthLevel(strength: number): string {
    if (strength >= 0.9) return 'exceptional';
    if (strength >= 0.8) return 'strong';
    if (strength >= 0.7) return 'solid';
    if (strength >= 0.6) return 'moderate';
    return 'developing';
  }

  /**
   * Humanize pattern name for display
   */
  private humanizeName(name: string): string {
    return name
      .replace(/_/g, ' ')
      .replace(/motivation /g, '')
      .replace(/\b\w/g, l => l.toUpperCase());
  }

  /**
   * Identify strength gaps (what the group lacks)
   */
  public identifyGaps(
    detectedStrengths: CollectiveStrength[],
    desiredCapabilities: string[]
  ): string[] {
    const presentStrengths = new Set(detectedStrengths.map(s => s.name));
    
    return desiredCapabilities.filter(capability => 
      !presentStrengths.has(capability)
    );
  }

  /**
   * Calculate diversity index for the group
   */
  public calculateDiversityIndex(memberData: MemberData[]): number {
    // Measure diversity across multiple dimensions
    const dimensions = {
      cognitive: new Set<string>(),
      behavioral: new Set<string>(),
      values: new Set<string>()
    };
    
    memberData.forEach(member => {
      // Cognitive diversity
      if (member.cognitive?.problemSolvingStyle) {
        dimensions.cognitive.add(member.cognitive.problemSolvingStyle);
      }
      
      // Behavioral diversity
      if (member.personality?.conflictResolutionStyle) {
        dimensions.behavioral.add(member.personality.conflictResolutionStyle);
      }
      
      // Value diversity
      member.values?.core?.forEach(value => {
        dimensions.values.add(value);
      });
    });
    
    // Calculate Shannon diversity index for each dimension
    const diversityScores = Object.values(dimensions).map(uniqueValues => {
      if (uniqueValues.size <= 1) return 0;
      
      const total = memberData.length;
      let shannonIndex = 0;
      
      uniqueValues.forEach(value => {
        const count = memberData.filter(m => 
          this.memberHasAttribute(m, value)
        ).length;
        
        if (count > 0) {
          const proportion = count / total;
          shannonIndex -= proportion * Math.log(proportion);
        }
      });
      
      return shannonIndex;
    });
    
    // Average diversity across dimensions
    const avgDiversity = diversityScores.reduce((a, b) => a + b, 0) / 
      diversityScores.length;
    
    // Normalize to 0-1 scale
    return Math.min(avgDiversity / Math.log(memberData.length), 1);
  }

  /**
   * Check if member has a specific attribute
   */
  private memberHasAttribute(member: MemberData, attribute: string): boolean {
    // Check across all relevant fields
    return (
      member.cognitive?.problemSolvingStyle === attribute ||
      member.cognitive?.decisionMakingStyle === attribute ||
      member.cognitive?.learningStyle === attribute ||
      member.personality?.conflictResolutionStyle === attribute ||
      member.personality?.communicationStyle === attribute ||
      member.values?.core?.includes(attribute) ||
      false
    );
  }

  /**
   * Initialize detector (no-op, for consistency with other components)
   */
  public async initialize(): Promise<void> {
    this.logger.info('Collective Strength Detector initialized');
  }

  /**
   * Shutdown detector (no-op, for consistency with other components)
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Collective Strength Detector shutdown');
  }
}

// Export singleton instance
export const collectiveStrengthDetector = new CollectiveStrengthDetector();
