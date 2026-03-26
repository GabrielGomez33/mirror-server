// mirror-server/systems/mirrorGroupNotifications.ts
/**
 * MIRROR NOTIFICATION SYSTEM
 *
 * Handles all Mirror notifications:
 * - Group invitations
 * - Peer reviews
 * - Video call notifications
 * - Member activity alerts
 * - Admin role changes
 * - Analysis completion events
 * - TruthStream events (reviews, classifications, analysis, dialogue, queue, milestones)
 *
 * Delivery channels:
 * - WebSocket (real-time in-app)
 * - Push notifications (placeholder for future)
 *
 * CHANGES:
 * - Added 'analysis_completed' to GroupNotificationType union and validTypes
 * - Added 'analysis_completed' template in TEMPLATES
 * - Added sendDirectWebSocketMessage() for raw WebSocket sends (preserves event type)
 * - Added notifyAnalysisCompleted() for sending to group members
 * - Added TruthStream notification types and convenience methods
 */

import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { mirrorRedis, NotificationQueue } from '../config/redis';

// ============================================================================
// ERROR HANDLING UTILITIES
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
// TYPE GUARDS
// ============================================================================

function isValidGroupNotificationType(type: any): type is GroupNotificationType {
  const validTypes: GroupNotificationType[] = [
    'group_invite',
    'member_joined',
    'member_left',
    'peer_review_received',
    'compatibility_updated',
    'video_call_started',
    'admin_promoted',
    'admin_demoted',
    'drawing_session_started',
    // Phase 4: Voting & Conversation Intelligence
    'vote_proposed',
    'vote_completed',
    'conversation_insight',
    'conversation_summary',
    // Phase 5: Chat Infrastructure
    'chat_message',
    'chat_message_edited',
    'chat_message_deleted',
    'chat_typing',
    'chat_presence',
    'chat_reactions_updated',
    'chat_message_read',
    'chat_mention',
    //Dina processing status
    'dina_processing_started',
    // Phase 6: Analysis completion
    'analysis_completed',
    // TruthStream
    'ts_review_received',
    'ts_review_classified',
    'ts_analysis_complete',
    'ts_dialogue_message',
    'ts_queue_assigned',
    'ts_milestone_earned',
  ];
  return typeof type === 'string' && validTypes.includes(type as GroupNotificationType);
}

// ============================================================================
// TYPES
// ============================================================================

interface GroupMember {
  userId: string;
  userName: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
}

interface NotificationContent {
  title: string;
  message: string;
  actionUrl?: string;
  actionText?: string;
  imageUrl?: string;
  metadata?: any;
}

interface NotificationDelivery {
  userId: string;
  type: GroupNotificationType;
  content: NotificationContent;
  priority: 'immediate' | 'normal' | 'low';
  channels: ('websocket' | 'push' | 'email')[];
  groupId?: string;
  createdAt: Date;
  expiresAt?: Date;
}

export type GroupNotificationType =
  | 'group_invite'
  | 'member_joined'
  | 'member_left'
  | 'peer_review_received'
  | 'compatibility_updated'
  | 'video_call_started'
  | 'admin_promoted'
  | 'admin_demoted'
  | 'drawing_session_started'
  // Phase 4: Voting & Conversation Intelligence
  | 'vote_proposed'
  | 'vote_completed'
  | 'conversation_insight'
  | 'conversation_summary'
  // Phase 5: Chat Infrastructure
  | 'chat_message'
  | 'chat_message_edited'
  | 'chat_message_deleted'
  | 'chat_typing'
  | 'chat_presence'
  | 'chat_reactions_updated'
  | 'chat_message_read'
  | 'chat_mention'
  |	'dina_processing_started'
  // Phase 6: Analysis completion
  | 'analysis_completed'
  // TruthStream
  | 'ts_review_received'
  | 'ts_review_classified'
  | 'ts_analysis_complete'
  | 'ts_dialogue_message'
  | 'ts_queue_assigned'
  | 'ts_milestone_earned';

// ============================================================================
// TYPE ALIASES
// ============================================================================

// Validated notification queue item with proper GroupNotificationType
type ValidatedNotificationQueue = NotificationQueue & { type: GroupNotificationType };

// ============================================================================
// NOTIFICATION SYSTEM CLASS
// ============================================================================

export class MirrorGroupNotificationSystem extends EventEmitter {
  private initialized: boolean = false;
  private activeConnections: Map<string, WebSocket> = new Map();

  // Notification templates
  private readonly TEMPLATES: Record<GroupNotificationType, {
    title: (data: any) => string;
    message: (data: any) => string;
    priority: 'immediate' | 'normal' | 'low';
    channels: ('websocket' | 'push' | 'email')[];
  }> = {
    group_invite: {
      title: (data) => `Group Invitation: ${data.groupName}`,
      message: (data) => `${data.inviterName} invited you to join "${data.groupName}"`,
      priority: 'normal',
      channels: ['websocket', 'push', 'email']
    },
    member_joined: {
      title: (data) => `New Member: ${data.groupName}`,
      message: (data) => `${data.memberName} joined your group "${data.groupName}"`,
      priority: 'normal',
      channels: ['websocket', 'push']
    },
    member_left: {
      title: (data) => `Member Left: ${data.groupName}`,
      message: (data) => `${data.memberName} left your group "${data.groupName}"`,
      priority: 'low',
      channels: ['websocket']
    },
    peer_review_received: {
      title: (data) => `New Peer Review`,
      message: (data) => `${data.reviewerName} left you a review in "${data.groupName}"`,
      priority: 'normal',
      channels: ['websocket', 'push']
    },
    compatibility_updated: {
      title: (data) => `Compatibility Analysis Updated`,
      message: (data) => `New insights available for "${data.groupName}" with ${data.memberCount} members`,
      priority: 'low',
      channels: ['websocket']
    },
    video_call_started: {
      title: (data) => `Video Call Started: ${data.groupName}`,
      message: (data) => `${data.initiatorName} started a video call in "${data.groupName}"`,
      priority: 'immediate',
      channels: ['websocket', 'push']
    },
    admin_promoted: {
      title: (data) => `Admin Role Granted`,
      message: (data) => `You're now an admin of "${data.groupName}"`,
      priority: 'normal',
      channels: ['websocket', 'push']
    },
    admin_demoted: {
      title: (data) => `Admin Role Removed`,
      message: (data) => `Your admin role in "${data.groupName}" was removed`,
      priority: 'normal',
      channels: ['websocket']
    },
    drawing_session_started: {
      title: (data) => `Drawing Session: ${data.groupName}`,
      message: (data) => `${data.initiatorName} started a drawing session in "${data.groupName}"`,
      priority: 'normal',
      channels: ['websocket', 'push']
    },
    // Phase 4: Voting & Conversation Intelligence
    vote_proposed: {
      title: (data) => `New Vote: ${data.topic || 'Group Vote'}`,
      message: (data) => `${data.proposer?.username || 'Someone'} started a vote: "${data.topic}"`,
      priority: 'immediate',
      channels: ['websocket', 'push']
    },
    vote_completed: {
      title: (data) => `Vote Completed: ${data.topic || 'Group Vote'}`,
      message: (data) => `The vote "${data.topic}" has ended. View the results!`,
      priority: 'normal',
      channels: ['websocket', 'push']
    },
    conversation_insight: {
      title: (data) => `AI Insight Available`,
      message: (data) => `New conversation analysis ready for your session`,
      priority: 'normal',
      channels: ['websocket']
    },
    conversation_summary: {
      title: (data) => `Session Summary Ready`,
      message: (data) => `Your session summary has been generated`,
      priority: 'normal',
      channels: ['websocket', 'push']
    },
    // Phase 5: Chat Infrastructure
    chat_message: {
      title: (data) => `New Message in ${data.groupName || 'Group'}`,
      message: (data) => `${data.senderUsername || 'Someone'} sent a message`,
      priority: 'immediate',
      channels: ['websocket', 'push']
    },
    chat_message_edited: {
      title: (data) => `Message Edited`,
      message: (data) => `A message was edited in ${data.groupName || 'your group'}`,
      priority: 'low',
      channels: ['websocket']
    },
    chat_message_deleted: {
      title: (data) => `Message Deleted`,
      message: (data) => `A message was deleted in ${data.groupName || 'your group'}`,
      priority: 'low',
      channels: ['websocket']
    },
    chat_typing: {
      title: (data) => `Typing`,
      message: (data) => `${data.username || 'Someone'} is typing...`,
      priority: 'low',
      channels: ['websocket']
    },
    chat_presence: {
      title: (data) => `Status Update`,
      message: (data) => `${data.username || 'Someone'} is now ${data.status}`,
      priority: 'low',
      channels: ['websocket']
    },
    chat_reactions_updated: {
      title: (data) => `Reactions Updated`,
      message: (data) => `Reactions changed on a message`,
      priority: 'low',
      channels: ['websocket']
    },
    chat_message_read: {
      title: (data) => `Message Read`,
      message: (data) => `Your message was read`,
      priority: 'low',
      channels: ['websocket']
    },
    chat_mention: {
      title: (data) => `You were mentioned`,
      message: (data) => `${data.senderUsername || 'Someone'} mentioned you in ${data.groupName || 'a group'}`,
      priority: 'immediate',
      channels: ['websocket', 'push']
    },

    dina_processing_started: {
      title: (data) => `DINA`,
      message: (data) => `DINA: processing started`,
      priority: 'immediate',
      channels: ['websocket','push']
    },

    // Phase 6: Analysis completion
    analysis_completed: {
      title: (data) => `Analysis Complete`,
      message: (data) => `Group analysis is ready for "${data.groupName || 'your group'}"`,
      priority: 'immediate',
      channels: ['websocket']
    },

    // ========================================================================
    // TRUTHSTREAM
    // ========================================================================
    ts_review_received: {
      title: () => `New TruthStream Review`,
      message: () => `Someone just reviewed your Truth Card`,
      priority: 'immediate',
      channels: ['websocket', 'push']
    },
    ts_review_classified: {
      title: () => `Review Analyzed`,
      message: (data) => `Your review has been analyzed: ${data.classification || 'complete'}`,
      priority: 'normal',
      channels: ['websocket']
    },
    ts_analysis_complete: {
      title: () => `Truth Mirror Report Ready`,
      message: (data) => `Your ${data.analysisType === 'perception_gap' ? 'Perception Gap Analysis' : 'Truth Mirror Report'} is ready`,
      priority: 'immediate',
      channels: ['websocket', 'push']
    },
    ts_dialogue_message: {
      title: () => `New Anonymous Message`,
      message: (data) => `New message in your anonymous conversation (from ${data.authorRole || 'someone'})`,
      priority: 'immediate',
      channels: ['websocket', 'push']
    },
    ts_queue_assigned: {
      title: () => `New Review Queue`,
      message: (data) => `${data.itemCount || 'New'} profiles ready for review`,
      priority: 'normal',
      channels: ['websocket', 'push']
    },
    ts_milestone_earned: {
      title: () => `Milestone Earned!`,
      message: (data) => `You earned: ${data.milestoneName || 'a new milestone'}!`,
      priority: 'normal',
      channels: ['websocket', 'push']
    },
  };

  constructor() {
    super();
    console.log('📬 Initializing Mirror Group Notification System...');
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('✅ Mirror Group Notification System already initialized');
      return;
    }

    try {
      console.log('🔧 Setting up group notification delivery systems...');

      // Verify Redis connection
      if (!mirrorRedis.isConnected()) {
        console.warn('⚠️ Redis not connected, notifications may be limited');
      }

      // Setup notification processing intervals
      this.setupNotificationProcessing();

      this.initialized = true;
      console.log('✅ Mirror Group Notification System initialized successfully');

      this.emit('initialized');
    } catch (error) {
      logError('Failed to initialize Mirror Group Notification System', error);
      throw error;
    }
  }

  private setupNotificationProcessing(): void {
    // Process immediate notifications every 1 second
    setInterval(async () => {
      await this.processNotificationQueue('immediate');
    }, 1000);

    // Process normal notifications every 5 seconds
    setInterval(async () => {
      await this.processNotificationQueue('normal');
    }, 5000);

    // Process low priority notifications every 30 seconds
    setInterval(async () => {
      await this.processNotificationQueue('low');
    }, 30000);
  }

  private async processNotificationQueue(priority: 'immediate' | 'normal' | 'low'): Promise<void> {
    try {
      const queueLength = await mirrorRedis.getQueueLength(priority);
      if (queueLength === 0) return;

      for (let i = 0; i < Math.min(queueLength, 10); i++) { // Process max 10 per batch
        const rawNotification = await mirrorRedis.dequeueNotification(priority);
        if (rawNotification) {
          // ✅ Validate the dequeued notification has proper structure
          if (this.isValidNotificationQueueItem(rawNotification)) {
            await this.deliverNotification(rawNotification);
          } else {
            logError('Invalid notification structure from queue', new Error(`Invalid notification: ${JSON.stringify(rawNotification)}`));
          }
        }
      }
    } catch (error) {
      logError(`Error processing ${priority} notification queue`, error);
    }
  }

  // ✅ Type guard for notification queue items
  private isValidNotificationQueueItem(item: any): item is NotificationQueue & { type: GroupNotificationType } {
    return (
      typeof item === 'object' &&
      item !== null &&
      typeof item.id === 'string' &&
      (typeof item.userId === 'string' || typeof item.userId === 'number') && // Accept both string and number
      isValidGroupNotificationType(item.type) &&
      typeof item.content === 'object' &&
      typeof item.priority === 'string' &&
      ['immediate', 'normal', 'low'].includes(item.priority) &&
      typeof item.createdAt === 'number' &&
      typeof item.retryCount === 'number'
    );
  }

  // ============================================================================
  // WEBSOCKET CONNECTION MANAGEMENT
  // ============================================================================

  registerConnection(userId: string, ws: WebSocket): void {
    this.activeConnections.set(userId, ws);

    ws.on('close', () => {
      this.activeConnections.delete(userId);
    });

    ws.on('error', (error) => {
      logError(`WebSocket error for user ${userId}`, error);
      this.activeConnections.delete(userId);
    });

    console.log(`✅ Registered WebSocket connection for user ${userId}`);
  }

  unregisterConnection(userId: string): void {
    this.activeConnections.delete(userId);
    console.log(`🔌 Unregistered WebSocket connection for user ${userId}`);
  }

  // ============================================================================
  // GROUP NOTIFICATION METHODS
  // ============================================================================

  async notifyGroupInvite(data: {
    inviteeUserId: string;
    inviterName: string;
    groupId: string;
    groupName: string;
    inviteCode: string;
  }): Promise<boolean> {
    return this.sendNotification('group_invite', data.inviteeUserId, {
      inviterName: data.inviterName,
      groupName: data.groupName,
      groupId: data.groupId,
      inviteCode: data.inviteCode,
    });
  }

  async notifyMemberJoined(groupMembers: GroupMember[], newMember: {
    userId: string;
    userName: string;
  }, groupName: string): Promise<boolean[]> {
    const results: boolean[] = [];

    for (const member of groupMembers) {
      if (member.userId !== newMember.userId) { // Don't notify the new member
        const result = await this.sendNotification('member_joined', member.userId, {
          memberName: newMember.userName,
          groupName: groupName,
        });
        results.push(result);
      }
    }

    return results;
  }

  async notifyMemberLeft(groupMembers: GroupMember[], leftMember: {
    userId: string;
    userName: string;
  }, groupName: string): Promise<boolean[]> {
    const results: boolean[] = [];

    for (const member of groupMembers) {
      const result = await this.sendNotification('member_left', member.userId, {
        memberName: leftMember.userName,
        groupName: groupName,
      });
      results.push(result);
    }

    return results;
  }

  async notifyPeerReview(data: {
    revieweeUserId: string;
    reviewerName: string;
    groupId: string;
    groupName: string;
    reviewType: 'strength' | 'improvement';
    reviewText: string;
  }): Promise<boolean> {
    return this.sendNotification('peer_review_received', data.revieweeUserId, {
      reviewerName: data.reviewerName,
      groupName: data.groupName,
      reviewType: data.reviewType,
      preview: data.reviewText.substring(0, 100) + (data.reviewText.length > 100 ? '...' : ''),
    });
  }

  async notifyCompatibilityUpdated(groupMembers: GroupMember[], groupName: string): Promise<boolean[]> {
    const results: boolean[] = [];

    for (const member of groupMembers) {
      const result = await this.sendNotification('compatibility_updated', member.userId, {
        groupName: groupName,
        memberCount: groupMembers.length,
      });
      results.push(result);
    }

    return results;
  }

  async notifyVideoCallStarted(groupMembers: GroupMember[], initiator: {
    userId: string;
    userName: string;
  }, groupName: string, sessionId: string): Promise<boolean[]> {
    const results: boolean[] = [];

    for (const member of groupMembers) {
      if (member.userId !== initiator.userId) { // Don't notify the initiator
        const result = await this.sendNotification('video_call_started', member.userId, {
          initiatorName: initiator.userName,
          groupName: groupName,
          sessionId: sessionId,
          joinUrl: `/groups/${member.userId}/video/${sessionId}`,
        });
        results.push(result);
      }
    }

    return results;
  }

  async notifyAdminPromoted(data: {
    userId: string;
    groupName: string;
    promotedBy: string;
  }): Promise<boolean> {
    return this.sendNotification('admin_promoted', data.userId, {
      groupName: data.groupName,
      promotedBy: data.promotedBy,
    });
  }

  async notifyAdminDemoted(data: {
    userId: string;
    groupName: string;
    demotedBy: string;
  }): Promise<boolean> {
    return this.sendNotification('admin_demoted', data.userId, {
      groupName: data.groupName,
      demotedBy: data.demotedBy,
    });
  }

  async notifyDrawingSessionStarted(groupMembers: GroupMember[], initiator: {
    userId: string;
    userName: string;
  }, groupName: string, sessionId: string): Promise<boolean[]> {
    const results: boolean[] = [];

    for (const member of groupMembers) {
      if (member.userId !== initiator.userId) { // Don't notify the initiator
        const result = await this.sendNotification('drawing_session_started', member.userId, {
          initiatorName: initiator.userName,
          groupName: groupName,
          sessionId: sessionId,
          joinUrl: `/groups/${member.userId}/drawing/${sessionId}`,
        });
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Notify all group members that analysis has completed.
   * Sends direct 'analysis:completed' WebSocket messages (not wrapped as 'group_notification')
   * so the client's EventHandlers can receive them with the correct event type.
   */
  async notifyAnalysisCompleted(
    groupMembers: GroupMember[],
    data: {
      groupId: string;
      groupName: string;
      analysisId: string;
    }
  ): Promise<boolean[]> {
    const results: boolean[] = [];

    const wsMessage = JSON.stringify({
      type: 'analysis:completed',
      payload: {
        groupId: data.groupId,
        analysisId: data.analysisId,
        status: 'completed',
        timestamp: new Date().toISOString()
      }
    });

    for (const member of groupMembers) {
      const result = await this.sendDirectWebSocketMessage(member.userId, wsMessage);
      results.push(result);
    }

    return results;
  }

  // ============================================================================
  // TRUTHSTREAM NOTIFICATION METHODS
  // ============================================================================

  async notifyTruthStreamReviewReceived(userId: number, reviewId: string): Promise<boolean> {
    return this.sendNotification('ts_review_received', String(userId), {
      reviewId,
    });
  }

  async notifyTruthStreamReviewClassified(
    userId: number,
    reviewId: string,
    classification: string
  ): Promise<boolean> {
    return this.sendNotification('ts_review_classified', String(userId), {
      reviewId,
      classification,
    });
  }

  async notifyTruthStreamAnalysisComplete(
    userId: number,
    analysisId: string,
    analysisType: string
  ): Promise<boolean> {
    return this.sendNotification('ts_analysis_complete', String(userId), {
      analysisId,
      analysisType,
    });
  }

  async notifyTruthStreamDialogueMessage(
    userId: number,
    reviewId: string,
    recipientView: string
  ): Promise<boolean> {
    return this.sendNotification('ts_dialogue_message', String(userId), {
      reviewId,
      recipientView,
    });
  }

  async notifyTruthStreamQueueAssigned(
    userId: number,
    batchNumber: number,
    itemCount: number
  ): Promise<boolean> {
    return this.sendNotification('ts_queue_assigned', String(userId), {
      batchNumber,
      itemCount,
    });
  }

  async notifyTruthStreamMilestoneEarned(
    userId: number,
    milestoneName: string
  ): Promise<boolean> {
    return this.sendNotification('ts_milestone_earned', String(userId), {
      milestoneName,
    });
  }

  // ============================================================================
  // GENERIC NOTIFICATION METHOD (Phase 4)
  // ============================================================================

  /**
   * Generic notification method for Phase 4 features (voting, conversation insights)
   * Accepts notification type with colon format (e.g., 'vote:proposed') and converts
   * to underscore format used internally (e.g., 'vote_proposed')
   */
  async notify(userId: string | number, notification: {
    type: string;
    payload: Record<string, any>;
  }): Promise<boolean> {
    try {
      // Convert colon format to underscore format (e.g., 'vote:proposed' -> 'vote_proposed')
      const internalType = notification.type.replace(':', '_') as GroupNotificationType;

      // Validate notification type
      if (!isValidGroupNotificationType(internalType)) {
        console.warn(`⚠️ Unknown notification type: ${notification.type}, delivering as raw WebSocket message`);
        // Fallback: deliver as raw WebSocket message if type not in templates
        return this.deliverRawWebSocketNotification(String(userId), notification);
      }

      // Use the existing sendNotification infrastructure
      return await this.sendNotification(internalType, String(userId), notification.payload);
    } catch (error) {
      logError(`Error in generic notify for user ${userId}`, error);
      return false;
    }
  }

  /**
   * Fallback method for delivering raw WebSocket notifications
   * Used when notification type doesn't match any template
   */
  private async deliverRawWebSocketNotification(userId: string, notification: {
    type: string;
    payload: Record<string, any>;
  }): Promise<boolean> {
    try {
      const ws = this.activeConnections.get(userId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
      }

      const message = JSON.stringify({
        type: 'group_notification',
        data: {
          notificationType: notification.type,
          ...notification.payload,
          timestamp: new Date().toISOString(),
        },
      });

      ws.send(message);
      console.log(`✅ Raw WebSocket notification delivered to user ${userId}`);
      return true;
    } catch (error) {
      logError(`Raw WebSocket delivery failed for user ${userId}`, error);
      return false;
    }
  }

  // ============================================================================
  // DIRECT WEBSOCKET SEND (Phase 6)
  // ============================================================================

  /**
   * Send a raw WebSocket message directly to a connected user.
   * Unlike deliverViaWebSocket which wraps in 'group_notification' type,
   * this sends the message as-is, preserving the original event type
   * (e.g., 'analysis:completed').
   *
   * Used by the WebSocket server's Redis subscription handler to forward
   * analysis events directly to clients with the correct event type.
   */
  async sendDirectWebSocketMessage(userId: string, message: string): Promise<boolean> {
    try {
      const ws = this.activeConnections.get(userId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
      }
      ws.send(message);
      return true;
    } catch (error) {
      logError(`Direct WebSocket send failed for user ${userId}`, error);
      return false;
    }
  }

  // ============================================================================
  // CORE NOTIFICATION LOGIC
  // ============================================================================

  private async sendNotification(
    type: GroupNotificationType,
    userId: string,
    data: any
  ): Promise<boolean> {
    try {
      const template = this.TEMPLATES[type];
      if (!template) {
        console.error(`❌ Unknown notification type: ${type}`);
        return false;
      }

      const content: NotificationContent = {
        title: template.title(data),
        message: template.message(data),
        actionUrl: data.joinUrl || data.actionUrl,
        actionText: data.actionText || (data.joinUrl ? 'Join' : undefined),
        metadata: {
          type,
          groupId: data.groupId,
          sessionId: data.sessionId,
          ...data,
        },
      };

      const notification: NotificationDelivery = {
        userId,
        type,
        content,
        priority: template.priority,
        channels: template.channels,
        groupId: data.groupId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      };

      // For immediate notifications, try WebSocket first
      if (template.priority === 'immediate') {
        const delivered = await this.deliverViaWebSocket(notification);
        if (delivered) {
          // Still queue for other channels
          await this.queueNotification(notification);
          return true;
        }
      }

      // Queue for processing
      return await this.queueNotification(notification);
    } catch (error) {
      logError(`Error sending ${type} notification to user ${userId}`, error);
      return false;
    }
  }

  private async queueNotification(notification: NotificationDelivery): Promise<boolean> {
    try {
      const queueItem: NotificationQueue = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        userId: notification.userId,
        type: notification.type, // This is GroupNotificationType, but stored as string in queue
        content: notification.content,
        priority: notification.priority,
        createdAt: Date.now(),
        retryCount: 0,
      };

      return await mirrorRedis.enqueueNotification(queueItem);
    } catch (error) {
      logError('Error queueing notification', error);
      return false;
    }
  }

  private async deliverNotification(queueItem: NotificationQueue & { type: GroupNotificationType }): Promise<boolean> {
    try {
      // ✅ TypeScript now knows queueItem.type is GroupNotificationType
      // Ensure userId is a string (may come from DB as number)
      const notification: NotificationDelivery = {
        userId: String(queueItem.userId),
        type: queueItem.type, // ✅ Now properly typed as GroupNotificationType
        content: queueItem.content,
        priority: queueItem.priority,
        channels: this.TEMPLATES[queueItem.type].channels, // ✅ TypeScript knows this is valid
        createdAt: new Date(queueItem.createdAt),
      };

      const results: boolean[] = [];

      // Try each delivery channel
      for (const channel of notification.channels) {
        switch (channel) {
          case 'websocket':
            results.push(await this.deliverViaWebSocket(notification));
            break;
          case 'push':
            results.push(await this.deliverViaPush(notification));
            break;
          case 'email':
            results.push(await this.deliverViaEmail(notification));
            break;
        }
      }

      // Consider successful if any channel worked
      const success = results.some(result => result === true);

      if (!success && queueItem.retryCount < 3) {
        // Requeue with incremented retry count
        queueItem.retryCount++;
        await mirrorRedis.enqueueNotification(queueItem);
      }

      return success;
    } catch (error) {
      logError('Error delivering notification', error);
      return false;
    }
  }

  private async deliverViaWebSocket(notification: NotificationDelivery): Promise<boolean> {
    try {
      const ws = this.activeConnections.get(notification.userId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
      }

      const message = JSON.stringify({
        type: 'group_notification',
        data: {
          notificationType: notification.type,
          ...notification.content,
          timestamp: notification.createdAt.toISOString(),
        },
      });

      ws.send(message);
      console.log(`✅ WebSocket notification delivered to user ${notification.userId}`);
      return true;
    } catch (error) {
      logError(`WebSocket delivery failed for user ${notification.userId}`, error);
      return false;
    }
  }

  private async deliverViaPush(notification: NotificationDelivery): Promise<boolean> {
    try {
      // Placeholder for push notification implementation
      // This would integrate with your push notification service (Firebase, APNs, etc.)
      console.log(`📱 Push notification placeholder for user ${notification.userId}: ${notification.content.title}`);
      return true;
    } catch (error) {
      logError(`Push delivery failed for user ${notification.userId}`, error);
      return false;
    }
  }

  private async deliverViaEmail(notification: NotificationDelivery): Promise<boolean> {
    try {
      // Placeholder for email notification implementation
      // This would integrate with your email service (SendGrid, SES, etc.)
      console.log(`📧 Email notification placeholder for user ${notification.userId}: ${notification.content.title}`);
      return true;
    } catch (error) {
      logError(`Email delivery failed for user ${notification.userId}`, error);
      return false;
    }
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  async getActiveConnections(): Promise<string[]> {
    return Array.from(this.activeConnections.keys());
  }

  async getQueueStats(): Promise<{
    immediate: number;
    normal: number;
    low: number;
  }> {
    return {
      immediate: await mirrorRedis.getQueueLength('immediate'),
      normal: await mirrorRedis.getQueueLength('normal'),
      low: await mirrorRedis.getQueueLength('low'),
    };
  }

  async shutdown(): Promise<void> {
    console.log('📬 Shutting down Mirror Group Notification System...');

    try {
      // Close all WebSocket connections
      for (const [userId, ws] of this.activeConnections) {
        ws.close();
      }
      this.activeConnections.clear();

      this.initialized = false;
      console.log('✅ Mirror Group Notification System shutdown complete');
    } catch (error) {
      logError('Error during notification system shutdown', error);
    }
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const mirrorGroupNotifications = new MirrorGroupNotificationSystem();
