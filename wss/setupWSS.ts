// wss/setupWSS.ts - Single WebSocket server with manual routing
// Phase 5: Extended with real-time chat support

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import * as https from 'https';
import { TokenManager } from '../controllers/authController';
import { MirrorGroupNotificationSystem } from '../systems/mirrorGroupNotifications';
import { chatWSHandler } from './chatWSHandler';

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

export function SetupWebSocket(
  server: https.Server,
  groupNotifications?: MirrorGroupNotificationSystem
): void {
  console.log('Setting up single WebSocket server with routing...');

  // Initialize chat WebSocket handler
  chatWSHandler.initialize().catch(err => {
    console.error('Failed to initialize chat WebSocket handler:', err);
  });

  // Single WebSocket server - no path specified
  const wss = new WebSocketServer({
    server
  });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const url = req.url || '';

    // Route 1: Mirror WebSocket (/ws)
    if (url === '/ws') {
      const protocol = req.headers['sec-websocket-protocol'];

      if (protocol === 'Mirror') {
        console.log('Mirror client connected');

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

        groupNotifications.registerConnection(decoded.id.toString(), ws);

        ws.on('close', () => {
          console.log(`Group WebSocket connection closed for user ${decoded.id}`);
          groupNotifications.unregisterConnection(decoded.id.toString());
        });

        ws.on('error', (error) => {
          logError(`Group WebSocket error for user ${decoded.id}`, error);
          groupNotifications.unregisterConnection(decoded.id.toString());
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

        console.log(`💬 Chat WebSocket connection for user ${decoded.id} (${decoded.username})`);

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
            const message = data.toString();
            await chatWSHandler.handleMessage(decoded.id, message);
          } catch (error) {
            logError(`Chat message handling error for user ${decoded.id}`, error);
          }
        });

        // Handle disconnection
        ws.on('close', () => {
          console.log(`💬 Chat WebSocket connection closed for user ${decoded.id}`);
          chatWSHandler.unregisterUser(decoded.id);
        });

        ws.on('error', (error) => {
          logError(`Chat WebSocket error for user ${decoded.id}`, error);
          chatWSHandler.unregisterUser(decoded.id);
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

  console.log('WebSocket server ready - supports /ws, /mirror/groups/ws, and /mirror/groups/chat');
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
        }
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
  await chatWSHandler.shutdown();
  console.log('WebSocket handlers shutdown complete');
}
