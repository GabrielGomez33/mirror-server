// index.ts - Mirror Server with MirrorGroups Phase 3.5 Integration + @Dina Chat + TruthStream
// Includes: Existing routes, Redis, Notifications, Encryption, Group APIs, WebSocket signaling, Group Analysis, DINA LLM, @Dina Chat, TruthStream

import https from 'https';
import fs from 'fs';
import express from 'express';
import path from 'path';
import dotenv from 'dotenv';

// ============================================================================
// EXISTING ROUTES
// ============================================================================
import authRoutes from './routes/auth';
import userRoutes from './routes/user';
import storageRoutes from './routes/storage';
import debugRoutes from './routes/debug';
import intakeRoutes from './routes/intake';
import dashboardRoutes from './routes/dashboard';
import journalRoutes from './routes/journal';

// ============================================================================
// EXISTING WEBSOCKET SETUP
// ============================================================================
import { SetupWebSocket, getWebSocketHealth } from './wss/setupWSS';

// ============================================================================
// MIRRORGROUPS PHASE 0 (Existing)
// ============================================================================
import { mirrorRedis } from './config/redis';
import { mirrorGroupNotifications } from './systems/mirrorGroupNotifications';

// ============================================================================
// MIRRORGROUPS PHASE 1 (Encryption + APIs)
// ============================================================================
import { groupEncryptionManager } from './systems/GroupEncryptionManager';
import groupRoutes from './routes/groups';
import groupInsightsRoutes from './routes/groupInsights';

// ============================================================================
// MIRRORGROUPS PHASE 4 (Conversation Intelligence + Voting)
// ============================================================================
import { conversationAnalyzer } from './analyzers/ConversationAnalyzer';
import groupVotesRoutes from './routes/groupVotes';
import sessionInsightsRoutes from './routes/sessionInsights';

// ============================================================================
// MIRRORGROUPS PHASE 5 (Chat Infrastructure)
// ============================================================================
import groupChatRoutes, { setBroadcastFunction as setChatBroadcast } from './routes/groupChat';
import { chatMessageManager } from './managers/ChatMessageManager';

// ============================================================================
// TRUTHSTREAM (Anonymous Peer Review System)
// ============================================================================
import truthstreamRoutes from './routes/truthstream';

// ============================================================================
// MIRRORGROUPS PHASE 3 (Group Analysis System)
// ============================================================================
import { groupAnalyzer } from './analyzers/GroupAnalyzer';
import { compatibilityCalculator } from './analyzers/CompatibilityCalculator';
import { collectiveStrengthDetector } from './analyzers/CollectiveStrengthDetector';
import { conflictRiskPredictor } from './analyzers/ConflictRiskPredictor';

// ============================================================================
// MIRRORGROUPS PHASE 3.5 (DINA LLM Integration)
// ============================================================================
import { dinaLLMConnector } from './integrations/DINALLMConnector';

// ============================================================================
// @DINA CHAT - WebSocket Connection + Queue Processor
// ============================================================================
// The DINA WebSocket connection is established on server startup
// This serves as the ONLY path for communication between Mirror and DINA
import { dinaWebSocket } from './services/DinaWebSocketClient';

// Note: DinaChatQueueProcessor uses the WebSocket connection for real-time streaming
// Run processor separately: npx ts-node workers/DinaChatQueueProcessor.ts

// ============================================================================
// ERROR HANDLING UTILITIES
// ============================================================================

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error occurred';
}

function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) return error.stack;
  return undefined;
}

function logError(context: string, error: unknown): void {
  console.error(`❌ ${context}:`, getErrorMessage(error));

  // Log full error object in development
  if (process.env.NODE_ENV === 'development') {
    const stack = getErrorStack(error);
    if (stack) {
      console.error('Stack trace:', stack);
    }
    console.error('Full error object:', error);
  }
}

function logSecurityEvent(event: string, details: any): void {
  console.warn(`🔒 SECURITY: ${event}`, details);
}

// ============================================================================
// ENVIRONMENT SETUP
// ============================================================================

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvs = [
  'TUGRRPRIV',
  'TUGRRCERT',
  'TUGRRINTERCERT',
  'MIRRORPORT',
  'MIRRORSTORAGE',
  'JWT_KEY',
  'REDIS_PASSWORD',           // Phase 0
  'SYSTEM_MASTER_KEY'         // Phase 1
];

for (const key of requiredEnvs) {
  if (!process.env[key]) {
    throw new Error(`❌ Missing required environment variable: ${key}`);
  }
}

// Validate SYSTEM_MASTER_KEY format (must be 64 hex characters)
if (process.env.SYSTEM_MASTER_KEY!.length !== 64) {
  throw new Error('❌ SYSTEM_MASTER_KEY must be exactly 64 hexadecimal characters (256 bits)');
}

console.log('✅ All required environment variables validated');

// ============================================================================
// EXPRESS APP SETUP
// ============================================================================

const APP = express();

// IMPORTANT: express.json() MUST come before any middleware that reads req.body
APP.use(express.json());

// Custom logging middleware
APP.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  if (process.env.NODE_ENV === 'development') {
    console.log('[DEBUG] Headers:', req.headers);
    console.log('[DEBUG] Body:', req.body);
  }
  next();
});

// ============================================================================
// MOUNT EXISTING ROUTES
// ============================================================================

APP.use('/mirror/api/auth', authRoutes);
APP.use('/mirror/api/user', userRoutes);
APP.use('/mirror/api/storage', storageRoutes);
APP.use('/mirror/api/debug', debugRoutes);
APP.use('/mirror/api/intake', intakeRoutes);
APP.use('/mirror/api/dashboard', dashboardRoutes);
APP.use('/mirror/api/journal', journalRoutes);

// ============================================================================
// MOUNT MIRRORGROUPS ROUTES (PHASE 1 + PHASE 3 + PHASE 4)
// ============================================================================

APP.use('/mirror/api/groups', groupRoutes);
console.log('📍 MirrorGroups routes mounted at /mirror/api/groups');

APP.use('/mirror/api', groupInsightsRoutes);
console.log('📍 MirrorGroups Insights routes mounted at /mirror/api/groups/:groupId/insights');

// Phase 4: Voting and Conversation Intelligence
APP.use('/mirror/api', groupVotesRoutes);
console.log('📍 MirrorGroups Voting routes mounted at /mirror/api/groups/:groupId/votes');

APP.use('/mirror/api', sessionInsightsRoutes);
console.log('📍 MirrorGroups Session Insights routes mounted at /mirror/api/groups/:groupId/sessions');

// Phase 5: Chat Infrastructure
APP.use('/mirror/api/groups', groupChatRoutes);
console.log('📍 MirrorGroups Chat routes mounted at /mirror/api/groups/:groupId/chat');

// ============================================================================
// MOUNT TRUTHSTREAM ROUTES
// ============================================================================

APP.use('/mirror/api/truthstream', truthstreamRoutes);
console.log('📍 TruthStream routes mounted at /mirror/api/truthstream');

// ============================================================================
// @DINA CHAT - Processor runs as SEPARATE PROCESS (via PM2/systemd)
// ============================================================================
// Stats endpoint removed - query the processor directly when running separately
// Run processor: npx ts-node workers/DinaChatQueueProcessor.ts

// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================

APP.get('/mirror/api/health', async (req, res) => {
  const wsHealth = getWebSocketHealth();

  // Note: @Dina Chat Processor runs as separate process - not monitored here

  res.json({
    status: 'healthy',
    service: 'mirror-server',
    timestamp: new Date().toISOString(),
    version: '3.7.0', // Bumped for TruthStream integration
    features: {
      authentication: 'enabled',
      redis: mirrorRedis.isConnected() ? 'connected' : 'disconnected',
      notifications: 'enabled',
      encryption: 'enabled',
      groups: 'enabled',
      groupAnalysis: 'enabled',
      dinaIntegration: 'enabled',
      llmSynthesis: 'enabled',
      truthstream: 'enabled',
      dinaChatProcessor: 'separate_process', // Runs via PM2/systemd
      websocket: wsHealth.status
    },
    mirrorgroups: {
      phase0: {
        name: 'Redis + Notifications',
        status: 'active',
        redis: mirrorRedis.isConnected() ? 'connected' : 'disconnected'
      },
      phase1: {
        name: 'Encryption + Group APIs',
        status: 'active'
      },
      phase3: {
        name: 'Group Analysis System',
        status: 'active',
        analyzers: {
          compatibility: 'active',
          collectiveStrength: 'active',
          conflictRisk: 'active',
          orchestrator: 'active'
        }
      },
      phase3_5: {
        name: 'DINA LLM Integration',
        status: 'active',
        protocol: 'DinaUniversalMessage v2.0',
        endpoint: process.env.DINA_ENDPOINT || 'configured',
        authentication: 'auto-registration',
        circuitBreaker: 'initialized',
        fallback: 'stub-synthesis'
      },
      phase4: {
        name: 'Conversation Intelligence + Voting',
        status: 'active',
        features: {
          voting: 'enabled',
          conversationAnalysis: 'enabled',
          periodicInsights: 'enabled',
          postSessionSummary: 'enabled'
        },
        config: {
          checkInIntervalMs: process.env.AI_CHECKIN_INTERVAL_MS || '1800000',
          voteDefaultDuration: process.env.VOTE_DURATION_SECONDS || '60'
        }
      },
      phase5: {
        name: 'Chat Infrastructure + @Dina',
        status: 'active',
        features: {
          messaging: 'enabled',
          encryption: 'e2e',
          typing: 'enabled',
          presence: 'enabled',
          reactions: 'enabled',
          readReceipts: 'enabled',
          threading: 'enabled',
          pinnedMessages: 'enabled',
          search: 'enabled',
          dinaChatBot: 'enabled'
        },
        dinaChatProcessor: {
          note: 'Runs as separate process via PM2/systemd',
          command: 'npx ts-node workers/DinaChatQueueProcessor.ts'
        },
        websocket: {
          path: '/mirror/groups/chat',
          authentication: 'JWT'
        }
      }
    },
    truthStream: {
      status: 'active',
      queueProcessor: 'separate_process',
      command: 'npx ts-node workers/TruthStreamQueueProcessor.ts',
      endpoints: '/mirror/api/truthstream/*'
    },
    endpoints: {
      auth: '/mirror/api/auth',
      user: '/mirror/api/user',
      storage: '/mirror/api/storage',
      intake: '/mirror/api/intake',
      dashboard: '/mirror/api/dashboard',
      journal: '/mirror/api/journal',
      groups: '/mirror/api/groups',
      insights: '/mirror/api/groups/:groupId/insights',
      votes: '/mirror/api/groups/:groupId/votes',
      sessions: '/mirror/api/groups/:groupId/sessions/:sessionId',
      chat: '/mirror/api/groups/:groupId/chat',
      truthstream: '/mirror/api/truthstream/*',
      websocket: 'wss://theundergroundrailroad.world:8444/mirror/groups/ws',
      chatWebsocket: 'wss://theundergroundrailroad.world:8444/mirror/groups/chat'
    }
  });
});

// ============================================================================
// MIRRORGROUPS INFRASTRUCTURE INITIALIZATION
// ============================================================================

/**
 * Initialize all MirrorGroups infrastructure components
 * Phase 0: Redis + Notifications
 * Phase 1: Encryption + Group APIs
 * Phase 3: Group Analysis System
 * Phase 3.5: DINA LLM Integration
 * Phase 5: Chat Infrastructure + @Dina Chat Processor
 */
async function initializeMirrorGroupsInfrastructure(): Promise<void> {
  console.log('🚀 Initializing MirrorGroups Infrastructure (Phase 0 → Phase 5 + @Dina)...');

  try {
    // =========================================================================
    // PHASE 0: Redis Connection
    // =========================================================================
    console.log('📡 Phase 0: Connecting to Redis...');

    let retries = 10;
    while (!mirrorRedis.isConnected() && retries > 0) {
      console.log(`⏳ Redis connection attempt ${11 - retries}/10...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      retries--;
    }

    if (!mirrorRedis.isConnected()) {
      throw new Error('Failed to connect to Redis after 10 attempts');
    }
    console.log('✅ Phase 0: Redis connected successfully');

    // =========================================================================
    // PHASE 0: Group Notifications
    // =========================================================================
    console.log('📬 Phase 0: Initializing Group Notification System...');
    await mirrorGroupNotifications.initialize();
    console.log('✅ Phase 0: Group Notification System initialized');

    // =========================================================================
    // PHASE 1: Encryption Manager
    // =========================================================================
    console.log('🔐 Phase 1: Initializing Group Encryption Manager...');
    await groupEncryptionManager.initialize();
    console.log('✅ Phase 1: Group Encryption Manager initialized');

    // =========================================================================
    // PHASE 3: Group Analysis System
    // =========================================================================
    console.log('🧠 Phase 3: Initializing Group Analysis System...');

    // Initialize sub-analyzers first
    console.log('   📊 Initializing Compatibility Calculator...');
    await compatibilityCalculator.initialize();
    console.log('   ✅ Compatibility Calculator ready');

    console.log('   💪 Initializing Collective Strength Detector...');
    await collectiveStrengthDetector.initialize();
    console.log('   ✅ Collective Strength Detector ready');

    console.log('   ⚠️  Initializing Conflict Risk Predictor...');
    await conflictRiskPredictor.initialize();
    console.log('   ✅ Conflict Risk Predictor ready');

    // Initialize main analyzer (orchestrator)
    console.log('   🎯 Initializing Group Analyzer (orchestrator)...');
    await groupAnalyzer.initialize();
    console.log('✅ Phase 3: Group Analysis System initialized (4 analyzers active)');

    // =========================================================================
    // PHASE 3.5: DINA LLM Integration
    // =========================================================================
    console.log('🤖 Phase 3.5: Initializing DINA LLM Integration...');

    const dinaEndpoint = process.env.DINA_ENDPOINT || 'https://www.theundergroundrailroad.world/dina/api/v1/models/mistral:7b/chat';
    const dinaKey = process.env.DINA_KEY;
    const userId = process.env.DINA_USER_ID || 'mirror-groups-system';

    console.log(`   🌐 DINA Endpoint: ${dinaEndpoint}`);
    console.log(`   📋 Protocol: DinaUniversalMessage v2.0`);
    console.log(`   🔑 Authentication: Auto-registration (no API key required)`);
    console.log(`   👤 User ID: ${userId}`);

    if (dinaKey) {
      console.log(`   🎫 DINA Key: ${dinaKey.substring(0, 20)}... (reusing existing registration)`);
    } else {
      console.log(`   🎫 DINA Key: Will auto-register on first request`);
    }

    // Initialize DINA connector (includes circuit breaker)
    await dinaLLMConnector.initialize();

    console.log('✅ Phase 3.5: DINA LLM Integration initialized');
    console.log(`   🔌 Circuit Breaker: CLOSED (Threshold: 5 failures, 60s recovery)`);
    console.log(`   💡 LLM Synthesis: Enabled with graceful fallback to stub mode`);
    console.log(`   🔄 Resilience: Circuit breaker active, 60s recovery window`);

    // =========================================================================
    // PHASE 4: Conversation Intelligence + Voting
    // =========================================================================
    console.log('🗳️ Phase 4: Initializing Conversation Intelligence + Voting...');

    await conversationAnalyzer.initialize();

    console.log('✅ Phase 4: Conversation Intelligence + Voting initialized');
    console.log(`   🧠 Conversation Analyzer: Ready`);
    console.log(`   🗳️ Group Voting: Enabled (${process.env.VOTE_DURATION_SECONDS || 60}s default)`);
    console.log(`   ⏱️ Periodic Check-ins: Every ${(parseInt(process.env.AI_CHECKIN_INTERVAL_MS || '1800000') / 60000).toFixed(0)} minutes`);
    console.log(`   📊 Post-Session Summaries: Enabled`);

    // =========================================================================
    // PHASE 5: Chat Infrastructure
    // =========================================================================
    console.log('💬 Phase 5: Initializing Chat Infrastructure...');

    await chatMessageManager.initialize();

    console.log('✅ Phase 5: Chat Infrastructure initialized');
    console.log(`   📱 Real-time Messaging: Enabled`);
    console.log(`   🔐 End-to-End Encryption: Enabled`);
    console.log(`   ⌨️ Typing Indicators: Enabled`);
    console.log(`   👤 Presence Status: Enabled`);
    console.log(`   😀 Reactions: Enabled`);
    console.log(`   ✅ Read Receipts: Enabled`);
    console.log(`   🧵 Message Threading: Enabled`);
    console.log(`   📌 Pinned Messages: Enabled`);
    console.log(`   🔍 Search: Enabled`);
    console.log(`   🌐 WebSocket: /mirror/groups/chat`);

    // =========================================================================
    // @DINA CHAT QUEUE PROCESSOR - RUNS AS SEPARATE PROCESS
    // =========================================================================
    console.log('📝 Note: @Dina Chat Queue Processor runs as a SEPARATE PROCESS');
    console.log('   Run separately via PM2/systemd: npx ts-node workers/DinaChatQueueProcessor.ts');
    console.log('   This ensures non-blocking, truly async processing');

    console.log('\n🎉 MirrorGroups Infrastructure fully initialized (Phase 0 → Phase 5)');
  } catch (error) {
    logError('Failed to initialize MirrorGroups Infrastructure', error);
    throw error;
  }
}

// ============================================================================
// WEBSOCKET BROADCAST WIRING
// ============================================================================

/**
 * Wire up the WebSocket broadcast function for Chat routes
 * Call this after WebSocket is set up
 * Note: @Dina Chat Processor runs as separate process with its own WebSocket handling
 */
function wireWebSocketBroadcast(wss: any): void {
  // Create a broadcast function that emits to all clients in a group
  const broadcastToGroup = (groupId: string, payload: any) => {
    // This implementation depends on your WebSocket setup
    // Option 1: Using Socket.io
    // wss.to(`group:${groupId}`).emit(payload.type, payload);

    // Option 2: Using raw WebSocket with room management
    // Your SetupWebSocket should expose a broadcast method
    if (wss.broadcastToGroup) {
      wss.broadcastToGroup(groupId, payload);
    } else if (wss.to) {
      // Socket.io style
      wss.to(`group:${groupId}`).emit(payload.type, payload);
    } else {
      console.log(`[WS] Broadcast to group ${groupId}:`, payload.type);
    }
  };

  // Wire up to groupChat routes
  // Note: DinaChatQueueProcessor runs as separate process - handles its own broadcasting
  setChatBroadcast(broadcastToGroup);

  console.log('✅ WebSocket broadcast wired to Chat routes');
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

/**
 * Setup graceful shutdown handlers for all MirrorGroups components
 */
function setupGracefulShutdown(server: https.Server): void {
  const shutdown = async (signal: string) => {
    console.log(`\n🛑 ${signal} received, shutting down gracefully...`);

    try {
      // Stop accepting new connections
      server.close(() => {
        console.log('✅ HTTP server closed');
      });

      // Shutdown MirrorGroups components in reverse order (Phase 5 → Phase 0)

      // Shutdown DINA WebSocket connection first
      console.log('🔌 Closing DINA WebSocket connection...');
      await dinaWebSocket.shutdown();
      console.log('✅ DINA WebSocket connection closed');

      console.log('💬 Shutting down Chat Infrastructure...');
      await chatMessageManager.shutdown();
      console.log('✅ Chat Infrastructure shutdown complete');

      console.log('🗳️ Shutting down Conversation Intelligence + Voting...');
      await conversationAnalyzer.shutdown();
      console.log('✅ Conversation Intelligence + Voting shutdown complete');

      console.log('🤖 Shutting down DINA LLM Integration...');
      await dinaLLMConnector.shutdown();
      console.log('✅ DINA LLM Integration shutdown complete');

      console.log('🧠 Shutting down Group Analysis System...');
      await groupAnalyzer.shutdown();
      await compatibilityCalculator.shutdown();
      await collectiveStrengthDetector.shutdown();
      await conflictRiskPredictor.shutdown();
      console.log('✅ Group Analysis System shutdown complete');

      console.log('🔐 Shutting down Group Encryption Manager...');
      await groupEncryptionManager.shutdown();
      console.log('✅ Group Encryption Manager shutdown complete');

      console.log('📬 Shutting down Group Notifications...');
      await mirrorGroupNotifications.shutdown();
      console.log('✅ Group Notifications shutdown complete');

      console.log('📡 Closing Redis connection...');
      await mirrorRedis.shutdown();
      console.log('✅ Redis connection closed');

      console.log('👋 Mirror Server shutdown complete');
      process.exit(0);
    } catch (error) {
      logError('Error during graceful shutdown', error);
      process.exit(1);
    }
  };

  // Handle termination signals
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logError('Uncaught Exception', error);
    shutdown('UNCAUGHT_EXCEPTION');
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    shutdown('UNHANDLED_REJECTION');
  });
}

// ============================================================================
// SSL CERTIFICATE LOADING
// ============================================================================

console.log('🔐 Loading SSL certificates...');

const PRIV = fs.readFileSync(process.env.TUGRRPRIV!, 'utf8');
const CERT = fs.readFileSync(process.env.TUGRRCERT!, 'utf8');
const INTERCERT = fs.readFileSync(process.env.TUGRRINTERCERT!, 'utf8');

const credentials = {
  key: PRIV,
  cert: CERT,
  ca: INTERCERT,
};

console.log('✅ SSL certificates loaded');

// ============================================================================
// HTTPS SERVER CREATION
// ============================================================================

const httpsServer = https.createServer(credentials, APP);

// ============================================================================
// MAIN SERVER STARTUP
// ============================================================================

/**
 * Main server startup function
 * Initializes all components and starts listening
 */
async function startServer(): Promise<void> {
  try {
    console.log('🚀 Starting Mirror Server with MirrorGroups (Phase 0 → Phase 5 + @Dina)...');
    console.log('📅 Startup time:', new Date().toISOString());

    // Initialize all MirrorGroups infrastructure
    await initializeMirrorGroupsInfrastructure();

    // ========================================================================
    // DINA WEBSOCKET CONNECTION (Must happen before WebSocket layer setup)
    // This establishes the secure connection to DINA server
    // All @Dina chat communication will flow through this single connection
    // ========================================================================
    console.log('\n' + '─'.repeat(60));
    console.log('🔌 DINA WEBSOCKET INITIALIZATION');
    console.log('─'.repeat(60));
    console.log(`   Target: ${process.env.DINA_WS_URL || 'wss://localhost:8445/dina/ws'}`);
    console.log('   Initiating connection...');
    try {
      await dinaWebSocket.initialize();
      console.log('─'.repeat(60));
      console.log('✅ WSS TO DINA-SERVER INITIATED');
      console.log('─'.repeat(60));
      console.log(`   Status: CONNECTED`);
      console.log(`   Connection ID: ${dinaWebSocket.getConnectionId()}`);
      console.log(`   Ready for @Dina chat requests`);
      console.log('─'.repeat(60) + '\n');
    } catch (dinaError) {
      console.log('─'.repeat(60));
      console.warn('⚠️ WSS TO DINA-SERVER FAILED');
      console.log('─'.repeat(60));
      console.warn(`   Error: ${getErrorMessage(dinaError)}`);
      console.warn('   Status: Will retry automatically');
      console.warn('   Fallback: HTTP requests until connection restored');
      console.log('─'.repeat(60) + '\n');
    }

    // Setup WebSocket layer
    // This handles: Mirror protocol, Group notifications, Group signaling (WebRTC)
    console.log('🔌 Setting up WebSocket layer...');
    const wss = SetupWebSocket(httpsServer, mirrorGroupNotifications);
    console.log('✅ WebSocket layer ready');

    // Wire up WebSocket broadcast for @Dina and Chat
    wireWebSocketBroadcast(wss);

    // Setup graceful shutdown handlers
    setupGracefulShutdown(httpsServer);

    // Start listening
    const PORT = parseInt(process.env.MIRRORPORT || '8444');
    httpsServer.listen(PORT, () => {
      console.log('\n' + '='.repeat(80));
      console.log('🎉 MIRROR SERVER WITH MIRRORGROUPS + @DINA CHAT SUCCESSFULLY STARTED');
      console.log('='.repeat(80));
      console.log(`📍 Port: ${PORT}`);
      console.log(`🌐 Base URL: https://theundergroundrailroad.world:${PORT}`);
      console.log(`📊 Health: https://theundergroundrailroad.world:${PORT}/mirror/api/health`);
      console.log('\n📡 WEBSOCKET:');
      console.log(`   URL: wss://theundergroundrailroad.world:${PORT}/mirror/groups/ws?token=YOUR_JWT`);
      console.log(`   Features: Notifications, WebRTC Signaling, Drawing Sync`);
      console.log(`   Auth: JWT token required in query parameter`);
      console.log('\n🔌 API ENDPOINTS:');
      console.log(`   Auth:      /mirror/api/auth/*`);
      console.log(`   User:      /mirror/api/user/*`);
      console.log(`   Storage:   /mirror/api/storage/*`);
      console.log(`   Intake:    /mirror/api/intake/*`);
      console.log(`   Dashboard: /mirror/api/dashboard/*`);
      console.log(`   Journal:   /mirror/api/journal/*`);
      console.log(`   TruthStrm: /mirror/api/truthstream/*`);
      console.log(`   Groups:    /mirror/api/groups/* (Phase 1-3)`);
      console.log(`   Insights:  /mirror/api/groups/:groupId/insights (Phase 3.5)`);
      console.log(`   @Dina Stats: /mirror/api/dina/chat/stats`);
      console.log('\n🎯 MIRRORGROUPS STATUS:');
      console.log(`   ✅ Phase 0: Redis + Notifications`);
      console.log(`   ✅ Phase 1: Encryption + Group APIs + WebRTC Signaling`);
      console.log(`   ✅ Phase 3: Group Analysis (4 Analyzers) + Worker Queue`);
      console.log(`   ✅ Phase 3.5: DINA LLM Integration (DinaUniversalMessage v2.0)`);
      console.log(`   ✅ Phase 4: Conversation Intelligence + Group Voting`);
      console.log(`   ✅ Phase 5: Chat Infrastructure + @Dina Chat Bot`);
      console.log('\n🤖 @DINA CHAT BOT:');
      console.log(`   How it works: Users mention @Dina in group chat`);
      console.log(`   Queue Processing: Automatic (started with server)`);
      console.log(`   Streaming: ${process.env.DINA_STREAMING_ENABLED !== 'false' ? 'ENABLED (default)' : 'DISABLED'}`);
      console.log(`   DINA Server: ${process.env.DINA_BASE_URL || 'http://localhost:8445'}`);
      console.log(`   WebSocket: ${dinaWebSocket.connected ? '✅ CONNECTED' : '⚠️ DISCONNECTED (will retry)'}`);
      console.log(`   Connection ID: ${dinaWebSocket.getConnectionId() || 'N/A'}`);
      console.log(`   Model: ${process.env.DEFAULT_MODEL || 'mistral:7b'}`);
      console.log(`   HTTP Fallback: Active (if WebSocket unavailable)`);
      console.log('\n🤖 DINA INTEGRATION:');
      console.log(`   Endpoint:  ${process.env.DINA_ENDPOINT || 'https://www.theundergroundrailroad.world/dina/api/v1/models/mistral:7b/chat'}`);
      console.log(`   Protocol:  DinaUniversalMessage v2.0`);
      console.log(`   Auth:      Auto-registration (${process.env.DINA_KEY ? 'registered' : 'will register on first request'})`);
      console.log(`   LLM Model: mistral:7b (fast responses for chat)`);
      console.log(`   Fallback:  Intelligent stub synthesis (circuit breaker protected)`);
      console.log('\n📊 ANALYSIS CAPABILITIES:');
      console.log(`   ✅ Compatibility scoring (pairwise + group average)`);
      console.log(`   ✅ Collective strength detection (8+ dimensions)`);
      console.log(`   ✅ Conflict risk prediction (severity + mitigation)`);
      console.log(`   ✅ LLM-powered narrative synthesis (contextual insights)`);
      console.log('\n🗳️ PHASE 4 FEATURES:');
      console.log(`   ✅ Group Voting (yes/no, multiple choice, ${process.env.VOTE_DURATION_SECONDS || 60}s timer)`);
      console.log(`   ✅ Conversation Intelligence (AI-powered insights)`);
      console.log(`   ✅ Periodic Check-ins (every ${parseInt(process.env.AI_CHECKIN_INTERVAL_MS || '1800000') / 60000} min)`);
      console.log(`   ✅ Post-Session Summaries (auto-generated)`);
      console.log(`   ✅ Real-time WebSocket events (votes, insights)`);
      console.log('='.repeat(80) + '\n');
    });

  } catch (error) {
    logError('Failed to start Mirror Server', error);
    process.exit(1);
  }
}

// ============================================================================
// START THE SERVER
// ============================================================================

startServer();
