// wss/setupWSS.ts - Extended to handle Group Notifications with existing auth

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import * as https from 'https';
import { TokenManager } from '../controllers/authController';
import { MirrorGroupNotificationSystem } from '../systems/mirrorGroupNotifications';

// ============================================================================
// WEBSOCKET TYPES
// ============================================================================

interface VerifyClientInfo {
  origin: string;
  secure: boolean;
  req: IncomingMessage;
}

// ============================================================================
// BEST PRACTICE ERROR HANDLING
// ============================================================================

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error occurred';
}

function logError(context: string, error: unknown): void {
  console.error(`❌ ${context}:`, getErrorMessage(error));
}

function logSecurityEvent(event: string, details: any): void {
  console.warn(`🔒 SECURITY: ${event}`, details);
}

// ============================================================================
// ENHANCED WEBSOCKET SETUP
// ============================================================================

export function SetupWebSocket(
  server: https.Server, 
  groupNotifications?: MirrorGroupNotificationSystem
): void {
  console.log('🔌 Setting up WebSocket servers...');

  // ============================================================================
  // EXISTING MIRROR WEBSOCKET (Preserved exactly as before)
  // ============================================================================
  
  const mirrorWSS = new WebSocketServer({ 
    server,
    path: '/ws'  // Original path for existing Mirror WebSocket
  });

  mirrorWSS.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const protocol = req.headers['sec-websocket-protocol'];
    const clientType = protocol === 'Mirror' ? 'Mirror' : 'Intruder';

    if (clientType === 'Mirror') {
      console.log('✅ Mirror client connected.');
    } else {
      console.log('⚠️ Intruder WebSocket attempt. Closing connection');
      ws.close();
    }
  });

  console.log('✅ Mirror WebSocket server setup complete on /ws');

  // ============================================================================
  // NEW GROUP NOTIFICATIONS WEBSOCKET (Only if notification system provided)
  // ============================================================================

  if (groupNotifications) {
    console.log('🔌 Setting up authenticated Group Notifications WebSocket...');

    const groupWSS = new WebSocketServer({
      server,
      path: '/mirror/groups/ws',
      verifyClient: async (info: VerifyClientInfo): Promise<boolean> => {
        try {
          // Extract JWT token from query params or headers
          const url = new URL(info.req.url!, `http://${info.req.headers.host}`);
          const token = url.searchParams.get('token') || 
                       info.req.headers.authorization?.replace('Bearer ', '');

          if (!token) {
            logSecurityEvent('Group WebSocket rejected: No JWT token', {
              ip: info.req.socket.remoteAddress,
              userAgent: info.req.headers['user-agent'],
              origin: info.origin,
              secure: info.secure
            });
            return false;
          }

          // ✅ USE EXISTING AUTHENTICATION SYSTEM
          const decoded = TokenManager.verifyAccessToken(token);
          if (!decoded) {
            logSecurityEvent('Group WebSocket rejected: Invalid JWT token', {
              ip: info.req.socket.remoteAddress,
              userAgent: info.req.headers['user-agent'],
              origin: info.origin
            });
            return false;
          }

          // ✅ USE EXISTING SESSION VALIDATION
          const isValidSession = await TokenManager.validateSession(decoded.id, decoded.sessionId);
          if (!isValidSession) {
            logSecurityEvent('Group WebSocket rejected: Invalid or expired session', {
              userId: decoded.id,
              sessionId: decoded.sessionId,
              ip: info.req.socket.remoteAddress
            });
            return false;
          }

          // Store user info in request for use in connection handler
          (info.req as any).user = decoded;
          console.log(`✅ Group WebSocket authenticated for user ${decoded.id}`);
          return true;

        } catch (error) {
          logError('Group WebSocket authentication error', error);
          return false;
        }
      }
    });

    groupWSS.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      const user = (request as any).user;
      
      if (!user) {
        console.error('❌ Group WebSocket connection without user context, closing');
        ws.close(1008, 'Authentication required');
        return;
      }

      console.log(`📱 Authenticated group WebSocket connection for user ${user.id}`);
      
      // Register connection with notification system using authenticated user ID
      groupNotifications.registerConnection(user.id.toString(), ws);
      
      ws.on('close', () => {
        console.log(`🔌 Group WebSocket connection closed for user ${user.id}`);
        groupNotifications.unregisterConnection(user.id.toString());
      });

      ws.on('error', (error) => {
        logError(`Group WebSocket error for user ${user.id}`, error);
        groupNotifications.unregisterConnection(user.id.toString());
      });

      // Send connection confirmation with authenticated user info
      try {
        ws.send(JSON.stringify({
          type: 'connection_established',
          data: {
            userId: user.id,
            username: user.username,
            email: user.email,
            timestamp: new Date().toISOString(),
            message: 'MirrorGroups authenticated notifications enabled',
            sessionId: user.sessionId,
            features: [
              'real_time_notifications',
              'group_invitations', 
              'peer_reviews',
              'video_call_alerts',
              'drawing_session_alerts'
            ]
          }
        }));
      } catch (error) {
        logError(`Failed to send connection confirmation to user ${user.id}`, error);
      }
    });

    groupWSS.on('error', (error) => {
      logError('Group WebSocket server error', error);
    });

    console.log('✅ Group WebSocket server setup complete on /mirror/groups/ws');
  } else {
    console.log('⚠️ Group notification system not provided, skipping group WebSocket setup');
  }

  console.log('🎯 All WebSocket servers configured successfully');
}

// ============================================================================
// OPTIONAL: WebSocket Health Check Function
// ============================================================================

export function getWebSocketHealth(): {
  status: 'healthy' | 'degraded' | 'unhealthy';
  details: any;
} {
  try {
    // Basic health check - you could extend this with connection counts, etc.
    return {
      status: 'healthy',
      details: {
        timestamp: new Date().toISOString(),
        mirrorWebSocket: {
          path: '/ws',
          protocol: 'Mirror',
          authentication: 'Protocol-based'
        },
        groupWebSocket: {
          path: '/mirror/groups/ws', 
          protocol: 'Standard',
          authentication: 'JWT required'
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
