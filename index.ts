// index.ts - Mirror Server with MirrorGroups Phase 1 Integration
// Includes: Existing routes, Redis, Notifications, Encryption, Group APIs, WebSocket signaling

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
// MIRRORGROUPS PHASE 1 + PHASE 3 (NEW)
// ============================================================================
import { groupEncryptionManager } from './systems/GroupEncryptionManager';
import groupRoutes from './routes/groups';
import groupInsightsRoutes from './routes/groupInsights';

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
// MOUNT MIRRORGROUPS ROUTES (PHASE 1 + PHASE 3)
// ============================================================================

APP.use('/mirror/api/groups', groupRoutes);
console.log('📍 MirrorGroups routes mounted at /mirror/api/groups');

APP.use('/mirror/api', groupInsightsRoutes);
console.log('📍 MirrorGroups Insights routes mounted at /mirror/api/groups/:groupId/insights');

// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================

APP.get('/mirror/api/health', (req, res) => {
  const wsHealth = getWebSocketHealth();
  
  res.json({
    status: 'healthy',
    service: 'mirror-server',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    features: {
      authentication: 'enabled',
      redis: mirrorRedis.isConnected() ? 'connected' : 'disconnected',
      notifications: 'enabled',
      encryption: 'enabled',
      groups: 'enabled',
      websocket: wsHealth.status
    },
    endpoints: {
      auth: '/mirror/api/auth',
      user: '/mirror/api/user',
      storage: '/mirror/api/storage',
      intake: '/mirror/api/intake',
      dashboard: '/mirror/api/dashboard',
      journal: '/mirror/api/journal',
      groups: '/mirror/api/groups',
      websocket: 'wss://theundergroundrailroad.world:8444/mirror/groups/ws'
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
 */
async function initializeMirrorGroupsInfrastructure(): Promise<void> {
  console.log('🚀 Initializing MirrorGroups Infrastructure (Phase 0 + Phase 1)...');

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

    console.log('🎉 MirrorGroups Infrastructure fully initialized (Phase 0 + Phase 1)');
  } catch (error) {
    logError('Failed to initialize MirrorGroups Infrastructure', error);
    throw error;
  }
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

      // Shutdown MirrorGroups components in reverse order
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
    console.log('🚀 Starting Mirror Server with MirrorGroups (Phase 0 + Phase 1)...');
    console.log('📅 Startup time:', new Date().toISOString());

    // Initialize all MirrorGroups infrastructure
    await initializeMirrorGroupsInfrastructure();

    // Setup WebSocket layer
    // This handles: Mirror protocol, Group notifications, Group signaling (WebRTC)
    console.log('🔌 Setting up WebSocket layer...');
    SetupWebSocket(httpsServer, mirrorGroupNotifications);
    console.log('✅ WebSocket layer ready');

    // Setup graceful shutdown handlers
    setupGracefulShutdown(httpsServer);

    // Start listening
    const PORT = parseInt(process.env.MIRRORPORT || '8444');
    httpsServer.listen(PORT, () => {
      console.log('\n' + '='.repeat(80));
      console.log('🎉 MIRROR SERVER WITH MIRRORGROUPS SUCCESSFULLY STARTED');
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
      console.log(`   Groups:    /mirror/api/groups/* (Phase 1)`);
      console.log('\n🎯 MIRRORGROUPS STATUS:');
      console.log(`   ✅ Phase 0: Redis + Notifications`);
      console.log(`   ✅ Phase 1: Encryption + Group APIs + WebRTC Signaling`);
      console.log(`   🔜 Phase 2: Data Sharing`);
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
