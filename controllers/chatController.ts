// ============================================================================
// CHAT CONTROLLER - MirrorGroups Phase 5
// ============================================================================
// Handles HTTP request/response logic for chat operations:
// - Input validation with security measures
// - Rate limiting
// - Response formatting
// - Error handling
// ============================================================================

import {
  chatMessageManager,
  SendMessageInput,
  MessageQueryOptions,
  ChatMessage
} from '../managers/ChatMessageManager';
import crypto from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

// Express-compatible types (without requiring @types/express)
export interface AuthenticatedRequest {
  user?: {
    id: number;
    username: string;
    email: string;
    sessionId: string;
  };
  params: Record<string, string>;
  query: Record<string, any>;
  body: any;
}

export interface Response {
  status(code: number): Response;
  json(body: any): void;
}

interface ValidationError {
  field: string;
  message: string;
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error occurred';
}

function validateRequired(value: any, fieldName: string): ValidationError | null {
  if (value === undefined || value === null || value === '') {
    return { field: fieldName, message: `${fieldName} is required` };
  }
  return null;
}

function validateString(value: any, fieldName: string, options: {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
} = {}): ValidationError | null {
  if (typeof value !== 'string') {
    return { field: fieldName, message: `${fieldName} must be a string` };
  }

  if (options.minLength && value.length < options.minLength) {
    return { field: fieldName, message: `${fieldName} must be at least ${options.minLength} characters` };
  }

  if (options.maxLength && value.length > options.maxLength) {
    return { field: fieldName, message: `${fieldName} must be at most ${options.maxLength} characters` };
  }

  if (options.pattern && !options.pattern.test(value)) {
    return { field: fieldName, message: `${fieldName} has invalid format` };
  }

  return null;
}

function validateUUID(value: any, fieldName: string): ValidationError | null {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    return { field: fieldName, message: `${fieldName} must be a valid UUID` };
  }
  return null;
}

function validateEnum<T extends string>(
  value: any,
  fieldName: string,
  validValues: T[]
): ValidationError | null {
  if (!validValues.includes(value)) {
    return {
      field: fieldName,
      message: `${fieldName} must be one of: ${validValues.join(', ')}`
    };
  }
  return null;
}

function validateNumber(value: any, fieldName: string, options: {
  min?: number;
  max?: number;
  integer?: boolean;
} = {}): ValidationError | null {
  const num = typeof value === 'string' ? parseFloat(value) : value;

  if (typeof num !== 'number' || isNaN(num)) {
    return { field: fieldName, message: `${fieldName} must be a number` };
  }

  if (options.integer && !Number.isInteger(num)) {
    return { field: fieldName, message: `${fieldName} must be an integer` };
  }

  if (options.min !== undefined && num < options.min) {
    return { field: fieldName, message: `${fieldName} must be at least ${options.min}` };
  }

  if (options.max !== undefined && num > options.max) {
    return { field: fieldName, message: `${fieldName} must be at most ${options.max}` };
  }

  return null;
}

// ============================================================================
// SANITIZATION HELPERS
// ============================================================================

function sanitizeHtml(input: string): string {
  // Basic XSS prevention
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

function sanitizeForLog(input: string, maxLength: number = 100): string {
  // Truncate and sanitize for logging
  const truncated = input.length > maxLength
    ? input.substring(0, maxLength) + '...'
    : input;
  return truncated.replace(/[\r\n]/g, ' ');
}

// ============================================================================
// RESPONSE HELPERS
// ============================================================================

function successResponse(res: Response, data: any, statusCode: number = 200): void {
  res.status(statusCode).json({
    success: true,
    data,
    timestamp: new Date().toISOString()
  });
}

function errorResponse(
  res: Response,
  message: string,
  code: string,
  statusCode: number = 400,
  details?: any
): void {
  res.status(statusCode).json({
    success: false,
    error: message,
    code,
    details,
    timestamp: new Date().toISOString()
  });
}

function validationErrorResponse(res: Response, errors: ValidationError[]): void {
  res.status(400).json({
    success: false,
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    validationErrors: errors,
    timestamp: new Date().toISOString()
  });
}

// ============================================================================
// CONTROLLER CLASS
// ============================================================================

export class ChatController {

  // ==========================================================================
  // MESSAGE OPERATIONS
  // ==========================================================================

  /**
   * Send a new message to a group
   * POST /api/groups/:groupId/chat/messages
   */
  async sendMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId } = req.params;
      const {
        content,
        contentType = 'text',
        parentMessageId,
        metadata,
        clientMessageId
      } = req.body;

      // Validation
      const errors: ValidationError[] = [];

      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) errors.push(groupIdError);

      // Content is required unless attachments are provided
      if (!content && !req.body.attachments?.length) {
        errors.push({ field: 'content', message: 'content is required' });
      }

      if (content) {
        const contentError = validateString(content, 'content', {
          minLength: 1,
          maxLength: 10000
        });
        if (contentError) errors.push(contentError);
      }

      const validContentTypes = ['text', 'image', 'file', 'audio', 'video', 'system', 'reply'];
      const contentTypeError = validateEnum(contentType, 'contentType', validContentTypes as any);
      if (contentTypeError) errors.push(contentTypeError);

      if (parentMessageId) {
        const parentError = validateUUID(parentMessageId, 'parentMessageId');
        if (parentError) errors.push(parentError);
      }

      if (errors.length > 0) {
        validationErrorResponse(res, errors);
        return;
      }

      // Build input
      const input: SendMessageInput = {
        groupId,
        senderUserId: user.id,
        content: content || '',
        contentType,
        parentMessageId,
        metadata,
        clientMessageId: clientMessageId || crypto.randomUUID(),
      };

      // Send message
      const message = await chatMessageManager.sendMessage(input);

      console.log(`💬 Message sent by user ${user.id} in group ${groupId}`);

      successResponse(res, { message }, 201);

    } catch (error) {
      console.error('❌ Send message error:', getErrorMessage(error));

      if (getErrorMessage(error).includes('Rate limit')) {
        errorResponse(res, getErrorMessage(error), 'RATE_LIMIT_EXCEEDED', 429);
        return;
      }

      if (getErrorMessage(error).includes('Not a member')) {
        errorResponse(res, 'You are not a member of this group', 'FORBIDDEN', 403);
        return;
      }

      errorResponse(res, 'Failed to send message', 'SEND_FAILED', 500);
    }
  }

  /**
   * Get messages for a group
   * GET /api/groups/:groupId/chat/messages
   */
  async getMessages(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId } = req.params;
      const {
        limit,
        before,
        after,
        threadRootId,
        includeReactions,
        includeReadBy
      } = req.query;

      // Validation
      const errors: ValidationError[] = [];

      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) errors.push(groupIdError);

      if (limit) {
        const limitError = validateNumber(limit, 'limit', { min: 1, max: 100, integer: true });
        if (limitError) errors.push(limitError);
      }

      if (before) {
        const beforeError = validateUUID(before as string, 'before');
        if (beforeError) errors.push(beforeError);
      }

      if (after) {
        const afterError = validateUUID(after as string, 'after');
        if (afterError) errors.push(afterError);
      }

      if (threadRootId) {
        const threadError = validateUUID(threadRootId as string, 'threadRootId');
        if (threadError) errors.push(threadError);
      }

      if (errors.length > 0) {
        validationErrorResponse(res, errors);
        return;
      }

      // Build options
      const options: MessageQueryOptions = {
        limit: limit ? parseInt(limit as string, 10) : 50,
        before: before as string,
        after: after as string,
        threadRootId: threadRootId as string,
        includeReactions: includeReactions === 'true',
        includeReadBy: includeReadBy === 'true',
      };

      const result = await chatMessageManager.getMessages(groupId, user.id, options);

      successResponse(res, {
        messages: result.messages,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      });

    } catch (error) {
      console.error('❌ Get messages error:', getErrorMessage(error));

      if (getErrorMessage(error).includes('Not a member')) {
        errorResponse(res, 'You are not a member of this group', 'FORBIDDEN', 403);
        return;
      }

      errorResponse(res, 'Failed to get messages', 'GET_FAILED', 500);
    }
  }

  /**
   * Get a single message by ID
   * GET /api/groups/:groupId/chat/messages/:messageId
   */
  async getMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId, messageId } = req.params;

      // Validation
      const errors: ValidationError[] = [];

      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) errors.push(groupIdError);

      const messageIdError = validateUUID(messageId, 'messageId');
      if (messageIdError) errors.push(messageIdError);

      if (errors.length > 0) {
        validationErrorResponse(res, errors);
        return;
      }

      const message = await chatMessageManager.getMessageById(messageId, user.id);

      // Verify message belongs to the group
      if (message.groupId !== groupId) {
        errorResponse(res, 'Message not found in this group', 'NOT_FOUND', 404);
        return;
      }

      successResponse(res, { message });

    } catch (error) {
      console.error('❌ Get message error:', getErrorMessage(error));

      if (getErrorMessage(error).includes('not found')) {
        errorResponse(res, 'Message not found', 'NOT_FOUND', 404);
        return;
      }

      if (getErrorMessage(error).includes('Not a member')) {
        errorResponse(res, 'You are not a member of this group', 'FORBIDDEN', 403);
        return;
      }

      errorResponse(res, 'Failed to get message', 'GET_FAILED', 500);
    }
  }

  /**
   * Edit a message
   * PUT /api/groups/:groupId/chat/messages/:messageId
   */
  async editMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId, messageId } = req.params;
      const { content } = req.body;

      // Validation
      const errors: ValidationError[] = [];

      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) errors.push(groupIdError);

      const messageIdError = validateUUID(messageId, 'messageId');
      if (messageIdError) errors.push(messageIdError);

      const contentError = validateString(content, 'content', {
        minLength: 1,
        maxLength: 10000
      });
      if (contentError) errors.push(contentError);

      if (errors.length > 0) {
        validationErrorResponse(res, errors);
        return;
      }

      const message = await chatMessageManager.editMessage(messageId, user.id, content);

      console.log(`✏️ Message ${messageId} edited by user ${user.id}`);

      successResponse(res, { message });

    } catch (error) {
      console.error('❌ Edit message error:', getErrorMessage(error));

      if (getErrorMessage(error).includes('not found')) {
        errorResponse(res, 'Message not found', 'NOT_FOUND', 404);
        return;
      }

      if (getErrorMessage(error).includes('only edit your own')) {
        errorResponse(res, 'You can only edit your own messages', 'FORBIDDEN', 403);
        return;
      }

      errorResponse(res, 'Failed to edit message', 'EDIT_FAILED', 500);
    }
  }

  /**
   * Delete a message
   * DELETE /api/groups/:groupId/chat/messages/:messageId
   */
  async deleteMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId, messageId } = req.params;

      // Validation
      const errors: ValidationError[] = [];

      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) errors.push(groupIdError);

      const messageIdError = validateUUID(messageId, 'messageId');
      if (messageIdError) errors.push(messageIdError);

      if (errors.length > 0) {
        validationErrorResponse(res, errors);
        return;
      }

      await chatMessageManager.deleteMessage(messageId, user.id);

      console.log(`🗑️ Message ${messageId} deleted by user ${user.id}`);

      successResponse(res, {
        deleted: true,
        messageId
      });

    } catch (error) {
      console.error('❌ Delete message error:', getErrorMessage(error));

      if (getErrorMessage(error).includes('not found')) {
        errorResponse(res, 'Message not found', 'NOT_FOUND', 404);
        return;
      }

      if (getErrorMessage(error).includes('permissions')) {
        errorResponse(res, 'Insufficient permissions to delete this message', 'FORBIDDEN', 403);
        return;
      }

      errorResponse(res, 'Failed to delete message', 'DELETE_FAILED', 500);
    }
  }

  // ==========================================================================
  // REACTIONS
  // ==========================================================================

  /**
   * Add a reaction to a message
   * POST /api/groups/:groupId/chat/messages/:messageId/reactions
   */
  async addReaction(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId, messageId } = req.params;
      const { emoji } = req.body;

      // Validation
      const errors: ValidationError[] = [];

      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) errors.push(groupIdError);

      const messageIdError = validateUUID(messageId, 'messageId');
      if (messageIdError) errors.push(messageIdError);

      const emojiError = validateString(emoji, 'emoji', { minLength: 1, maxLength: 32 });
      if (emojiError) errors.push(emojiError);

      if (errors.length > 0) {
        validationErrorResponse(res, errors);
        return;
      }

      const reactions = await chatMessageManager.addReaction(messageId, user.id, emoji);

      successResponse(res, { reactions });

    } catch (error) {
      console.error('❌ Add reaction error:', getErrorMessage(error));

      if (getErrorMessage(error).includes('not found')) {
        errorResponse(res, 'Message not found', 'NOT_FOUND', 404);
        return;
      }

      if (getErrorMessage(error).includes('Not a member')) {
        errorResponse(res, 'You are not a member of this group', 'FORBIDDEN', 403);
        return;
      }

      errorResponse(res, 'Failed to add reaction', 'REACTION_FAILED', 500);
    }
  }

  /**
   * Remove a reaction from a message
   * DELETE /api/groups/:groupId/chat/messages/:messageId/reactions/:emoji
   */
  async removeReaction(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId, messageId, emoji } = req.params;

      // Validation
      const errors: ValidationError[] = [];

      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) errors.push(groupIdError);

      const messageIdError = validateUUID(messageId, 'messageId');
      if (messageIdError) errors.push(messageIdError);

      if (!emoji) {
        errors.push({ field: 'emoji', message: 'emoji is required' });
      }

      if (errors.length > 0) {
        validationErrorResponse(res, errors);
        return;
      }

      const reactions = await chatMessageManager.removeReaction(
        messageId,
        user.id,
        decodeURIComponent(emoji)
      );

      successResponse(res, { reactions });

    } catch (error) {
      console.error('❌ Remove reaction error:', getErrorMessage(error));

      if (getErrorMessage(error).includes('not found')) {
        errorResponse(res, 'Message not found', 'NOT_FOUND', 404);
        return;
      }

      errorResponse(res, 'Failed to remove reaction', 'REACTION_FAILED', 500);
    }
  }

  /**
   * Get reactions for a message
   * GET /api/groups/:groupId/chat/messages/:messageId/reactions
   */
  async getReactions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId, messageId } = req.params;

      // Validation
      const errors: ValidationError[] = [];

      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) errors.push(groupIdError);

      const messageIdError = validateUUID(messageId, 'messageId');
      if (messageIdError) errors.push(messageIdError);

      if (errors.length > 0) {
        validationErrorResponse(res, errors);
        return;
      }

      const reactions = await chatMessageManager.getMessageReactions(messageId, user.id);

      successResponse(res, { reactions });

    } catch (error) {
      console.error('❌ Get reactions error:', getErrorMessage(error));
      errorResponse(res, 'Failed to get reactions', 'GET_FAILED', 500);
    }
  }

  // ==========================================================================
  // READ RECEIPTS
  // ==========================================================================

  /**
   * Mark messages as read
   * POST /api/groups/:groupId/chat/read
   */
  async markAsRead(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId } = req.params;
      const { messageId } = req.body;

      // Validation
      const errors: ValidationError[] = [];

      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) errors.push(groupIdError);

      const messageIdError = validateUUID(messageId, 'messageId');
      if (messageIdError) errors.push(messageIdError);

      if (errors.length > 0) {
        validationErrorResponse(res, errors);
        return;
      }

      await chatMessageManager.markAsRead(groupId, user.id, messageId);

      successResponse(res, {
        marked: true,
        upToMessageId: messageId
      });

    } catch (error) {
      console.error('❌ Mark as read error:', getErrorMessage(error));
      errorResponse(res, 'Failed to mark as read', 'MARK_READ_FAILED', 500);
    }
  }

  /**
   * Get unread count for a group
   * GET /api/groups/:groupId/chat/unread
   */
  async getUnreadCount(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId } = req.params;

      // Validation
      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) {
        validationErrorResponse(res, [groupIdError]);
        return;
      }

      const count = await chatMessageManager.getUnreadCount(groupId, user.id);

      successResponse(res, {
        groupId,
        unreadCount: count
      });

    } catch (error) {
      console.error('❌ Get unread count error:', getErrorMessage(error));
      errorResponse(res, 'Failed to get unread count', 'GET_FAILED', 500);
    }
  }

  // ==========================================================================
  // TYPING INDICATORS
  // ==========================================================================

  /**
   * Set typing status
   * POST /api/groups/:groupId/chat/typing
   */
  async setTypingStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId } = req.params;
      const { isTyping } = req.body;

      // Validation
      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) {
        validationErrorResponse(res, [groupIdError]);
        return;
      }

      await chatMessageManager.setTypingStatus(groupId, user.id, isTyping === true);

      successResponse(res, {
        groupId,
        isTyping: isTyping === true
      });

    } catch (error) {
      console.error('❌ Set typing status error:', getErrorMessage(error));
      // Don't return error for typing - it's non-critical
      successResponse(res, { groupId: req.params.groupId, isTyping: false });
    }
  }

  /**
   * Get typing users in a group
   * GET /api/groups/:groupId/chat/typing
   */
  async getTypingUsers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId } = req.params;

      // Validation
      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) {
        validationErrorResponse(res, [groupIdError]);
        return;
      }

      const typingUsers = await chatMessageManager.getTypingUsers(groupId);

      successResponse(res, { typingUsers });

    } catch (error) {
      console.error('❌ Get typing users error:', getErrorMessage(error));
      successResponse(res, { typingUsers: [] });
    }
  }

  // ==========================================================================
  // PRESENCE
  // ==========================================================================

  /**
   * Update presence status
   * POST /api/groups/:groupId/chat/presence
   */
  async updatePresence(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId } = req.params;
      const { status, deviceType } = req.body;

      // Validation
      const errors: ValidationError[] = [];

      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) errors.push(groupIdError);

      const validStatuses = ['online', 'away', 'busy', 'offline'];
      const statusError = validateEnum(status, 'status', validStatuses as any);
      if (statusError) errors.push(statusError);

      if (errors.length > 0) {
        validationErrorResponse(res, errors);
        return;
      }

      await chatMessageManager.updatePresence(groupId, user.id, status, deviceType);

      successResponse(res, {
        groupId,
        status,
        deviceType
      });

    } catch (error) {
      console.error('❌ Update presence error:', getErrorMessage(error));
      errorResponse(res, 'Failed to update presence', 'PRESENCE_FAILED', 500);
    }
  }

  /**
   * Get presence for all users in a group
   * GET /api/groups/:groupId/chat/presence
   */
  async getGroupPresence(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId } = req.params;

      // Validation
      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) {
        validationErrorResponse(res, [groupIdError]);
        return;
      }

      const presence = await chatMessageManager.getGroupPresence(groupId);

      successResponse(res, { presence });

    } catch (error) {
      console.error('❌ Get presence error:', getErrorMessage(error));
      errorResponse(res, 'Failed to get presence', 'GET_FAILED', 500);
    }
  }

  // ==========================================================================
  // PINNED MESSAGES
  // ==========================================================================

  /**
   * Pin a message
   * POST /api/groups/:groupId/chat/messages/:messageId/pin
   */
  async pinMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId, messageId } = req.params;
      const { note } = req.body;

      // Validation
      const errors: ValidationError[] = [];

      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) errors.push(groupIdError);

      const messageIdError = validateUUID(messageId, 'messageId');
      if (messageIdError) errors.push(messageIdError);

      if (errors.length > 0) {
        validationErrorResponse(res, errors);
        return;
      }

      await chatMessageManager.pinMessage(messageId, user.id, note);

      console.log(`📌 Message ${messageId} pinned by user ${user.id}`);

      successResponse(res, {
        pinned: true,
        messageId
      });

    } catch (error) {
      console.error('❌ Pin message error:', getErrorMessage(error));

      if (getErrorMessage(error).includes('not found')) {
        errorResponse(res, 'Message not found', 'NOT_FOUND', 404);
        return;
      }

      if (getErrorMessage(error).includes('Only admins')) {
        errorResponse(res, 'Only admins can pin messages', 'FORBIDDEN', 403);
        return;
      }

      errorResponse(res, 'Failed to pin message', 'PIN_FAILED', 500);
    }
  }

  /**
   * Unpin a message
   * DELETE /api/groups/:groupId/chat/messages/:messageId/pin
   */
  async unpinMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId, messageId } = req.params;

      // Validation
      const errors: ValidationError[] = [];

      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) errors.push(groupIdError);

      const messageIdError = validateUUID(messageId, 'messageId');
      if (messageIdError) errors.push(messageIdError);

      if (errors.length > 0) {
        validationErrorResponse(res, errors);
        return;
      }

      await chatMessageManager.unpinMessage(messageId, user.id);

      console.log(`📌 Message ${messageId} unpinned by user ${user.id}`);

      successResponse(res, {
        unpinned: true,
        messageId
      });

    } catch (error) {
      console.error('❌ Unpin message error:', getErrorMessage(error));

      if (getErrorMessage(error).includes('not pinned')) {
        errorResponse(res, 'Message is not pinned', 'NOT_FOUND', 404);
        return;
      }

      if (getErrorMessage(error).includes('Only admins')) {
        errorResponse(res, 'Only admins can unpin messages', 'FORBIDDEN', 403);
        return;
      }

      errorResponse(res, 'Failed to unpin message', 'UNPIN_FAILED', 500);
    }
  }

  /**
   * Get pinned messages for a group
   * GET /api/groups/:groupId/chat/pinned
   */
  async getPinnedMessages(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId } = req.params;

      // Validation
      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) {
        validationErrorResponse(res, [groupIdError]);
        return;
      }

      const messages = await chatMessageManager.getPinnedMessages(groupId, user.id);

      successResponse(res, {
        pinnedMessages: messages,
        count: messages.length
      });

    } catch (error) {
      console.error('❌ Get pinned messages error:', getErrorMessage(error));

      if (getErrorMessage(error).includes('Not a member')) {
        errorResponse(res, 'You are not a member of this group', 'FORBIDDEN', 403);
        return;
      }

      errorResponse(res, 'Failed to get pinned messages', 'GET_FAILED', 500);
    }
  }

  // ==========================================================================
  // SEARCH
  // ==========================================================================

  /**
   * Search messages in a group
   * GET /api/groups/:groupId/chat/search
   */
  async searchMessages(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        errorResponse(res, 'Authentication required', 'UNAUTHORIZED', 401);
        return;
      }

      const { groupId } = req.params;
      const { q: query, limit, offset } = req.query;

      // Validation
      const errors: ValidationError[] = [];

      const groupIdError = validateUUID(groupId, 'groupId');
      if (groupIdError) errors.push(groupIdError);

      if (!query || typeof query !== 'string' || query.length < 2) {
        errors.push({ field: 'q', message: 'Search query must be at least 2 characters' });
      }

      if (limit) {
        const limitError = validateNumber(limit, 'limit', { min: 1, max: 50, integer: true });
        if (limitError) errors.push(limitError);
      }

      if (offset) {
        const offsetError = validateNumber(offset, 'offset', { min: 0, integer: true });
        if (offsetError) errors.push(offsetError);
      }

      if (errors.length > 0) {
        validationErrorResponse(res, errors);
        return;
      }

      const messages = await chatMessageManager.searchMessages(
        groupId,
        user.id,
        query as string,
        {
          limit: limit ? parseInt(limit as string, 10) : undefined,
          offset: offset ? parseInt(offset as string, 10) : undefined,
        }
      );

      successResponse(res, {
        messages,
        query,
        count: messages.length
      });

    } catch (error) {
      console.error('❌ Search messages error:', getErrorMessage(error));

      if (getErrorMessage(error).includes('Not a member')) {
        errorResponse(res, 'You are not a member of this group', 'FORBIDDEN', 403);
        return;
      }

      errorResponse(res, 'Failed to search messages', 'SEARCH_FAILED', 500);
    }
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const chatController = new ChatController();
