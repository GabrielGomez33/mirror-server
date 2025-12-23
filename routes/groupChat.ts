// ============================================================================
// GROUP CHAT API ROUTES - MirrorGroups Phase 5
// ============================================================================
// RESTful endpoints for group chat functionality:
// - Message CRUD with encryption
// - Reactions and read receipts
// - Typing indicators and presence
// - Pinned messages
// - Search functionality
// ============================================================================

import express, { RequestHandler } from 'express';
import AuthMiddleware, { SecurityLevel } from '../middleware/authMiddleware';
import { chatController, AuthenticatedRequest } from '../controllers/chatController';

const router = express.Router();

// ============================================================================
// MIDDLEWARE SETUP
// ============================================================================

// All chat routes require authentication
const verified = AuthMiddleware.verifyToken as unknown as RequestHandler;
const basicSecurity = AuthMiddleware.requireSecurityLevel(SecurityLevel.BASIC) as unknown as RequestHandler;

// ============================================================================
// MESSAGE ROUTES
// ============================================================================

/**
 * POST /api/groups/:groupId/chat/messages
 * Send a new message to a group
 *
 * Body:
 * - content: string (required) - Message content
 * - contentType: string (optional) - 'text' | 'image' | 'file' | 'audio' | 'video' | 'reply'
 * - parentMessageId: string (optional) - For reply threads
 * - metadata: object (optional) - Custom metadata (mentions, links, etc.)
 * - clientMessageId: string (optional) - Client-side deduplication ID
 *
 * Response:
 * - message: ChatMessage object
 */
router.post('/:groupId/chat/messages', verified, basicSecurity, (async (req, res) => {
  await chatController.sendMessage(req as AuthenticatedRequest, res);
}) as RequestHandler);

/**
 * GET /api/groups/:groupId/chat/messages
 * Get messages for a group with cursor-based pagination
 *
 * Query params:
 * - limit: number (optional, default 50, max 100)
 * - before: string (optional) - Message ID cursor for older messages
 * - after: string (optional) - Message ID cursor for newer messages
 * - threadRootId: string (optional) - Get replies to a thread
 * - includeReactions: boolean (optional) - Include reaction data
 * - includeReadBy: boolean (optional) - Include read receipt data
 *
 * Response:
 * - messages: ChatMessage[]
 * - hasMore: boolean
 * - nextCursor: string (optional)
 */
router.get('/:groupId/chat/messages', verified, (async (req, res) => {
  await chatController.getMessages(req as AuthenticatedRequest, res);
}) as RequestHandler);

/**
 * GET /api/groups/:groupId/chat/messages/:messageId
 * Get a single message by ID
 *
 * Response:
 * - message: ChatMessage object with reactions and readBy
 */
router.get('/:groupId/chat/messages/:messageId', verified, (async (req, res) => {
  await chatController.getMessage(req as AuthenticatedRequest, res);
}) as RequestHandler);

/**
 * PUT /api/groups/:groupId/chat/messages/:messageId
 * Edit a message (only sender can edit)
 *
 * Body:
 * - content: string (required) - New message content
 *
 * Response:
 * - message: Updated ChatMessage object
 */
router.put('/:groupId/chat/messages/:messageId', verified, (async (req, res) => {
  await chatController.editMessage(req as AuthenticatedRequest, res);
}) as RequestHandler);

/**
 * DELETE /api/groups/:groupId/chat/messages/:messageId
 * Delete a message (sender or admin can delete)
 *
 * Response:
 * - deleted: boolean
 * - messageId: string
 */
router.delete('/:groupId/chat/messages/:messageId', verified, (async (req, res) => {
  await chatController.deleteMessage(req as AuthenticatedRequest, res);
}) as RequestHandler);

// ============================================================================
// REACTION ROUTES
// ============================================================================

/**
 * POST /api/groups/:groupId/chat/messages/:messageId/reactions
 * Add a reaction to a message
 *
 * Body:
 * - emoji: string (required) - Unicode emoji or custom emoji code
 *
 * Response:
 * - reactions: ReactionSummary[] - Updated reaction counts
 */
router.post('/:groupId/chat/messages/:messageId/reactions', verified, (async (req, res) => {
  await chatController.addReaction(req as AuthenticatedRequest, res);
}) as RequestHandler);

/**
 * DELETE /api/groups/:groupId/chat/messages/:messageId/reactions/:emoji
 * Remove a reaction from a message
 *
 * Response:
 * - reactions: ReactionSummary[] - Updated reaction counts
 */
router.delete('/:groupId/chat/messages/:messageId/reactions/:emoji', verified, (async (req, res) => {
  await chatController.removeReaction(req as AuthenticatedRequest, res);
}) as RequestHandler);

/**
 * GET /api/groups/:groupId/chat/messages/:messageId/reactions
 * Get reactions for a message
 *
 * Response:
 * - reactions: ReactionSummary[]
 */
router.get('/:groupId/chat/messages/:messageId/reactions', verified, (async (req, res) => {
  await chatController.getReactions(req as AuthenticatedRequest, res);
}) as RequestHandler);

// ============================================================================
// READ RECEIPT ROUTES
// ============================================================================

/**
 * POST /api/groups/:groupId/chat/read
 * Mark messages as read up to a specific message
 *
 * Body:
 * - messageId: string (required) - Mark all messages up to this one as read
 *
 * Response:
 * - marked: boolean
 * - upToMessageId: string
 */
router.post('/:groupId/chat/read', verified, (async (req, res) => {
  await chatController.markAsRead(req as AuthenticatedRequest, res);
}) as RequestHandler);

/**
 * GET /api/groups/:groupId/chat/unread
 * Get unread message count for the current user
 *
 * Response:
 * - groupId: string
 * - unreadCount: number
 */
router.get('/:groupId/chat/unread', verified, (async (req, res) => {
  await chatController.getUnreadCount(req as AuthenticatedRequest, res);
}) as RequestHandler);

// ============================================================================
// TYPING INDICATOR ROUTES
// ============================================================================

/**
 * POST /api/groups/:groupId/chat/typing
 * Set typing status (prefer WebSocket for real-time)
 *
 * Body:
 * - isTyping: boolean (required)
 *
 * Response:
 * - groupId: string
 * - isTyping: boolean
 */
router.post('/:groupId/chat/typing', verified, (async (req, res) => {
  await chatController.setTypingStatus(req as AuthenticatedRequest, res);
}) as RequestHandler);

/**
 * GET /api/groups/:groupId/chat/typing
 * Get currently typing users
 *
 * Response:
 * - typingUsers: TypingIndicator[]
 */
router.get('/:groupId/chat/typing', verified, (async (req, res) => {
  await chatController.getTypingUsers(req as AuthenticatedRequest, res);
}) as RequestHandler);

// ============================================================================
// PRESENCE ROUTES
// ============================================================================

/**
 * POST /api/groups/:groupId/chat/presence
 * Update presence status (prefer WebSocket for real-time)
 *
 * Body:
 * - status: 'online' | 'away' | 'busy' | 'offline'
 * - deviceType: string (optional)
 *
 * Response:
 * - groupId: string
 * - status: string
 */
router.post('/:groupId/chat/presence', verified, (async (req, res) => {
  await chatController.updatePresence(req as AuthenticatedRequest, res);
}) as RequestHandler);

/**
 * GET /api/groups/:groupId/chat/presence
 * Get presence status for all group members
 *
 * Response:
 * - presence: PresenceStatus[]
 */
router.get('/:groupId/chat/presence', verified, (async (req, res) => {
  await chatController.getGroupPresence(req as AuthenticatedRequest, res);
}) as RequestHandler);

// ============================================================================
// PINNED MESSAGES ROUTES
// ============================================================================

/**
 * POST /api/groups/:groupId/chat/messages/:messageId/pin
 * Pin a message (admin only)
 *
 * Body:
 * - note: string (optional) - Note about why message is pinned
 *
 * Response:
 * - pinned: boolean
 * - messageId: string
 */
router.post('/:groupId/chat/messages/:messageId/pin', verified, (async (req, res) => {
  await chatController.pinMessage(req as AuthenticatedRequest, res);
}) as RequestHandler);

/**
 * DELETE /api/groups/:groupId/chat/messages/:messageId/pin
 * Unpin a message (admin only)
 *
 * Response:
 * - unpinned: boolean
 * - messageId: string
 */
router.delete('/:groupId/chat/messages/:messageId/pin', verified, (async (req, res) => {
  await chatController.unpinMessage(req as AuthenticatedRequest, res);
}) as RequestHandler);

/**
 * GET /api/groups/:groupId/chat/pinned
 * Get all pinned messages for a group
 *
 * Response:
 * - pinnedMessages: ChatMessage[]
 * - count: number
 */
router.get('/:groupId/chat/pinned', verified, (async (req, res) => {
  await chatController.getPinnedMessages(req as AuthenticatedRequest, res);
}) as RequestHandler);

// ============================================================================
// SEARCH ROUTES
// ============================================================================

/**
 * GET /api/groups/:groupId/chat/search
 * Search messages in a group
 *
 * Query params:
 * - q: string (required) - Search query (min 2 chars)
 * - limit: number (optional, default 20, max 50)
 * - offset: number (optional, default 0)
 *
 * Response:
 * - messages: ChatMessage[]
 * - query: string
 * - count: number
 */
router.get('/:groupId/chat/search', verified, (async (req, res) => {
  await chatController.searchMessages(req as AuthenticatedRequest, res);
}) as RequestHandler);

// ============================================================================
// EXPORT
// ============================================================================

export default router;

