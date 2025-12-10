// ============================================================================
// CHAT MESSAGE MANAGER - MirrorGroups Phase 5
// ============================================================================
// Handles all chat message operations:
// - Message CRUD with encryption
// - Redis caching for performance
// - Delivery status tracking
// - Read receipts
// - Real-time WebSocket delivery
// - Mobile-first optimizations
// ============================================================================

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { DB } from '../db';
import { mirrorRedis } from '../config/redis';
import { groupEncryptionManager } from '../systems/GroupEncryptionManager';
import { mirrorGroupNotifications } from '../systems/mirrorGroupNotifications';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface ChatMessage {
  id: string;
  groupId: string;
  senderUserId: number;
  senderUsername?: string;
  content: string;
  contentType: MessageContentType;
  parentMessageId?: string | null;
  threadRootId?: string | null;
  threadReplyCount?: number;
  metadata?: MessageMetadata;
  status: MessageStatus;
  isEdited: boolean;
  editedAt?: Date | null;
  isDeleted: boolean;
  deletedAt?: Date | null;
  encryptionKeyId?: string | null;
  clientMessageId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  reactions?: ReactionSummary[];
  attachments?: ChatAttachment[];
  readBy?: number[];
}

export interface ChatAttachment {
  id: string;
  messageId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  filePath: string;
  thumbnailPath?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  isEncrypted: boolean;
  processingStatus: 'pending' | 'processing' | 'completed' | 'failed';
}

export interface MessageMetadata {
  mentions?: MentionInfo[];
  links?: LinkPreview[];
  formatting?: FormattingInfo;
  replyPreview?: ReplyPreview;
  custom?: Record<string, any>;
  // Pin-related metadata (populated for pinned messages)
  pinNote?: string | null;
  pinnedAt?: Date | null;
  pinnedBy?: number | null;
}

export interface MentionInfo {
  userId: number;
  username: string;
  startIndex: number;
  endIndex: number;
  type: 'user' | 'everyone' | 'role';
}

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  startIndex: number;
  endIndex: number;
}

export interface FormattingInfo {
  bold?: Array<[number, number]>;
  italic?: Array<[number, number]>;
  code?: Array<[number, number]>;
  links?: Array<[number, number, string]>;
}

export interface ReplyPreview {
  messageId: string;
  senderUsername: string;
  content: string;  // Truncated content
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  users?: number[];
  hasReacted?: boolean;
}

export type MessageContentType = 'text' | 'image' | 'file' | 'audio' | 'video' | 'system' | 'reply';
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'failed';

export interface SendMessageInput {
  groupId: string;
  senderUserId: number;
  content: string;
  contentType?: MessageContentType;
  parentMessageId?: string;
  metadata?: MessageMetadata;
  clientMessageId?: string;
  attachments?: AttachmentInput[];
}

export interface AttachmentInput {
  fileName: string;
  fileType: string;
  fileSize: number;
  filePath: string;
  thumbnailPath?: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface MessageQueryOptions {
  limit?: number;
  before?: string;  // Message ID for cursor-based pagination
  after?: string;   // Message ID for cursor-based pagination
  threadRootId?: string;  // For fetching thread replies
  includeDeleted?: boolean;
  includeReactions?: boolean;
  includeReadBy?: boolean;
}

export interface TypingIndicator {
  userId: number;
  username: string;
  groupId: string;
  isTyping: boolean;
  startedAt: Date;
}

export interface PresenceStatus {
  userId: number;
  username?: string;
  groupId: string;
  status: 'online' | 'away' | 'busy' | 'offline';
  customStatus?: string;
  lastSeenAt: Date;
  deviceType?: string;
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

function sanitizeContent(content: string): string {
  // Basic XSS prevention - remove script tags and event handlers
  return content
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .trim();
}

// ============================================================================
// CHAT MESSAGE MANAGER CLASS
// ============================================================================

export class ChatMessageManager extends EventEmitter {
  private initialized: boolean = false;

  // Redis key prefixes
  private readonly REDIS_KEYS = {
    MESSAGE_CACHE: 'mirror:chat:message:',
    GROUP_MESSAGES: 'mirror:chat:group:',
    TYPING: 'mirror:chat:typing:',
    PRESENCE: 'mirror:chat:presence:',
    UNREAD_COUNT: 'mirror:chat:unread:',
    RATE_LIMIT: 'mirror:chat:ratelimit:',
  } as const;

  // Configuration
  private readonly CONFIG = {
    MESSAGE_CACHE_TTL: 3600,           // 1 hour
    TYPING_INDICATOR_TTL: 5,           // 5 seconds
    PRESENCE_UPDATE_INTERVAL: 30,      // 30 seconds
    MAX_MESSAGE_LENGTH: 10000,         // 10k chars
    MAX_MESSAGES_PER_MINUTE: 30,       // Rate limiting
    MAX_ATTACHMENTS_PER_MESSAGE: 10,
    PAGINATION_DEFAULT_LIMIT: 50,
    PAGINATION_MAX_LIMIT: 100,
  } as const;

  constructor() {
    super();
    console.log('📱 Initializing Chat Message Manager...');
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('✅ Chat Message Manager already initialized');
      return;
    }

    try {
      // Verify database tables exist
      await this.verifyTables();

      // Setup Redis subscriptions for real-time updates
      await this.setupRedisSubscriptions();

      this.initialized = true;
      console.log('✅ Chat Message Manager initialized successfully');
      this.emit('initialized');
    } catch (error) {
      logError('Chat Message Manager initialization failed', error);
      throw error;
    }
  }

  private async verifyTables(): Promise<void> {
    const tables = [
      'mirror_group_messages',
      'mirror_group_message_reads',
      'mirror_group_message_reactions',
      'mirror_group_chat_preferences'
    ];

    for (const table of tables) {
      const [rows] = await DB.query(
        `SELECT COUNT(*) as count FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = ?`,
        [table]
      );

      if ((rows as any[])[0].count === 0) {
        console.warn(`⚠️ Table ${table} does not exist - chat features may be limited`);
      }
    }
  }

  private async setupRedisSubscriptions(): Promise<void> {
    // Subscribe to typing indicators channel
    // This is handled by the Redis manager
    console.log('📡 Redis subscriptions for chat are ready');
  }

  // ============================================================================
  // MESSAGE OPERATIONS
  // ============================================================================

  /**
   * Send a new message to a group
   */
  async sendMessage(input: SendMessageInput): Promise<ChatMessage> {
    try {
      // Validate input
      await this.validateMessageInput(input);

      // Check rate limiting
      await this.checkRateLimit(input.senderUserId, input.groupId);

      // Verify sender is a group member
      await this.verifyGroupMembership(input.senderUserId, input.groupId);

      // Generate message ID
      const messageId = uuidv4();
      const now = new Date();

      // Sanitize content
      const sanitizedContent = sanitizeContent(input.content);

      // Encrypt content
      const { encryptedContent, keyId } = await this.encryptContent(
        sanitizedContent,
        input.groupId
      );

      // Extract mentions from content
      const mentions = this.extractMentions(input.content, input.metadata?.mentions);

      // Determine thread root if this is a reply
      let threadRootId = null;
      if (input.parentMessageId) {
        threadRootId = await this.getThreadRootId(input.parentMessageId);
      }

      // Prepare metadata
      const metadata: MessageMetadata = {
        ...input.metadata,
        mentions: mentions.length > 0 ? mentions : undefined,
      };

      // Insert message into database
      await DB.query(
        `INSERT INTO mirror_group_messages (
          id, group_id, sender_user_id, content, content_type,
          parent_message_id, thread_root_id, metadata,
          status, encryption_key_id, client_message_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)`,
        [
          messageId,
          input.groupId,
          input.senderUserId,
          encryptedContent,
          input.contentType || 'text',
          input.parentMessageId || null,
          threadRootId,
          JSON.stringify(metadata),
          keyId,
          input.clientMessageId || null,
          now
        ]
      );

      // Handle attachments
      if (input.attachments && input.attachments.length > 0) {
        await this.saveAttachments(messageId, input.groupId, input.senderUserId, input.attachments);
      }

      // Store mentions for notifications
      if (mentions.length > 0) {
        await this.storeMentions(messageId, input.groupId, mentions);
      }

      // Get sender info for the response
      const [userRows] = await DB.query(
        'SELECT username FROM users WHERE id = ?',
        [input.senderUserId]
      );
      const senderUsername = (userRows as any[])[0]?.username || 'Unknown';

      // Create message object
      const message: ChatMessage = {
        id: messageId,
        groupId: input.groupId,
        senderUserId: input.senderUserId,
        senderUsername,
        content: sanitizedContent,  // Return decrypted for sender
        contentType: input.contentType || 'text',
        parentMessageId: input.parentMessageId || null,
        threadRootId,
        threadReplyCount: 0,
        metadata,
        status: 'sent',
        isEdited: false,
        editedAt: null,
        isDeleted: false,
        deletedAt: null,
        encryptionKeyId: keyId,
        clientMessageId: input.clientMessageId || null,
        createdAt: now,
        updatedAt: now,
        reactions: [],
        readBy: []
      };

      // Cache the message
      await this.cacheMessage(message);

      // Broadcast to group members via WebSocket
      await this.broadcastMessage(message);

      // Queue delivery for offline members
      await this.queueOfflineDelivery(message);

      // Emit event for real-time processing
      this.emit('message:sent', message);

      console.log(`✉️ Message sent: ${messageId} to group ${input.groupId}`);
      return message;

    } catch (error) {
      logError('Failed to send message', error);
      throw error;
    }
  }

  /**
   * Get messages for a group with pagination
   */
  async getMessages(groupId: string, userId: number, options: MessageQueryOptions = {}): Promise<{
    messages: ChatMessage[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    try {
      // Verify user is a group member
      await this.verifyGroupMembership(userId, groupId);

      const limit = Math.min(
        options.limit || this.CONFIG.PAGINATION_DEFAULT_LIMIT,
        this.CONFIG.PAGINATION_MAX_LIMIT
      );

      let query = `
        SELECT
          m.id, m.group_id, m.sender_user_id, m.content, m.content_type,
          m.parent_message_id, m.thread_root_id, m.thread_reply_count,
          m.metadata, m.status, m.is_edited, m.edited_at, m.is_deleted,
          m.deleted_at, m.encryption_key_id, m.client_message_id,
          m.created_at, m.updated_at,
          u.username as sender_username
        FROM mirror_group_messages m
        JOIN users u ON m.sender_user_id = u.id
        WHERE m.group_id = ?
      `;

      const queryParams: any[] = [groupId];

      // Thread filtering
      if (options.threadRootId) {
        query += ` AND m.thread_root_id = ?`;
        queryParams.push(options.threadRootId);
      } else {
        // Only get root messages (not replies) in main view
        query += ` AND m.parent_message_id IS NULL`;
      }

      // Soft delete filtering
      if (!options.includeDeleted) {
        query += ` AND m.is_deleted = FALSE`;
      }

      // Cursor-based pagination
      if (options.before) {
        const [cursorRows] = await DB.query(
          'SELECT created_at FROM mirror_group_messages WHERE id = ?',
          [options.before]
        );
        if ((cursorRows as any[]).length > 0) {
          query += ` AND m.created_at < ?`;
          queryParams.push((cursorRows as any[])[0].created_at);
        }
      } else if (options.after) {
        const [cursorRows] = await DB.query(
          'SELECT created_at FROM mirror_group_messages WHERE id = ?',
          [options.after]
        );
        if ((cursorRows as any[]).length > 0) {
          query += ` AND m.created_at > ?`;
          queryParams.push((cursorRows as any[])[0].created_at);
        }
      }

      // Order and limit (fetch one extra to determine hasMore)
      query += ` ORDER BY m.created_at DESC LIMIT ?`;
      queryParams.push(limit + 1);

      const [rows] = await DB.query(query, queryParams);
      const messageRows = rows as any[];

      // Determine if there are more messages
      const hasMore = messageRows.length > limit;
      if (hasMore) {
        messageRows.pop(); // Remove the extra row
      }

      // Decrypt and process messages
      const messages: ChatMessage[] = await Promise.all(
        messageRows.map(async (row) => {
          try {
            // Decrypt content
            const decryptedContent = await this.decryptContent(
              row.content,
              userId.toString(),
              groupId
            );

            const message: ChatMessage = {
              id: row.id,
              groupId: row.group_id,
              senderUserId: row.sender_user_id,
              senderUsername: row.sender_username,
              content: decryptedContent,
              contentType: row.content_type,
              parentMessageId: row.parent_message_id,
              threadRootId: row.thread_root_id,
              threadReplyCount: row.thread_reply_count,
              metadata: this.safeJsonParse(row.metadata, {}),
              status: row.status,
              isEdited: row.is_edited,
              editedAt: row.edited_at,
              isDeleted: row.is_deleted,
              deletedAt: row.deleted_at,
              encryptionKeyId: row.encryption_key_id,
              clientMessageId: row.client_message_id,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            };

            // Include reactions if requested
            if (options.includeReactions) {
              message.reactions = await this.getMessageReactions(row.id, userId);
            }

            // Include read by if requested
            if (options.includeReadBy) {
              message.readBy = await this.getMessageReadBy(row.id);
            }

            return message;
          } catch (decryptError) {
            // Return placeholder for failed decryption
            return {
              id: row.id,
              groupId: row.group_id,
              senderUserId: row.sender_user_id,
              senderUsername: row.sender_username,
              content: '[Unable to decrypt message]',
              contentType: row.content_type,
              parentMessageId: row.parent_message_id,
              threadRootId: row.thread_root_id,
              threadReplyCount: row.thread_reply_count,
              metadata: {},
              status: row.status,
              isEdited: row.is_edited,
              editedAt: row.edited_at,
              isDeleted: row.is_deleted,
              deletedAt: row.deleted_at,
              encryptionKeyId: null,
              clientMessageId: row.client_message_id,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            };
          }
        })
      );

      // Reverse to get chronological order (oldest first for chat display)
      messages.reverse();

      return {
        messages,
        hasMore,
        nextCursor: hasMore && messageRows.length > 0
          ? messageRows[messageRows.length - 1].id
          : undefined
      };

    } catch (error) {
      logError('Failed to get messages', error);
      throw error;
    }
  }

  /**
   * Edit a message
   */
  async editMessage(messageId: string, userId: number, newContent: string): Promise<ChatMessage> {
    try {
      // Verify ownership
      const [messageRows] = await DB.query(
        `SELECT group_id, sender_user_id, encryption_key_id
         FROM mirror_group_messages
         WHERE id = ? AND is_deleted = FALSE`,
        [messageId]
      );

      if ((messageRows as any[]).length === 0) {
        throw new Error('Message not found');
      }

      const message = (messageRows as any[])[0];

      if (message.sender_user_id !== userId) {
        throw new Error('You can only edit your own messages');
      }

      // Sanitize and encrypt new content
      const sanitizedContent = sanitizeContent(newContent);
      const { encryptedContent } = await this.encryptContent(
        sanitizedContent,
        message.group_id
      );

      // Update message
      await DB.query(
        `UPDATE mirror_group_messages
         SET content = ?, is_edited = TRUE, edited_at = NOW(),
             edit_count = edit_count + 1, updated_at = NOW()
         WHERE id = ?`,
        [encryptedContent, messageId]
      );

      // Get updated message
      const updatedMessage = await this.getMessageById(messageId, userId);

      // Broadcast edit to group
      await this.broadcastMessageEdit(updatedMessage);

      // Invalidate cache
      await this.invalidateMessageCache(messageId);

      this.emit('message:edited', updatedMessage);
      console.log(`✏️ Message edited: ${messageId}`);

      return updatedMessage;

    } catch (error) {
      logError('Failed to edit message', error);
      throw error;
    }
  }

  /**
   * Delete a message (soft delete)
   */
  async deleteMessage(messageId: string, userId: number): Promise<void> {
    try {
      // Get message info
      const [messageRows] = await DB.query(
        `SELECT group_id, sender_user_id FROM mirror_group_messages
         WHERE id = ? AND is_deleted = FALSE`,
        [messageId]
      );

      if ((messageRows as any[]).length === 0) {
        throw new Error('Message not found');
      }

      const message = (messageRows as any[])[0];

      // Check permissions (owner or group admin)
      const canDelete = message.sender_user_id === userId ||
        await this.isGroupAdmin(userId, message.group_id);

      if (!canDelete) {
        throw new Error('Insufficient permissions to delete this message');
      }

      // Soft delete
      await DB.query(
        `UPDATE mirror_group_messages
         SET is_deleted = TRUE, deleted_at = NOW(), deleted_by = ?, updated_at = NOW()
         WHERE id = ?`,
        [userId, messageId]
      );

      // Broadcast deletion
      await this.broadcastMessageDeletion(messageId, message.group_id);

      // Invalidate cache
      await this.invalidateMessageCache(messageId);

      this.emit('message:deleted', { messageId, groupId: message.group_id, deletedBy: userId });
      console.log(`🗑️ Message deleted: ${messageId}`);

    } catch (error) {
      logError('Failed to delete message', error);
      throw error;
    }
  }

  /**
   * Get a single message by ID
   */
  async getMessageById(messageId: string, userId: number): Promise<ChatMessage> {
    const [rows] = await DB.query(
      `SELECT
        m.*, u.username as sender_username
       FROM mirror_group_messages m
       JOIN users u ON m.sender_user_id = u.id
       WHERE m.id = ?`,
      [messageId]
    );

    if ((rows as any[]).length === 0) {
      throw new Error('Message not found');
    }

    const row = (rows as any[])[0];

    // Verify membership
    await this.verifyGroupMembership(userId, row.group_id);

    // Decrypt content
    const decryptedContent = await this.decryptContent(
      row.content,
      userId.toString(),
      row.group_id
    );

    return {
      id: row.id,
      groupId: row.group_id,
      senderUserId: row.sender_user_id,
      senderUsername: row.sender_username,
      content: decryptedContent,
      contentType: row.content_type,
      parentMessageId: row.parent_message_id,
      threadRootId: row.thread_root_id,
      threadReplyCount: row.thread_reply_count,
      metadata: this.safeJsonParse(row.metadata, {}),
      status: row.status,
      isEdited: row.is_edited,
      editedAt: row.edited_at,
      isDeleted: row.is_deleted,
      deletedAt: row.deleted_at,
      encryptionKeyId: row.encryption_key_id,
      clientMessageId: row.client_message_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reactions: await this.getMessageReactions(row.id, userId),
      readBy: await this.getMessageReadBy(row.id),
    };
  }

  // ============================================================================
  // REACTIONS
  // ============================================================================

  /**
   * Add a reaction to a message
   */
  async addReaction(messageId: string, userId: number, emoji: string): Promise<ReactionSummary[]> {
    try {
      // Validate emoji (basic check)
      if (!emoji || emoji.length > 32) {
        throw new Error('Invalid emoji');
      }

      // Get message info
      const [messageRows] = await DB.query(
        'SELECT group_id FROM mirror_group_messages WHERE id = ? AND is_deleted = FALSE',
        [messageId]
      );

      if ((messageRows as any[]).length === 0) {
        throw new Error('Message not found');
      }

      const groupId = (messageRows as any[])[0].group_id;

      // Verify membership
      await this.verifyGroupMembership(userId, groupId);

      // Insert reaction (or ignore if duplicate)
      const reactionId = uuidv4();
      await DB.query(
        `INSERT INTO mirror_group_message_reactions
         (id, message_id, user_id, group_id, emoji, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE created_at = created_at`,
        [reactionId, messageId, userId, groupId, emoji]
      );

      // Get updated reactions
      const reactions = await this.getMessageReactions(messageId, userId);

      // Broadcast reaction update
      await this.broadcastReactionUpdate(messageId, groupId, reactions);

      this.emit('reaction:added', { messageId, userId, emoji });
      return reactions;

    } catch (error) {
      logError('Failed to add reaction', error);
      throw error;
    }
  }

  /**
   * Remove a reaction from a message
   */
  async removeReaction(messageId: string, userId: number, emoji: string): Promise<ReactionSummary[]> {
    try {
      // Get message info
      const [messageRows] = await DB.query(
        'SELECT group_id FROM mirror_group_messages WHERE id = ?',
        [messageId]
      );

      if ((messageRows as any[]).length === 0) {
        throw new Error('Message not found');
      }

      const groupId = (messageRows as any[])[0].group_id;

      // Remove reaction
      await DB.query(
        `DELETE FROM mirror_group_message_reactions
         WHERE message_id = ? AND user_id = ? AND emoji = ?`,
        [messageId, userId, emoji]
      );

      // Get updated reactions
      const reactions = await this.getMessageReactions(messageId, userId);

      // Broadcast reaction update
      await this.broadcastReactionUpdate(messageId, groupId, reactions);

      this.emit('reaction:removed', { messageId, userId, emoji });
      return reactions;

    } catch (error) {
      logError('Failed to remove reaction', error);
      throw error;
    }
  }

  /**
   * Get reactions for a message
   */
  async getMessageReactions(messageId: string, userId: number): Promise<ReactionSummary[]> {
    const [rows] = await DB.query(
      `SELECT emoji, COUNT(*) as count,
        GROUP_CONCAT(user_id) as user_ids
       FROM mirror_group_message_reactions
       WHERE message_id = ?
       GROUP BY emoji
       ORDER BY count DESC`,
      [messageId]
    );

    return (rows as any[]).map(row => ({
      emoji: row.emoji,
      count: row.count,
      users: row.user_ids ? row.user_ids.split(',').map(Number) : [],
      hasReacted: row.user_ids ? row.user_ids.split(',').includes(userId.toString()) : false,
    }));
  }

  // ============================================================================
  // READ RECEIPTS
  // ============================================================================

  /**
   * Mark messages as read
   */
  async markAsRead(groupId: string, userId: number, messageId: string): Promise<void> {
    try {
      // Call stored procedure for efficient batch marking
      await DB.query('CALL mark_messages_read(?, ?, ?)', [groupId, userId, messageId]);

      // Broadcast read receipt
      await this.broadcastReadReceipt(groupId, userId, messageId);

      this.emit('messages:read', { groupId, userId, upToMessageId: messageId });

    } catch (error) {
      logError('Failed to mark messages as read', error);
      throw error;
    }
  }

  /**
   * Get read status for a message
   */
  async getMessageReadBy(messageId: string): Promise<number[]> {
    const [rows] = await DB.query(
      'SELECT user_id FROM mirror_group_message_reads WHERE message_id = ?',
      [messageId]
    );
    return (rows as any[]).map(row => row.user_id);
  }

  /**
   * Get unread count for a user in a group
   */
  async getUnreadCount(groupId: string, userId: number): Promise<number> {
    // Check cache first
    const cacheKey = `${this.REDIS_KEYS.UNREAD_COUNT}${groupId}:${userId}`;
    const cached = await mirrorRedis.get(cacheKey);
    if (cached !== null) {
      return cached;
    }

    // Query database
    const [rows] = await DB.query(
      'SELECT unread_count FROM mirror_group_chat_preferences WHERE group_id = ? AND user_id = ?',
      [groupId, userId]
    );

    const count = (rows as any[])[0]?.unread_count || 0;

    // Cache for 30 seconds
    await mirrorRedis.set(cacheKey, count, 30);

    return count;
  }

  // ============================================================================
  // TYPING INDICATORS
  // ============================================================================

  /**
   * Set typing status
   */
  async setTypingStatus(groupId: string, userId: number, isTyping: boolean): Promise<void> {
    try {
      const key = `${this.REDIS_KEYS.TYPING}${groupId}:${userId}`;

      if (isTyping) {
        // Get username
        const [userRows] = await DB.query(
          'SELECT username FROM users WHERE id = ?',
          [userId]
        );
        const username = (userRows as any[])[0]?.username || 'Unknown';

        const data: TypingIndicator = {
          userId,
          username,
          groupId,
          isTyping: true,
          startedAt: new Date(),
        };

        // Store in Redis with short TTL
        await mirrorRedis.set(key, data, this.CONFIG.TYPING_INDICATOR_TTL);

        // Broadcast to group
        await this.broadcastTypingIndicator(groupId, data);

      } else {
        // Remove typing indicator
        await mirrorRedis.del(key);

        // Broadcast stop typing
        await this.broadcastTypingIndicator(groupId, {
          userId,
          username: '',
          groupId,
          isTyping: false,
          startedAt: new Date(),
        });
      }

    } catch (error) {
      logError('Failed to set typing status', error);
      // Don't throw - typing is non-critical
    }
  }

  /**
   * Get currently typing users in a group
   */
  async getTypingUsers(groupId: string): Promise<TypingIndicator[]> {
    try {
      // Get all typing keys for this group
      const pattern = `${this.REDIS_KEYS.TYPING}${groupId}:*`;
      // Note: In production, consider using SCAN instead of KEYS
      const keys = await this.getRedisKeys(pattern);

      const typingUsers: TypingIndicator[] = [];

      for (const key of keys) {
        const data = await mirrorRedis.get(key);
        if (data && data.isTyping) {
          typingUsers.push(data);
        }
      }

      return typingUsers;

    } catch (error) {
      logError('Failed to get typing users', error);
      return [];
    }
  }

  // ============================================================================
  // PRESENCE
  // ============================================================================

  /**
   * Update user presence status
   */
  async updatePresence(
    groupId: string,
    userId: number,
    status: PresenceStatus['status'],
    deviceType?: string
  ): Promise<void> {
    try {
      const key = `${this.REDIS_KEYS.PRESENCE}${groupId}:${userId}`;

      // Get username
      const [userRows] = await DB.query(
        'SELECT username FROM users WHERE id = ?',
        [userId]
      );
      const username = (userRows as any[])[0]?.username;

      const presence: PresenceStatus = {
        userId,
        username,
        groupId,
        status,
        lastSeenAt: new Date(),
        deviceType,
      };

      // Store in Redis
      await mirrorRedis.set(key, presence, this.CONFIG.PRESENCE_UPDATE_INTERVAL * 2);

      // Also update database for persistence
      await DB.query(
        `INSERT INTO mirror_group_chat_presence
         (id, user_id, group_id, status, last_seen_at, connected_at, device_type, updated_at)
         VALUES (?, ?, ?, ?, NOW(), NOW(), ?, NOW())
         ON DUPLICATE KEY UPDATE
           status = VALUES(status),
           last_seen_at = NOW(),
           device_type = VALUES(device_type),
           updated_at = NOW()`,
        [uuidv4(), userId, groupId, status, deviceType || 'web']
      );

      // Broadcast presence update
      await this.broadcastPresenceUpdate(groupId, presence);

      this.emit('presence:updated', presence);

    } catch (error) {
      logError('Failed to update presence', error);
    }
  }

  /**
   * Get presence status for all users in a group
   */
  async getGroupPresence(groupId: string): Promise<PresenceStatus[]> {
    try {
      // Get from database for complete list
      const [rows] = await DB.query(
        `SELECT p.user_id, p.status, p.custom_status, p.last_seen_at, p.device_type,
                u.username
         FROM mirror_group_chat_presence p
         JOIN users u ON p.user_id = u.id
         WHERE p.group_id = ?
         ORDER BY
           CASE p.status
             WHEN 'online' THEN 1
             WHEN 'away' THEN 2
             WHEN 'busy' THEN 3
             ELSE 4
           END`,
        [groupId]
      );

      return (rows as any[]).map(row => ({
        userId: row.user_id,
        username: row.username,
        groupId,
        status: row.status,
        customStatus: row.custom_status,
        lastSeenAt: row.last_seen_at,
        deviceType: row.device_type,
      }));

    } catch (error) {
      logError('Failed to get group presence', error);
      return [];
    }
  }

  // ============================================================================
  // SEARCH
  // ============================================================================

  /**
   * Search messages in a group
   */
  async searchMessages(
    groupId: string,
    userId: number,
    query: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<ChatMessage[]> {
    try {
      // Verify membership
      await this.verifyGroupMembership(userId, groupId);

      const limit = Math.min(options.limit || 20, 50);
      const offset = options.offset || 0;

      // Note: Full-text search on encrypted content won't work directly
      // This is a simplified version - for production, consider:
      // 1. Searchable encryption
      // 2. Search index with encrypted metadata
      // 3. Client-side search after decryption

      const [rows] = await DB.query(
        `SELECT m.*, u.username as sender_username
         FROM mirror_group_messages m
         JOIN users u ON m.sender_user_id = u.id
         WHERE m.group_id = ?
           AND m.is_deleted = FALSE
           AND MATCH(m.content) AGAINST(? IN NATURAL LANGUAGE MODE)
         ORDER BY m.created_at DESC
         LIMIT ? OFFSET ?`,
        [groupId, query, limit, offset]
      );

      // Note: Results will need client-side filtering since content is encrypted
      return (rows as any[]).map(row => ({
        id: row.id,
        groupId: row.group_id,
        senderUserId: row.sender_user_id,
        senderUsername: row.sender_username,
        content: '[Encrypted - search match]',
        contentType: row.content_type,
        parentMessageId: row.parent_message_id,
        threadRootId: row.thread_root_id,
        threadReplyCount: row.thread_reply_count,
        metadata: this.safeJsonParse(row.metadata, {}),
        status: row.status,
        isEdited: row.is_edited,
        editedAt: row.edited_at,
        isDeleted: row.is_deleted,
        deletedAt: row.deleted_at,
        encryptionKeyId: row.encryption_key_id,
        clientMessageId: row.client_message_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

    } catch (error) {
      logError('Failed to search messages', error);
      throw error;
    }
  }

  // ============================================================================
  // PINNED MESSAGES
  // ============================================================================

  /**
   * Pin a message
   */
  async pinMessage(messageId: string, userId: number, note?: string): Promise<void> {
    try {
      const [messageRows] = await DB.query(
        'SELECT group_id FROM mirror_group_messages WHERE id = ? AND is_deleted = FALSE',
        [messageId]
      );

      if ((messageRows as any[]).length === 0) {
        throw new Error('Message not found');
      }

      const groupId = (messageRows as any[])[0].group_id;

      // Verify admin permissions
      const isAdmin = await this.isGroupAdmin(userId, groupId);
      if (!isAdmin) {
        throw new Error('Only admins can pin messages');
      }

      // Get next pin order
      const [orderRows] = await DB.query(
        'SELECT COALESCE(MAX(pin_order), 0) + 1 as next_order FROM mirror_group_pinned_messages WHERE group_id = ?',
        [groupId]
      );
      const pinOrder = (orderRows as any[])[0].next_order;

      await DB.query(
        `INSERT INTO mirror_group_pinned_messages
         (id, message_id, group_id, pinned_by_user_id, pin_order, pin_note, pinned_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           pin_note = VALUES(pin_note),
           pinned_at = NOW()`,
        [uuidv4(), messageId, groupId, userId, pinOrder, note || null]
      );

      this.emit('message:pinned', { messageId, groupId, pinnedBy: userId });

    } catch (error) {
      logError('Failed to pin message', error);
      throw error;
    }
  }

  /**
   * Unpin a message
   */
  async unpinMessage(messageId: string, userId: number): Promise<void> {
    try {
      const [pinRows] = await DB.query(
        'SELECT group_id FROM mirror_group_pinned_messages WHERE message_id = ?',
        [messageId]
      );

      if ((pinRows as any[]).length === 0) {
        throw new Error('Message is not pinned');
      }

      const groupId = (pinRows as any[])[0].group_id;

      // Verify admin permissions
      const isAdmin = await this.isGroupAdmin(userId, groupId);
      if (!isAdmin) {
        throw new Error('Only admins can unpin messages');
      }

      await DB.query(
        'DELETE FROM mirror_group_pinned_messages WHERE message_id = ?',
        [messageId]
      );

      this.emit('message:unpinned', { messageId, groupId, unpinnedBy: userId });

    } catch (error) {
      logError('Failed to unpin message', error);
      throw error;
    }
  }

  /**
   * Get pinned messages for a group
   */
  async getPinnedMessages(groupId: string, userId: number): Promise<ChatMessage[]> {
    try {
      await this.verifyGroupMembership(userId, groupId);

      const [rows] = await DB.query(
        `SELECT m.*, u.username as sender_username, p.pin_note, p.pinned_at
         FROM mirror_group_pinned_messages p
         JOIN mirror_group_messages m ON p.message_id = m.id
         JOIN users u ON m.sender_user_id = u.id
         WHERE p.group_id = ? AND m.is_deleted = FALSE
         ORDER BY p.pin_order ASC`,
        [groupId]
      );

      return Promise.all((rows as any[]).map(async row => {
        const decryptedContent = await this.decryptContent(
          row.content,
          userId.toString(),
          groupId
        );

        return {
          id: row.id,
          groupId: row.group_id,
          senderUserId: row.sender_user_id,
          senderUsername: row.sender_username,
          content: decryptedContent,
          contentType: row.content_type,
          parentMessageId: row.parent_message_id,
          threadRootId: row.thread_root_id,
          threadReplyCount: row.thread_reply_count,
          metadata: {
            ...this.safeJsonParse(row.metadata, {}),
            pinNote: row.pin_note,
            pinnedAt: row.pinned_at,
          },
          status: row.status,
          isEdited: row.is_edited,
          editedAt: row.edited_at,
          isDeleted: row.is_deleted,
          deletedAt: row.deleted_at,
          encryptionKeyId: row.encryption_key_id,
          clientMessageId: row.client_message_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }));

    } catch (error) {
      logError('Failed to get pinned messages', error);
      throw error;
    }
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  private async validateMessageInput(input: SendMessageInput): Promise<void> {
    if (!input.groupId) throw new Error('groupId is required');
    if (!input.senderUserId) throw new Error('senderUserId is required');
    if (!input.content && (!input.attachments || input.attachments.length === 0)) {
      throw new Error('content or attachments are required');
    }

    if (input.content && input.content.length > this.CONFIG.MAX_MESSAGE_LENGTH) {
      throw new Error(`Message exceeds maximum length of ${this.CONFIG.MAX_MESSAGE_LENGTH} characters`);
    }

    if (input.attachments && input.attachments.length > this.CONFIG.MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(`Maximum ${this.CONFIG.MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
    }
  }

  private async checkRateLimit(userId: number, groupId: string): Promise<void> {
    const key = `${this.REDIS_KEYS.RATE_LIMIT}${userId}:${groupId}`;
    const current = await mirrorRedis.get(key) || 0;

    if (current >= this.CONFIG.MAX_MESSAGES_PER_MINUTE) {
      throw new Error('Rate limit exceeded. Please wait before sending more messages.');
    }

    // Increment counter with 60 second TTL
    await mirrorRedis.set(key, current + 1, 60);
  }

  private async verifyGroupMembership(userId: number, groupId: string): Promise<void> {
    const [rows] = await DB.query(
      `SELECT role FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, userId]
    );

    if ((rows as any[]).length === 0) {
      throw new Error('Not a member of this group');
    }
  }

  private async isGroupAdmin(userId: number, groupId: string): Promise<boolean> {
    const [rows] = await DB.query(
      `SELECT role FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, userId]
    );

    if ((rows as any[]).length === 0) return false;
    return ['owner', 'admin'].includes((rows as any[])[0].role);
  }

  private async encryptContent(content: string, groupId: string): Promise<{
    encryptedContent: string;
    keyId: string;
  }> {
    // Get active encryption key for group
    const [keyRows] = await DB.query(
      `SELECT id FROM mirror_group_encryption_keys
       WHERE group_id = ? AND status = 'active'
       ORDER BY key_version DESC LIMIT 1`,
      [groupId]
    );

    if ((keyRows as any[]).length === 0) {
      // Create a new key if none exists
      const keyId = await groupEncryptionManager.generateGroupKey(groupId);
      const encrypted = await groupEncryptionManager.encryptForGroup(
        Buffer.from(content, 'utf-8'),
        keyId
      );
      return { encryptedContent: encrypted.encrypted, keyId };
    }

    const keyId = (keyRows as any[])[0].id;
    const encrypted = await groupEncryptionManager.encryptForGroup(
      Buffer.from(content, 'utf-8'),
      keyId
    );

    return { encryptedContent: encrypted.encrypted, keyId };
  }

  private async decryptContent(encryptedContent: string, userId: string, groupId: string): Promise<string> {
    try {
      const decrypted = await groupEncryptionManager.decryptForUser(
        encryptedContent,
        userId,
        groupId
      );
      return decrypted.data.toString('utf-8');
    } catch (error) {
      logError('Decryption failed', error);
      return '[Unable to decrypt]';
    }
  }

  private extractMentions(content: string, existingMentions?: MentionInfo[]): MentionInfo[] {
    if (existingMentions) return existingMentions;

    // Extract @username mentions
    const mentionRegex = /@(\w+)/g;
    const mentions: MentionInfo[] = [];
    let match;

    while ((match = mentionRegex.exec(content)) !== null) {
      mentions.push({
        userId: 0,  // Will be resolved later
        username: match[1],
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        type: match[1].toLowerCase() === 'everyone' ? 'everyone' : 'user',
      });
    }

    return mentions;
  }

  private async getThreadRootId(parentMessageId: string): Promise<string | null> {
    const [rows] = await DB.query(
      'SELECT id, thread_root_id FROM mirror_group_messages WHERE id = ?',
      [parentMessageId]
    );

    if ((rows as any[]).length === 0) return null;

    const parent = (rows as any[])[0];
    // If parent has a thread root, use that; otherwise, parent becomes the root
    return parent.thread_root_id || parent.id;
  }

  private async saveAttachments(
    messageId: string,
    groupId: string,
    userId: number,
    attachments: AttachmentInput[]
  ): Promise<void> {
    for (const attachment of attachments) {
      await DB.query(
        `INSERT INTO mirror_group_chat_attachments
         (id, message_id, group_id, uploader_user_id, file_name, file_type,
          file_size, file_path, thumbnail_path, width, height, duration,
          is_encrypted, processing_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, 'completed', NOW())`,
        [
          uuidv4(), messageId, groupId, userId,
          attachment.fileName, attachment.fileType, attachment.fileSize,
          attachment.filePath, attachment.thumbnailPath || null,
          attachment.width || null, attachment.height || null,
          attachment.duration || null
        ]
      );
    }
  }

  private async storeMentions(messageId: string, groupId: string, mentions: MentionInfo[]): Promise<void> {
    for (const mention of mentions) {
      // Resolve username to user ID if not already set
      let userId = mention.userId;
      if (!userId && mention.username) {
        const [userRows] = await DB.query(
          'SELECT id FROM users WHERE username = ?',
          [mention.username]
        );
        if ((userRows as any[]).length > 0) {
          userId = (userRows as any[])[0].id;
        }
      }

      if (userId) {
        await DB.query(
          `INSERT INTO mirror_group_message_mentions
           (id, message_id, mentioned_user_id, group_id, mention_type, created_at)
           VALUES (?, ?, ?, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE created_at = created_at`,
          [uuidv4(), messageId, userId, groupId, mention.type]
        );
      }
    }
  }

  private async cacheMessage(message: ChatMessage): Promise<void> {
    const key = `${this.REDIS_KEYS.MESSAGE_CACHE}${message.id}`;
    await mirrorRedis.set(key, message, this.CONFIG.MESSAGE_CACHE_TTL);
  }

  private async invalidateMessageCache(messageId: string): Promise<void> {
    const key = `${this.REDIS_KEYS.MESSAGE_CACHE}${messageId}`;
    await mirrorRedis.del(key);
  }

  private async broadcastMessage(message: ChatMessage): Promise<void> {
    // Get all group members
    const [members] = await DB.query(
      `SELECT user_id FROM mirror_group_members
       WHERE group_id = ? AND status = 'active'`,
      [message.groupId]
    );

    // Send to all except sender
    for (const member of members as any[]) {
      if (member.user_id !== message.senderUserId) {
        await mirrorGroupNotifications.notify(member.user_id, {
          type: 'chat:message',
          payload: {
            messageId: message.id,
            groupId: message.groupId,
            senderUserId: message.senderUserId,
            senderUsername: message.senderUsername,
            contentType: message.contentType,
            // Note: Content is encrypted - client must decrypt
            encryptedContent: true,
            createdAt: message.createdAt.toISOString(),
            clientMessageId: message.clientMessageId,
          }
        });
      }
    }
  }

  private async broadcastMessageEdit(message: ChatMessage): Promise<void> {
    const [members] = await DB.query(
      `SELECT user_id FROM mirror_group_members
       WHERE group_id = ? AND status = 'active'`,
      [message.groupId]
    );

    for (const member of members as any[]) {
      await mirrorGroupNotifications.notify(member.user_id, {
        type: 'chat:message_edited',
        payload: {
          messageId: message.id,
          groupId: message.groupId,
          editedAt: message.editedAt?.toISOString(),
        }
      });
    }
  }

  private async broadcastMessageDeletion(messageId: string, groupId: string): Promise<void> {
    const [members] = await DB.query(
      `SELECT user_id FROM mirror_group_members
       WHERE group_id = ? AND status = 'active'`,
      [groupId]
    );

    for (const member of members as any[]) {
      await mirrorGroupNotifications.notify(member.user_id, {
        type: 'chat:message_deleted',
        payload: { messageId, groupId }
      });
    }
  }

  private async broadcastReactionUpdate(
    messageId: string,
    groupId: string,
    reactions: ReactionSummary[]
  ): Promise<void> {
    const [members] = await DB.query(
      `SELECT user_id FROM mirror_group_members
       WHERE group_id = ? AND status = 'active'`,
      [groupId]
    );

    for (const member of members as any[]) {
      await mirrorGroupNotifications.notify(member.user_id, {
        type: 'chat:reactions_updated',
        payload: { messageId, groupId, reactions }
      });
    }
  }

  private async broadcastReadReceipt(groupId: string, userId: number, messageId: string): Promise<void> {
    // Get message sender to notify them
    const [messageRows] = await DB.query(
      'SELECT sender_user_id FROM mirror_group_messages WHERE id = ?',
      [messageId]
    );

    if ((messageRows as any[]).length > 0) {
      const senderId = (messageRows as any[])[0].sender_user_id;
      if (senderId !== userId) {
        await mirrorGroupNotifications.notify(senderId, {
          type: 'chat:message_read',
          payload: { messageId, groupId, readBy: userId }
        });
      }
    }
  }

  private async broadcastTypingIndicator(groupId: string, indicator: TypingIndicator): Promise<void> {
    const [members] = await DB.query(
      `SELECT user_id FROM mirror_group_members
       WHERE group_id = ? AND status = 'active' AND user_id != ?`,
      [groupId, indicator.userId]
    );

    for (const member of members as any[]) {
      await mirrorGroupNotifications.notify(member.user_id, {
        type: 'chat:typing',
        payload: indicator
      });
    }
  }

  private async broadcastPresenceUpdate(groupId: string, presence: PresenceStatus): Promise<void> {
    const [members] = await DB.query(
      `SELECT user_id FROM mirror_group_members
       WHERE group_id = ? AND status = 'active' AND user_id != ?`,
      [groupId, presence.userId]
    );

    for (const member of members as any[]) {
      await mirrorGroupNotifications.notify(member.user_id, {
        type: 'chat:presence',
        payload: presence
      });
    }
  }

  private async queueOfflineDelivery(message: ChatMessage): Promise<void> {
    // Get offline members
    const [members] = await DB.query(
      `SELECT m.user_id
       FROM mirror_group_members m
       LEFT JOIN mirror_group_chat_presence p ON m.user_id = p.user_id AND m.group_id = p.group_id
       WHERE m.group_id = ? AND m.status = 'active'
         AND m.user_id != ?
         AND (p.status IS NULL OR p.status = 'offline')`,
      [message.groupId, message.senderUserId]
    );

    // Queue for each offline member
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    for (const member of members as any[]) {
      await DB.query(
        `INSERT INTO mirror_group_message_delivery_queue
         (id, message_id, recipient_user_id, group_id, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, NOW())`,
        [uuidv4(), message.id, member.user_id, message.groupId, expiresAt]
      );
    }
  }

  private safeJsonParse<T>(value: any, fallback: T): T {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'object') return value as T;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as T;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }

  private async getRedisKeys(pattern: string): Promise<string[]> {
    // This is a workaround since mirrorRedis doesn't expose KEYS
    // In production, use SCAN for better performance
    try {
      // Access the underlying client if available
      return [];  // Placeholder - will be handled via pub/sub instead
    } catch (error) {
      return [];
    }
  }

  // ============================================================================
  // SHUTDOWN
  // ============================================================================

  async shutdown(): Promise<void> {
    console.log('📱 Shutting down Chat Message Manager...');
    this.initialized = false;
    this.emit('shutdown');
    console.log('✅ Chat Message Manager shutdown complete');
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const chatMessageManager = new ChatMessageManager();
