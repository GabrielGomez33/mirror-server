// ============================================================================
// CHAT WEBSOCKET HANDLER - MirrorGroups Phase 5
// ============================================================================
// Real-time WebSocket message handling for chat functionality:
// - Message sending/receiving with encryption
// - Typing indicators
// - Presence updates
// - Read receipts
// - Reactions
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
  private users: Map<number, ChatWSUser> = new Map();
  private groupSubscriptions: Map<string, Set<number>> = new Map();
  private initialized: boolean = false;

  // Rate limiting
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
   * Register a user's WebSocket connection
   */
  registerUser(user: {
    userId: number;
    username: string;
    email: string;
    sessionId: string;
  }, ws: WebSocket): ChatWSUser {
    // Check for existing connection and close it
    const existing = this.users.get(user.userId);
    if (existing) {
      try {
        existing.ws.close(1000, 'New connection established');
      } catch (e) {
        // Ignore close errors
      }
    }

    const chatUser: ChatWSUser = {
      ...user,
      ws,
      connectedAt: new Date(),
      activeGroups: new Set(),
    };

    this.users.set(user.userId, chatUser);

    console.log(`👤 Chat user registered: ${user.userId} (${user.username})`);

    return chatUser;
  }

  /**
   * Unregister a user's WebSocket connection
   */
  unregisterUser(userId: number): void {
    const user = this.users.get(userId);
    if (user) {
      // Remove from all group subscriptions
      for (const groupId of user.activeGroups) {
        this.removeFromGroup(userId, groupId);
      }

      // Set offline presence
      for (const groupId of user.activeGroups) {
        this.handlePresenceChange(userId, groupId, 'offline');
      }

      this.users.delete(userId);
      console.log(`👤 Chat user unregistered: ${userId}`);
    }
  }

  // ============================================================================
  // MESSAGE ROUTING
  // ============================================================================

  /**
   * Handle incoming WebSocket message
   */
  async handleMessage(userId: number, data: string): Promise<void> {
    try {
      const message: ChatWSMessage = JSON.parse(data);

      // Validate message structure
      if (!message.type || !message.payload) {
        this.sendError(userId, 'Invalid message format', message.requestId);
        return;
      }

      // Route message based on type
      switch (message.type) {
        // Message operations
        case 'chat:send_message':
          await this.handleSendMessage(userId, message.payload, message.requestId);
          break;
        case 'chat:edit_message':
          await this.handleEditMessage(userId, message.payload, message.requestId);
          break;
        case 'chat:delete_message':
          await this.handleDeleteMessage(userId, message.payload, message.requestId);
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
          await this.handleMarkRead(userId, message.payload, message.requestId);
          break;

        // Reactions
        case 'chat:add_reaction':
          await this.handleAddReaction(userId, message.payload, message.requestId);
          break;
        case 'chat:remove_reaction':
          await this.handleRemoveReaction(userId, message.payload, message.requestId);
          break;

        // Group subscription
        case 'chat:join_group':
          await this.handleJoinGroup(userId, message.payload, message.requestId);
          break;
        case 'chat:leave_group':
          await this.handleLeaveGroup(userId, message.payload, message.requestId);
          break;

        default:
          this.sendError(userId, `Unknown message type: ${message.type}`, message.requestId);
      }

    } catch (error) {
      logError('Failed to handle WebSocket message', error);
      this.sendError(userId, 'Failed to process message');
    }
  }

  // ============================================================================
  // MESSAGE HANDLERS
  // ============================================================================

  private async handleSendMessage(
    userId: number,
    payload: SendMessagePayload,
    requestId?: string
  ): Promise<void> {
    try {
      // Rate limiting
      if (!this.checkRateLimit(userId, 'MESSAGE')) {
        this.sendError(userId, 'Rate limit exceeded. Please slow down.', requestId);
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

      // Send acknowledgment to sender
      this.sendToUser(userId, {
        type: 'chat:ack',
        payload: {
          success: true,
          messageId: message.id,
          clientMessageId: payload.clientMessageId,
        },
        requestId,
      });

    } catch (error) {
      this.sendError(userId, getErrorMessage(error), requestId);
    }
  }

  private async handleEditMessage(
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

      // Send acknowledgment
      this.sendToUser(userId, {
        type: 'chat:ack',
        payload: { success: true, messageId: message.id },
        requestId,
      });

    } catch (error) {
      this.sendError(userId, getErrorMessage(error), requestId);
    }
  }

  private async handleDeleteMessage(
    userId: number,
    payload: DeleteMessagePayload,
    requestId?: string
  ): Promise<void> {
    try {
      await chatMessageManager.deleteMessage(payload.messageId, userId);

      // Send acknowledgment
      this.sendToUser(userId, {
        type: 'chat:ack',
        payload: { success: true, messageId: payload.messageId, deleted: true },
        requestId,
      });

    } catch (error) {
      this.sendError(userId, getErrorMessage(error), requestId);
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
        payload.deviceType
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

  // ============================================================================
  // READ RECEIPT HANDLERS
  // ============================================================================

  private async handleMarkRead(
    userId: number,
    payload: MarkReadPayload,
    requestId?: string
  ): Promise<void> {
    try {
      await chatMessageManager.markAsRead(payload.groupId, userId, payload.messageId);

      // Send acknowledgment
      this.sendToUser(userId, {
        type: 'chat:ack',
        payload: { success: true, marked: true },
        requestId,
      });

    } catch (error) {
      this.sendError(userId, getErrorMessage(error), requestId);
    }
  }

  // ============================================================================
  // REACTION HANDLERS
  // ============================================================================

  private async handleAddReaction(
    userId: number,
    payload: ReactionPayload,
    requestId?: string
  ): Promise<void> {
    try {
      if (!this.checkRateLimit(userId, 'REACTION')) {
        this.sendError(userId, 'Rate limit exceeded', requestId);
        return;
      }

      const reactions = await chatMessageManager.addReaction(
        payload.messageId,
        userId,
        payload.emoji
      );

      // Send acknowledgment
      this.sendToUser(userId, {
        type: 'chat:ack',
        payload: { success: true, reactions },
        requestId,
      });

    } catch (error) {
      this.sendError(userId, getErrorMessage(error), requestId);
    }
  }

  private async handleRemoveReaction(
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

      // Send acknowledgment
      this.sendToUser(userId, {
        type: 'chat:ack',
        payload: { success: true, reactions },
        requestId,
      });

    } catch (error) {
      this.sendError(userId, getErrorMessage(error), requestId);
    }
  }

  // ============================================================================
  // GROUP SUBSCRIPTION HANDLERS
  // ============================================================================

  private async handleJoinGroup(
    userId: number,
    payload: GroupPayload,
    requestId?: string
  ): Promise<void> {
    try {
      const user = this.users.get(userId);
      if (!user) {
        this.sendError(userId, 'User not connected', requestId);
        return;
      }

      // Verify membership
      const [rows] = await DB.query(
        `SELECT role FROM mirror_group_members
         WHERE group_id = ? AND user_id = ? AND status = 'active'`,
        [payload.groupId, userId]
      );

      if ((rows as any[]).length === 0) {
        this.sendError(userId, 'Not a member of this group', requestId);
        return;
      }

      // Add to subscriptions
      user.activeGroups.add(payload.groupId);

      let subscribers = this.groupSubscriptions.get(payload.groupId);
      if (!subscribers) {
        subscribers = new Set();
        this.groupSubscriptions.set(payload.groupId, subscribers);
      }
      subscribers.add(userId);

      // Update presence to online
      await chatMessageManager.updatePresence(payload.groupId, userId, 'online', user.deviceType);

      // Get username for the response
      const [userRows] = await DB.query('SELECT username FROM users WHERE id = ?', [userId]);
      const username = (userRows as any[])[0]?.username;

      // Send confirmation
      this.sendToUser(userId, {
        type: 'chat:group_joined',
        payload: {
          groupId: payload.groupId,
          subscriberCount: subscribers.size,
        },
        requestId,
      });

      // Notify other group members
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

      console.log(`📥 User ${userId} joined chat group ${payload.groupId}`);

    } catch (error) {
      this.sendError(userId, getErrorMessage(error), requestId);
    }
  }

  private async handleLeaveGroup(
    userId: number,
    payload: GroupPayload,
    requestId?: string
  ): Promise<void> {
    try {
      this.removeFromGroup(userId, payload.groupId);

      // Update presence to offline for this group
      await chatMessageManager.updatePresence(payload.groupId, userId, 'offline');

      // Send confirmation
      this.sendToUser(userId, {
        type: 'chat:group_left',
        payload: { groupId: payload.groupId },
        requestId,
      });

      // Notify other group members
      this.broadcastToGroup(payload.groupId, {
        type: 'chat:presence',
        payload: {
          userId,
          groupId: payload.groupId,
          status: 'offline',
          lastSeenAt: new Date().toISOString(),
        },
      }, userId);

      console.log(`📤 User ${userId} left chat group ${payload.groupId}`);

    } catch (error) {
      this.sendError(userId, getErrorMessage(error), requestId);
    }
  }

  private removeFromGroup(userId: number, groupId: string): void {
    const user = this.users.get(userId);
    if (user) {
      user.activeGroups.delete(groupId);
    }

    const subscribers = this.groupSubscriptions.get(groupId);
    if (subscribers) {
      subscribers.delete(userId);
      if (subscribers.size === 0) {
        this.groupSubscriptions.delete(groupId);
      }
    }
  }

  // ============================================================================
  // EVENT HANDLERS (from ChatMessageManager)
  // ============================================================================

  private handleMessageSent(message: ChatMessage): void {
    // Broadcast to all group subscribers
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

  private sendToUser(userId: number, message: ChatWSMessage): boolean {
    const user = this.users.get(userId);
    if (!user || user.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      user.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      logError(`Failed to send to user ${userId}`, error);
      return false;
    }
  }

  private sendError(userId: number, error: string, requestId?: string): void {
    this.sendToUser(userId, {
      type: 'chat:error',
      payload: { error },
      requestId,
    });
  }

  /**
   * Broadcast message to all users in a group
   */
  broadcastToGroup(
    groupId: string,
    message: ChatWSMessage,
    excludeUserId?: number
  ): number {
    const subscribers = this.groupSubscriptions.get(groupId);
    if (!subscribers) return 0;

    let sent = 0;
    for (const userId of subscribers) {
      if (excludeUserId && userId === excludeUserId) continue;
      if (this.sendToUser(userId, message)) {
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
    for (const [userId] of this.users) {
      if (this.sendToUser(userId, message)) {
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
    connectedUsers: number;
    activeGroups: number;
    totalSubscriptions: number;
  } {
    let totalSubscriptions = 0;
    for (const [, subscribers] of this.groupSubscriptions) {
      totalSubscriptions += subscribers.size;
    }

    return {
      connectedUsers: this.users.size,
      activeGroups: this.groupSubscriptions.size,
      totalSubscriptions,
    };
  }

  /**
   * Check if a user is connected
   */
  isUserConnected(userId: number): boolean {
    const user = this.users.get(userId);
    return user !== undefined && user.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get users subscribed to a group
   */
  getGroupSubscribers(groupId: string): number[] {
    const subscribers = this.groupSubscriptions.get(groupId);
    return subscribers ? Array.from(subscribers) : [];
  }

  // ============================================================================
  // SHUTDOWN
  // ============================================================================

  async shutdown(): Promise<void> {
    console.log('🔌 Shutting down Chat WebSocket Handler...');

    // Set all users offline
    for (const [userId, user] of this.users) {
      for (const groupId of user.activeGroups) {
        await chatMessageManager.updatePresence(groupId, userId, 'offline');
      }

      try {
        user.ws.close(1001, 'Server shutting down');
      } catch (e) {
        // Ignore close errors
      }
    }

    this.users.clear();
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
