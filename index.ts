// index.ts - Mirror Server with MirrorGroups Phase 3.5 Integration + @Dina Chat + TruthStream
// Includes: Existing routes, Redis, Notifications, Encryption, Group APIs, WebSocket signaling, Group Analysis, DINA LLM, @Dina Chat, TruthStream
// UPDATED: Added Helmet.js, CORS, request size limits, security headers middleware

import https from 'https';
import fs from 'fs';
import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import helmet from 'helmet';

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
// PERSONAL ANALYSIS (MyMirror Comprehensive Reports)
// ============================================================================
import personalAnalysisRouter from './routes/personalAnalysis';

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
// AUTH MIDDLEWARE (for security headers)
// ============================================================================
import AuthMiddleware from './middleware/authMiddleware';

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
  const message = getErrorMessage(error);
  if (process.env.NODE_ENV === 'production') {
    // Structured logging in production - no stack traces in output
    console.error(JSON.stringify({
      level: 'error',
      context,
      message,
      timestamp: new Date().toISOString()
    }));
  } else {
    console.error(`[ERROR] ${context}:`, message);
    const stack = getErrorStack(error);
    if (stack) {
      console.error('Stack trace:', stack);
    }
  }
}

function logSecurityEvent(event: string, details: any): void {
  console.warn(JSON.stringify({
    level: 'security',
    event,
    details,
    timestamp: new Date().toISOString()
  }));
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
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

// Validate SYSTEM_MASTER_KEY format (must be 64 hex characters)
if (process.env.SYSTEM_MASTER_KEY!.length !== 64) {
  throw new Error('SYSTEM_MASTER_KEY must be exactly 64 hexadecimal characters (256 bits)');
}

console.log('[STARTUP] All required environment variables validated');

// ============================================================================
// EXPRESS APP SETUP
// ============================================================================

const APP = express();

// ============================================================================
// SECURITY MIDDLEWARE (Applied BEFORE routes)
// ============================================================================

// Helmet.js - Comprehensive HTTP security headers
// Provides: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection,
//           Strict-Transport-Security, Content-Security-Policy, and more
APP.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],  // No unsafe-inline or unsafe-eval
      styleSrc: ["'self'", "'unsafe-inline'"],  // Inline styles needed for Tailwind
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "https:"],
      connectSrc: ["'self'", "wss:", "https:"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,  // Allow cross-origin resources (images, fonts)
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

// CORS configuration - explicit allowed origins only
const ALLOWED_ORIGINS = [
  'https://www.theundergroundrailroad.world',
  'https://theundergroundrailroad.world',
];

// Add development origins only in non-production
if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push(
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173'
  );
}

APP.use(((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400'); // 24 hour preflight cache
  }
  // Do NOT set wildcard or fall through with * — reject unknown origins silently

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}) as express.RequestHandler);

// Request body parsing with size limits
APP.use(express.json({ limit: '100kb', strict: true }));
APP.use(express.urlencoded({ extended: false, limit: '50kb' }));

// Request logging middleware (structured in production)
APP.use(((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    console.log(JSON.stringify({
      level: 'info',
      method: req.method,
      url: req.url,
      ip: (req.ip || '').replace('::ffff:', ''),
      timestamp: new Date().toISOString()
    }));
  } else {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  }
  next();
}) as express.RequestHandler);

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
console.log('[ROUTES] MirrorGroups routes mounted at /mirror/api/groups');

APP.use('/mirror/api', groupInsightsRoutes);
console.log('[ROUTES] MirrorGroups Insights routes mounted at /mirror/api/groups/:groupId/insights');

// Phase 4: Voting and Conversation Intelligence
APP.use('/mirror/api', groupVotesRoutes);
console.log('[ROUTES] MirrorGroups Voting routes mounted at /mirror/api/groups/:groupId/votes');

APP.use('/mirror/api', sessionInsightsRoutes);
console.log('[ROUTES] MirrorGroups Session Insights routes mounted at /mirror/api/groups/:groupId/sessions');

// Phase 5: Chat Infrastructure
APP.use('/mirror/api/groups', groupChatRoutes);
console.log('[ROUTES] MirrorGroups Chat routes mounted at /mirror/api/groups/:groupId/chat');

// ============================================================================
// MOUNT TRUTHSTREAM ROUTES
// ============================================================================

APP.use('/mirror/api/truthstream', truthstreamRoutes);
console.log('[ROUTES] TruthStream routes mounted at /mirror/api/truthstream');

// ============================================================================
// MOUNT PERSONAL ANALYSIS ROUTES
// ============================================================================

APP.use('/mirror/api/personal-analysis', personalAnalysisRouter);
console.log('[ROUTES] Personal Analysis routes mounted at /mirror/api/personal-analysis');

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
    version: '3.8.0', // Bumped for security hardening
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
      websocket: wsHealth.status,
      security: {
        helmet: 'enabled',
        cors: 'strict',
        csp: 'enforced',
        hsts: 'enabled',
        requestSizeLimit: '100kb'
      }
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
        endpoint: process.env.DINA_ENDPOINT ? 'configured' : 'default',
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
// GLOBAL ERROR HANDLER (Catch-all for unhandled route errors)
// ============================================================================

APP.use(((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logError(`Unhandled error on ${req.method} ${req.path}`, err);

  // Never expose internal error details in production
  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    error: statusCode >= 500 ? 'Internal server error' : (err.message || 'Request failed'),
    code: err.code || 'INTERNAL_ERROR'
  });
}) as express.ErrorRequestHandler);

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
  console.log('[STARTUP] Initializing MirrorGroups Infrastructure (Phase 0 -> Phase 5 + @Dina)...');

  try {
    // =========================================================================
    // PHASE 0: Redis Connection
    // =========================================================================
    console.log('[PHASE 0] Connecting to Redis...');

    let retries = 10;
    while (!mirrorRedis.isConnected() && retries > 0) {
      console.log(`[PHASE 0] Redis connection attempt ${11 - retries}/10...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      retries--;
    }

    if (!mirrorRedis.isConnected()) {
      throw new Error('Failed to connect to Redis after 10 attempts');
    }
    console.log('[PHASE 0] Redis connected successfully');

    // =========================================================================
    // PHASE 0: Group Notifications
    // =========================================================================
    console.log('[PHASE 0] Initializing Group Notification System...');
    await mirrorGroupNotifications.initialize();
    console.log('[PHASE 0] Group Notification System initialized');

    // =========================================================================
    // PHASE 1: Encryption Manager
    // =========================================================================
    console.log('[PHASE 1] Initializing Group Encryption Manager...');
    await groupEncryptionManager.initialize();
    console.log('[PHASE 1] Group Encryption Manager initialized');

    // =========================================================================
    // PHASE 3: Group Analysis System
    // =========================================================================
    console.log('[PHASE 3] Initializing Group Analysis System...');

    // Initialize sub-analyzers first
    await compatibilityCalculator.initialize();
    await collectiveStrengthDetector.initialize();
    await conflictRiskPredictor.initialize();

    // Initialize main analyzer (orchestrator)
    await groupAnalyzer.initialize();
    console.log('[PHASE 3] Group Analysis System initialized (4 analyzers active)');

    // =========================================================================
    // PHASE 3.5: DINA LLM Integration
    // =========================================================================
    console.log('[PHASE 3.5] Initializing DINA LLM Integration...');

    const dinaEndpoint = process.env.DINA_ENDPOINT || 'https://www.theundergroundrailroad.world/dina/api/v1/models/mistral:7b/chat';
    const dinaKey = process.env.DINA_KEY;
    const userId = process.env.DINA_USER_ID || 'mirror-groups-system';

    console.log(`[PHASE 3.5] DINA Endpoint: ${dinaEndpoint}`);
    console.log(`[PHASE 3.5] Protocol: DinaUniversalMessage v2.0`);
    console.log(`[PHASE 3.5] User ID: ${userId}`);

    if (dinaKey) {
      console.log(`[PHASE 3.5] DINA Key: ${dinaKey.substring(0, 8)}... (reusing existing registration)`);
    } else {
      console.log(`[PHASE 3.5] DINA Key: Will auto-register on first request`);
    }

    // Initialize DINA connector (includes circuit breaker)
    await dinaLLMConnector.initialize();

    console.log('[PHASE 3.5] DINA LLM Integration initialized');

    // =========================================================================
    // PHASE 4: Conversation Intelligence + Voting
    // =========================================================================
    console.log('[PHASE 4] Initializing Conversation Intelligence + Voting...');

    await conversationAnalyzer.initialize();

    console.log('[PHASE 4] Conversation Intelligence + Voting initialized');

    // =========================================================================
    // PHASE 5: Chat Infrastructure
    // =========================================================================
    console.log('[PHASE 5] Initializing Chat Infrastructure...');

    await chatMessageManager.initialize();

    console.log('[PHASE 5] Chat Infrastructure initialized');

    console.log('[STARTUP] MirrorGroups Infrastructure fully initialized (Phase 0 -> Phase 5)');
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
  setChatBroadcast(broadcastToGroup);

  console.log('[WS] WebSocket broadcast wired to Chat routes');
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

/**
 * Setup graceful shutdown handlers for all MirrorGroups components
 */
function setupGracefulShutdown(server: https.Server): void {
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return; // Prevent double shutdown
    isShuttingDown = true;

    console.log(`[SHUTDOWN] ${signal} received, shutting down gracefully...`);

    // Set a hard timeout to force exit if graceful shutdown hangs
    const forceExitTimer = setTimeout(() => {
      console.error('[SHUTDOWN] Graceful shutdown timed out after 30s, forcing exit');
      process.exit(1);
    }, 30000);
    forceExitTimer.unref(); // Don't keep process alive just for this timer

    try {
      // Stop accepting new connections
      server.close(() => {
        console.log('[SHUTDOWN] HTTP server closed');
      });

      // Shutdown MirrorGroups components in reverse order (Phase 5 -> Phase 0)

      // Shutdown DINA WebSocket connection first
      console.log('[SHUTDOWN] Closing DINA WebSocket connection...');
      await dinaWebSocket.shutdown();
      console.log('[SHUTDOWN] DINA WebSocket connection closed');

      console.log('[SHUTDOWN] Shutting down Chat Infrastructure...');
      await chatMessageManager.shutdown();
      console.log('[SHUTDOWN] Chat Infrastructure shutdown complete');

      console.log('[SHUTDOWN] Shutting down Conversation Intelligence + Voting...');
      await conversationAnalyzer.shutdown();
      console.log('[SHUTDOWN] Conversation Intelligence + Voting shutdown complete');

      console.log('[SHUTDOWN] Shutting down DINA LLM Integration...');
      await dinaLLMConnector.shutdown();
      console.log('[SHUTDOWN] DINA LLM Integration shutdown complete');

      console.log('[SHUTDOWN] Shutting down Group Analysis System...');
      await groupAnalyzer.shutdown();
      await compatibilityCalculator.shutdown();
      await collectiveStrengthDetector.shutdown();
      await conflictRiskPredictor.shutdown();
      console.log('[SHUTDOWN] Group Analysis System shutdown complete');

      console.log('[SHUTDOWN] Shutting down Group Encryption Manager...');
      await groupEncryptionManager.shutdown();
      console.log('[SHUTDOWN] Group Encryption Manager shutdown complete');

      console.log('[SHUTDOWN] Shutting down Group Notifications...');
      await mirrorGroupNotifications.shutdown();
      console.log('[SHUTDOWN] Group Notifications shutdown complete');

      console.log('[SHUTDOWN] Closing Redis connection...');
      await mirrorRedis.shutdown();
      console.log('[SHUTDOWN] Redis connection closed');

      console.log('[SHUTDOWN] Mirror Server shutdown complete');
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
    logError('Unhandled Rejection', reason);
    shutdown('UNHANDLED_REJECTION');
  });
}

// ============================================================================
// SSL CERTIFICATE LOADING
// ============================================================================

console.log('[STARTUP] Loading SSL certificates...');

const PRIV = fs.readFileSync(process.env.TUGRRPRIV!, 'utf8');
const CERT = fs.readFileSync(process.env.TUGRRCERT!, 'utf8');
const INTERCERT = fs.readFileSync(process.env.TUGRRINTERCERT!, 'utf8');

const credentials = {
  key: PRIV,
  cert: CERT,
  ca: INTERCERT,
};

console.log('[STARTUP] SSL certificates loaded');

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
    console.log('[STARTUP] Starting Mirror Server with MirrorGroups (Phase 0 -> Phase 5 + @Dina)...');
    console.log(`[STARTUP] Time: ${new Date().toISOString()}`);
    console.log(`[STARTUP] Environment: ${process.env.NODE_ENV || 'development'}`);

    // Initialize all MirrorGroups infrastructure
    await initializeMirrorGroupsInfrastructure();

    // ========================================================================
    // DINA WEBSOCKET CONNECTION (Must happen before WebSocket layer setup)
    // ========================================================================
    console.log('[DINA-WS] Initiating connection...');
    console.log(`[DINA-WS] Target: ${process.env.DINA_WS_URL || 'wss://localhost:8445/dina/ws'}`);
    try {
      await dinaWebSocket.initialize();
      console.log(`[DINA-WS] CONNECTED (ID: ${dinaWebSocket.getConnectionId()})`);
    } catch (dinaError) {
      console.warn(`[DINA-WS] Connection failed: ${getErrorMessage(dinaError)} - Will retry automatically`);
    }

    // Setup WebSocket layer
    console.log('[WS] Setting up WebSocket layer...');
    const wss = SetupWebSocket(httpsServer, mirrorGroupNotifications);
    console.log('[WS] WebSocket layer ready');

    // Wire up WebSocket broadcast for @Dina and Chat
    wireWebSocketBroadcast(wss);

    // Setup graceful shutdown handlers
    setupGracefulShutdown(httpsServer);

    // Start listening
    const PORT = parseInt(process.env.MIRRORPORT || '8444');
    httpsServer.listen(PORT, () => {
      console.log('='.repeat(70));
      console.log('MIRROR SERVER STARTED SUCCESSFULLY');
      console.log('='.repeat(70));
      console.log(`  Port: ${PORT}`);
      console.log(`  Base URL: https://theundergroundrailroad.world:${PORT}`);
      console.log(`  Health: https://theundergroundrailroad.world:${PORT}/mirror/api/health`);
      console.log(`  Security: Helmet + CORS + CSP + HSTS + Size Limits`);
      console.log(`  DINA WS: ${dinaWebSocket.connected ? 'CONNECTED' : 'DISCONNECTED (will retry)'}`);
      console.log(`  Model: ${process.env.DEFAULT_MODEL || 'mistral:7b'}`);
      console.log('='.repeat(70));
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
