// index.ts - Mirror Server with MirrorGroups Phase 0 Integration
// Uses existing authentication system and proper separation of concerns

import https from 'https';
import fs from 'fs';
import express from 'express';
import path from 'path';
import dotenv from 'dotenv';

// EXISTING ROUTES
import authRoutes from './routes/auth';
import userRoutes from './routes/user';
import storageRoutes from './routes/storage';
import debugRoutes from './routes/debug';
import intakeRoutes from './routes/intake';
import dashboardRoutes from './routes/dashboard';
import journalRoutes from './routes/journal';

// EXISTING WEBSOCKET SETUP
import { SetupWebSocket, getWebSocketHealth } from './wss/setupWSS';

// ✨ NEW IMPORTS FOR PHASE 0 ✨
import { mirrorRedis } from './config/redis';
import { mirrorGroupNotifications } from './systems/mirrorGroupNotifications';

// ============================================================================
// BEST PRACTICE ERROR HANDLING UTILITIES
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
  // In production, you might want to send this to a security monitoring service
}

// ============================================================================
// ENVIRONMENT SETUP
// ============================================================================

// ✅ 1. Load environment variables
dotenv.config();

// ✅ 2. Validate required environment variables (UPDATED)
const requiredEnvs = [
  'TUGRRPRIV', 
  'TUGRRCERT', 
  'TUGRRINTERCERT', 
  'MIRRORPORT', 
  'MIRRORSTORAGE', 
  'JWT_KEY',
  // ✨ NEW REDIS ENVIRONMENT VARIABLES ✨
  'REDIS_PASSWORD'  // Redis host/port have defaults, but password is required
];

for (const key of requiredEnvs) {
  if (!process.env[key]) {
    throw new Error(`❌ Missing environment variable: ${key}`);
  }
}

// ============================================================================
// EXPRESS APP SETUP
// ============================================================================

// ✅ 3. Create and configure Express
const APP = express();

// ✅ IMPORTANT: express.json() MUST come before any middleware that reads req.body
APP.use(express.json());

// ✅ Custom logging middleware
APP.use((req, res, next) => {
  console.log(`[DEBUG] Incoming ${req.method} request to ${req.url}`);
  console.log(`[DEBUG] Headers:`, req.headers);
  console.log('[DEBUG] Parsed Body:', req.body);
  next();
});

// ✅ 4. Setup existing routes
APP.use('/mirror/api/auth', authRoutes);
APP.use('/mirror/api/user', userRoutes);
APP.use('/mirror/api/storage', storageRoutes);
APP.use('/mirror/api/debug', debugRoutes);
APP.use('/mirror/api/intake', intakeRoutes);
APP.use('/mirror/api/dashboard', dashboardRoutes);
APP.use('/mirror/api/journal', journalRoutes);

// ============================================================================
// MIRRORGROUPS INFRASTRUCTURE
// ============================================================================

// ✨ MirrorGroups Infrastructure Initialization ✨
async function initializeMirrorGroupsInfrastructure(): Promise<void> {
  console.log('🚀 Initializing MirrorGroups Infrastructure (Phase 0)...');

  try {
    // Wait for Redis connection with timeout
    console.log('🔌 Waiting for Redis connection...');
    let retries = 10;
    while (!mirrorRedis.isConnected() && retries > 0) {
      console.log(`⏳ Redis connection attempt ${11 - retries}/10...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      retries--;
    }

    if (!mirrorRedis.isConnected()) {
      throw new Error('Failed to connect to Redis after 10 attempts');
    }
    console.log('✅ Redis connected successfully');

    // Initialize Group Notifications
    console.log('📬 Initializing Group Notification System...');
    await mirrorGroupNotifications.initialize();

    console.log('✅ MirrorGroups Infrastructure initialized successfully');
  } catch (error) {
    logError('Failed to initialize MirrorGroups Infrastructure', error);
    throw error;
  }
}

// ✨ Graceful Shutdown Handler ✨
function setupGracefulShutdown(httpsServer: https.Server): void {
  const gracefulShutdown = async (signal: string) => {
    console.log(`📴 Received ${signal}, starting graceful shutdown...`);

    try {
      // ✨ Shutdown MirrorGroups infrastructure ✨
      console.log('🔌 Shutting down MirrorGroups infrastructure...');
      await mirrorGroupNotifications.shutdown();
      await mirrorRedis.shutdown();

      // Close HTTPS server
      console.log('🔌 Closing HTTPS server...');
      httpsServer.close(() => {
        console.log('✅ HTTPS server closed');
      });

      console.log('✅ Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logError('Error during graceful shutdown', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // PM2 reload signal
}

// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================

// ✨ Health check endpoint with Redis status and proper error handling ✨
APP.get('/mirror/api/health', async (req, res) => {
  try {
    const startTime = Date.now();
    
    // Basic server health
    const serverHealth = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.version,
    };

    // ✨ Redis health check with proper error handling ✨
    let redisHealth;
    try {
      redisHealth = await mirrorRedis.healthCheck();
    } catch (error) {
      redisHealth = {
        status: 'unhealthy',
        error: getErrorMessage(error),
      };
    }

    // ✨ Notification system status ✨
    let notificationStats;
    try {
      const activeConnections = await mirrorGroupNotifications.getActiveConnections();
      notificationStats = {
        initialized: true,
        activeConnections: activeConnections.length,
        note: 'Queue details require authentication'
      };
    } catch (error) {
      notificationStats = {
        initialized: false,
        error: getErrorMessage(error),
      };
    }

    // ✨ WebSocket health check ✨
    let webSocketHealth;
    try {
      webSocketHealth = getWebSocketHealth();
    } catch (error) {
      webSocketHealth = {
        status: 'unhealthy',
        error: getErrorMessage(error),
      };
    }

    const responseTime = Date.now() - startTime;

    res.json({
      server: serverHealth,
      // ✨ MirrorGroups infrastructure status ✨
      mirrorGroups: {
        redis: redisHealth,
        notifications: notificationStats,
        webSocket: webSocketHealth,
        responseTime: `${responseTime}ms`,
      },
    });

  } catch (error) {
    logError('Health check error', error);
    res.status(500).json({
      status: 'error',
      error: getErrorMessage(error),
      timestamp: new Date().toISOString(),
    });
  }
});

// ============================================================================
// SSL AND SERVER SETUP
// ============================================================================

// ✅ 5. SSL certificate loading
const PRIV = fs.readFileSync(process.env.TUGRRPRIV!, 'utf8');
const CERT = fs.readFileSync(process.env.TUGRRCERT!, 'utf8');
const INTERCERT = fs.readFileSync(process.env.TUGRRINTERCERT!, 'utf8');

const credentials = {
  key: PRIV,
  cert: CERT,
  ca: INTERCERT,
};

// ✅ 6. Create HTTPS server
const httpsServer = https.createServer(credentials, APP);

// ============================================================================
// MAIN SERVER STARTUP
// ============================================================================

// ✨ Main Server Startup Function ✨
async function startServer(): Promise<void> {
  try {
    console.log('🚀 Starting Mirror Server with MirrorGroups...');

    // Initialize MirrorGroups infrastructure first
    await initializeMirrorGroupsInfrastructure();

    // ✅ Setup WebSocket layer (delegates to existing setupWSS module)
    // This will handle both existing WebSocket functionality AND new group notifications
    SetupWebSocket(httpsServer, mirrorGroupNotifications);

    // Setup graceful shutdown
    setupGracefulShutdown(httpsServer);

    // Start listening
    const PORT = parseInt(process.env.MIRRORPORT || '8444');
    httpsServer.listen(PORT, () => {
      console.log(`✅ MIRROR SERVER WITH MIRRORGROUPS LISTENING on port ${PORT}`);
      console.log(`📊 Health check: https://theundergroundrailroad.world:${PORT}/mirror/api/health`);
      console.log(`🔌 Authenticated WebSocket: wss://theundergroundrailroad.world:${PORT}/mirror/groups/ws?token=YOUR_JWT`);
      console.log(`🔐 WebSocket requires valid JWT token for connection`);
      console.log(`🎯 Phase 0 infrastructure ready with authentication!`);
    });

  } catch (error) {
    logError('Failed to start Mirror Server', error);
    process.exit(1);
  }
}

// ✨ Start the server ✨
startServer();
