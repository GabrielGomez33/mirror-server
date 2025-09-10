// routes/dashboard.ts - CORRECTED to use actual IntakeDataManager methods
import express, { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { IntakeDataManager } from '../controllers/intakeController';
import { DataAccessContext } from '../controllers/directoryController';

const router = express.Router();

// DINA server URL - using existing domain
const DINA_SERVER_URL = process.env.DINA_SERVER_URL || 'https://dina.theundergroundrailroad.world';

// ============================================================================
// CORRECTED PERSONAL DASHBOARD HANDLER - Uses actual IntakeDataManager methods
// ============================================================================

export const getPersonalIntelligenceHandler: RequestHandler = async (req, res) => {
  try {
    // ✅ Handle auth manually inside handler (following existing pattern)
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
    console.log(`📊 Building personal dashboard for user ${userId}`);

    // === 1. GET INTAKE DATA USING CORRECT METHOD ===
    let intakeData = null;
    
    try {
      console.log(`📂 Using IntakeDataManager.getLatestIntakeData for user ${userId}`);

      // ✅ Create proper DataAccessContext as required by IntakeDataManager
      const context: DataAccessContext = {
        userId: Number(userId),
        accessedBy: Number(userId),
        sessionId: decoded.sessionId || '',
        ipAddress: req.ip || req.connection?.remoteAddress || '',
        userAgent: req.headers['user-agent'] || '',
        reason: 'dashboard_personal_intelligence'
      };

      // ✅ Call the actual method that exists
      const result = await IntakeDataManager.getLatestIntakeData(
        String(userId),
        context,
        false // Don't include file contents for dashboard
      );

      console.log(`📂 IntakeDataManager.getLatestIntakeData result:`, {
        hasResult: !!result,
        hasIntakeData: !!result?.intakeData,
        resultKeys: result ? Object.keys(result) : [],
        intakeDataKeys: result?.intakeData ? Object.keys(result.intakeData) : []
      });

      // Extract the intakeData from the result structure
      intakeData = result?.intakeData || null;

      // Log detailed structure of what we got
      if (intakeData) {
        console.log(`📊 Intake data structure:`, {
          hasPersonalityResult: !!intakeData.personalityResult,
          hasAstrologicalResult: !!intakeData.astrologicalResult,
          hasIqResults: !!intakeData.iqResults,
          hasFaceAnalysis: !!intakeData.faceAnalysis,
          hasVoiceMetadata: !!intakeData.voiceMetadata,
          hasProgress: !!intakeData.progress,
          allKeys: Object.keys(intakeData)
        });
      } else {
        console.log(`📂 No intake data found for user ${userId}`);
      }

    } catch (error) {
      console.error(`❌ IntakeDataManager.getLatestIntakeData failed for user ${userId}:`, error);
      intakeData = null; // Graceful degradation
    }

    // === 2. GET AI INSIGHTS (from DINA - existing endpoint) ===
    const insights = await getAIInsightsFromDINA(String(userId), req);

    // === 3. SYNTHESIZE DASHBOARD (minimal new logic) ===
    const dashboard = synthesizePersonalDashboard(intakeData, insights);

    res.json({
      success: true,
      data: dashboard,
      timestamp: new Date().toISOString(),
      sources: {
        intake: !!intakeData,
        insights: insights.length,
        dina_server: DINA_SERVER_URL
      }
    });

  } catch (error) {
    console.error('❌ Error building personal dashboard:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to build personal dashboard',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// ============================================================================
// ROUTE REGISTRATION - Following existing simple pattern
// ============================================================================

router.get('/personal-intelligence', getPersonalIntelligenceHandler);

// ============================================================================
// DATA RETRIEVAL FUNCTIONS - Using existing methods only
// ============================================================================

async function getAIInsightsFromDINA(userId: string, req: any): Promise<any[]> {
  try {
    console.log(`🤖 Fetching AI insights for user ${userId} from existing DINA endpoint`);

    // ✅ Use existing auth header pattern
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      console.warn('No auth header for DINA request');
      return [];
    }

    // ✅ Make request to existing DINA API
    const response = await fetch(`${DINA_SERVER_URL}/api/mirror/insights?limit=10&sort=recent`, {
      method: 'GET',
      headers: {
        'Authorization': authHeader, // Forward existing auth
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
    console.warn(`⚠️ Could not fetch AI insights for user ${userId}:`, error);
    return [];
  }
}

// ============================================================================
// DASHBOARD SYNTHESIS - Minimal new logic to format existing data
// ============================================================================

function synthesizePersonalDashboard(intakeData: any, insights: any[]): any {
  return {
    // === PERSONALITY SNAPSHOT (from existing intake data) ===
    personalitySnapshot: buildPersonalitySnapshot(intakeData),

    // === LIVE INSIGHTS (from existing DINA AI) ===
    liveInsights: formatLiveInsights(insights),

    // === MIRROR SCORE (calculated from existing data) ===
    mirrorScore: calculateMirrorScore(intakeData, insights),

    // === GROWTH METRICS (from existing data progression) ===
    growthMetrics: calculateGrowthMetrics(intakeData, insights),

    // === RECENT ACTIVITY (from insights) ===
    recentActivity: formatRecentActivity(insights)
  };
}

function buildPersonalitySnapshot(intakeData: any): any {
  console.log(`🧠 Building personality snapshot from intake data:`, {
    hasData: !!intakeData,
    hasPersonalityResult: !!intakeData?.personalityResult,
    hasAstroLogicalResult: !!intakeData?.astrologicalData,
    hasFaceAnalysis: !!intakeData?.faceAnalysis,
    hasIqResults: !!intakeData?.iqResults
  });

  

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

  // Extract from real intake data structure
  const personality = intakeData.personalityResult || {};
  const astrology = intakeData.astrologicalData || {};
  const faceAnalysis = intakeData.faceAnalysis || {};
  const iqResults = intakeData.iqResults || {};

    
    // 🔍 ADD THIS DEBUGGING
    console.log(`🔮 DEBUG: Astrological data structure:`, {
      hasAstrology: !!astrology,
      astrologyKeys: astrology ? Object.keys(astrology) : [],
      westernKeys: astrology.western ? Object.keys(astrology.western) : [],
      chineseKeys: astrology.chinese ? Object.keys(astrology.chinese) : [],
      westernData: astrology.western,  // Full western object
    });

  console.log(`🔍 Extracted sections:`, {
    personality: !!personality && Object.keys(personality),
    astrology: !!astrology && Object.keys(astrology),
    faceAnalysis: !!faceAnalysis && Object.keys(faceAnalysis),
    iqResults: !!iqResults && Object.keys(iqResults)
  });

  return {
    dominantTraits: extractDominantTraits(personality),
    currentLifePhase: extractLifePhase(astrology),
    cognitiveStrengths: extractCognitiveStrengths(iqResults),
    emotionalProfile: {
      primaryEmotions: extractPrimaryEmotions(faceAnalysis.expressions),
      emotionalStability: calculateEmotionalStability(personality),
      expressiveness: calculateExpressiveness(personality)
    },
    astrologicalHighlights: {
      sunSign: astrology.western?.sunSign || astrology.sunSign || 'Unknown',
      moonSign: astrology.western?.moonSign || astrology.moonSign || 'Unknown',
      dominantElement: astrology.western?.dominantElement || astrology.dominantElement || 'Air',
      currentTransits: astrology.currentTransits || ['Jupiter in Growth Phase', 'Mercury Enhancing Communication']
    }
  };
}

// ============================================================================
// UTILITY FUNCTIONS - Enhanced for real data extraction
// ============================================================================

function extractDominantTraits(personality: any): string[] {
  if (!personality) return ['Thoughtful', 'Authentic', 'Growing'];

  // Check for explicit dominantTraits first
  if (personality.dominantTraits?.length > 0) {
    console.log(`🎭 Found explicit dominantTraits:`, personality.dominantTraits);
    return personality.dominantTraits.slice(0, 3);
  }

  const traits = [];

  // Extract from Big 5 if available
  const big5 = personality.big5Profile || {};
  if (Object.keys(big5).length > 0) {
    console.log(`🎭 Extracting from Big 5:`, big5);
    if (big5.openness > 70) traits.push('Creative');
    if (big5.conscientiousness > 70) traits.push('Organized');
    if (big5.extraversion > 70) traits.push('Social');
    if (big5.agreeableness > 70) traits.push('Empathetic');
    if (big5.neuroticism < 30) traits.push('Calm');
  }

  // Extract from MBTI if available
  const mbti = personality.mbtiType || personality.mbtiResult?.type;
  if (mbti) {
    console.log(`🎭 Extracting from MBTI:`, mbti);
    if (mbti.includes('N')) traits.push('Intuitive');
    if (mbti.includes('T')) traits.push('Analytical');
    if (mbti.includes('F')) traits.push('Values-driven');
    if (mbti.includes('J')) traits.push('Decisive');
  }

  const finalTraits = traits.length > 0 ? traits.slice(0, 3) : ['Analytical', 'Empathetic', 'Creative'];
  console.log(`🎭 Final dominant traits:`, finalTraits);
  return finalTraits;
}

function extractLifePhase(astrology: any): string {
  if (!astrology) return 'Growth and Exploration';
  
  return astrology.chinese?.lifePhase || 
         astrology.lifePhase ||
         'Growth and Exploration';
}

function extractCognitiveStrengths(iqResults: any): string[] {
  if (!iqResults) return ['Complete IQ assessment'];
  
  // Check for explicit strengths
  if (iqResults.strengths?.length > 0) {
    console.log(`🧠 Found explicit IQ strengths:`, iqResults.strengths);
    return iqResults.strengths;
  }

  // Default based on IQ category if available
  if (iqResults.category) {
    console.log(`🧠 Using IQ category for strengths:`, iqResults.category);
    return [`${iqResults.category} Intelligence`, 'Problem Solving'];
  }

  return ['Analytical Thinking', 'Problem Solving'];
}

function extractPrimaryEmotions(expressions: any): string[] {
  if (!expressions) return ['Complete visual assessment'];

  console.log(`😊 Extracting emotions from expressions:`, expressions);

  const emotions = Object.entries(expressions)
    .filter(([emotion, score]) => typeof score === 'number' && score > 0.3)
    .sort(([,a], [,b]) => (b as number) - (a as number))
    .slice(0, 2)
    .map(([emotion]) => emotion.charAt(0).toUpperCase() + emotion.slice(1));

  const finalEmotions = emotions.length > 0 ? emotions : ['Calm', 'Focused'];
  console.log(`😊 Primary emotions:`, finalEmotions);
  return finalEmotions;
}

function calculateEmotionalStability(personality: any): number {
  if (!personality?.big5Profile?.neuroticism) return 75;
  return Math.round(100 - personality.big5Profile.neuroticism);
}

function calculateExpressiveness(personality: any): number {
  if (!personality?.big5Profile?.extraversion) return 65;
  return Math.round(personality.big5Profile.extraversion);
}

// ============================================================================
// EXISTING FUNCTIONS (unchanged from your original)
// ============================================================================

function formatLiveInsights(insights: any[]): any[] {
  if (!insights || insights.length === 0) {
    return [{
      id: 'welcome_insight',
      text: 'Complete your Mirror assessment to unlock personalized AI insights about your personality, cognitive strengths, and astrological influences.',
      category: 'welcome',
      confidence: 1.0,
      timestamp: new Date(),
      sourceModalities: ['system'],
      actionable: 'Visit the intake section to begin your assessment'
    }];
  }

  return insights.slice(0, 5).map((insight, index) => ({
    id: insight.id || insight.insightId || `insight_${index}`,
    text: insight.insightText || insight.text || `Insight ${index + 1}`,
    category: insight.category || insight.insightType || 'cross_modal',
    confidence: insight.confidenceScore || insight.confidence || 0.8,
    timestamp: new Date(insight.createdAt || insight.timestamp || Date.now()),
    sourceModalities: insight.sourceModalities || ['personality', 'cognitive'],
    actionable: insight.actionable || insight.recommendation || 'Continue your self-reflection journey'
  }));
}

function calculateMirrorScore(intakeData: any, insights: any[]): any {
  const hasIntake = !!intakeData;
  const selfAwarenessIndex = hasIntake ? 85 : 15;
  const growthMomentum = Math.min(insights.length * 10 + 50, 100);
  const reflectionDepth = hasIntake ? 78 : 25;
  const authenticity = hasIntake ? 82 : 30;

  return {
    selfAwarenessIndex,
    growthMomentum,
    reflectionDepth,
    authenticity,
    overall: Math.round((selfAwarenessIndex + growthMomentum + reflectionDepth + authenticity) / 4)
  };
}

function calculateGrowthMetrics(intakeData: any, insights: any[]): any {
  return {
    areasOfFocus: intakeData ?
      ['Self-Awareness', 'Authentic Expression', 'Personal Growth'] :
      ['Complete Assessment', 'Begin Mirror Journey', 'Unlock Insights'],
    progressIndicators: [
      {
        area: 'Assessment Completion',
        progress: intakeData ? 100 : 0,
        trend: intakeData ? 'up' : 'stable'
      },
      {
        area: 'AI Insight Generation',
        progress: Math.min(insights.length * 20, 100),
        trend: insights.length > 0 ? 'up' : 'stable'
      },
      {
        area: 'Self-Reflection Depth',
        progress: intakeData ? 75 : 20,
        trend: 'up'
      }
    ],
    consistencyScore: intakeData ? 88 : 0,
    developmentVelocity: insights.length > 5 ? 15 : 3
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

export default router;
