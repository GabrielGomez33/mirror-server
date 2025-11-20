/**
 * ConflictRiskPredictor - Conflict Risk Assessment for Groups
 * 
 * Identifies potential conflict areas based on:
 * - Resolution style mismatches
 * - Empathy gaps
 * - Energy imbalances
 * - Communication clashes
 * - Value misalignments
 * 
 * @module analyzers/ConflictRiskPredictor
 */

import { v4 as uuidv4 } from 'uuid';
import { MemberData, ConflictRisk } from './GroupAnalyzer';
import { Logger } from '../utils/logger';

/**
 * Risk type definitions and detection thresholds
 */
const RISK_DEFINITIONS = {
  resolution_mismatch: {
    description: 'Incompatible conflict resolution styles',
    threshold: 0.6,
    impact: 0.8
  },
  empathy_gap: {
    description: 'Wide variance in empathy levels',
    threshold: 40, // Point difference
    impact: 0.7
  },
  energy_imbalance: {
    description: 'Extreme differences in social energy needs',
    threshold: 0.8, // Ratio threshold
    impact: 0.6
  },
  communication_clash: {
    description: 'Incompatible communication styles',
    threshold: 0.5,
    impact: 0.7
  },
  value_misalignment: {
    description: 'Conflicting core values or priorities',
    threshold: 0.3, // Overlap threshold
    impact: 0.9
  },
  expectation_divergence: {
    description: 'Different expectations for group participation',
    threshold: 0.5,
    impact: 0.6
  },
  leadership_conflict: {
    description: 'Multiple competing leadership styles',
    threshold: 3, // Number of strong leaders
    impact: 0.8
  },
  work_style_friction: {
    description: 'Incompatible working preferences',
    threshold: 0.6,
    impact: 0.5
  }
};

/**
 * Conflict resolution style incompatibilities
 */
const STYLE_CONFLICTS: Record<string, string[]> = {
  'competing': ['avoiding', 'accommodating'],
  'collaborating': ['avoiding'],
  'compromising': [], // Works with most styles
  'avoiding': ['competing', 'collaborating'],
  'accommodating': ['competing']
};

/**
 * Communication style friction points
 */
const COMMUNICATION_FRICTION: Record<string, string[]> = {
  'direct': ['indirect'],
  'supportive': [], // Generally compatible
  'analytical': ['indirect'],
  'indirect': ['direct', 'analytical']
};

export class ConflictRiskPredictor {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('ConflictRiskPredictor');
  }

  /**
   * Predict conflict risks for the group
   */
  public async predictRisks(memberData: MemberData[]): Promise<ConflictRisk[]> {
    const startTime = Date.now();
    
    if (memberData.length < 2) {
      this.logger.warn('Insufficient members for conflict prediction');
      return [];
    }
    
    const risks: ConflictRisk[] = [];
    
    // Detect various risk types
    risks.push(...this.detectResolutionMismatch(memberData));
    risks.push(...this.detectEmpathyGap(memberData));
    risks.push(...this.detectEnergyImbalance(memberData));
    risks.push(...this.detectCommunicationClash(memberData));
    risks.push(...this.detectValueMisalignment(memberData));
    risks.push(...this.detectExpectationDivergence(memberData));
    risks.push(...this.detectLeadershipConflict(memberData));
    risks.push(...this.detectWorkStyleFriction(memberData));
    
    // Calculate risk scores and sort by severity
    const scoredRisks = risks.map(risk => this.calculateRiskScore(risk));
    scoredRisks.sort((a, b) => b.riskScore - a.riskScore);
    
    // Add mitigation strategies
    const mitigatedRisks = scoredRisks.map(risk => 
      this.addMitigationStrategies(risk, memberData)
    );
    
    const processingTime = Date.now() - startTime;
    this.logger.info('Risk prediction completed', {
      members: memberData.length,
      risksFound: mitigatedRisks.length,
      criticalRisks: mitigatedRisks.filter(r => r.severity === 'critical').length,
      processingTime
    });
    
    return mitigatedRisks;
  }

  /**
   * Detect resolution style mismatches
   */
  private detectResolutionMismatch(memberData: MemberData[]): ConflictRisk[] {
    const risks: ConflictRisk[] = [];
    const styles = new Map<string, string[]>();
    
    // Group members by conflict resolution style
    memberData.forEach(member => {
      const style = member.personality?.conflictResolutionStyle;
      if (style) {
        if (!styles.has(style)) {
          styles.set(style, []);
        }
        styles.get(style)!.push(member.userId);
      }
    });
    
    // Check for incompatible style combinations
    styles.forEach((membersA, styleA) => {
      const conflicts = STYLE_CONFLICTS[styleA] || [];
      
      conflicts.forEach(conflictingStyle => {
        const membersB = styles.get(conflictingStyle);
        if (membersB && membersB.length > 0) {
          const affectedMembers = [...membersA, ...membersB];
          const probability = this.calculateMismatchProbability(
            membersA.length,
            membersB.length,
            memberData.length
          );
          
          risks.push({
            id: uuidv4(),
            type: 'resolution_mismatch',
            severity: this.calculateSeverity(probability, 0.8),
            affectedMembers,
            description: `Group has both ${styleA} (${membersA.length} members) and ${
              conflictingStyle
            } (${membersB.length} members) conflict resolution styles. This can lead to unresolved tensions when ${
              styleA
            } members want to address issues while ${conflictingStyle} members withdraw.`,
            triggers: [
              'Team disagreements',
              'Project conflicts',
              'Resource allocation disputes',
              'Priority setting discussions'
            ],
            mitigationStrategies: [],
            probability,
            impact: 0.8,
            riskScore: 0
          });
        }
      });
    });
    
    return risks;
  }

  /**
   * Detect empathy gaps
   */
  private detectEmpathyGap(memberData: MemberData[]): ConflictRisk[] {
    const risks: ConflictRisk[] = [];
    const empathyLevels: Array<{ userId: string; level: number }> = [];
    
    // Collect empathy levels
    memberData.forEach(member => {
      if (member.behavioral?.empathyLevel !== undefined) {
        empathyLevels.push({
          userId: member.userId,
          level: member.behavioral.empathyLevel
        });
      }
    });
    
    if (empathyLevels.length < 2) return risks;
    
    // Calculate variance
    const levels = empathyLevels.map(e => e.level);
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
    const variance = levels.reduce((sum, level) => 
      sum + Math.pow(level - mean, 2), 0
    ) / levels.length;
    const stdDev = Math.sqrt(variance);
    
    // Check for significant gap
    if (stdDev > RISK_DEFINITIONS.empathy_gap.threshold) {
      // Identify high and low empathy members
      const highEmpathy = empathyLevels
        .filter(e => e.level > mean + stdDev)
        .map(e => e.userId);
      const lowEmpathy = empathyLevels
        .filter(e => e.level < mean - stdDev)
        .map(e => e.userId);
      
      if (highEmpathy.length > 0 && lowEmpathy.length > 0) {
        risks.push({
          id: uuidv4(),
          type: 'empathy_gap',
          severity: this.calculateSeverity(0.7, 0.7),
          affectedMembers: [...highEmpathy, ...lowEmpathy],
          description: `Significant empathy gap detected. ${
            highEmpathy.length
          } members show high empathy (>80) while ${
            lowEmpathy.length
          } members show low empathy (<40). This can lead to misunderstandings and hurt feelings.`,
          triggers: [
            'Emotional discussions',
            'Personal feedback sessions',
            'Support requests',
            'Team bonding activities'
          ],
          mitigationStrategies: [],
          probability: 0.7,
          impact: 0.7,
          riskScore: 0
        });
      }
    }
    
    return risks;
  }

  /**
   * Detect energy imbalances
   */
  private detectEnergyImbalance(memberData: MemberData[]): ConflictRisk[] {
    const risks: ConflictRisk[] = [];
    const energyLevels: number[] = [];
    
    // Collect social energy levels
    memberData.forEach(member => {
      if (member.behavioral?.socialEnergy !== undefined) {
        energyLevels.push(member.behavioral.socialEnergy);
      }
    });
    
    if (energyLevels.length < 3) return risks;
    
    // Check for extreme imbalance
    const highEnergy = energyLevels.filter(e => e > 70).length;
    const lowEnergy = energyLevels.filter(e => e < 30).length;
    const total = energyLevels.length;
    
    // All high or all low energy
    if (highEnergy / total > 0.8) {
      risks.push({
        id: uuidv4(),
        type: 'energy_imbalance',
        severity: 'medium',
        affectedMembers: memberData.map(m => m.userId),
        description: `Group is dominated by high-energy extroverts (${
          highEnergy
        }/${total}). May lack reflection time and overwhelm quieter voices.`,
        triggers: [
          'Long meetings',
          'Brainstorming sessions',
          'Social events',
          'Collaborative work'
        ],
        mitigationStrategies: [],
        probability: 0.6,
        impact: 0.6,
        riskScore: 0
      });
    } else if (lowEnergy / total > 0.8) {
      risks.push({
        id: uuidv4(),
        type: 'energy_imbalance',
        severity: 'medium',
        affectedMembers: memberData.map(m => m.userId),
        description: `Group is dominated by low-energy introverts (${
          lowEnergy
        }/${total}). May struggle with group dynamics and spontaneous collaboration.`,
        triggers: [
          'Group presentations',
          'Networking requirements',
          'Open discussions',
          'Team building'
        ],
        mitigationStrategies: [],
        probability: 0.6,
        impact: 0.6,
        riskScore: 0
      });
    }
    
    return risks;
  }

  /**
   * Detect communication style clashes
   */
  private detectCommunicationClash(memberData: MemberData[]): ConflictRisk[] {
    const risks: ConflictRisk[] = [];
    const styles = new Map<string, string[]>();
    
    // Group by communication style
    memberData.forEach(member => {
      const style = member.personality?.communicationStyle;
      if (style) {
        if (!styles.has(style)) {
          styles.set(style, []);
        }
        styles.get(style)!.push(member.userId);
      }
    });
    
    // Check for friction points
    styles.forEach((membersA, styleA) => {
      const frictions = COMMUNICATION_FRICTION[styleA] || [];
      
      frictions.forEach(frictionStyle => {
        const membersB = styles.get(frictionStyle);
        if (membersB && membersB.length > 0) {
          const probability = this.calculateMismatchProbability(
            membersA.length,
            membersB.length,
            memberData.length
          );
          
          risks.push({
            id: uuidv4(),
            type: 'communication_clash',
            severity: this.calculateSeverity(probability, 0.7),
            affectedMembers: [...membersA, ...membersB],
            description: `Communication style mismatch between ${
              styleA
            } communicators (${membersA.length}) and ${
              frictionStyle
            } communicators (${membersB.length}). May lead to misunderstandings and frustration.`,
            triggers: [
              'Important announcements',
              'Feedback sessions',
              'Project updates',
              'Decision discussions'
            ],
            mitigationStrategies: [],
            probability,
            impact: 0.7,
            riskScore: 0
          });
        }
      });
    });
    
    return risks;
  }

  /**
   * Detect value misalignments
   */
  private detectValueMisalignment(memberData: MemberData[]): ConflictRisk[] {
    const risks: ConflictRisk[] = [];
    const valueFrequency = new Map<string, number>();
    const memberValues = new Map<string, Set<string>>();
    
    // Count value frequencies
    memberData.forEach(member => {
      if (!member.values?.core) return;
      
      const values = new Set<string>();
      member.values.core.forEach(value => {
        values.add(value);
        valueFrequency.set(value, (valueFrequency.get(value) || 0) + 1);
      });
      memberValues.set(member.userId, values);
    });
    
    // Find conflicting values
    const conflictingPairs = [
      ['innovation', 'stability'],
      ['competition', 'collaboration'],
      ['autonomy', 'teamwork'],
      ['speed', 'quality'],
      ['transparency', 'privacy']
    ];
    
    conflictingPairs.forEach(([valueA, valueB]) => {
      const countA = valueFrequency.get(valueA) || 0;
      const countB = valueFrequency.get(valueB) || 0;
      
      if (countA > 0 && countB > 0) {
        const affectedMembers: string[] = [];
        memberValues.forEach((values, userId) => {
          if (values.has(valueA) || values.has(valueB)) {
            affectedMembers.push(userId);
          }
        });
        
        const probability = (countA + countB) / (memberData.length * 2);
        
        risks.push({
          id: uuidv4(),
          type: 'value_misalignment',
          severity: this.calculateSeverity(probability, 0.9),
          affectedMembers,
          description: `Value conflict between "${valueA}" (${
            countA
          } members) and "${valueB}" (${
            countB
          } members). This fundamental difference can create tension in decision-making.`,
          triggers: [
            'Strategic planning',
            'Priority setting',
            'Resource allocation',
            'Culture discussions'
          ],
          mitigationStrategies: [],
          probability,
          impact: 0.9,
          riskScore: 0
        });
      }
    });
    
    return risks;
  }

  /**
   * Detect expectation divergence
   */
  private detectExpectationDivergence(memberData: MemberData[]): ConflictRisk[] {
    const risks: ConflictRisk[] = [];
    
    // Analyze participation expectations based on energy and values
    const highCommitment = memberData.filter(m => {
      const hasAchievement = m.values?.motivationDrivers?.some(
        d => d.driver === 'achievement' && d.strength > 0.7
      );
      const highEnergy = (m.behavioral?.socialEnergy || 0) > 70;
      return hasAchievement || highEnergy;
    });
    
    const lowCommitment = memberData.filter(m => {
      const hasAutonomy = m.values?.motivationDrivers?.some(
        d => d.driver === 'autonomy' && d.strength > 0.7
      );
      const lowEnergy = (m.behavioral?.socialEnergy || 0) < 30;
      return hasAutonomy || lowEnergy;
    });
    
    if (highCommitment.length > 0 && lowCommitment.length > 0) {
      const probability = 0.6;
      
      risks.push({
        id: uuidv4(),
        type: 'expectation_divergence',
        severity: 'medium',
        affectedMembers: [
          ...highCommitment.map(m => m.userId),
          ...lowCommitment.map(m => m.userId)
        ],
        description: `Different expectations for group participation. ${
          highCommitment.length
        } members expect high engagement while ${
          lowCommitment.length
        } prefer minimal commitment.`,
        triggers: [
          'Meeting frequency',
          'Response time expectations',
          'Participation requirements',
          'Commitment levels'
        ],
        mitigationStrategies: [],
        probability,
        impact: 0.6,
        riskScore: 0
      });
    }
    
    return risks;
  }

  /**
   * Detect leadership conflicts
   */
  private detectLeadershipConflict(memberData: MemberData[]): ConflictRisk[] {
    const risks: ConflictRisk[] = [];
    
    // Identify strong leaders
    const leaders = memberData.filter(m => {
      const hasLeadership = m.behavioral?.tendencies?.some(
        t => t.behavior.includes('leadership') && t.likelihood > 0.7
      );
      const hasPower = m.values?.motivationDrivers?.some(
        d => d.driver === 'power' && d.strength > 0.7
      );
      const isCompeting = m.personality?.conflictResolutionStyle === 'competing';
      
      return hasLeadership || hasPower || isCompeting;
    });
    
    if (leaders.length >= RISK_DEFINITIONS.leadership_conflict.threshold) {
      const probability = leaders.length / memberData.length;
      
      risks.push({
        id: uuidv4(),
        type: 'leadership_conflict',
        severity: this.calculateSeverity(probability, 0.8),
        affectedMembers: leaders.map(m => m.userId),
        description: `Multiple strong leadership personalities (${
          leaders.length
        }) may compete for influence and direction-setting.`,
        triggers: [
          'Decision making',
          'Project leadership',
          'Strategic planning',
          'Crisis situations'
        ],
        mitigationStrategies: [],
        probability,
        impact: 0.8,
        riskScore: 0
      });
    }
    
    return risks;
  }

  /**
   * Detect work style friction
   */
  private detectWorkStyleFriction(memberData: MemberData[]): ConflictRisk[] {
    const risks: ConflictRisk[] = [];
    
    // Analyze work style preferences
    const systematic = memberData.filter(m => 
      m.cognitive?.problemSolvingStyle === 'systematic' ||
      m.cognitive?.decisionMakingStyle === 'analytical'
    );
    
    const adaptive = memberData.filter(m => 
      m.cognitive?.problemSolvingStyle === 'intuitive' ||
      m.cognitive?.decisionMakingStyle === 'spontaneous'
    );
    
    if (systematic.length > 0 && adaptive.length > 0) {
      const total = systematic.length + adaptive.length;
      const balance = Math.abs(systematic.length - adaptive.length) / total;
      
      if (balance > 0.3) {
        const probability = 0.5;
        
        risks.push({
          id: uuidv4(),
          type: 'work_style_friction',
          severity: 'low',
          affectedMembers: [
            ...systematic.map(m => m.userId),
            ...adaptive.map(m => m.userId)
          ],
          description: `Work style differences between systematic planners (${
            systematic.length
          }) and adaptive improvisers (${adaptive.length}).`,
          triggers: [
            'Project planning',
            'Deadline management',
            'Process definition',
            'Documentation requirements'
          ],
          mitigationStrategies: [],
          probability,
          impact: 0.5,
          riskScore: 0
        });
      }
    }
    
    return risks;
  }

  /**
   * Calculate mismatch probability
   */
  private calculateMismatchProbability(
    groupASize: number,
    groupBSize: number,
    totalSize: number
  ): number {
    // Probability increases with group sizes and their proportion
    const proportionA = groupASize / totalSize;
    const proportionB = groupBSize / totalSize;
    
    // Higher probability when groups are more evenly matched
    const balance = 1 - Math.abs(proportionA - proportionB);
    
    return Math.min(proportionA * proportionB * 2 * balance, 0.95);
  }

  /**
   * Calculate risk severity
   */
  private calculateSeverity(
    probability: number,
    impact: number
  ): 'low' | 'medium' | 'high' | 'critical' {
    const score = probability * impact;
    
    if (score >= 0.7) return 'critical';
    if (score >= 0.5) return 'high';
    if (score >= 0.3) return 'medium';
    return 'low';
  }

  /**
   * Calculate overall risk score
   */
  private calculateRiskScore(risk: ConflictRisk): ConflictRisk {
    risk.riskScore = risk.probability * risk.impact;
    return risk;
  }

  /**
   * Add mitigation strategies based on risk type
   */
  private addMitigationStrategies(
    risk: ConflictRisk,
    memberData: MemberData[]
  ): ConflictRisk {
    const strategies: Record<string, string[]> = {
      resolution_mismatch: [
        'Establish clear conflict resolution protocols',
        'Create safe spaces for both direct and indirect communication',
        'Use a mediator for important disagreements',
        'Set ground rules that respect different styles',
        'Schedule regular check-ins to prevent issue buildup'
      ],
      empathy_gap: [
        'Implement structured empathy-building exercises',
        'Create opportunities for personal story sharing',
        'Use perspective-taking activities in meetings',
        'Establish emotional check-in rituals',
        'Provide empathy training resources'
      ],
      energy_imbalance: [
        'Balance meeting formats (large group vs small)',
        'Offer multiple participation channels (verbal, written, async)',
        'Create quiet reflection time in discussions',
        'Rotate leadership of activities',
        'Respect different energy recharge needs'
      ],
      communication_clash: [
        'Define clear communication protocols',
        'Use written summaries for important decisions',
        'Practice active listening techniques',
        'Clarify expectations explicitly',
        'Create communication preference profiles'
      ],
      value_misalignment: [
        'Find shared higher-order values',
        'Create space for value diversity discussions',
        'Focus on common goals despite different approaches',
        'Establish value-based decision criteria',
        'Celebrate diverse perspectives as strength'
      ],
      expectation_divergence: [
        'Set explicit participation agreements',
        'Create flexible engagement options',
        'Define minimum and optional activities',
        'Regular expectation alignment discussions',
        'Document and revisit group norms'
      ],
      leadership_conflict: [
        'Rotate leadership responsibilities',
        'Define clear roles and domains',
        'Use collaborative decision-making processes',
        'Channel leadership energy into complementary areas',
        'Establish shared leadership model'
      ],
      work_style_friction: [
        'Create process flexibility options',
        'Balance structure with adaptability',
        'Use hybrid planning approaches',
        'Respect different work rhythms',
        'Define outcome focus over process'
      ]
    };
    
    risk.mitigationStrategies = strategies[risk.type] || [
      'Foster open communication',
      'Build mutual understanding',
      'Focus on shared goals',
      'Practice patience and respect'
    ];
    
    return risk;
  }

  /**
   * Generate risk summary
   */
  public generateRiskSummary(risks: ConflictRisk[]): {
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    topRisk: ConflictRisk | null;
    overallRiskLevel: string;
    recommendations: string[];
  } {
    const critical = risks.filter(r => r.severity === 'critical');
    const high = risks.filter(r => r.severity === 'high');
    const medium = risks.filter(r => r.severity === 'medium');
    const low = risks.filter(r => r.severity === 'low');

    let overallRiskLevel: string;
    if (critical.length > 0) {
      overallRiskLevel = 'Critical attention needed';
    } else if (high.length > 2) {
      overallRiskLevel = 'High risk - proactive intervention recommended';
    } else if (medium.length > 3) {
      overallRiskLevel = 'Moderate risk - monitoring advised';
    } else {
      overallRiskLevel = 'Low risk - healthy dynamics';
    }

    const recommendations: string[] = [];

    if (critical.length > 0) {
      recommendations.push('Address critical risks immediately with group discussion');
    }
    if (risks.some(r => r.type === 'resolution_mismatch')) {
      recommendations.push('Establish conflict resolution protocols');
    }
    if (risks.some(r => r.type === 'communication_clash')) {
      recommendations.push('Create communication guidelines and norms');
    }
    if (risks.some(r => r.type === 'value_misalignment')) {
      recommendations.push('Facilitate values alignment workshop');
    }

    return {
      criticalCount: critical.length,
      highCount: high.length,
      mediumCount: medium.length,
      lowCount: low.length,
      topRisk: risks[0] || null,
      overallRiskLevel,
      recommendations
    };
  }

  /**
   * Initialize predictor (no-op, for consistency with other components)
   */
  public async initialize(): Promise<void> {
    this.logger.info('Conflict Risk Predictor initialized');
  }

  /**
   * Shutdown predictor (no-op, for consistency with other components)
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Conflict Risk Predictor shutdown');
  }
}

// Export singleton instance
export const conflictRiskPredictor = new ConflictRiskPredictor();
