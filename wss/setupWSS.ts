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

    // Unknown path
    console.log(`Unknown WebSocket path: ${url}`);
    ws.close(1008, 'Unknown path');
  });

  wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
  });

  console.log('WebSocket server ready - supports /ws and /mirror/groups/ws');
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
        paths: ['/ws', '/mirror/groups/ws'],
        authentication: {
          '/ws': 'Protocol-based (Mirror)',
          '/mirror/groups/ws': 'JWT required'
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
