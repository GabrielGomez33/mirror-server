// wss/groupSignaling.ts
// MirrorGroups Phase 1-4: WebRTC signaling + Voting + Conversation Intelligence
// Uses native WebSocket (ws library) - NO Socket.IO to avoid conflicts

import { WebSocket } from 'ws';
import { DB } from '../db';

// ============================================================================
// TYPES
// ============================================================================

interface AuthenticatedWebSocket extends WebSocket {
  userId?: number;
  username?: string;
  groupId?: string;
  sessionId?: string;
  isAlive?: boolean;
}

// Extended message types for Phase 4
type MessageType =
  // Phase 1 - WebRTC
  | 'join-session'
  | 'leave-session'
  | 'webrtc-offer'
  | 'webrtc-answer'
  | 'webrtc-ice-candidate'
  | 'drawing-action'
  | 'ping'
  // Phase 4 - Voting
  | 'vote:cast-response'
  | 'vote:subscribe'
  | 'vote:unsubscribe'
  // Phase 4 - Conversation Intelligence
  | 'insight:subscribe'
  | 'insight:unsubscribe'
  | 'insight:acknowledge';

interface WebRTCMessage {
  type: MessageType;
  payload: any;
}

// Vote event types for broadcasting
export interface VoteEvent {
  type: 'vote:proposed' | 'vote:cast' | 'vote:completed' | 'vote:cancelled';
  payload: any;
}

// Insight event types for broadcasting
export interface InsightEvent {
  type: 'conversation:insight' | 'conversation:summary';
  payload: any;
}

// ============================================================================
// GROUP SIGNALING MANAGER
// ============================================================================

export class GroupSignalingManager {
  private connections: Map<number, AuthenticatedWebSocket> = new Map();  // userId -> WebSocket
  private sessions: Map<string, Set<number>> = new Map();  // sessionId -> Set of userIds
  private groupSubscriptions: Map<string, Set<number>> = new Map();  // groupId -> Set of userIds (for votes/insights)

  /**
   * Register an authenticated WebSocket connection
   * Called from setupWSS.ts after JWT authentication
   */
  registerConnection(userId: number, username: string, ws: AuthenticatedWebSocket): void {
    console.log(`📡 Registering signaling connection for user ${userId} (${username})`);
    
    ws.userId = userId;
    ws.username = username;
    ws.isAlive = true;

    // Store connection
    this.connections.set(userId, ws);

    // Setup message handler
    ws.on('message', (data: Buffer) => {
      this.handleMessage(userId, data, ws).catch(error => {
        console.error(`❌ Error handling message from user ${userId}:`, error);
        this.sendError(ws, 'MESSAGE_PROCESSING_FAILED', 'Failed to process message');
      });
    });

    // Setup pong handler for heartbeat
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Cleanup on close
    ws.on('close', () => {
      console.log(`🔌 Signaling connection closed for user ${userId}`);
      this.unregisterConnection(userId);
    });

    // Send connection confirmation
    this.sendMessage(ws, {
      type: 'connection-established',
      payload: {
        userId,
        username,
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Unregister a connection
   */
  unregisterConnection(userId: number): void {
    const ws = this.connections.get(userId);
    if (!ws) return;

    // Remove from all sessions
    if (ws.sessionId) {
      this.leaveSession(userId, ws.sessionId);
    }

    // Remove connection
    this.connections.delete(userId);
    console.log(`✅ Unregistered signaling connection for user ${userId}`);
  }

  /**
   * Handle incoming WebSocket message
   */
  private async handleMessage(
    userId: number,
    data: Buffer,
    ws: AuthenticatedWebSocket
  ): Promise<void> {
    try {
      const message: WebRTCMessage = JSON.parse(data.toString());

      switch (message.type) {
        // Phase 1 - Session Management
        case 'join-session':
          await this.handleJoinSession(userId, message.payload, ws);
          break;

        case 'leave-session':
          await this.handleLeaveSession(userId, ws);
          break;

        // Phase 1 - WebRTC Signaling
        case 'webrtc-offer':
          await this.handleWebRTCOffer(userId, message.payload, ws);
          break;

        case 'webrtc-answer':
          await this.handleWebRTCAnswer(userId, message.payload, ws);
          break;

        case 'webrtc-ice-candidate':
          await this.handleICECandidate(userId, message.payload, ws);
          break;

        // Phase 6 - Drawing
        case 'drawing-action':
          await this.handleDrawingAction(userId, message.payload, ws);
          break;

        // Phase 4 - Voting subscriptions
        case 'vote:subscribe':
          await this.handleVoteSubscribe(userId, message.payload, ws);
          break;

        case 'vote:unsubscribe':
          await this.handleVoteUnsubscribe(userId, message.payload, ws);
          break;

        // Phase 4 - Insight subscriptions
        case 'insight:subscribe':
          await this.handleInsightSubscribe(userId, message.payload, ws);
          break;

        case 'insight:unsubscribe':
          await this.handleInsightUnsubscribe(userId, message.payload, ws);
          break;

        case 'insight:acknowledge':
          await this.handleInsightAcknowledge(userId, message.payload, ws);
          break;

        // Heartbeat
        case 'ping':
          this.sendMessage(ws, { type: 'pong', payload: { timestamp: Date.now() } });
          break;

        default:
          console.warn(`⚠️ Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error(`❌ Error parsing message from user ${userId}:`, error);
      this.sendError(ws, 'INVALID_MESSAGE', 'Failed to parse message');
    }
  }

  // ========================================================================
  // SESSION MANAGEMENT
  // ========================================================================

  /**
   * Handle join session request
   */
  private async handleJoinSession(
    userId: number,
    payload: { groupId: string; sessionType: 'video' | 'drawing'; metadata?: any },
    ws: AuthenticatedWebSocket
  ): Promise<void> {
    const { groupId, sessionType, metadata } = payload;

    console.log(`📍 User ${userId} joining ${sessionType} session in group ${groupId}`);

    // Verify user is a member of this group
    const [memberRows] = await DB.query(
      `SELECT role FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, userId]
    );

    if ((memberRows as any[]).length === 0) {
      this.sendError(ws, 'NOT_MEMBER', 'You are not a member of this group');
      return;
    }

    // Create session ID
    const sessionId = `${groupId}:${sessionType}`;
    ws.groupId = groupId;
    ws.sessionId = sessionId;

    // Add to session
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Set());
    }
    this.sessions.get(sessionId)!.add(userId);

    // Record in database
    await DB.query(
      `INSERT INTO mirror_session_participants (
        participant_id, session_id, user_id, joined_at, 
        session_type, is_active
      ) VALUES (UUID(), ?, ?, NOW(), ?, TRUE)
      ON DUPLICATE KEY UPDATE is_active = TRUE, joined_at = NOW()`,
      [sessionId, userId, sessionType]
    );

    // Get current participants
    const participants = this.getSessionParticipants(sessionId);

    // Notify others in the session
    this.broadcastToSession(sessionId, userId, {
      type: 'user-joined',
      payload: {
        userId,
        username: ws.username,
        joinedAt: new Date().toISOString(),
        metadata
      }
    });

    // Send confirmation to joiner
    this.sendMessage(ws, {
      type: 'session-joined',
      payload: {
        groupId,
        sessionType,
        sessionId,
        participants
      }
    });

    console.log(`✅ User ${userId} joined session ${sessionId}`);
  }

  /**
   * Handle leave session request
   */
  private async handleLeaveSession(userId: number, ws: AuthenticatedWebSocket): Promise<void> {
    if (!ws.sessionId) return;

    await this.leaveSession(userId, ws.sessionId);
    ws.sessionId = undefined;
    ws.groupId = undefined;
  }

  /**
   * Leave a session (internal method)
   */
  private async leaveSession(userId: number, sessionId: string): Promise<void> {
    console.log(`👋 User ${userId} leaving session ${sessionId}`);

    // Remove from session set
    const session = this.sessions.get(sessionId);
    if (session) {
      session.delete(userId);
      if (session.size === 0) {
        this.sessions.delete(sessionId);
      }
    }

    // Update database
    await DB.query(
      `UPDATE mirror_session_participants 
       SET is_active = FALSE, left_at = NOW() 
       WHERE session_id = ? AND user_id = ? AND is_active = TRUE`,
      [sessionId, userId]
    );

    // Notify others
    const ws = this.connections.get(userId);
    this.broadcastToSession(sessionId, userId, {
      type: 'user-left',
      payload: {
        userId,
        username: ws?.username,
        leftAt: new Date().toISOString()
      }
    });

    console.log(`✅ User ${userId} left session ${sessionId}`);
  }

  // ========================================================================
  // WEBRTC SIGNALING (Phase 5)
  // ========================================================================

  /**
   * Forward WebRTC offer to specific peer
   */
  private async handleWebRTCOffer(
    userId: number,
    payload: { targetUserId: number; offer: any },
    ws: AuthenticatedWebSocket
  ): Promise<void> {
    const { targetUserId, offer } = payload;

    console.log(`📡 Forwarding WebRTC offer from ${userId} to ${targetUserId}`);

    const targetWs = this.connections.get(targetUserId);
    if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
      this.sendError(ws, 'PEER_NOT_FOUND', 'Target user not connected');
      return;
    }

    this.sendMessage(targetWs, {
      type: 'webrtc-offer',
      payload: {
        fromUserId: userId,
        fromUsername: ws.username,
        offer
      }
    });
  }

  /**
   * Forward WebRTC answer to specific peer
   */
  private async handleWebRTCAnswer(
    userId: number,
    payload: { targetUserId: number; answer: any },
    ws: AuthenticatedWebSocket
  ): Promise<void> {
    const { targetUserId, answer } = payload;

    console.log(`📡 Forwarding WebRTC answer from ${userId} to ${targetUserId}`);

    const targetWs = this.connections.get(targetUserId);
    if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
      return;
    }

    this.sendMessage(targetWs, {
      type: 'webrtc-answer',
      payload: {
        fromUserId: userId,
        fromUsername: ws.username,
        answer
      }
    });
  }

  /**
   * Forward ICE candidate to specific peer
   */
  private async handleICECandidate(
    userId: number,
    payload: { targetUserId: number; candidate: any },
    ws: AuthenticatedWebSocket
  ): Promise<void> {
    const { targetUserId, candidate } = payload;

    const targetWs = this.connections.get(targetUserId);
    if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
      return;
    }

    this.sendMessage(targetWs, {
      type: 'webrtc-ice-candidate',
      payload: {
        fromUserId: userId,
        candidate
      }
    });
  }

  // ========================================================================
  // DRAWING BOARD (Phase 6 - Foundation)
  // ========================================================================

  /**
   * Broadcast drawing action to all session participants
   */
  private async handleDrawingAction(
    userId: number,
    payload: any,
    ws: AuthenticatedWebSocket
  ): Promise<void> {
    if (!ws.sessionId) {
      this.sendError(ws, 'NOT_IN_SESSION', 'Must join drawing session first');
      return;
    }

    // Broadcast to all others in the session
    this.broadcastToSession(ws.sessionId, userId, {
      type: 'drawing-action',
      payload: {
        userId,
        username: ws.username,
        timestamp: Date.now(),
        ...payload
      }
    });
  }

  // ========================================================================
  // HELPER METHODS
  // ========================================================================

  /**
   * Get all participants in a session
   */
  private getSessionParticipants(sessionId: string): Array<{ userId: number; username: string }> {
    const userIds = this.sessions.get(sessionId);
    if (!userIds) return [];

    return Array.from(userIds)
      .map(userId => {
        const ws = this.connections.get(userId);
        return ws ? { userId, username: ws.username || 'Unknown' } : null;
      })
      .filter(p => p !== null) as Array<{ userId: number; username: string }>;
  }

  /**
   * Broadcast message to all users in a session (except sender)
   */
  private broadcastToSession(
    sessionId: string,
    senderUserId: number,
    message: { type: string; payload: any }
  ): void {
    const userIds = this.sessions.get(sessionId);
    if (!userIds) return;

    for (const userId of userIds) {
      if (userId === senderUserId) continue;

      const ws = this.connections.get(userId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        this.sendMessage(ws, message);
      }
    }
  }

  /**
   * Send message to a WebSocket
   */
  private sendMessage(ws: WebSocket, message: { type: string; payload: any }): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send error message
   */
  private sendError(ws: WebSocket, code: string, message: string): void {
    this.sendMessage(ws, {
      type: 'error',
      payload: { code, message }
    });
  }

  /**
   * Heartbeat check - called periodically
   */
  heartbeat(): void {
    for (const [userId, ws] of this.connections.entries()) {
      if (ws.isAlive === false) {
        console.log(`💀 Connection timeout for user ${userId}`);
        this.unregisterConnection(userId);
        ws.terminate();
        continue;
      }

      ws.isAlive = false;
      ws.ping();
    }
  }

  /**
   * Get connection statistics
   */
  getStats(): { activeConnections: number; activeSessions: number; sessionDetails: any[] } {
    const sessionDetails = Array.from(this.sessions.entries()).map(([sessionId, userIds]) => ({
      sessionId,
      participantCount: userIds.size,
      participants: Array.from(userIds)
    }));

    return {
      activeConnections: this.connections.size,
      activeSessions: this.sessions.size,
      sessionDetails
    };
  }

  // ========================================================================
  // PHASE 4 - VOTING HANDLERS
  // ========================================================================

  /**
   * Subscribe user to vote events for a group
   */
  private async handleVoteSubscribe(
    userId: number,
    payload: { groupId: string },
    ws: AuthenticatedWebSocket
  ): Promise<void> {
    const { groupId } = payload;

    // Verify membership
    const [memberRows] = await DB.query(
      `SELECT role FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, userId]
    );

    if ((memberRows as any[]).length === 0) {
      this.sendError(ws, 'NOT_MEMBER', 'You are not a member of this group');
      return;
    }

    // Add to group subscriptions
    if (!this.groupSubscriptions.has(groupId)) {
      this.groupSubscriptions.set(groupId, new Set());
    }
    this.groupSubscriptions.get(groupId)!.add(userId);

    console.log(`📨 User ${userId} subscribed to vote events for group ${groupId}`);

    this.sendMessage(ws, {
      type: 'vote:subscribed',
      payload: { groupId, message: 'Subscribed to vote events' }
    });
  }

  /**
   * Unsubscribe user from vote events
   */
  private async handleVoteUnsubscribe(
    userId: number,
    payload: { groupId: string },
    ws: AuthenticatedWebSocket
  ): Promise<void> {
    const { groupId } = payload;

    const subscribers = this.groupSubscriptions.get(groupId);
    if (subscribers) {
      subscribers.delete(userId);
      if (subscribers.size === 0) {
        this.groupSubscriptions.delete(groupId);
      }
    }

    console.log(`📨 User ${userId} unsubscribed from vote events for group ${groupId}`);

    this.sendMessage(ws, {
      type: 'vote:unsubscribed',
      payload: { groupId, message: 'Unsubscribed from vote events' }
    });
  }

  /**
   * Broadcast vote event to all subscribed group members
   * Called from routes/groupVotes.ts
   */
  broadcastVoteEvent(groupId: string, event: VoteEvent): void {
    const subscribers = this.groupSubscriptions.get(groupId);
    if (!subscribers || subscribers.size === 0) {
      console.log(`📨 No subscribers for vote event in group ${groupId}`);
      return;
    }

    console.log(`📨 Broadcasting ${event.type} to ${subscribers.size} subscribers in group ${groupId}`);

    for (const userId of subscribers) {
      const ws = this.connections.get(userId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        this.sendMessage(ws, {
          type: event.type,
          payload: event.payload
        });
      }
    }
  }

  // ========================================================================
  // PHASE 4 - CONVERSATION INSIGHT HANDLERS
  // ========================================================================

  /**
   * Subscribe user to insight events for a group
   */
  private async handleInsightSubscribe(
    userId: number,
    payload: { groupId: string; sessionId?: string },
    ws: AuthenticatedWebSocket
  ): Promise<void> {
    const { groupId } = payload;

    // Verify membership
    const [memberRows] = await DB.query(
      `SELECT role FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, userId]
    );

    if ((memberRows as any[]).length === 0) {
      this.sendError(ws, 'NOT_MEMBER', 'You are not a member of this group');
      return;
    }

    // Add to group subscriptions (reuse same map for simplicity)
    if (!this.groupSubscriptions.has(groupId)) {
      this.groupSubscriptions.set(groupId, new Set());
    }
    this.groupSubscriptions.get(groupId)!.add(userId);

    console.log(`🧠 User ${userId} subscribed to insight events for group ${groupId}`);

    this.sendMessage(ws, {
      type: 'insight:subscribed',
      payload: { groupId, message: 'Subscribed to conversation insights' }
    });
  }

  /**
   * Unsubscribe user from insight events
   */
  private async handleInsightUnsubscribe(
    userId: number,
    payload: { groupId: string },
    ws: AuthenticatedWebSocket
  ): Promise<void> {
    const { groupId } = payload;

    const subscribers = this.groupSubscriptions.get(groupId);
    if (subscribers) {
      subscribers.delete(userId);
      if (subscribers.size === 0) {
        this.groupSubscriptions.delete(groupId);
      }
    }

    console.log(`🧠 User ${userId} unsubscribed from insight events for group ${groupId}`);

    this.sendMessage(ws, {
      type: 'insight:unsubscribed',
      payload: { groupId, message: 'Unsubscribed from conversation insights' }
    });
  }

  /**
   * Handle insight acknowledgment
   */
  private async handleInsightAcknowledge(
    userId: number,
    payload: { insightId: string; groupId: string },
    ws: AuthenticatedWebSocket
  ): Promise<void> {
    const { insightId, groupId } = payload;

    try {
      await DB.query(
        `UPDATE mirror_group_session_insights
         SET acknowledged_at = COALESCE(acknowledged_at, NOW())
         WHERE id = ? AND group_id = ?`,
        [insightId, groupId]
      );

      this.sendMessage(ws, {
        type: 'insight:acknowledged',
        payload: { insightId, message: 'Insight acknowledged' }
      });

    } catch (error) {
      console.error('Error acknowledging insight:', error);
      this.sendError(ws, 'ACK_FAILED', 'Failed to acknowledge insight');
    }
  }

  /**
   * Broadcast insight event to all subscribed group members
   * Called from routes/sessionInsights.ts
   */
  broadcastInsightEvent(groupId: string, event: InsightEvent): void {
    const subscribers = this.groupSubscriptions.get(groupId);
    if (!subscribers || subscribers.size === 0) {
      console.log(`🧠 No subscribers for insight event in group ${groupId}`);
      return;
    }

    console.log(`🧠 Broadcasting ${event.type} to ${subscribers.size} subscribers in group ${groupId}`);

    for (const userId of subscribers) {
      const ws = this.connections.get(userId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        this.sendMessage(ws, {
          type: event.type,
          payload: event.payload
        });
      }
    }
  }

  /**
   * Send message to specific user by ID
   * Useful for targeted notifications
   */
  sendToUser(userId: number, message: { type: string; payload: any }): boolean {
    const ws = this.connections.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      this.sendMessage(ws, message);
      return true;
    }
    return false;
  }

  /**
   * Check if user is connected
   */
  isUserConnected(userId: number): boolean {
    const ws = this.connections.get(userId);
    return ws !== undefined && ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get all connected users in a group
   */
  getConnectedGroupMembers(groupId: string): number[] {
    const subscribers = this.groupSubscriptions.get(groupId);
    if (!subscribers) return [];

    return Array.from(subscribers).filter(userId => this.isUserConnected(userId));
  }

  /**
   * Shutdown - clean up all connections
   */
  shutdown(): void {
    console.log('🛑 Shutting down GroupSignalingManager...');

    for (const [userId, ws] of this.connections.entries()) {
      ws.close(1001, 'Server shutdown');
      this.unregisterConnection(userId);
    }

    this.connections.clear();
    this.sessions.clear();
    this.groupSubscriptions.clear();

    console.log('✅ GroupSignalingManager shutdown complete');
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const groupSignalingManager = new GroupSignalingManager();
