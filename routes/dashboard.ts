// routes/dashboard.ts - COMPLETE DATA EXTRACTION VERSION
import express, { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { IntakeDataManager } from '../controllers/intakeController';
import { DataAccessContext } from '../controllers/directoryController';

const router = express.Router();

// DINA server URL
const DINA_SERVER_URL = process.env.DINA_SERVER_URL || 'https://theundergroundrailroad.world';

// ============================================================================
// COMPLETE PERSONAL DASHBOARD HANDLER - Returns ALL intake data
// ============================================================================

export const getPersonalIntelligenceHandler: RequestHandler = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'No token provided',
        code: 'NO_TOKEN'
      });
      return;
    }

    const token = authHeader.substring(7);
    let decoded: any;

    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET!);
    } catch (error) {
      res.status(401).json({
        success: false,
        error: 'Invalid token',
        code: 'INVALID_TOKEN'
      });
      return;
    }

    const userId = decoded.id;
    console.log(`📊 Building COMPLETE personal dashboard for user ${userId}`);

    // === 1. GET COMPLETE INTAKE DATA ===
    let completeIntakeData = null;
    
    try {
      const context: DataAccessContext = {
        userId: Number(userId),
        accessedBy: Number(userId),
        sessionId: decoded.sessionId || '',
        ipAddress: req.ip || req.connection?.remoteAddress || '',
        userAgent: req.headers['user-agent'] || '',
        reason: 'dashboard_complete_data_retrieval'
      };

      const result = await IntakeDataManager.getLatestIntakeData(
        String(userId),
        context,
        false // Don't include file contents for dashboard
      );

      completeIntakeData = result?.intakeData || null;

      console.log(`📊 COMPLETE intake data retrieved:`, {
        hasData: !!completeIntakeData,
        sections: completeIntakeData ? Object.keys(completeIntakeData) : [],
        hasPersonality: !!completeIntakeData?.personalityResult,
        hasAstrology: !!completeIntakeData?.astrologicalResult,
        hasIQ: !!completeIntakeData?.iqResults,
        hasFace: !!completeIntakeData?.faceAnalysis,
        hasVoice: !!completeIntakeData?.voiceMetadata
      });

    } catch (error) {
      console.error(`❌ Failed to retrieve complete intake data:`, error);
      completeIntakeData = null;
    }

    // === 2. GET AI INSIGHTS ===
    const insights = await getAIInsightsFromDINA(String(userId), req);

    // === 3. BUILD COMPLETE DASHBOARD ===
    const dashboard = buildCompleteDashboard(completeIntakeData, insights);

    res.json({
      success: true,
      data: dashboard,
      timestamp: new Date().toISOString(),
      sources: {
        intake: !!completeIntakeData,
        insights: insights.length,
        dina_server: DINA_SERVER_URL
      }
    });

  } catch (error) {
    console.error('❌ Error building complete personal dashboard:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to build complete personal dashboard',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// ============================================================================
// COMPLETE DASHBOARD BUILDER - Returns ALL available data
// ============================================================================

function buildCompleteDashboard(intakeData: any, insights: any[]): any {
  console.log(`🔧 Building complete dashboard with full data extraction`);

  return {
    // === ORIGINAL SIMPLIFIED SNAPSHOT (for backward compatibility) ===
    personalitySnapshot: buildSimplePersonalitySnapshot(intakeData),
    liveInsights: formatLiveInsights(insights),
    mirrorScore: calculateMirrorScore(intakeData, insights),
    growthMetrics: calculateGrowthMetrics(intakeData, insights),
    recentActivity: formatRecentActivity(insights),

    // === COMPLETE DATA SECTIONS (new comprehensive data) ===
    completePersonalityData: extractCompletePersonalityData(intakeData),
    completeAstrologicalData: extractCompleteAstrologicalData(intakeData),
    completeCognitiveData: extractCompleteCognitiveData(intakeData),
    completeEmotionalData: extractCompleteEmotionalData(intakeData),
    completeVoiceData: extractCompleteVoiceData(intakeData),
    assessmentMetadata: extractAssessmentMetadata(intakeData)
  };
}

// ============================================================================
// COMPLETE DATA EXTRACTION FUNCTIONS
// ============================================================================

function extractCompletePersonalityData(intakeData: any): any {
  if (!intakeData?.personalityResult) {
    return {
      available: false,
      message: 'Complete personality assessment to unlock detailed analysis'
    };
  }

  const personality = intakeData.personalityResult;
  console.log(`🧠 Extracting complete personality data:`, Object.keys(personality));

  return {
    available: true,
    mbti: {
      type: personality.mbtiType || 'Unknown',
      description: personality.description || 'No description available'
    },
    big5Profile: personality.big5Profile || {},
    dominantTraits: personality.dominantTraits || [],
    assessmentQuality: personality.assessmentQuality || 'Standard',
    personalityAnswers: intakeData.personalityAnswers || null // Include raw answers if needed
  };
}

function extractCompleteAstrologicalData(intakeData: any): any {
  if (!intakeData?.astrologicalData) {
    return {
      available: false,
      message: 'Complete astrological assessment to unlock cosmic analysis'
    };
  }

  const astrology = intakeData.astrologicalData;
  console.log(`🌟 Extracting complete astrological data:`, Object.keys(astrology));

  return {
    available: true,
    western: astrology.western || null,
    chinese: astrology.chinese || null,
    african: astrology.african || null,
    numerology: astrology.numerology || null,
    synthesis: astrology.synthesis || null
  };
}

function extractCompleteCognitiveData(intakeData: any): any {
  if (!intakeData?.iqResults) {
    return {
      available: false,
      message: 'Complete cognitive assessment to unlock intelligence analysis'
    };
  }

  const iq = intakeData.iqResults;
  console.log(`🧠 Extracting complete cognitive data:`, Object.keys(iq));

  return {
    available: true,
    iqScore: iq.iqScore || 0,
    category: iq.category || 'Unknown',
    rawScore: iq.rawScore || 0,
    totalQuestions: iq.totalQuestions || 0,
    strengths: iq.strengths || [],
    description: iq.description || '',
    percentile: calculatePercentile(iq.iqScore),
    iqAnswers: intakeData.iqAnswers || null // Include raw answers if needed
  };
}

function extractCompleteEmotionalData(intakeData: any): any {
  if (!intakeData?.faceAnalysis) {
    return {
      available: false,
      message: 'Complete visual assessment to unlock emotional analysis'
    };
  }

  const face = intakeData.faceAnalysis;
  console.log(`😊 Extracting complete emotional data:`, Object.keys(face));

  return {
    available: true,
    expressions: face.expressions || {},
    facialAngles: face.angle || {},
    detection: {
      confidence: face.detection?.confidence || 0,
      landmarks: face.landmarks ? Object.keys(face.landmarks).length : 0
    },
    dominantEmotion: getDominantEmotion(face.expressions),
    emotionalSpectrum: getEmotionalSpectrum(face.expressions)
  };
}

function extractCompleteVoiceData(intakeData: any): any {
  if (!intakeData?.voiceMetadata) {
    return {
      available: false,
      message: 'Complete voice assessment to unlock vocal analysis'
    };
  }

  const voice = intakeData.voiceMetadata;
  console.log(`🎵 Extracting complete voice data:`, Object.keys(voice));

  return {
    available: true,
    duration: voice.duration || 0,
    mimeType: voice.mimeType || 'unknown',
    size: voice.size || 0,
    deviceInfo: voice.deviceInfo || {},
    quality: assessVoiceQuality(voice),
    voiceFileRef: intakeData.voiceFileRef || null
  };
}

function extractAssessmentMetadata(intakeData: any): any {
  return {
    completionDate: intakeData.submissionDate || new Date(),
    sectionsCompleted: {
      personality: !!intakeData.personalityResult,
      astrology: !!intakeData.astrologicalData,
      cognitive: !!intakeData.iqResults,
      emotional: !!intakeData.faceAnalysis,
      voice: !!intakeData.voiceMetadata
    },
    totalSections: 5,
    completionPercentage: calculateCompletionPercentage(intakeData),
    dataIntegrity: assessDataIntegrity(intakeData)
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function calculatePercentile(iqScore: number): number {
  // Standard IQ percentile calculation
  if (iqScore >= 130) return 98;
  if (iqScore >= 120) return 91;
  if (iqScore >= 110) return 75;
  if (iqScore >= 100) return 50;
  if (iqScore >= 90) return 25;
  if (iqScore >= 80) return 9;
  return 2;
}

function getDominantEmotion(expressions: any): { emotion: string; confidence: number } {
  if (!expressions) return { emotion: 'neutral', confidence: 0 };
  
  const entries = Object.entries(expressions);
  const dominant = entries.reduce((max, [emotion, value]) => 
    (value as number) > max.confidence ? { emotion, confidence: value as number } : max,
    { emotion: 'neutral', confidence: 0 }
  );
  
  return dominant;
}

function getEmotionalSpectrum(expressions: any): Array<{ emotion: string; intensity: number }> {
  if (!expressions) return [];
  
  return Object.entries(expressions)
    .map(([emotion, intensity]) => ({ emotion, intensity: intensity as number }))
    .sort((a, b) => b.intensity - a.intensity);
}

function assessVoiceQuality(voice: any): string {
  const duration = voice.duration || 0;
  if (duration > 5) return 'Excellent';
  if (duration > 3) return 'Good';
  if (duration > 1) return 'Fair';
  return 'Minimal';
}

function calculateCompletionPercentage(intakeData: any): number {
  const sections = [
    intakeData.personalityResult,
    intakeData.astrologicalData,
    intakeData.iqResults,
    intakeData.faceAnalysis,
    intakeData.voiceMetadata
  ];
  
  const completed = sections.filter(section => !!section).length;
  return Math.round((completed / sections.length) * 100);
}

function assessDataIntegrity(intakeData: any): string {
  const completionPercentage = calculateCompletionPercentage(intakeData);
  if (completionPercentage === 100) return 'Complete';
  if (completionPercentage >= 80) return 'Substantial';
  if (completionPercentage >= 60) return 'Partial';
  return 'Incomplete';
}

// ============================================================================
// SIMPLIFIED FUNCTIONS (for backward compatibility)
// ============================================================================

function buildSimplePersonalitySnapshot(intakeData: any): any {
  if (!intakeData) {
    return {
      dominantTraits: ['Complete your assessment to unlock insights'],
      currentLifePhase: 'Assessment Phase',
      cognitiveStrengths: ['Assessment needed'],
      emotionalProfile: {
        primaryEmotions: ['Assessment needed'],
        emotionalStability: 0,
        expressiveness: 0
      },
      astrologicalHighlights: {
        sunSign: 'Complete intake',
        moonSign: 'Complete intake',
        dominantElement: 'Unknown',
        currentTransits: ['Complete your assessment']
      }
    };
  }

  const personality = intakeData.personalityResult || {};
  const astrology = intakeData.astrologicalData || {};
  const face = intakeData.faceAnalysis || {};
  const iq = intakeData.iqResults || {};

  return {
    dominantTraits: personality.dominantTraits || ['Thoughtful', 'Authentic', 'Growing'],
    currentLifePhase: astrology.chinese?.lifePhase || 'Growth and Exploration',
    cognitiveStrengths: iq.strengths || ['Analytical Thinking'],
    emotionalProfile: {
      primaryEmotions: extractTopEmotions(face.expressions),
      emotionalStability: calculateEmotionalStability(personality),
      expressiveness: calculateExpressiveness(personality)
    },
    astrologicalHighlights: {
      sunSign: astrology.western?.sunSign || 'Unknown',
      moonSign: astrology.western?.moonSign || 'Unknown',
      dominantElement: astrology.western?.dominantElement || 'Air',
      currentTransits: astrology.western?.currentTransits || ['Jupiter in Growth Phase']
    }
  };
}

function extractTopEmotions(expressions: any): string[] {
  if (!expressions) return ['Calm'];
  
  return Object.entries(expressions)
    .filter(([emotion, score]) => (score as number) > 0.3)
    .sort(([,a], [,b]) => (b as number) - (a as number))
    .slice(0, 2)
    .map(([emotion]) => emotion.charAt(0).toUpperCase() + emotion.slice(1));
}

function calculateEmotionalStability(personality: any): number {
  const neuroticism = personality?.big5Profile?.neuroticism;
  return neuroticism ? Math.round(100 - neuroticism) : 75;
}

function calculateExpressiveness(personality: any): number {
  const extraversion = personality?.big5Profile?.extraversion;
  return extraversion ? Math.round(extraversion) : 65;
}

// ============================================================================
// EXISTING FUNCTIONS (unchanged)
// ============================================================================

async function getAIInsightsFromDINA(userId: string, req: any): Promise<any[]> {
  try {
    console.log(`🤖 Fetching AI insights for user ${userId}`);
    const authHeader = req.headers.authorization;
    if (!authHeader) return [];

    const response = await fetch(`${DINA_SERVER_URL}/api/mirror/insights?limit=10&sort=recent`, {
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'User-Agent': 'Mirror-Server/2.0.0'
      }
    });

    if (!response.ok) {
      console.warn(`DINA insights API responded with ${response.status}`);
      return [];
    }

    const result = await response.json();
    return result.insights || result.data?.insights || [];
  } catch (error) {
    console.warn(`⚠️ Could not fetch AI insights:`, error);
    return [];
  }
}

function formatLiveInsights(insights: any[]): any[] {
  if (!insights || insights.length === 0) {
    return [{
      id: 'welcome_insight',
      text: 'Complete your Mirror assessment to unlock personalized AI insights.',
      category: 'welcome',
      confidence: 1.0,
      timestamp: new Date(),
      sourceModalities: ['system'],
      actionable: 'Visit the intake section to begin your assessment'
    }];
  }

  return insights.slice(0, 5).map((insight, index) => ({
    id: insight.id || `insight_${index}`,
    text: insight.insightText || insight.text || `Insight ${index + 1}`,
    category: insight.category || 'cross_modal',
    confidence: insight.confidenceScore || insight.confidence || 0.8,
    timestamp: new Date(insight.createdAt || insight.timestamp || Date.now()),
    sourceModalities: insight.sourceModalities || ['personality', 'cognitive'],
    actionable: insight.actionable || 'Continue your self-reflection journey'
  }));
}

function calculateMirrorScore(intakeData: any, insights: any[]): any {
  const hasIntake = !!intakeData;
  const completionPercentage = calculateCompletionPercentage(intakeData);
  
  return {
    selfAwarenessIndex: hasIntake ? Math.min(85 + (completionPercentage - 80), 100) : 15,
    growthMomentum: Math.min(insights.length * 10 + 50, 100),
    reflectionDepth: hasIntake ? Math.min(78 + (completionPercentage - 80), 100) : 25,
    authenticity: hasIntake ? Math.min(82 + (completionPercentage - 80), 100) : 30,
    overall: hasIntake ? Math.round((completionPercentage + insights.length * 5) / 1.25) : 30
  };
}

function calculateGrowthMetrics(intakeData: any, insights: any[]): any {
  const completionPercentage = calculateCompletionPercentage(intakeData);
  
  return {
    areasOfFocus: intakeData ?
      ['Self-Awareness', 'Authentic Expression', 'Personal Growth'] :
      ['Complete Assessment', 'Begin Mirror Journey', 'Unlock Insights'],
    progressIndicators: [
      {
        area: 'Assessment Completion',
        progress: completionPercentage,
        trend: completionPercentage === 100 ? 'up' : 'stable'
      },
      {
        area: 'AI Insight Generation',
        progress: Math.min(insights.length * 20, 100),
        trend: insights.length > 0 ? 'up' : 'stable'
      },
      {
        area: 'Self-Reflection Depth',
        progress: intakeData ? Math.min(75 + (completionPercentage - 80), 100) : 20,
        trend: 'up'
      }
    ],
    consistencyScore: intakeData ? Math.min(88 + (completionPercentage - 80), 100) : 0,
    developmentVelocity: Math.min(insights.length + Math.round(completionPercentage / 20), 10)
  };
}

function formatRecentActivity(insights: any[]): any[] {
  return insights.slice(0, 3).map(insight => ({
    id: insight.id || insight.insightId,
    type: 'insight',
    message: `New ${insight.category || 'cross-modal'} insight generated`,
    timestamp: new Date(insight.createdAt || insight.timestamp || Date.now()),
    isRead: false
  }));
}

router.get('/personal-intelligence', getPersonalIntelligenceHandler);

export default router;
