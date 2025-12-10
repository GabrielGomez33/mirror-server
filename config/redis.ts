// mirror-server/config/redis.ts
/**
 * MIRROR REDIS MANAGER - Phase 0 Infrastructure
 * 
 * Handles all Redis operations for MirrorGroups:
 * - Drawing synchronization (pub/sub)
 * - Session participant tracking
 * - Group insights caching
 * - Notification queuing
 * - WebRTC signaling support
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';

// ============================================================================
// ERROR HANDLING UTILITIES
// ============================================================================

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error occurred';
}

// ============================================================================
// TYPES
// ============================================================================

interface DrawAction {
  type: 'draw' | 'erase' | 'clear' | 'undo' | 'redo';
  sessionId: string;
  userId: string;
  userName: string;
  data: any;
  timestamp: number;
}

interface SessionParticipant {
  userId: string;
  userName: string;
  role: 'pen_holder' | 'spectator';
  joinedAt: number;
  lastActivity: number;
}

interface GroupInsight {
  groupId: string;
  type: 'compatibility_matrix' | 'collective_strengths' | 'conflict_risks';
  data: any;
  confidence: number;
  generatedAt: number;
  expiresAt: number;
}

export interface NotificationQueue {
  id: string;
  userId: string;
  type: string; // Keep as string for flexibility, validation happens in notification system
  content: any;
  priority: 'immediate' | 'normal' | 'low';
  createdAt: number;
  retryCount: number;
}

// ============================================================================
// REDIS MANAGER CLASS
// ============================================================================

export class MirrorRedisManager extends EventEmitter {
  private client!: Redis;        // ✅ Definite assignment assertion
  private subscriber!: Redis;    // ✅ Definite assignment assertion  
  private publisher!: Redis;     // ✅ Definite assignment assertion
  private connected: boolean = false;
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;

  // Configuration
  private readonly host: string;
  private readonly port: number;
  private readonly password: string;
  private readonly db: number;

  // Cache TTL values (in seconds)
  private readonly TTL = {
    GROUP_INSIGHTS: 3600,        // 1 hour
    SESSION_PARTICIPANTS: 1800,   // 30 minutes
    COMPATIBILITY_MATRIX: 7200,   // 2 hours
    NOTIFICATION_QUEUE: 86400,    // 24 hours
    DRAWING_SESSION: 3600,        // 1 hour
    // Phase 5: Chat Infrastructure
    CHAT_MESSAGE: 3600,          // 1 hour
    CHAT_TYPING: 5,              // 5 seconds
    CHAT_PRESENCE: 60,           // 1 minute
    CHAT_UNREAD_COUNT: 30,       // 30 seconds
    CHAT_RATE_LIMIT: 60,         // 1 minute
  } as const;

  constructor() {
    super();
    
    // Load configuration from environment
    this.host = process.env.REDIS_HOST || 'localhost';
    this.port = parseInt(process.env.REDIS_PORT || '6380');
    this.password = process.env.REDIS_PASSWORD || '';
    this.db = parseInt(process.env.REDIS_DB || '0');

    console.log(`🔌 Initializing Mirror Redis Manager (${this.host}:${this.port})`);
    this.initializeConnections();
  }

  // ============================================================================
  // CONNECTION MANAGEMENT
  // ============================================================================

  private initializeConnections(): void {
    const config = {
      host: this.host,
      port: this.port,
      password: this.password,
      db: this.db,
      retryDelayOnFailover: 100,
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    };

    try {
      // Main client for general operations
      this.client = new Redis(config);
      
      // Dedicated subscriber for pub/sub
      this.subscriber = new Redis(config);
      
      // Dedicated publisher for pub/sub
      this.publisher = new Redis(config);

      this.setupEventHandlers();
      this.connect();
    } catch (error) {
      console.error('❌ Failed to initialize Redis connections:', error);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    // Main client events
    this.client.on('connect', () => {
      console.log('✅ Mirror Redis client connected');
      this.connected = true;
      this.reconnectAttempts = 0;
      this.emit('connected');
    });

    this.client.on('error', (error) => {
      console.error('❌ Mirror Redis client error:', error);
      this.connected = false;
      this.emit('error', error);
    });

    this.client.on('close', () => {
      console.log('⚠️ Mirror Redis client connection closed');
      this.connected = false;
      this.handleReconnect();
    });

    // Subscriber events
    this.subscriber.on('connect', () => {
      console.log('✅ Mirror Redis subscriber connected');
    });

    this.subscriber.on('error', (error) => {
      console.error('❌ Mirror Redis subscriber error:', error);
    });

    // Publisher events
    this.publisher.on('connect', () => {
      console.log('✅ Mirror Redis publisher connected');
    });

    this.publisher.on('error', (error) => {
      console.error('❌ Mirror Redis publisher error:', error);
    });
  }

  private async connect(): Promise<void> {
    try {
      await Promise.all([
        this.client.connect(),
        this.subscriber.connect(),
        this.publisher.connect()
      ]);
      console.log('✅ All Mirror Redis connections established');
    } catch (error) {
      console.error('❌ Failed to connect to Mirror Redis:', error);
      throw error;
    }
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error('❌ Max reconnection attempts reached for Mirror Redis');
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    
    console.log(`🔄 Attempting Mirror Redis reconnection ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    
    setTimeout(() => {
      this.connect().catch(error => {
        console.error('❌ Reconnection failed:', error);
        this.handleReconnect();
      });
    }, delay);
  }

  // ============================================================================
  // BASIC OPERATIONS
  // ============================================================================

  async set(key: string, value: any, ttl?: number): Promise<boolean> {
    try {
      const serializedValue = JSON.stringify(value);
      if (ttl) {
        await this.client.setex(key, ttl, serializedValue);
      } else {
        await this.client.set(key, serializedValue);
      }
      return true;
    } catch (error) {
      console.error(`❌ Redis SET error for key ${key}:`, error);
      return false;
    }
  }

  async get(key: string): Promise<any | null> {
    try {
      const value = await this.client.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error(`❌ Redis GET error for key ${key}:`, error);
      return null;
    }
  }

  async del(key: string): Promise<boolean> {
    try {
      const result = await this.client.del(key);
      return result > 0;
    } catch (error) {
      console.error(`❌ Redis DEL error for key ${key}:`, error);
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      console.error(`❌ Redis EXISTS error for key ${key}:`, error);
      return false;
    }
  }

  // ============================================================================
  // DRAWING SYNCHRONIZATION (PUB/SUB)
  // ============================================================================

  async publishDrawAction(sessionId: string, action: DrawAction): Promise<boolean> {
    try {
      const channel = `mirror:drawing:${sessionId}`;
      const message = JSON.stringify(action);
      
      await this.publisher.publish(channel, message);
      
      // Also store the action for late joiners
      const historyKey = `mirror:drawing:history:${sessionId}`;
      await this.client.lpush(historyKey, message);
      await this.client.ltrim(historyKey, 0, 99); // Keep last 100 actions
      await this.client.expire(historyKey, this.TTL.DRAWING_SESSION);
      
      return true;
    } catch (error) {
      console.error(`❌ Failed to publish draw action for session ${sessionId}:`, error);
      return false;
    }
  }

  async subscribeToDrawing(sessionId: string, callback: (action: DrawAction) => void): Promise<boolean> {
    try {
      const channel = `mirror:drawing:${sessionId}`;
      
      await this.subscriber.subscribe(channel);
      
      this.subscriber.on('message', (receivedChannel, message) => {
        if (receivedChannel === channel) {
          try {
            const action = JSON.parse(message) as DrawAction;
            callback(action);
          } catch (error) {
            console.error('❌ Failed to parse draw action:', error);
          }
        }
      });
      
      return true;
    } catch (error) {
      console.error(`❌ Failed to subscribe to drawing session ${sessionId}:`, error);
      return false;
    }
  }

  async unsubscribeFromDrawing(sessionId: string): Promise<boolean> {
    try {
      const channel = `mirror:drawing:${sessionId}`;
      await this.subscriber.unsubscribe(channel);
      return true;
    } catch (error) {
      console.error(`❌ Failed to unsubscribe from drawing session ${sessionId}:`, error);
      return false;
    }
  }

  async getDrawingHistory(sessionId: string): Promise<DrawAction[]> {
    try {
      const historyKey = `mirror:drawing:history:${sessionId}`;
      const messages = await this.client.lrange(historyKey, 0, -1);
      
      return messages.map(message => {
        try {
          return JSON.parse(message) as DrawAction;
        } catch (error) {
          console.error('❌ Failed to parse draw action from history:', error);
          return null;
        }
      }).filter(action => action !== null) as DrawAction[];
    } catch (error) {
      console.error(`❌ Failed to get drawing history for session ${sessionId}:`, error);
      return [];
    }
  }

  // ============================================================================
  // SESSION PARTICIPANT MANAGEMENT
  // ============================================================================

  async storeSessionParticipants(sessionId: string, participants: SessionParticipant[]): Promise<boolean> {
    try {
      const key = `mirror:session:participants:${sessionId}`;
      await this.set(key, participants, this.TTL.SESSION_PARTICIPANTS);
      return true;
    } catch (error) {
      console.error(`❌ Failed to store session participants for ${sessionId}:`, error);
      return false;
    }
  }

  async addParticipantToSession(sessionId: string, participant: SessionParticipant): Promise<boolean> {
    try {
      const key = `mirror:session:participants:${sessionId}`;
      const existing = await this.get(key) || [];
      
      // Remove if already exists (update case)
      const filtered = existing.filter((p: SessionParticipant) => p.userId !== participant.userId);
      filtered.push(participant);
      
      await this.set(key, filtered, this.TTL.SESSION_PARTICIPANTS);
      return true;
    } catch (error) {
      console.error(`❌ Failed to add participant to session ${sessionId}:`, error);
      return false;
    }
  }

  async removeParticipantFromSession(sessionId: string, userId: string): Promise<boolean> {
    try {
      const key = `mirror:session:participants:${sessionId}`;
      const existing = await this.get(key) || [];
      
      const filtered = existing.filter((p: SessionParticipant) => p.userId !== userId);
      await this.set(key, filtered, this.TTL.SESSION_PARTICIPANTS);
      return true;
    } catch (error) {
      console.error(`❌ Failed to remove participant from session ${sessionId}:`, error);
      return false;
    }
  }

  async getSessionParticipants(sessionId: string): Promise<SessionParticipant[]> {
    try {
      const key = `mirror:session:participants:${sessionId}`;
      return await this.get(key) || [];
    } catch (error) {
      console.error(`❌ Failed to get session participants for ${sessionId}:`, error);
      return [];
    }
  }

  // ============================================================================
  // GROUP INSIGHTS CACHING
  // ============================================================================

  async cacheGroupInsights(groupId: string, insights: GroupInsight): Promise<boolean> {
    try {
      const key = `mirror:group:insights:${groupId}:${insights.type}`;
      await this.set(key, insights, this.TTL.GROUP_INSIGHTS);
      return true;
    } catch (error) {
      console.error(`❌ Failed to cache group insights for ${groupId}:`, error);
      return false;
    }
  }

  async getCompatibilityMatrix(groupId: string): Promise<any | null> {
    try {
      const key = `mirror:group:insights:${groupId}:compatibility_matrix`;
      const cached = await this.get(key);
      return cached?.data || null;
    } catch (error) {
      console.error(`❌ Failed to get compatibility matrix for ${groupId}:`, error);
      return null;
    }
  }

  async invalidateGroupInsights(groupId: string): Promise<boolean> {
    try {
      const pattern = `mirror:group:insights:${groupId}:*`;
      const keys = await this.client.keys(pattern);
      
      if (keys.length > 0) {
        await this.client.del(...keys);
      }
      return true;
    } catch (error) {
      console.error(`❌ Failed to invalidate group insights for ${groupId}:`, error);
      return false;
    }
  }

  // ============================================================================
  // NOTIFICATION QUEUE MANAGEMENT
  // ============================================================================

  async enqueueNotification(notification: NotificationQueue): Promise<boolean> {
    try {
      const queueKey = `mirror:notifications:${notification.priority}`;
      const message = JSON.stringify(notification);
      
      await this.client.lpush(queueKey, message);
      await this.client.expire(queueKey, this.TTL.NOTIFICATION_QUEUE);
      return true;
    } catch (error) {
      console.error('❌ Failed to enqueue notification:', error);
      return false;
    }
  }

  async dequeueNotification(priority: 'immediate' | 'normal' | 'low'): Promise<NotificationQueue | null> {
    try {
      const queueKey = `mirror:notifications:${priority}`;
      const message = await this.client.rpop(queueKey);
      
      if (!message) return null;
      
      return JSON.parse(message) as NotificationQueue;
    } catch (error) {
      console.error(`❌ Failed to dequeue ${priority} notification:`, error);
      return null;
    }
  }

  async getQueueLength(priority: 'immediate' | 'normal' | 'low'): Promise<number> {
    try {
      const queueKey = `mirror:notifications:${priority}`;
      return await this.client.llen(queueKey);
    } catch (error) {
      console.error(`❌ Failed to get queue length for ${priority}:`, error);
      return 0;
    }
  }

  // ============================================================================
  // PUB/SUB UTILITY METHODS
  // ============================================================================

  async publish(channel: string, message: string): Promise<number> {
    try {
      const result = await this.publisher.publish(channel, message);
      return result;
    } catch (error) {
      console.error(`❌ Failed to publish to channel ${channel}:`, error);
      return 0;
    }
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  isConnected(): boolean {
    return this.connected;
  }

  async healthCheck(): Promise<{ status: 'healthy' | 'unhealthy'; details: any }> {
    try {
      const start = Date.now();
      await this.client.ping();
      const latency = Date.now() - start;

      const info = await this.client.info('memory');
      const usedMemory = info.match(/used_memory:(\d+)/)?.[1] || '0';

      return {
        status: 'healthy',
        details: {
          connected: this.connected,
          latency: `${latency}ms`,
          usedMemory: `${Math.round(parseInt(usedMemory) / 1024 / 1024)}MB`,
          reconnectAttempts: this.reconnectAttempts,
        }
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        details: {
          connected: false,
          error: getErrorMessage(error),  // ✅ Use proper error handling
          reconnectAttempts: this.reconnectAttempts,
        }
      };
    }
  }

  async shutdown(): Promise<void> {
    console.log('🔌 Shutting down Mirror Redis Manager...');
    
    try {
      await Promise.all([
        this.client.quit(),
        this.subscriber.quit(),
        this.publisher.quit()
      ]);
      this.connected = false;
      console.log('✅ Mirror Redis Manager shutdown complete');
    } catch (error) {
      console.error('❌ Error during Mirror Redis shutdown:', getErrorMessage(error));
    }
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const mirrorRedis = new MirrorRedisManager();
