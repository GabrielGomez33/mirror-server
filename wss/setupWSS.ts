// wss/setupWSS.ts - Single WebSocket server with manual routing
// Phase 5: Extended with real-time chat support
// Phase 5.1: @Dina broadcast bridge via Redis pub/sub
// Phase 5.2: last_active tracking on connect/disconnect
// Phase 6: Robust connection management with native ping/pong

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import * as https from 'https';
import { TokenManager } from '../controllers/authController';
import { MirrorGroupNotificationSystem } from '../systems/mirrorGroupNotifications';
import { chatWSHandler } from './chatWSHandler';
import { mirrorRedis } from '../config/redis';
import { DINA_BROADCAST_CHANNEL } from '../workers/DinaChatQueueProcessor';
import { DB } from '../db';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error occurred';
}

function logError(context: string, error: unknown): void {
  console.error(`Error ${context}:`, getErrorMessage(error));
}

function logSecurityEvent(event: string, details: any): void {
  console.warn(`SECURITY: ${event}`, details);
}

// ============================================================================
// CONNECTION LIVENESS CONFIGURATION
// ============================================================================

/** How often the server sends native WebSocket ping frames (ms) */
const PING_INTERVAL = 30_000;

/** How long to wait for a pong before considering the connection dead (ms) */
const PONG_TIMEOUT = 10_000;

// ============================================================================
// CONNECTED USERS TRACKING (for online status)
// ============================================================================

// Track all users with active WebSocket connections (group WS + chat WS)
const connectedUserIds: Set<number> = new Set();

// Track all managed WebSocket connections for heartbeat sweeping
interface ManagedConnection {
  ws: WebSocket;
  userId: number | null;
  route: string;
  isAlive: boolean;
  connectedAt: number;
}
const managedConnections: Set<ManagedConnection> = new Set();

/**
 * Update last_active timestamp in the users table.
 * Fire-and-forget: errors are logged but do not break the connection flow.
 */
function updateLastActive(userId: number): void {
  DB.query('UPDATE users SET last_active = NOW() WHERE id = ?', [userId]).catch(err => {
    logError(`Failed to update last_active for user ${userId}`, err);
  });
}

/**
 * Check if a user currently has an active WebSocket connection.
 * This checks both group notification WS and chat WS connections.
 */
export function isUserOnline(userId: number): boolean {
  return connectedUserIds.has(userId) || chatWSHandler.isUserConnected(userId);
}

/**
 * Get all currently connected user IDs.
 */
export function getConnectedUserIds(): number[] {
  return Array.from(connectedUserIds);
}

/**
 * Register a WebSocket for server-side liveness monitoring.
 * Attaches a pong listener and tracks the connection for periodic sweeps.
 */
function trackConnection(ws: WebSocket, userId: number | null, route: string): ManagedConnection {
  const conn: ManagedConnection = {
    ws,
    userId,
    route,
    isAlive: true,
    connectedAt: Date.now(),
  };

  // Native pong handler: the ws library fires 'pong' when the client
  // responds to a protocol-level ping frame. This is handled at the TCP
  // level by the browser and does NOT require any application-level code
  // on the client side.
  ws.on('pong', () => {
    conn.isAlive = true;
  });

  managedConnections.add(conn);

  // Clean up tracking on close
  const onClose = () => {
    managedConnections.delete(conn);
  };
  ws.on('close', onClose);

  return conn;
}

/**
 * Handle application-level ping messages from clients.
 * Clients send JSON {"type":"ping"} and expect {"type":"pong"}.
 * Returns true if the message was a ping and was handled.
 */
function handleAppPing(ws: WebSocket, data: string): boolean {
  try {
    const msg = JSON.parse(data);
    if (msg.type === 'ping') {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      }
      return true;
    }
  } catch {
    // Not JSON or parse error - not a ping
  }
  return false;
}

// ============================================================================
// WEBSOCKET SERVER SETUP
// ============================================================================

let heartbeatSweepTimer: ReturnType<typeof setInterval> | null = null;

export function SetupWebSocket(
  server: https.Server,
  groupNotifications?: MirrorGroupNotificationSystem
): void {
  console.log('Setting up single WebSocket server with routing...');

  // Initialize chat WebSocket handler
  chatWSHandler.initialize().catch(err => {
    console.error('Failed to initialize chat WebSocket handler:', err);
  });

  // Subscribe to @Dina broadcast channel (bridges separate processor → chat WebSocket)
  mirrorRedis.subscribe(DINA_BROADCAST_CHANNEL, (message: string) => {
    try {
      const { groupId, payload } = JSON.parse(message);
      const sent = chatWSHandler.broadcastToGroup(groupId, payload);
      if (sent > 0) {
        console.log(`[DINA-BRIDGE] Delivered ${payload.type} to ${sent} client(s) in group ${groupId}`);
      }
    } catch (err) {
      console.error('[DINA-BRIDGE] Failed to relay broadcast:', err);
    }
  });

  // Single WebSocket server - no path specified
  const wss = new WebSocketServer({
    server
  });

  // --------------------------------------------------------------------------
  // Server-side heartbeat sweep: ping all connections, terminate dead ones
  // --------------------------------------------------------------------------
  // This runs at PING_INTERVAL. On each sweep:
  //   1. Any connection that hasn't responded to the PREVIOUS ping is dead → terminate it.
  //   2. All surviving connections get a new ping frame sent.
  // The ws library's native ping/pong uses WebSocket control frames (opcode 0x9/0xA).
  // Browsers respond to these automatically at the protocol level - no client JS needed.
  heartbeatSweepTimer = setInterval(() => {
    for (const conn of managedConnections) {
      if (!conn.isAlive) {
        // Did not respond to previous ping - connection is dead
        console.log(`[WS-HEARTBEAT] Dead connection detected (user=${conn.userId}, route=${conn.route}), terminating`);
        conn.ws.terminate();
        // 'close' event handler will clean up managedConnections + connectedUserIds
        continue;
      }

      // Mark as not-alive, send ping. If pong comes back before next sweep, isAlive resets to true.
      conn.isAlive = false;
      try {
        conn.ws.ping();
      } catch {
        // Socket already broken, terminate
        conn.ws.terminate();
      }
    }
  }, PING_INTERVAL);

  // Don't let the sweep timer keep the process alive during graceful shutdown
  if (heartbeatSweepTimer.unref) {
    heartbeatSweepTimer.unref();
  }

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const url = req.url || '';

    // Route 1: Mirror WebSocket (/ws)
    if (url === '/ws') {
      const protocol = req.headers['sec-websocket-protocol'];

      if (protocol === 'Mirror') {
        console.log('Mirror client connected');
        trackConnection(ws, null, '/ws');

        ws.on('close', () => {
          console.log('Mirror client disconnected');
        });

        ws.on('error', (error) => {
          console.error('WebSocket error:', error);
        });

      } else {
        console.log('Invalid protocol, closing connection');
        ws.close();
      }
      return;
    }

    // Route 2: Group WebSocket (/mirror/groups/ws)
    if (url.startsWith('/mirror/groups/ws')) {
      if (!groupNotifications) {
        console.log('Group notifications not available');
        ws.close(1011, 'Service unavailable');
        return;
      }

      try {
        // Extract token from URL
        const urlObj = new URL(url, `https://${req.headers.host}`);
        const token = urlObj.searchParams.get('token') ||
                     req.headers.authorization?.replace('Bearer ', '');

        if (!token) {
          logSecurityEvent('Group WebSocket rejected: No JWT token', {
            ip: req.socket.remoteAddress,
            userAgent: req.headers['user-agent']
          });
          ws.close(1008, 'Authentication required');
          return;
        }

        const decoded = TokenManager.verifyAccessToken(token);
        if (!decoded) {
          logSecurityEvent('Group WebSocket rejected: Invalid JWT token', {
            ip: req.socket.remoteAddress,
            userAgent: req.headers['user-agent']
          });
          ws.close(1008, 'Invalid token');
          return;
        }

        const isValidSession = await TokenManager.validateSession(decoded.id, decoded.sessionId);
        if (!isValidSession) {
          logSecurityEvent('Group WebSocket rejected: Invalid session', {
            userId: decoded.id,
            sessionId: decoded.sessionId,
            ip: req.socket.remoteAddress
          });
          ws.close(1008, 'Invalid session');
          return;
        }

        console.log(`Authenticated group WebSocket connection for user ${decoded.id}`);

        // Track connection for liveness monitoring + update last_active
        trackConnection(ws, decoded.id, '/mirror/groups/ws');
        connectedUserIds.add(decoded.id);
        updateLastActive(decoded.id);

        groupNotifications.registerConnection(decoded.id.toString(), ws);

        // Handle incoming messages (required for application-level ping/pong)
        ws.on('message', (data: Buffer | string) => {
          const raw = data.toString();
          // Handle application-level ping from client
          if (handleAppPing(ws, raw)) return;
          // Other group WS messages can be handled here in the future
        });

        ws.on('close', () => {
          console.log(`Group WebSocket connection closed for user ${decoded.id}`);
          groupNotifications.unregisterConnection(decoded.id.toString());
          connectedUserIds.delete(decoded.id);
          // Update last_active on disconnect (last seen time)
          updateLastActive(decoded.id);
        });

        ws.on('error', (error) => {
          logError(`Group WebSocket error for user ${decoded.id}`, error);
          groupNotifications.unregisterConnection(decoded.id.toString());
          connectedUserIds.delete(decoded.id);
          updateLastActive(decoded.id);
        });

        // Send connection confirmation
        try {
          ws.send(JSON.stringify({
            type: 'connection_established',
            data: {
              userId: decoded.id,
              username: decoded.username,
              email: decoded.email,
              timestamp: new Date().toISOString(),
              message: 'MirrorGroups authenticated notifications enabled'
            }
          }));
        } catch (error) {
          logError(`Failed to send connection confirmation to user ${decoded.id}`, error);
        }

      } catch (error) {
        logError('Group WebSocket authentication error', error);
        ws.close(1008, 'Authentication failed');
      }
      return;
    }

    // Route 3: Chat WebSocket (/mirror/groups/chat) - Phase 5
    if (url.startsWith('/mirror/groups/chat')) {
      try {
        // Extract token from URL
        const urlObj = new URL(url, `https://${req.headers.host}`);
        const token = urlObj.searchParams.get('token') ||
                     req.headers.authorization?.replace('Bearer ', '');
        const deviceType = urlObj.searchParams.get('device') || 'web';

        if (!token) {
          logSecurityEvent('Chat WebSocket rejected: No JWT token', {
            ip: req.socket.remoteAddress,
            userAgent: req.headers['user-agent']
          });
          ws.close(1008, 'Authentication required');
          return;
        }

        const decoded = TokenManager.verifyAccessToken(token);
        if (!decoded) {
          logSecurityEvent('Chat WebSocket rejected: Invalid JWT token', {
            ip: req.socket.remoteAddress,
            userAgent: req.headers['user-agent']
          });
          ws.close(1008, 'Invalid token');
          return;
        }

        const isValidSession = await TokenManager.validateSession(decoded.id, decoded.sessionId);
        if (!isValidSession) {
          logSecurityEvent('Chat WebSocket rejected: Invalid session', {
            userId: decoded.id,
            sessionId: decoded.sessionId,
            ip: req.socket.remoteAddress
          });
          ws.close(1008, 'Invalid session');
          return;
        }

        console.log(`Chat WebSocket connection for user ${decoded.id} (${decoded.username})`);

        // Track connection for liveness monitoring + update last_active
        trackConnection(ws, decoded.id, '/mirror/groups/chat');
        connectedUserIds.add(decoded.id);
        updateLastActive(decoded.id);

        // Register with chat handler
        const chatUser = chatWSHandler.registerUser({
          userId: decoded.id,
          username: decoded.username,
          email: decoded.email,
          sessionId: decoded.sessionId,
        }, ws);

        // Set device type
        chatUser.deviceType = deviceType;

        // Handle incoming messages
        ws.on('message', async (data: Buffer | string) => {
          try {
            const raw = data.toString();
            // Handle application-level ping from client
            if (handleAppPing(ws, raw)) return;
            await chatWSHandler.handleMessage(decoded.id, raw);
          } catch (error) {
            logError(`Chat message handling error for user ${decoded.id}`, error);
          }
        });

        // Handle disconnection
        ws.on('close', () => {
          console.log(`Chat WebSocket connection closed for user ${decoded.id}`);
          chatWSHandler.unregisterUser(decoded.id);
          connectedUserIds.delete(decoded.id);
          // Update last_active on disconnect (last seen time)
          updateLastActive(decoded.id);
        });

        ws.on('error', (error) => {
          logError(`Chat WebSocket error for user ${decoded.id}`, error);
          chatWSHandler.unregisterUser(decoded.id);
          connectedUserIds.delete(decoded.id);
          updateLastActive(decoded.id);
        });

        // Send connection confirmation
        try {
          ws.send(JSON.stringify({
            type: 'chat:connection_established',
            payload: {
              userId: decoded.id,
              username: decoded.username,
              timestamp: new Date().toISOString(),
              features: [
                'messaging',
                'typing_indicators',
                'presence',
                'reactions',
                'read_receipts',
                'threading',
                'pinned_messages'
              ],
              rateLimit: {
                messagesPerSecond: 10,
                typingUpdatesPerSecond: 5,
                reactionsPerSecond: 20
              }
            }
          }));
        } catch (error) {
          logError(`Failed to send chat connection confirmation to user ${decoded.id}`, error);
        }

      } catch (error) {
        logError('Chat WebSocket authentication error', error);
        ws.close(1008, 'Authentication failed');
      }
      return;
    }

    // Unknown path
    console.log(`Unknown WebSocket path: ${url}`);
    ws.close(1008, 'Unknown path');
  });

  wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
  });

  console.log(`WebSocket server ready - supports /ws, /mirror/groups/ws, and /mirror/groups/chat (ping interval: ${PING_INTERVAL / 1000}s)`);
}

export function getWebSocketHealth(): {
  status: 'healthy' | 'degraded' | 'unhealthy';
  details: any;
} {
  try {
    const chatStats = chatWSHandler.getStats();

    return {
      status: 'healthy',
      details: {
        timestamp: new Date().toISOString(),
        implementation: 'single_server_manual_routing',
        paths: ['/ws', '/mirror/groups/ws', '/mirror/groups/chat'],
        authentication: {
          '/ws': 'Protocol-based (Mirror)',
          '/mirror/groups/ws': 'JWT required',
          '/mirror/groups/chat': 'JWT required'
        },
        chat: {
          connectedUsers: chatStats.connectedUsers,
          activeGroups: chatStats.activeGroups,
          totalSubscriptions: chatStats.totalSubscriptions
        },
        connectedUserIds: connectedUserIds.size,
        totalManagedConnections: managedConnections.size,
      }
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      details: {
        error: getErrorMessage(error),
        timestamp: new Date().toISOString()
      }
    };
  }
}

/**
 * Graceful shutdown for WebSocket handlers
 */
export async function shutdownWebSocket(): Promise<void> {
  console.log('Shutting down WebSocket handlers...');

  // Stop the heartbeat sweep
  if (heartbeatSweepTimer) {
    clearInterval(heartbeatSweepTimer);
    heartbeatSweepTimer = null;
  }

  // Update last_active for all connected users before shutdown
  for (const userId of connectedUserIds) {
    updateLastActive(userId);
  }
  connectedUserIds.clear();

  // Close all managed connections gracefully
  for (const conn of managedConnections) {
    try {
      conn.ws.close(1001, 'Server shutting down');
    } catch {
      conn.ws.terminate();
    }
  }
  managedConnections.clear();

  await chatWSHandler.shutdown();
  console.log('WebSocket handlers shutdown complete');
}
