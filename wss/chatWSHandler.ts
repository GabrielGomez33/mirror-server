// ============================================================================
// CHAT WEBSOCKET HANDLER - MirrorGroups Phase 5
// ============================================================================
// Real-time WebSocket message handling for chat functionality:
// - Message sending/receiving with encryption
// - Typing indicators
// - Presence updates
// - Read receipts
// - Reactions
//
// MULTI-CONNECTION DESIGN (Goal #3)
// ----------------------------------
// Every WebSocket connection is keyed by a unique `connId` (uuid). A single
// user may have unlimited concurrent connections (multiple devices, multiple
// tabs, PWA + browser) and each connection is fully independent — own
// activeGroups, own subscription set membership, own ack-routing target.
// Dead/stale connections are reaped by the server-side heartbeat sweep in
// setupWSS.ts (30s interval). There is intentionally NO "kick on register"
// behavior — that was the cause of the multi-device ping-pong disconnect
// cycle.
// ============================================================================

import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { chatMessageManager, ChatMessage, TypingIndicator, PresenceStatus } from '../managers/ChatMessageManager';
import { mirrorRedis } from '../config/redis';
import { DB } from '../db';

// ============================================================================
// TYPES
// ============================================================================

export interface ChatWSUser {
  /** Unique per-connection identifier. A single userId may have many. */
  connId: string;
  userId: number;
  username: string;
  email: string;
  sessionId: string;
  ws: WebSocket;
  connectedAt: Date;
  activeGroups: Set<string>;
  deviceType?: string;
}

export interface ChatWSMessage {
  type: ChatMessageType;
  payload: any;
  requestId?: string;  // For request-response correlation
}

export type ChatMessageType =
  // Message operations
  | 'chat:send_message'
  | 'chat:message'
  | 'chat:edit_message'
  | 'chat:message_edited'
  | 'chat:delete_message'
  | 'chat:message_deleted'
  // Typing
  | 'chat:typing_start'
  | 'chat:typing_stop'
  | 'chat:typing'
  // Presence
  | 'chat:presence_update'
  | 'chat:presence'
  // Read receipts
  | 'chat:mark_read'
  | 'chat:message_read'
  // Reactions
  | 'chat:add_reaction'
  | 'chat:remove_reaction'
  | 'chat:reactions_updated'
  // Group subscription
  | 'chat:join_group'
  | 'chat:leave_group'
  | 'chat:group_joined'
  | 'chat:group_left'
  // Errors and acknowledgments
  | 'chat:ack'
  | 'chat:error';

interface SendMessagePayload {
  groupId: string;
  content: string;
  contentType?: string;
  parentMessageId?: string;
  metadata?: any;
  clientMessageId?: string;
}

interface EditMessagePayload {
  messageId: string;
  groupId: string;
  content: string;
}

interface DeleteMessagePayload {
  messageId: string;
  groupId: string;
}

interface TypingPayload {
  groupId: string;
}

interface PresencePayload {
  groupId: string;
  status: 'online' | 'away' | 'busy' | 'offline';
  deviceType?: string;
}

interface MarkReadPayload {
  groupId: string;
  messageId: string;
}

interface ReactionPayload {
  messageId: string;
  groupId: string;
  emoji: string;
}

interface GroupPayload {
  groupId: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error occurred';
}

function logError(context: string, error: unknown): void {
  console.error(`❌ ${context}:`, getErrorMessage(error));
}

// ============================================================================
// CHAT WEBSOCKET HANDLER CLASS
// ============================================================================

export class ChatWSHandler extends EventEmitter {
  /** connId → ChatWSUser. One entry per live WebSocket. */
  private connections: Map<string, ChatWSUser> = new Map();

  /** userId → set of connIds. Reverse index for fan-out. */
  private userConnIds: Map<number, Set<string>> = new Map();

  /** groupId → set of connIds subscribed to that group. */
  private groupSubscriptions: Map<string, Set<string>> = new Map();

  private initialized: boolean = false;

  // Rate limiting (keyed by userId — applies across all of a user's connections)
  private readonly RATE_LIMITS = {
    MESSAGE: { count: 10, windowMs: 1000 },      // 10 messages per second
    TYPING: { count: 5, windowMs: 1000 },        // 5 typing updates per second
    REACTION: { count: 20, windowMs: 1000 },     // 20 reactions per second
  };
  private rateLimiters: Map<string, { count: number; resetAt: number }> = new Map();

  constructor() {
    super();
    console.log('🔌 Initializing Chat WebSocket Handler...');
  }

  // ============================================================================
  // INITIALIZATION & CONNECTION MANAGEMENT
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Setup chat message manager event listeners
    chatMessageManager.on('message:sent', this.handleMessageSent.bind(this));
    chatMessageManager.on('message:edited', this.handleMessageEdited.bind(this));
    chatMessageManager.on('message:deleted', this.handleMessageDeleted.bind(this));

    this.initialized = true;
    console.log('✅ Chat WebSocket Handler initialized');
  }

  /**
   * Register a new WebSocket connection for a user.
   *
   * IMPORTANT: this does NOT close or kick any existing connections for
   * the same userId. A user may have unlimited simultaneous connections
   * (multi-device, multi-tab, PWA + browser). Dead connections are
   * reaped by the server-side heartbeat sweep in setupWSS.ts.
   *
   * Returns the ChatWSUser including a freshly-generated `connId` that
   * the caller MUST pass back to `unregisterUser` / `handleMessage` for
   * this connection.
   */
  registerUser(user: {
    userId: number;
    username: string;
    email: string;
    sessionId: string;
  }, ws: WebSocket): ChatWSUser {
    const connId = uuidv4();

    const chatUser: ChatWSUser = {
      connId,
      ...user,
      ws,
      connectedAt: new Date(),
      activeGroups: new Set(),
    };

    this.connections.set(connId, chatUser);

    let conns = this.userConnIds.get(user.userId);
    if (!conns) {
      conns = new Set();
      this.userConnIds.set(user.userId, conns);
    }
    conns.add(connId);

    console.log(`👤 Chat user registered: ${user.userId} (${user.username}) [conn=${connId.slice(0, 8)}, total=${conns.size}]`);

    return chatUser;
  }

  /**
   * Unregister a specific connection. Other connections owned by the
   * same userId are left intact.
   *
   * Presence is set to 'offline' for the user's group memberships only
   * when this was the LAST connection of theirs — otherwise they're
   * still online from another device/tab.
   */
  unregisterUser(connId: string): void {
    const user = this.connections.get(connId);
    if (!user) return;

    // Remove this connection from every group subscription it held.
    for (const groupId of user.activeGroups) {
      const subs = this.groupSubscriptions.get(groupId);
      if (subs) {
        subs.delete(connId);
        if (subs.size === 0) {
          this.groupSubscriptions.delete(groupId);
        }
      }
    }

    // Remove from the userId → connIds reverse index.
    const conns = this.userConnIds.get(user.userId);
    let wasLastConnection = false;
    if (conns) {
      conns.delete(connId);
      if (conns.size === 0) {
        this.userConnIds.delete(user.userId);
        wasLastConnection = true;
      }
    }

    // Drop the connection record.
    this.connections.delete(connId);

    // Only emit 'offline' presence when there are no more connections
    // for this user; otherwise the user remains online from elsewhere.
    if (wasLastConnection) {
      for (const groupId of user.activeGroups) {
        this.handlePresenceChange(user.userId, groupId, 'offline');
      }
    }

    const remaining = conns?.size ?? 0;
    console.log(`👤 Chat connection closed: user=${user.userId} conn=${connId.slice(0, 8)} remaining=${remaining}`);
  }

  // ============================================================================
  // MESSAGE ROUTING
  // ============================================================================

  /**
   * Handle an incoming WebSocket message from a specific connection.
   */
  async handleMessage(connId: string, data: string): Promise<void> {
    const user = this.connections.get(connId);
    if (!user) {
      // Connection closed between message arrival and dispatch. Ignore.
      return;
    }
    const userId = user.userId;

    try {
      const message: ChatWSMessage = JSON.parse(data);

      // Validate message structure
      if (!message.type || !message.payload) {
        this.sendErrorToConnection(connId, 'Invalid message format', message.requestId);
        return;
      }

      // Route message based on type
      switch (message.type) {
        // Message operations
        case 'chat:send_message':
          await this.handleSendMessage(connId, userId, message.payload, message.requestId);
          break;
        case 'chat:edit_message':
          await this.handleEditMessage(connId, userId, message.payload, message.requestId);
          break;
        case 'chat:delete_message':
          await this.handleDeleteMessage(connId, userId, message.payload, message.requestId);
          break;

        // Typing
        case 'chat:typing_start':
          await this.handleTypingStart(userId, message.payload);
          break;
        case 'chat:typing_stop':
          await this.handleTypingStop(userId, message.payload);
          break;

        // Presence
        case 'chat:presence_update':
          await this.handlePresenceUpdate(userId, message.payload);
          break;

        // Read receipts
        case 'chat:mark_read':
          await this.handleMarkRead(connId, userId, message.payload, message.requestId);
          break;

        // Reactions
        case 'chat:add_reaction':
          await this.handleAddReaction(connId, userId, message.payload, message.requestId);
          break;
        case 'chat:remove_reaction':
          await this.handleRemoveReaction(connId, userId, message.payload, message.requestId);
          break;

        // Group subscription
        case 'chat:join_group':
          await this.handleJoinGroup(connId, message.payload, message.requestId);
          break;
        case 'chat:leave_group':
          await this.handleLeaveGroup(connId, message.payload, message.requestId);
          break;

        default:
          this.sendErrorToConnection(connId, `Unknown message type: ${message.type}`, message.requestId);
      }

    } catch (error) {
      logError('Failed to handle WebSocket message', error);
      this.sendErrorToConnection(connId, 'Failed to process message');
    }
  }

  // ============================================================================
  // MESSAGE HANDLERS
  // ============================================================================

  private async handleSendMessage(
    connId: string,
    userId: number,
    payload: SendMessagePayload,
    requestId?: string
  ): Promise<void> {
    try {
      // Rate limiting (per-user, shared across all connections)
      if (!this.checkRateLimit(userId, 'MESSAGE')) {
        this.sendErrorToConnection(connId, 'Rate limit exceeded. Please slow down.', requestId);
        return;
      }

      // Send message through manager
      const message = await chatMessageManager.sendMessage({
        groupId: payload.groupId,
        senderUserId: userId,
        content: payload.content,
        contentType: payload.contentType as any || 'text',
        parentMessageId: payload.parentMessageId,
        metadata: payload.metadata,
        clientMessageId: payload.clientMessageId,
      });

      // Send acknowledgment to the SPECIFIC connection that sent the
      // request. Other tabs/devices for this user do not need this ack
      // — they will receive the 'chat:message' broadcast separately if
      // they're subscribed to the group.
      this.sendToConnection(connId, {
        type: 'chat:ack',
        payload: {
          success: true,
          messageId: message.id,
          clientMessageId: payload.clientMessageId,
        },
        requestId,
      });

    } catch (error) {
      this.sendErrorToConnection(connId, getErrorMessage(error), requestId);
    }
  }

  private async handleEditMessage(
    connId: string,
    userId: number,
    payload: EditMessagePayload,
    requestId?: string
  ): Promise<void> {
    try {
      const message = await chatMessageManager.editMessage(
        payload.messageId,
        userId,
        payload.content
      );

      this.sendToConnection(connId, {
        type: 'chat:ack',
        payload: { success: true, messageId: message.id },
        requestId,
      });

    } catch (error) {
      this.sendErrorToConnection(connId, getErrorMessage(error), requestId);
    }
  }

  private async handleDeleteMessage(
    connId: string,
    userId: number,
    payload: DeleteMessagePayload,
    requestId?: string
  ): Promise<void> {
    try {
      await chatMessageManager.deleteMessage(payload.messageId, userId);

      this.sendToConnection(connId, {
        type: 'chat:ack',
        payload: { success: true, messageId: payload.messageId, deleted: true },
        requestId,
      });

    } catch (error) {
      this.sendErrorToConnection(connId, getErrorMessage(error), requestId);
    }
  }

  // ============================================================================
  // TYPING HANDLERS
  // ============================================================================

  private async handleTypingStart(userId: number, payload: TypingPayload): Promise<void> {
    try {
      if (!this.checkRateLimit(userId, 'TYPING')) return;

      await chatMessageManager.setTypingStatus(payload.groupId, userId, true);

    } catch (error) {
      logError('Typing start error', error);
    }
  }

  private async handleTypingStop(userId: number, payload: TypingPayload): Promise<void> {
    try {
      await chatMessageManager.setTypingStatus(payload.groupId, userId, false);

    } catch (error) {
      logError('Typing stop error', error);
    }
  }

  // ============================================================================
  // PRESENCE HANDLERS
  // ============================================================================

  private async handlePresenceUpdate(userId: number, payload: PresencePayload): Promise<void> {
    try {
      await chatMessageManager.updatePresence(
        payload.groupId,
        userId,
        payload.status,
        // Use first connection's deviceType as representative; presence
        // is per-user not per-connection in the underlying manager.
        payload.deviceType ?? this.getRepresentativeDeviceType(userId)
      );

    } catch (error) {
      logError('Presence update error', error);
    }
  }

  private handlePresenceChange(
    userId: number,
    groupId: string,
    status: 'online' | 'away' | 'busy' | 'offline'
  ): void {
    // Fire and forget - don't await
    chatMessageManager.updatePresence(groupId, userId, status).catch(err => {
      logError('Presence change error', err);
    });
  }

  private getRepresentativeDeviceType(userId: number): string | undefined {
    const connIds = this.userConnIds.get(userId);
    if (!connIds) return undefined;
    for (const connId of connIds) {
      const u = this.connections.get(connId);
      if (u?.deviceType) return u.deviceType;
    }
    return undefined;
  }

  // ============================================================================
  // READ RECEIPT HANDLERS
  // ============================================================================

  private async handleMarkRead(
    connId: string,
    userId: number,
    payload: MarkReadPayload,
    requestId?: string
  ): Promise<void> {
    try {
      await chatMessageManager.markAsRead(payload.groupId, userId, payload.messageId);

      this.sendToConnection(connId, {
        type: 'chat:ack',
        payload: { success: true, marked: true },
        requestId,
      });

    } catch (error) {
      this.sendErrorToConnection(connId, getErrorMessage(error), requestId);
    }
  }

  // ============================================================================
  // REACTION HANDLERS
  // ============================================================================

  private async handleAddReaction(
    connId: string,
    userId: number,
    payload: ReactionPayload,
    requestId?: string
  ): Promise<void> {
    try {
      if (!this.checkRateLimit(userId, 'REACTION')) {
        this.sendErrorToConnection(connId, 'Rate limit exceeded', requestId);
        return;
      }

      const reactions = await chatMessageManager.addReaction(
        payload.messageId,
        userId,
        payload.emoji
      );

      this.sendToConnection(connId, {
        type: 'chat:ack',
        payload: { success: true, reactions },
        requestId,
      });

    } catch (error) {
      this.sendErrorToConnection(connId, getErrorMessage(error), requestId);
    }
  }

  private async handleRemoveReaction(
    connId: string,
    userId: number,
    payload: ReactionPayload,
    requestId?: string
  ): Promise<void> {
    try {
      const reactions = await chatMessageManager.removeReaction(
        payload.messageId,
        userId,
        payload.emoji
      );

      this.sendToConnection(connId, {
        type: 'chat:ack',
        payload: { success: true, reactions },
        requestId,
      });

    } catch (error) {
      this.sendErrorToConnection(connId, getErrorMessage(error), requestId);
    }
  }

  // ============================================================================
  // GROUP SUBSCRIPTION HANDLERS
  // ============================================================================

  private async handleJoinGroup(
    connId: string,
    payload: GroupPayload,
    requestId?: string
  ): Promise<void> {
    try {
      const user = this.connections.get(connId);
      if (!user) {
        // Connection just closed — no recipient to ack.
        return;
      }
      const userId = user.userId;

      // Verify membership
      const [rows] = await DB.query(
        `SELECT role FROM mirror_group_members
         WHERE group_id = ? AND user_id = ? AND status = 'active'`,
        [payload.groupId, userId]
      );

      if ((rows as any[]).length === 0) {
        this.sendErrorToConnection(connId, 'Not a member of this group', requestId);
        return;
      }

      // Per-connection subscription: this device subscribes; others
      // owned by the same user must call join_group independently if
      // they want to receive group events. The client's `onopen` rejoin
      // loop in chatWebSocket.ts does this automatically for each
      // device's own subscribedGroups set.
      user.activeGroups.add(payload.groupId);

      let subscribers = this.groupSubscriptions.get(payload.groupId);
      if (!subscribers) {
        subscribers = new Set();
        this.groupSubscriptions.set(payload.groupId, subscribers);
      }
      subscribers.add(connId);

      // Update presence to online
      await chatMessageManager.updatePresence(payload.groupId, userId, 'online', user.deviceType);

      // Get username for the presence broadcast
      const [userRows] = await DB.query('SELECT username FROM users WHERE id = ?', [userId]);
      const username = (userRows as any[])[0]?.username;

      // Ack the specific connection that asked. chat:ack with requestId
      // resolves the client's sendWithAck Promise; the protocol matches
      // every other request/response handler in this file.
      this.sendToConnection(connId, {
        type: 'chat:ack',
        payload: {
          success: true,
          groupId: payload.groupId,
          subscriberCount: subscribers.size,
        },
        requestId,
      });

      // Emit the semantic event so chat:group_joined listeners fire.
      // Sent only to the connection that joined (per-connection scope).
      this.sendToConnection(connId, {
        type: 'chat:group_joined',
        payload: {
          groupId: payload.groupId,
          subscriberCount: subscribers.size,
        },
      });

      // Notify other group members (skipping the joiner's other tabs too)
      this.broadcastToGroup(payload.groupId, {
        type: 'chat:presence',
        payload: {
          userId,
          username,
          groupId: payload.groupId,
          status: 'online',
          lastSeenAt: new Date().toISOString(),
        },
      }, userId);

      console.log(`📥 conn=${connId.slice(0, 8)} (user=${userId}) joined chat group ${payload.groupId}`);

    } catch (error) {
      this.sendErrorToConnection(connId, getErrorMessage(error), requestId);
    }
  }

  private async handleLeaveGroup(
    connId: string,
    payload: GroupPayload,
    requestId?: string
  ): Promise<void> {
    try {
      const user = this.connections.get(connId);
      if (!user) return;
      const userId = user.userId;

      this.removeFromGroup(connId, payload.groupId);

      // Was this the user's LAST subscription to this group across all
      // their connections? Only then is it correct to broadcast offline
      // presence to other group members.
      const stillSubscribed = this.userHasGroupSubscription(userId, payload.groupId);
      if (!stillSubscribed) {
        await chatMessageManager.updatePresence(payload.groupId, userId, 'offline');
      }

      this.sendToConnection(connId, {
        type: 'chat:ack',
        payload: { success: true, groupId: payload.groupId, left: true },
        requestId,
      });

      this.sendToConnection(connId, {
        type: 'chat:group_left',
        payload: { groupId: payload.groupId },
      });

      if (!stillSubscribed) {
        this.broadcastToGroup(payload.groupId, {
          type: 'chat:presence',
          payload: {
            userId,
            groupId: payload.groupId,
            status: 'offline',
            lastSeenAt: new Date().toISOString(),
          },
        }, userId);
      }

      console.log(`📤 conn=${connId.slice(0, 8)} (user=${userId}) left chat group ${payload.groupId}`);

    } catch (error) {
      this.sendErrorToConnection(connId, getErrorMessage(error), requestId);
    }
  }

  /** Does this user still subscribe to the group via ANY of their connections? */
  private userHasGroupSubscription(userId: number, groupId: string): boolean {
    const connIds = this.userConnIds.get(userId);
    if (!connIds) return false;
    const subs = this.groupSubscriptions.get(groupId);
    if (!subs) return false;
    for (const connId of connIds) {
      if (subs.has(connId)) return true;
    }
    return false;
  }

  private removeFromGroup(connId: string, groupId: string): void {
    const user = this.connections.get(connId);
    if (user) {
      user.activeGroups.delete(groupId);
    }

    const subscribers = this.groupSubscriptions.get(groupId);
    if (subscribers) {
      subscribers.delete(connId);
      if (subscribers.size === 0) {
        this.groupSubscriptions.delete(groupId);
      }
    }
  }

  // ============================================================================
  // EVENT HANDLERS (from ChatMessageManager)
  // ============================================================================

  private handleMessageSent(message: ChatMessage): void {
    // Broadcast to all group subscribers EXCEPT the sender's connections.
    // The sender's tab that submitted the message already has it optimistically;
    // their OTHER tabs/devices, however, DO need it — see the comment in
    // broadcastToGroup for how cross-tab delivery is handled.
    this.broadcastToGroup(message.groupId, {
      type: 'chat:message',
      payload: this.formatMessageForBroadcast(message),
    }, message.senderUserId);
  }

  private handleMessageEdited(message: ChatMessage): void {
    this.broadcastToGroup(message.groupId, {
      type: 'chat:message_edited',
      payload: {
        messageId: message.id,
        groupId: message.groupId,
        editedAt: message.editedAt?.toISOString(),
      },
    });
  }

  private handleMessageDeleted(data: { messageId: string; groupId: string; deletedBy: number }): void {
    this.broadcastToGroup(data.groupId, {
      type: 'chat:message_deleted',
      payload: {
        messageId: data.messageId,
        groupId: data.groupId,
        deletedBy: data.deletedBy,
      },
    });
  }

  // ============================================================================
  // SENDING HELPERS
  // ============================================================================

  /**
   * Send a message to a specific connection. Used for request/response
   * acks where only the originating client should receive the reply.
   */
  private sendToConnection(connId: string, message: ChatWSMessage): boolean {
    const user = this.connections.get(connId);
    if (!user || user.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      user.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      logError(`Failed to send to conn ${connId.slice(0, 8)}`, error);
      return false;
    }
  }

  /**
   * Send a message to ALL of a user's connections.
   *
   * Returns the count of connections successfully delivered to. A return
   * of 0 means none of the user's connections were open — caller can fall
   * back to push notification etc.
   */
  sendToUser(userId: number, message: ChatWSMessage): number {
    const connIds = this.userConnIds.get(userId);
    if (!connIds) return 0;

    let sent = 0;
    for (const connId of connIds) {
      if (this.sendToConnection(connId, message)) {
        sent++;
      }
    }
    return sent;
  }

  private sendErrorToConnection(connId: string, error: string, requestId?: string): void {
    this.sendToConnection(connId, {
      type: 'chat:error',
      payload: { error },
      requestId,
    });
  }

  /**
   * Broadcast a message to every connection subscribed to a group.
   *
   * `excludeUserId` skips ALL connections owned by that user — including
   * the user's other tabs/devices. This is correct for `chat:message`
   * broadcasts because the sender's other devices receive the message
   * via a DIFFERENT path: they're subscribed to the group too and get
   * the broadcast directly, but the sender's submitting tab already has
   * an optimistic copy of the message. We skip all their connections to
   * avoid duplicating that optimistic message; ChatContext's dedup Set
   * also handles any leftover race, and the message reload on focus/open
   * brings the canonical persisted row.
   *
   * Returns the number of connections delivered to.
   */
  broadcastToGroup(
    groupId: string,
    message: ChatWSMessage,
    excludeUserId?: number
  ): number {
    const subscribers = this.groupSubscriptions.get(groupId);
    if (!subscribers) return 0;

    let sent = 0;
    for (const connId of subscribers) {
      const user = this.connections.get(connId);
      if (!user) continue;
      if (excludeUserId && user.userId === excludeUserId) continue;
      if (this.sendToConnection(connId, message)) {
        sent++;
      }
    }

    return sent;
  }

  /**
   * Broadcast to all connected users (admin use only)
   */
  broadcastToAll(message: ChatWSMessage): number {
    let sent = 0;
    for (const connId of this.connections.keys()) {
      if (this.sendToConnection(connId, message)) {
        sent++;
      }
    }
    return sent;
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  private formatMessageForBroadcast(message: ChatMessage): any {
    return {
      id: message.id,
      groupId: message.groupId,
      senderUserId: message.senderUserId,
      senderUsername: message.senderUsername,
      contentType: message.contentType,
      parentMessageId: message.parentMessageId,
      threadRootId: message.threadRootId,
      metadata: message.metadata,
      status: message.status,
      clientMessageId: message.clientMessageId,
      createdAt: message.createdAt.toISOString(),
      // Note: Content is NOT included - clients must fetch encrypted content
      encryptedContent: true,
    };
  }

  private checkRateLimit(userId: number, type: 'MESSAGE' | 'TYPING' | 'REACTION'): boolean {
    const key = `${userId}:${type}`;
    const limit = this.RATE_LIMITS[type];
    const now = Date.now();

    let limiter = this.rateLimiters.get(key);
    if (!limiter || now >= limiter.resetAt) {
      limiter = { count: 0, resetAt: now + limit.windowMs };
      this.rateLimiters.set(key, limiter);
    }

    limiter.count++;
    return limiter.count <= limit.count;
  }

  /**
   * Get connection statistics
   */
  getStats(): {
    connectedConnections: number;
    connectedUsers: number;
    activeGroups: number;
    totalSubscriptions: number;
  } {
    let totalSubscriptions = 0;
    for (const [, subscribers] of this.groupSubscriptions) {
      totalSubscriptions += subscribers.size;
    }

    return {
      connectedConnections: this.connections.size,
      connectedUsers: this.userConnIds.size,
      activeGroups: this.groupSubscriptions.size,
      totalSubscriptions,
    };
  }

  /**
   * Check if a user has at least one open connection.
   */
  isUserConnected(userId: number): boolean {
    const connIds = this.userConnIds.get(userId);
    if (!connIds || connIds.size === 0) return false;
    for (const connId of connIds) {
      const user = this.connections.get(connId);
      if (user && user.ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  /**
   * Get the count of open connections for a user.
   */
  getUserConnectionCount(userId: number): number {
    const connIds = this.userConnIds.get(userId);
    return connIds ? connIds.size : 0;
  }

  /**
   * Get unique userIds subscribed to a group (de-duplicated across
   * multiple connections for the same user).
   */
  getGroupSubscribers(groupId: string): number[] {
    const subscribers = this.groupSubscriptions.get(groupId);
    if (!subscribers) return [];
    const userIds = new Set<number>();
    for (const connId of subscribers) {
      const user = this.connections.get(connId);
      if (user) userIds.add(user.userId);
    }
    return Array.from(userIds);
  }

  // ============================================================================
  // SHUTDOWN
  // ============================================================================

  async shutdown(): Promise<void> {
    console.log('🔌 Shutting down Chat WebSocket Handler...');

    // Set all users offline and close every connection
    const presenceUpdates: Promise<void>[] = [];
    for (const [, user] of this.connections) {
      for (const groupId of user.activeGroups) {
        presenceUpdates.push(
          chatMessageManager.updatePresence(groupId, user.userId, 'offline').catch(() => {})
        );
      }

      try {
        user.ws.close(1001, 'Server shutting down');
      } catch {
        // Ignore close errors
      }
    }
    await Promise.allSettled(presenceUpdates);

    this.connections.clear();
    this.userConnIds.clear();
    this.groupSubscriptions.clear();
    this.rateLimiters.clear();
    this.initialized = false;

    console.log('✅ Chat WebSocket Handler shutdown complete');
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const chatWSHandler = new ChatWSHandler();