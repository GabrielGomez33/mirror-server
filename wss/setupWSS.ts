// wss/setupWSS.ts - Single WebSocket server with manual routing

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import * as https from 'https';
import { TokenManager } from '../controllers/authController';
import { MirrorGroupNotificationSystem } from '../systems/mirrorGroupNotifications';

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

    // Route 2: Group WebSocket (/mirror/groups/ws or /mirror/groups/chat)
    // Support both paths for backward compatibility with frontend
    if (url.startsWith('/mirror/groups/ws') || url.startsWith('/mirror/groups/chat')) {
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

        // Track subscribed groups for this connection
        const subscribedGroups = new Set<string>();

        // Handle incoming messages
        ws.on('message', (rawData) => {
          try {
            const message = JSON.parse(rawData.toString());
            console.log(`[WS] Message from user ${decoded.id}:`, message.type);

            switch (message.type) {
              case 'subscribe':
                // Subscribe to a group's updates
                if (message.payload?.groupId) {
                  subscribedGroups.add(message.payload.groupId);
                  console.log(`[WS] User ${decoded.id} subscribed to group ${message.payload.groupId}`);

                  // Send acknowledgment
                  ws.send(JSON.stringify({
                    type: 'subscribed',
                    data: {
                      groupId: message.payload.groupId,
                      timestamp: new Date().toISOString()
                    }
                  }));
                }
                break;

              case 'unsubscribe':
                // Unsubscribe from a group
                if (message.payload?.groupId) {
                  subscribedGroups.delete(message.payload.groupId);
                  console.log(`[WS] User ${decoded.id} unsubscribed from group ${message.payload.groupId}`);

                  ws.send(JSON.stringify({
                    type: 'unsubscribed',
                    data: {
                      groupId: message.payload.groupId,
                      timestamp: new Date().toISOString()
                    }
                  }));
                }
                break;

              case 'chat':
                // Handle chat messages - broadcast to group members
                if (message.payload?.groupId && message.payload?.content) {
                  const chatMessage = {
                    type: 'chat_message',
                    data: {
                      groupId: message.payload.groupId,
                      senderId: decoded.id,
                      senderUsername: decoded.username,
                      content: message.payload.content,
                      timestamp: new Date().toISOString(),
                      messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
                    }
                  };

                  console.log(`[WS] Chat message from user ${decoded.id} in group ${message.payload.groupId}`);

                  // For now, echo back to sender as confirmation
                  // TODO: Broadcast to all group members via groupNotifications
                  ws.send(JSON.stringify({
                    type: 'chat_sent',
                    data: chatMessage.data
                  }));
                }
                break;

              case 'ping':
                // Respond to keepalive pings
                ws.send(JSON.stringify({
                  type: 'pong',
                  data: {
                    timestamp: new Date().toISOString()
                  }
                }));
                break;

              default:
                console.log(`[WS] Unknown message type from user ${decoded.id}: ${message.type}`);
            }
          } catch (error) {
            logError(`Failed to parse WebSocket message from user ${decoded.id}`, error);
            ws.send(JSON.stringify({
              type: 'error',
              data: {
                message: 'Invalid message format',
                timestamp: new Date().toISOString()
              }
            }));
          }
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
    return {
      status: 'healthy',
      details: {
        timestamp: new Date().toISOString(),
        implementation: 'single_server_manual_routing',
        paths: ['/ws', '/mirror/groups/ws', '/mirror/groups/chat'],
        authentication: {
          '/ws': 'Protocol-based (Mirror)',
          '/mirror/groups/ws': 'JWT required',
          '/mirror/groups/chat': 'JWT required (alias)'
        },
        messageTypes: ['subscribe', 'unsubscribe', 'chat', 'ping']
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
