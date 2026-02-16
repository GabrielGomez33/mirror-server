// ============================================================================
// DINA CHAT QUEUE PROCESSOR - Production-Ready with Streaming Support
// ============================================================================
// File: workers/DinaChatQueueProcessor.ts
//
// Purpose: Processes @Dina messages with intelligent streaming support.
// Uses WebSocket connection to DINA server for real-time communication.
//
// Architecture:
//   - Single WebSocket connection to DINA (established on init)
//   - Streaming chunks delivered via WebSocket for real-time feedback
//   - DUMP protocol for standardized message format
//
// Features:
// - Queue-based async processing (no latency bottleneck)
// - WebSocket streaming via DINA connection
// - Exponential backoff retries with jitter
// - Circuit breaker pattern for DINA service resilience
// - Rate limiting per user
// - Comprehensive structured logging
// - Input sanitization and security
// - Health monitoring and metrics
// - Graceful shutdown handling
//
// Copy this file to: /var/www/mirror-server/workers/DinaChatQueueProcessor.ts
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import { DB } from '../db';
import { EventEmitter } from 'events';

// DINA WebSocket Client - Use factory to create DCQP's own connection
import {
  createDinaWebSocket,
  dinaWebSocket as mirrorServerWebSocket,
  StreamingChunk,
  DinaWebSocketClient
} from '../services/DinaWebSocketClient';

// DCQP's own WebSocket instance (initialized in standalone mode)
// When running in mirror-server process, uses the shared mirrorServerWebSocket
let dcqpWebSocket: DinaWebSocketClient = mirrorServerWebSocket;

// DINA Message Utilities - Standardized message creation for DUMP protocol
import {
  createDinaChatRequest,
  createDinaStreamingChatRequest,
  createDinaApiRequest,
  buildDinaLlmEndpoint,
  buildMirrorChatEndpoint,
  createMirrorChatRequest,
  buildDinaChatContext,
  extractDinaResponseContent,
  safeJsonParse,
  getDinaRequestHeaders,
  sanitizeDinaQuery,
  getMySQLNow,
  DINA_ENDPOINTS,
  DINA_DEFAULTS,
  DINA_DEFAULT_MODEL,
  type DinaChatContext,
} from '../utils/dinaMessageUtils';

// ============================================================================
// WEBSOCKET BROADCAST - Will be wired up from main server
// ============================================================================
let broadcastToGroup = (groupId: string, payload: any) => {
  console.log(`[DINA-WS] 📡 Broadcast to group ${groupId}: ${payload.type}`);
};

export function setBroadcastFunction(fn: (groupId: string, payload: any) => void) {
  console.log('[DINA] ✅ WebSocket broadcast function configured');
  broadcastToGroup = fn;
}

// ============================================================================
// TYPES
// ============================================================================

interface DinaChatQueueItem {
  id: string;
  group_id: string;
  user_id: number;
  username: string;
  query: string;
  original_message_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  priority: number;
  retry_count: number;
  next_retry_at: Date | null;
  context: string | null;
  response: string | null;
  processing_time_ms: number | null;
  last_error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface StreamingConfig {
  enabled: boolean;
  decisionDelayMs: number;
  minChunkSize: number;
  chunkIntervalMs: number;
}

interface ProcessorConfig {
  pollIntervalMs: number;
  maxConcurrent: number;
  maxRetries: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  timeoutMs: number;
  rateLimitPerUser: number;
  rateLimitWindowMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
  maxQueryLength: number;
  maxResponseLength: number;
  streaming: StreamingConfig;
}

interface StreamingState {
  messageId: string;
  groupId: string;
  isStreaming: boolean;
  accumulatedContent: string;
  chunkIndex: number;
  startTime: number;
  lastChunkTime: number;
}

interface ProcessorStats {
  processed: number;
  succeeded: number;
  failed: number;
  retried: number;
  streamed: number;
  averageProcessingTimeMs: number;
  lastProcessedAt: Date | null;
  circuitBreakerState: 'closed' | 'open' | 'half-open';
  pollCount: number;
  lastPollAt: Date | null;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ============================================================================
// LOGGER - Structured Logging
// ============================================================================

class Logger {
  private context: string;
  private minLevel: LogLevel;

  private readonly levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(context: string, minLevel: LogLevel = 'debug') {
    this.context = context;
    this.minLevel = minLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levels[level] >= this.levels[this.minLevel];
  }

  private formatMessage(level: LogLevel, message: string, meta?: Record<string, any>): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    const emoji = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'info' ? '📋' : '🔍';
    return `[${timestamp}] ${emoji} [${level.toUpperCase()}] [${this.context}] ${message}${metaStr}`;
  }

  debug(message: string, meta?: Record<string, any>): void {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message, meta));
    }
  }

  info(message: string, meta?: Record<string, any>): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, meta));
    }
  }

  warn(message: string, meta?: Record<string, any>): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, meta));
    }
  }

  error(message: string, error?: Error, meta?: Record<string, any>): void {
    if (this.shouldLog('error')) {
      const errorMeta = error ? { error: error.message, stack: error.stack, ...meta } : meta;
      console.error(this.formatMessage('error', message, errorMeta));
    }
  }
}

// ============================================================================
// CIRCUIT BREAKER - Resilience Pattern
// ============================================================================

class CircuitBreaker {
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private readonly threshold: number;
  private readonly resetTimeMs: number;
  private readonly logger: Logger;

  constructor(threshold: number, resetTimeMs: number, logger: Logger) {
    this.threshold = threshold;
    this.resetTimeMs = resetTimeMs;
    this.logger = logger;
  }

  canExecute(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure >= this.resetTimeMs) {
        this.state = 'half-open';
        this.logger.info('Circuit breaker entering half-open state');
        return true;
      }
      return false;
    }

    return true;
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.logger.info('Circuit breaker closing after successful request');
    }
    this.failureCount = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.state = 'open';
      this.logger.warn('Circuit breaker re-opened after failure in half-open state');
    } else if (this.failureCount >= this.threshold) {
      this.state = 'open';
      this.logger.warn('Circuit breaker opened', { failureCount: this.failureCount, threshold: this.threshold });
    }
  }

  getState(): 'closed' | 'open' | 'half-open' {
    return this.state;
  }

  reset(): void {
    this.failureCount = 0;
    this.state = 'closed';
    this.logger.info('Circuit breaker manually reset');
  }
}

// ============================================================================
// RATE LIMITER - Per-User Rate Limiting
// ============================================================================

class RateLimiter {
  private userRequests: Map<number, number[]> = new Map();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  canProcess(userId: number): boolean {
    const now = Date.now();
    const requests = this.userRequests.get(userId) || [];
    const recentRequests = requests.filter(time => now - time < this.windowMs);

    if (recentRequests.length >= this.limit) {
      return false;
    }

    recentRequests.push(now);
    this.userRequests.set(userId, recentRequests);
    return true;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [userId, requests] of this.userRequests.entries()) {
      const recentRequests = requests.filter(time => now - time < this.windowMs);
      if (recentRequests.length === 0) {
        this.userRequests.delete(userId);
      } else {
        this.userRequests.set(userId, recentRequests);
      }
    }
  }
}

// ============================================================================
// INPUT SANITIZER - Security
// ============================================================================

class InputSanitizer {
  private readonly maxLength: number;

  constructor(maxLength: number) {
    this.maxLength = maxLength;
  }

  sanitizeQuery(input: string): string {
    if (!input || typeof input !== 'string') return '';

    let sanitized = input
      .replace(/\0/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (sanitized.length > this.maxLength) {
      sanitized = sanitized.substring(0, this.maxLength) + '...';
    }

    return sanitized;
  }

  sanitizeResponse(input: string, maxLength: number): string {
    if (!input || typeof input !== 'string') {
      return 'I apologize, but I was unable to generate a response.';
    }

    let sanitized = input.replace(/\0/g, '').trim();

    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength) + '...';
    }

    return sanitized;
  }
}

// ============================================================================
// DINA CHAT QUEUE PROCESSOR CLASS
// ============================================================================

export class DinaChatQueueProcessor extends EventEmitter {
  private isRunning: boolean = false;
  private isShuttingDown: boolean = false;
  private processingCount: number = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private activeStreams: Map<string, StreamingState> = new Map();

  private readonly config: ProcessorConfig;
  private readonly logger: Logger;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly rateLimiter: RateLimiter;
  private readonly sanitizer: InputSanitizer;
  private readonly stats: ProcessorStats;

  private readonly DINA_USER_ID: number;
  private readonly DINA_USERNAME = 'Dina';
  private readonly DINA_SERVER_URL: string;
  private readonly DINA_CHAT_ENDPOINT: string;

  constructor(config?: Partial<ProcessorConfig>) {
    super();

    this.config = {
      pollIntervalMs: parseInt(process.env.DINA_CHAT_POLL_INTERVAL || '2000', 10),
      maxConcurrent: parseInt(process.env.DINA_CHAT_MAX_CONCURRENT || '5', 10),
      maxRetries: parseInt(process.env.DINA_CHAT_MAX_RETRIES || '3', 10),
      baseRetryDelayMs: 5000,
      maxRetryDelayMs: 60000,
      timeoutMs: parseInt(process.env.DINA_TIMEOUT || '30000', 10),
      rateLimitPerUser: parseInt(process.env.DINA_RATE_LIMIT_PER_USER || '10', 10),
      rateLimitWindowMs: parseInt(process.env.DINA_RATE_LIMIT_WINDOW || '60000', 10),
      circuitBreakerThreshold: parseInt(process.env.DINA_CIRCUIT_BREAKER_THRESHOLD || '5', 10),
      circuitBreakerResetMs: parseInt(process.env.DINA_CIRCUIT_BREAKER_RESET || '30000', 10),
      maxQueryLength: parseInt(process.env.DINA_MAX_QUERY_LENGTH || '4000', 10),
      maxResponseLength: parseInt(process.env.DINA_MAX_RESPONSE_LENGTH || '8000', 10),
      streaming: {
        enabled: process.env.DINA_STREAMING_ENABLED !== 'false', // TRUE by default
        decisionDelayMs: parseInt(process.env.DINA_STREAM_DECISION_DELAY || '250', 10),
        minChunkSize: 10,
        chunkIntervalMs: 50,
      },
      ...config,
    };

    this.DINA_USER_ID = parseInt(process.env.DINA_USER_ID_SQL || '59', 10);
    this.DINA_SERVER_URL = process.env.DINA_BASE_URL || 'http://localhost:8445';
    // Use DINA_ENDPOINT for direct API calls (standard DINA API)
    // Falls back to constructed URL if not specified
    this.DINA_CHAT_ENDPOINT = process.env.DINA_ENDPOINT ||
      `${this.DINA_SERVER_URL}/api/v1/models/mistral:7b/chat`;

    // Default to debug level for more visibility
    const logLevel = (process.env.DINA_LOG_LEVEL || 'debug') as LogLevel;
    this.logger = new Logger('DinaChatQueueProcessor', logLevel);
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold,
      this.config.circuitBreakerResetMs,
      this.logger
    );
    this.rateLimiter = new RateLimiter(
      this.config.rateLimitPerUser,
      this.config.rateLimitWindowMs
    );
    this.sanitizer = new InputSanitizer(this.config.maxQueryLength);

    this.stats = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      retried: 0,
      streamed: 0,
      averageProcessingTimeMs: 0,
      lastProcessedAt: null,
      circuitBreakerState: 'closed',
      pollCount: 0,
      lastPollAt: null,
    };

    this.logger.info('🤖 DinaChatQueueProcessor initialized', {
      config: {
        pollIntervalMs: this.config.pollIntervalMs,
        maxConcurrent: this.config.maxConcurrent,
        maxRetries: this.config.maxRetries,
        streamingEnabled: this.config.streaming.enabled,
        streamDecisionDelayMs: this.config.streaming.decisionDelayMs,
        dinaServerUrl: this.DINA_SERVER_URL,
        dinaChatEndpoint: this.DINA_CHAT_ENDPOINT,
        dinaUserId: this.DINA_USER_ID,
      },
    });
  }

  // ============================================================================
  // LIFECYCLE METHODS
  // ============================================================================

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Processor already running');
      return;
    }

    this.logger.info('🚀 Starting DinaChatQueueProcessor...');

    // Test database connection first
    try {
      this.logger.info('🔌 Testing database connection...');
      const [result]: any = await DB.query('SELECT 1 as test');
      this.logger.info('✅ Database connection successful');

      // Check if queue table exists
      const [tables]: any = await DB.query(
        "SHOW TABLES LIKE 'mirror_dina_chat_queue'"
      );
      if (tables.length === 0) {
        throw new Error('Table mirror_dina_chat_queue does not exist!');
      }
      this.logger.info('✅ Queue table exists');

      // Check pending items count
      const [pending]: any = await DB.query(
        "SELECT COUNT(*) as count FROM mirror_dina_chat_queue WHERE status = 'pending'"
      );
      this.logger.info(`📊 Current pending items in queue: ${pending[0]?.count || 0}`);

    } catch (dbError) {
      this.logger.error('❌ Database connection/table check failed', dbError as Error);
      throw dbError;
    }

    this.isRunning = true;
    this.isShuttingDown = false;

    this.registerShutdownHandlers();

    // Cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.rateLimiter.cleanup();
    }, 60000);

    // Status logging timer - every 30 seconds
    this.statusTimer = setInterval(() => {
      this.logStatus();
    }, 30000);

    // Start polling
    this.logger.info('📡 Starting poll loop...');
    this.poll();

    this.emit('started');
    this.logger.info('✅ DinaChatQueueProcessor started successfully');
  }

  private logStatus(): void {
    console.log('\n' + '='.repeat(60));
    console.log('📊 @DINA PROCESSOR STATUS');
    console.log('='.repeat(60));
    console.log(`⏱️  Time: ${new Date().toISOString()}`);
    console.log(`🏃 Running: ${this.isRunning}`);
    console.log(`📡 Poll Count: ${this.stats.pollCount}`);
    console.log(`📨 Last Poll: ${this.stats.lastPollAt?.toISOString() || 'Never'}`);
    console.log(`🔄 Processing: ${this.processingCount}/${this.config.maxConcurrent}`);
    console.log(`✅ Succeeded: ${this.stats.succeeded}`);
    console.log(`❌ Failed: ${this.stats.failed}`);
    console.log(`🔁 Retried: ${this.stats.retried}`);
    console.log(`🌊 Streamed: ${this.stats.streamed}`);
    console.log(`⚡ Circuit Breaker: ${this.circuitBreaker.getState()}`);
    console.log('='.repeat(60) + '\n');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.logger.info('🛑 Stopping DinaChatQueueProcessor...');
    this.isRunning = false;
    this.isShuttingDown = true;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }

    // Finalize active streams
    for (const [messageId, state] of this.activeStreams) {
      await this.finalizeStream(messageId, state);
    }
    this.activeStreams.clear();

    const maxWaitTime = 30000;
    const startWait = Date.now();

    while (this.processingCount > 0 && Date.now() - startWait < maxWaitTime) {
      this.logger.info(`⏳ Waiting for ${this.processingCount} items to complete...`);
      await this.sleep(1000);
    }

    if (this.processingCount > 0) {
      this.logger.warn(`⚠️ Force stopping with ${this.processingCount} items still processing`);
    }

    this.emit('stopped');
    this.logger.info('🛑 DinaChatQueueProcessor stopped');
  }

  private registerShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      this.logger.info(`📴 Received ${signal}, initiating graceful shutdown...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  // ============================================================================
  // STATIC QUEUE METHODS (for use in ChatMessageManager)
  // ============================================================================

  static async queueDinaMessage(params: {
    groupId: string;
    userId: number;
    username: string;
    query: string;
    originalMessageId: string;
    context?: any;
    priority?: number;
  }): Promise<string> {
    const id = uuidv4();
    const priority = params.priority ?? 5;

    console.log('\n' + '🤖'.repeat(30));
    console.log('[DINA-QUEUE] 📥 QUEUING NEW @DINA MESSAGE');
    console.log('🤖'.repeat(30));
    console.log(`  📋 Queue ID: ${id}`);
    console.log(`  👤 User: ${params.username} (ID: ${params.userId})`);
    console.log(`  🏠 Group: ${params.groupId}`);
    console.log(`  💬 Query: "${params.query.substring(0, 100)}${params.query.length > 100 ? '...' : ''}"`);
    console.log(`  🔗 Original Message: ${params.originalMessageId}`);
    console.log(`  ⭐ Priority: ${priority}`);
    console.log('🤖'.repeat(30) + '\n');

    if (!params.groupId || !params.userId || !params.query) {
      console.error('[DINA-QUEUE] ❌ Missing required parameters!', {
        hasGroupId: !!params.groupId,
        hasUserId: !!params.userId,
        hasQuery: !!params.query,
      });
      throw new Error('Missing required parameters for queueDinaMessage');
    }

    try {
      await DB.query(
        `INSERT INTO mirror_dina_chat_queue
         (id, group_id, user_id, username, query, original_message_id, status, priority, context, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NOW(), NOW())`,
        [
          id,
          params.groupId,
          params.userId,
          params.username,
          params.query.substring(0, 4000),
          params.originalMessageId,
          priority,
          JSON.stringify(params.context || {}),
        ]
      );

      console.log(`[DINA-QUEUE] ✅ Successfully queued message: ${id}`);

      // Broadcast that @Dina is processing
      broadcastToGroup(params.groupId, {
        type: 'dina:processing_start',
        payload: {
          queueId: id,
          originalMessageId: params.originalMessageId,
          username: params.username,
          query: params.query.substring(0, 200),
        },
        timestamp: new Date().toISOString(),
      });

      return id;
    } catch (error) {
      console.error('[DINA-QUEUE] ❌ Failed to queue message:', error);
      throw error;
    }
  }

  static containsDinaMention(content: string): boolean {
    if (!content || typeof content !== 'string') {
      console.log('[DINA-DETECT] ⚠️ Invalid content for @dina detection:', typeof content);
      return false;
    }
    const hasMention = /@dina\b/i.test(content);
    console.log(`[DINA-DETECT] 🔍 Checking for @dina in "${content.substring(0, 50)}..." → ${hasMention ? '✅ FOUND' : '❌ NOT FOUND'}`);
    return hasMention;
  }

  static extractDinaQuery(content: string): string {
    if (!content || typeof content !== 'string') return '';
    const query = content.replace(/@dina\b/gi, '').trim();
    console.log(`[DINA-EXTRACT] 📝 Extracted query: "${query.substring(0, 100)}"`);
    return query;
  }

  // ============================================================================
  // POLLING & PROCESSING
  // ============================================================================

  private async poll(): Promise<void> {
    if (!this.isRunning || this.isShuttingDown) {
      this.logger.debug('Poll skipped - processor not running or shutting down');
      return;
    }

    this.stats.pollCount++;
    this.stats.lastPollAt = new Date();

    try {
      // Circuit breaker check
      if (!this.circuitBreaker.canExecute()) {
        this.logger.warn('⚡ Circuit breaker is OPEN, skipping poll');
        this.schedulePoll();
        return;
      }

      // Capacity check
      if (this.processingCount >= this.config.maxConcurrent) {
        this.logger.debug(`🚫 At max concurrent capacity (${this.processingCount}/${this.config.maxConcurrent})`);
        this.schedulePoll();
        return;
      }

      const availableSlots = this.config.maxConcurrent - this.processingCount;

      this.logger.debug(`🔍 Polling for items (slots available: ${availableSlots})...`);

      const items = await this.fetchPendingItems(availableSlots);

      if (items.length > 0) {
        console.log('\n' + '⭐'.repeat(30));
        console.log(`[DINA-POLL] 🎉 FOUND ${items.length} PENDING ITEM(S)!`);
        items.forEach((item, i) => {
          console.log(`  ${i + 1}. ID: ${item.id.substring(0, 8)}... | User: ${item.username} | Query: "${item.query.substring(0, 50)}..."`);
        });
        console.log('⭐'.repeat(30) + '\n');

        const promises = items.map(item => this.processItem(item));
        await Promise.allSettled(promises);
      } else {
        // Log every 10th poll to reduce noise but still show activity
        if (this.stats.pollCount % 10 === 0) {
          this.logger.debug(`📭 Queue empty (poll #${this.stats.pollCount})`);
        }
      }
    } catch (error) {
      this.logger.error('❌ Error in poll cycle', error as Error);
    }

    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.isRunning && !this.pollTimer && !this.isShuttingDown) {
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        this.poll();
      }, this.config.pollIntervalMs);
    }
  }

  private async fetchPendingItems(limit: number): Promise<DinaChatQueueItem[]> {
    try {
      const [rows]: any = await DB.query(
        `SELECT * FROM mirror_dina_chat_queue
         WHERE status = 'pending'
           AND (next_retry_at IS NULL OR next_retry_at <= NOW())
         ORDER BY priority ASC, created_at ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED`,
        [limit]
      );

      return rows as DinaChatQueueItem[];
    } catch (error) {
      this.logger.error('❌ Failed to fetch pending items', error as Error);
      return [];
    }
  }

  // ============================================================================
  // ITEM PROCESSING WITH STREAMING
  // ============================================================================

  private async processItem(item: DinaChatQueueItem): Promise<void> {
    const startTime = Date.now();
    this.processingCount++;
    this.stats.processed++;

    console.log('\n' + '🚀'.repeat(30));
    console.log('[DINA-PROCESS] 🔄 PROCESSING ITEM');
    console.log('🚀'.repeat(30));
    console.log(`  📋 ID: ${item.id}`);
    console.log(`  👤 User: ${item.username} (ID: ${item.user_id})`);
    console.log(`  🏠 Group: ${item.group_id}`);
    console.log(`  💬 Query: "${item.query}"`);
    console.log(`  🔁 Retry Count: ${item.retry_count}`);
    console.log(`  🌊 Streaming: ${this.config.streaming.enabled ? 'ENABLED' : 'DISABLED'}`);
    console.log('🚀'.repeat(30) + '\n');

    try {
      // Check rate limit
      if (!this.rateLimiter.canProcess(item.user_id)) {
        this.logger.warn(`⏱️ Rate limit exceeded for user ${item.user_id}`);
        await this.updateItemStatus(item.id, 'pending', {
          next_retry_at: new Date(Date.now() + this.config.rateLimitWindowMs),
          last_error: 'Rate limit exceeded',
        });
        return;
      }

      // Mark as processing
      await this.updateItemStatus(item.id, 'processing', { started_at: new Date() });
      console.log(`[DINA-PROCESS] 📝 Marked as processing`);

      // Sanitize the query
      const sanitizedQuery = this.sanitizer.sanitizeQuery(item.query);
      if (!sanitizedQuery) {
        throw new Error('Invalid or empty query after sanitization');
      }
      console.log(`[DINA-PROCESS] 🧹 Sanitized query: "${sanitizedQuery}"`);

      // Build context
      console.log(`[DINA-PROCESS] 🔧 Building context...`);
      const context = await this.buildDinaContext(item);
      console.log(`[DINA-PROCESS] ✅ Context built`);

      // Create message ID for Dina's response
      const messageId = uuidv4();
      const now = getMySQLNow(); // MySQL-compatible datetime format

      // Send typing indicator
      console.log(`[DINA-PROCESS] ⌨️ Sending typing indicator...`);
      this.sendTypingIndicator(item.group_id, true);

      let response: string;
      let wasStreamed = false;

      if (this.config.streaming.enabled) {
        // Insert placeholder message for streaming
        console.log(`[DINA-PROCESS] 📝 Inserting placeholder message...`);
        await this.insertPlaceholderMessage(messageId, item, now);

        // Process with streaming
        console.log(`[DINA-PROCESS] 🌊 Starting streaming request to DINA server...`);
        console.log(`[DINA-PROCESS] 🌐 URL: ${this.DINA_SERVER_URL}/api/mirror/chat/stream`);
        const result = await this.processWithStreaming(item, messageId, context, sanitizedQuery);
        response = result.response;
        wasStreamed = result.wasStreamed;

        // Finalize the message in DB
        await this.finalizeMessage(messageId, item, response);
      } else {
        // Non-streaming: get full response then insert
        console.log(`[DINA-PROCESS] 📨 Starting non-streaming request to DINA server...`);
        response = await this.getFullResponse(item, context, sanitizedQuery);
        await this.insertDinaResponse(messageId, item, response, now);
      }

      // Stop typing indicator
      this.sendTypingIndicator(item.group_id, false);

      // Sanitize response
      const sanitizedResponse = this.sanitizer.sanitizeResponse(response, this.config.maxResponseLength);

      const processingTimeMs = Date.now() - startTime;

      // Mark as completed
      await this.updateItemStatus(item.id, 'completed', {
        response: sanitizedResponse,
        processing_time_ms: processingTimeMs,
        completed_at: new Date(),
      });

      // Update stats
      this.stats.succeeded++;
      if (wasStreamed) this.stats.streamed++;
      this.stats.lastProcessedAt = new Date();
      this.updateAverageProcessingTime(processingTimeMs);
      this.circuitBreaker.recordSuccess();

      console.log('\n' + '✅'.repeat(30));
      console.log('[DINA-PROCESS] 🎉 PROCESSING COMPLETED SUCCESSFULLY');
      console.log('✅'.repeat(30));
      console.log(`  📋 ID: ${item.id}`);
      console.log(`  ⏱️  Time: ${processingTimeMs}ms`);
      console.log(`  🌊 Streamed: ${wasStreamed}`);
      console.log(`  📝 Response length: ${response.length} chars`);
      console.log(`     Full response: ${response}`);
      console.log('✅'.repeat(30) + '\n');

    } catch (error) {
      const errorMessage = (error as Error).message;

      console.log('\n' + '❌'.repeat(30));
      console.log('[DINA-PROCESS] ❌ PROCESSING FAILED');
      console.log('❌'.repeat(30));
      console.log(`  📋 ID: ${item.id}`);
      console.log(`  ❌ Error: ${errorMessage}`);
      console.log(`  📚 Stack: ${(error as Error).stack}`);
      console.log('❌'.repeat(30) + '\n');

      this.sendTypingIndicator(item.group_id, false);
      this.circuitBreaker.recordFailure();

      if (item.retry_count < this.config.maxRetries) {
        const retryDelay = this.calculateRetryDelay(item.retry_count);
        const nextRetryAt = new Date(Date.now() + retryDelay);

        await this.updateItemStatus(item.id, 'pending', {
          retry_count: item.retry_count + 1,
          next_retry_at: nextRetryAt,
          last_error: errorMessage,
        });

        this.stats.retried++;
        console.log(`[DINA-PROCESS] 🔁 Scheduled for retry #${item.retry_count + 1} at ${nextRetryAt.toISOString()}`);
      } else {
        await this.updateItemStatus(item.id, 'failed', {
          last_error: errorMessage,
          completed_at: new Date(),
        });

        this.stats.failed++;
        await this.insertDinaErrorResponse(item);
        console.log(`[DINA-PROCESS] ❌ Max retries exceeded, marked as FAILED`);
      }
    } finally {
      this.processingCount--;
    }
  }

  // ============================================================================
  // STREAMING PROCESSING
  // ============================================================================

  /**
   * Processes a chat request with streaming support using DUMP protocol
   * Uses standardized message format from dinaMessageUtils
   */
  private async processWithStreaming(
    item: DinaChatQueueItem,
    messageId: string,
    context: any,
    query: string
  ): Promise<{ response: string; wasStreamed: boolean }> {
    const { decisionDelayMs } = this.config.streaming;

    return new Promise(async (resolve, reject) => {
      let responseComplete = false;
      let fullResponse = '';
      let streamingStarted = false;
      let accumulatedChunks: string[] = [];

      const streamState: StreamingState = {
        messageId,
        groupId: item.group_id,
        isStreaming: false,
        accumulatedContent: '',
        chunkIndex: 0,
        startTime: Date.now(),
        lastChunkTime: Date.now(),
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.log(`[DINA-STREAM] ⏱️ Request timeout after ${this.config.timeoutMs}ms`);
        controller.abort();
      }, this.config.timeoutMs);

      try {
        // Check WebSocket connection
        if (!dcqpWebSocket.connected) {
          console.log(`[DINA-STREAM] ⚠️ WebSocket not connected, attempting reconnect...`);
          throw new Error('DINA WebSocket not connected');
        }

        console.log(`[DINA-STREAM] 🔌 Using WebSocket connection to DINA`);
        console.log(`[DINA-STREAM] 📤 Sending streaming chat request for: "${query.substring(0, 50)}..."`);

        // Build context for DINA
        const chatContext = {
          groupName: context.groupInfo?.name,
          groupGoal: context.groupInfo?.goal,
          members: context.members?.map((m: any) => m.username),
          recentMessages: context.recentMessages?.slice(-10).map((m: any) => ({
            username: m.username,
            content: m.content?.substring(0, 200),
            timestamp: m.createdAt,
          })),
          requestingUser: item.username,
        };

        // Start streaming mode immediately for WebSocket
        streamingStarted = true;
        streamState.isStreaming = true;
        this.activeStreams.set(messageId, streamState);
        this.sendStreamingStarted(messageId, item.group_id);

        // Send streaming request via WebSocket
        await dcqpWebSocket.sendStreamingChat({
          requestId: item.id,
          groupId: item.group_id,
          userId: String(item.user_id),
          username: item.username,
          query: query,
          context: chatContext,
          options: {
            model: DINA_DEFAULT_MODEL, // mistral:7b for fast responses
            maxTokens: this.config.maxResponseLength,
            temperature: 0.7,
          },
          onChunk: (chunk: StreamingChunk) => {
            // Handle streaming chunks from WebSocket
            if (chunk.type === 'start') {
              console.log(`[DINA-STREAM] 🚀 Stream started for ${chunk.requestId}`);
            } else if (chunk.type === 'chunk' && chunk.content) {
              accumulatedChunks.push(chunk.content);
              fullResponse += chunk.content;
              console.log(`[DINA-STREAM] 📝 Chunk ${chunk.chunkIndex}: "${chunk.content.substring(0, 30)}..."`);

              // Emit chunk to clients
              if (streamState.isStreaming) {
                this.emitStreamChunk(streamState, chunk.content);
              }
            } else if (chunk.type === 'done') {
              responseComplete = true;
              console.log(`[DINA-STREAM] ✅ Stream complete: ${chunk.metadata?.totalChunks} chunks in ${chunk.metadata?.processingTime}ms`);
            } else if (chunk.type === 'error') {
              console.error(`[DINA-STREAM] ❌ Stream error: ${chunk.error}`);
              responseComplete = true;
            }
          },
        });

        clearTimeout(timeoutId);

        // Finalize the stream
        await this.finalizeStream(messageId, streamState);
        this.activeStreams.delete(messageId);

        console.log(`[DINA-STREAM] ✅ WebSocket streaming completed. full response: ${fullResponse} Total length: ${fullResponse.length}`);
        resolve({ response: fullResponse, wasStreamed: true });

      } catch (error) {
        clearTimeout(timeoutId);
        this.activeStreams.delete(messageId);
        console.log(`[DINA-STREAM] ❌ WebSocket streaming error:`, error);

        // Fallback to HTTP if WebSocket fails
        console.log(`[DINA-STREAM] 🔄 Falling back to HTTP request...`);
        try {
          const httpResponse = await this.getFullResponseHTTP(item, context, query);
          this.sendCompleteMessage(messageId, item.group_id, httpResponse);
          resolve({ response: httpResponse, wasStreamed: false });
        } catch (httpError) {
          reject(httpError);
        }
      }
    });
  }

  /**
   * Gets a full (non-streaming) response from DINA server
   * Tries WebSocket first, falls back to HTTP
   */
  private async getFullResponse(item: DinaChatQueueItem, context: any, query: string): Promise<string> {
    // Try WebSocket first if connected
    if (dcqpWebSocket.connected) {
      try {
        console.log(`[DINA-FULL] 🔌 Using WebSocket for non-streaming request`);
        const response = await dcqpWebSocket.send({
          target: { module: 'mirror', method: 'mirror_chat', priority: 5 },
          payload: {
            data: {
              requestId: item.id,
              groupId: item.group_id,
              userId: String(item.user_id),
              username: item.username,
              query: query,
              context: {
                groupName: context.groupInfo?.name,
                groupGoal: context.groupInfo?.goal,
                members: context.members?.map((m: any) => m.username),
                recentMessages: context.recentMessages?.slice(-10).map((m: any) => ({
                  username: m.username,
                  content: m.content?.substring(0, 200),
                  timestamp: m.createdAt,
                })),
                requestingUser: item.username,
              },
              options: {
                model_preference: DINA_DEFAULT_MODEL,
                max_tokens: this.config.maxResponseLength,
                temperature: 0.7,
              },
            },
          },
          security: { user_id: String(item.user_id) },
        });

        if (response.status === 'success' && response.payload?.data?.response) {
          return response.payload.data.response;
        }
        throw new Error('Invalid response from WebSocket');
      } catch (wsError) {
        console.log(`[DINA-FULL] ⚠️ WebSocket failed, falling back to HTTP:`, wsError);
      }
    }

    // Fallback to HTTP
    return this.getFullResponseHTTP(item, context, query);
  }

  /**
   * Gets a full (non-streaming) response from DINA server via HTTP
   * Used as fallback when WebSocket is unavailable
   */
  private async getFullResponseHTTP(item: DinaChatQueueItem, context: any, query: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      // Build the Mirror chat endpoint URL (non-streaming)
      const endpoint = buildMirrorChatEndpoint(this.DINA_SERVER_URL, false);
      console.log(`[DINA-FULL] 🌐 Fetching: ${endpoint}`);

      // Create Mirror chat request with full context
      const chatRequest = createMirrorChatRequest({
        requestId: item.id,
        groupId: item.group_id,
        userId: item.user_id,
        username: item.username,
        query: query,
        context: {
          groupName: context.groupInfo?.name,
          groupGoal: context.groupInfo?.goal,
          members: context.members?.map((m: any) => m.username),
          recentMessages: context.recentMessages?.slice(-10).map((m: any) => ({
            username: m.username,
            content: m.content?.substring(0, 200),
            timestamp: m.createdAt,
          })),
          requestingUser: item.username,
        },
        options: {
          model: DINA_DEFAULT_MODEL,  // mistral:7b for fast responses
          max_tokens: this.config.maxResponseLength,
          temperature: 0.7,
        },
      });

      console.log(`[DINA-FULL] 📤 Request payload:`, JSON.stringify(chatRequest).substring(0, 500));

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          ...getDinaRequestHeaders(item.id, 'mirror-chat-full'),
          'X-Group-ID': item.group_id,
          'X-User-ID': String(item.user_id),
        },
        body: JSON.stringify(chatRequest),
        signal: controller.signal,
      });

      console.log(`[DINA-FULL] 📥 Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`[DINA-FULL] ❌ Error response: ${errorText}`);
        throw new Error(`DINA server error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      console.log(`[DINA-FULL] 📦 Response data:`, JSON.stringify(data).substring(0, 300));

      if (!data.success && data.status === 'error') {
        throw new Error(data.error || data.payload?.error || 'Unknown error from DINA server');
      }

      // Extract response from Mirror chat format: { success, response, ... }
      if (data.response) {
        return data.response;
      }

      // Fallback to standardized response extraction
      return extractDinaResponseContent(data);

    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ============================================================================
  // STREAMING HELPERS
  // ============================================================================

  private emitStreamChunk(state: StreamingState, chunk: string): void {
    state.accumulatedContent += chunk;
    state.chunkIndex++;
    state.lastChunkTime = Date.now();

    broadcastToGroup(state.groupId, {
      type: 'dina:stream_chunk',
      payload: {
        messageId: state.messageId,
        chunk,
        chunkIndex: state.chunkIndex,
        accumulatedLength: state.accumulatedContent.length,
      },
      timestamp: new Date().toISOString(),
    });
  }

  private sendStreamingStarted(messageId: string, groupId: string): void {
    console.log(`[DINA-WS] 📡 Sending stream_start to group ${groupId}`);
    broadcastToGroup(groupId, {
      type: 'dina:stream_start',
      payload: {
        messageId,
        senderUserId: this.DINA_USER_ID,
        senderUsername: this.DINA_USERNAME,
      },
      timestamp: new Date().toISOString(),
    });
  }

  private async finalizeStream(messageId: string, state: StreamingState): Promise<void> {
    console.log(`[DINA-WS] 📡 Sending stream_complete to group ${state.groupId}`);
    broadcastToGroup(state.groupId, {
      type: 'dina:stream_complete',
      payload: {
        messageId,
        finalContent: state.accumulatedContent,
        totalChunks: state.chunkIndex,
        totalTime: Date.now() - state.startTime,
      },
      timestamp: new Date().toISOString(),
    });
  }

  private sendCompleteMessage(messageId: string, groupId: string, content: string): void {
    console.log(`[DINA-WS] 📡 Sending complete message to group ${groupId}`);
    broadcastToGroup(groupId, {
      type: 'chat:message',
      payload: {
        id: messageId,
        groupId,
        senderUserId: this.DINA_USER_ID,
        senderUsername: this.DINA_USERNAME,
        content,
        contentType: 'text',
        status: 'sent',
        createdAt: new Date().toISOString(),
        metadata: { isDinaResponse: true },
      },
      timestamp: new Date().toISOString(),
    });
  }

  private sendTypingIndicator(groupId: string, isTyping: boolean): void {
    console.log(`[DINA-WS] ⌨️ Sending typing indicator (${isTyping}) to group ${groupId}`);
    broadcastToGroup(groupId, {
      type: 'chat:typing',
      payload: {
        groupId,
        userId: this.DINA_USER_ID,
        username: this.DINA_USERNAME,
        isTyping,
      },
      timestamp: new Date().toISOString(),
    });
  }

  // ============================================================================
  // CONTEXT & PROMPT BUILDING
  // ============================================================================

  /**
   * Builds rich context for DINA chat using the standardized utility
   * @see utils/dinaMessageUtils.ts buildDinaChatContext
   */
  private async buildDinaContext(item: DinaChatQueueItem): Promise<DinaChatContext & { groupId: string; requestingUser: { id: number; username: string } }> {
    console.log(`[DINA-CONTEXT] 🔧 Building context for group ${item.group_id}...`);

    // Fetch recent messages
    const [recentMessages]: any = await DB.query(
      `SELECT m.content, m.sender_user_id, u.username, m.created_at
       FROM mirror_group_messages m
       LEFT JOIN users u ON u.id = m.sender_user_id
       WHERE m.group_id = ? AND m.is_deleted = 0
       ORDER BY m.created_at DESC
       LIMIT ?`,
      [item.group_id, DINA_DEFAULTS.MAX_CONTEXT_MESSAGES]
    );
    console.log(`[DINA-CONTEXT] 📜 Found ${recentMessages?.length || 0} recent messages`);

    // Fetch group info
    const [groupInfo]: any = await DB.query(
      `SELECT name, description, goal FROM mirror_groups WHERE id = ?`,
      [item.group_id]
    );
    console.log(`[DINA-CONTEXT] 🏠 Group: ${groupInfo[0]?.name || 'Unknown'}`);

    // Fetch members
    const [members]: any = await DB.query(
      `SELECT u.username, mgm.role
       FROM mirror_group_members mgm
       LEFT JOIN users u ON u.id = mgm.user_id
       WHERE mgm.group_id = ? AND mgm.status = 'active'
       LIMIT ?`,
      [item.group_id, DINA_DEFAULTS.MAX_MEMBERS_IN_CONTEXT]
    );
    console.log(`[DINA-CONTEXT] 👥 Found ${members?.length || 0} members`);

    // Parse any original context from the queue item
    const originalContext = safeJsonParse(item.context, {});

    // Build standardized context using utility
    const chatContext = buildDinaChatContext({
      groupInfo: groupInfo[0] || null,
      members: members || [],
      recentMessages: (recentMessages || []).reverse(),
      requestingUser: {
        id: item.user_id,
        username: item.username,
      },
      originalContext,
    });

    // Return enriched context with additional fields for logging
    return {
      ...chatContext,
      groupId: item.group_id,
      requestingUser: {
        id: item.user_id,
        username: item.username,
      },
    };
  }

  private buildSystemPrompt(context: any): string {
    const recentMessagesText = context.recentMessages
      ?.slice(-10)
      .map((m: any) => `${m.username}: ${m.content?.substring(0, 200)}`)
      .join('\n') || 'No recent messages';

    return `You are Dina, an intelligent and friendly AI assistant integrated into Mirror, a group chat application focused on personal growth and meaningful connections.

CONTEXT:
- Group: "${context.groupInfo?.name || 'Unknown Group'}"
- Group Goal: "${context.groupInfo?.goal || 'General discussion'}"
- Members: ${context.members?.map((m: any) => m.username).join(', ') || 'Unknown'}
- User asking: ${context.requestingUser?.username}

RECENT CONVERSATION:
${recentMessagesText}

GUIDELINES:
- Be helpful, concise, and friendly
- Stay relevant to the group context and conversation
- Provide actionable insights when appropriate
- Keep responses under 500 words unless more detail is necessary
- Use a warm but professional tone`;
  }

  // ============================================================================
  // MESSAGE MANAGEMENT
  // ============================================================================

  private async insertPlaceholderMessage(messageId: string, item: DinaChatQueueItem, now: string): Promise<void> {
    console.log(`[DINA-MSG] 📝 Inserting placeholder message ${messageId}...`);

    // Build metadata with reply preview for visual threading
    const metadata = {
      isDinaResponse: true,
      isStreaming: true,
      originalQuery: item.query.substring(0, 200),
      respondingTo: item.username,
      replyPreview: {
        messageId: item.original_message_id,
        senderUsername: item.username,
        content: item.query.substring(0, 100) + (item.query.length > 100 ? '...' : ''),
      },
    };

    await DB.query(
      `INSERT INTO mirror_group_messages
       (id, group_id, sender_user_id, content, content_type, status, parent_message_id, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'text', 'sending', ?, ?, ?, ?)`,
      [
        messageId,
        item.group_id,
        this.DINA_USER_ID,
        '',
        item.original_message_id,
        JSON.stringify(metadata),
        now,
        now,
      ]
    );
    console.log(`[DINA-MSG] ✅ Placeholder message inserted`);
  }

  private async finalizeMessage(messageId: string, item: DinaChatQueueItem, content: string): Promise<void> {
    const now = getMySQLNow(); // MySQL-compatible datetime format
    console.log(`[DINA-MSG] 📝 Finalizing message ${messageId}...`);

    // Build metadata with reply preview for visual threading
    const metadata = {
      isDinaResponse: true,
      isStreaming: false,
      originalQuery: item.query.substring(0, 200),
      respondingTo: item.username,
      replyPreview: {
        messageId: item.original_message_id,
        senderUsername: item.username,
        content: item.query.substring(0, 100) + (item.query.length > 100 ? '...' : ''),
      },
    };

    await DB.query(
      `UPDATE mirror_group_messages
       SET content = ?, status = 'sent', metadata = ?, updated_at = ?
       WHERE id = ?`,
      [
        content,
        JSON.stringify(metadata),
        now,
        messageId,
      ]
    );
    console.log(`[DINA-MSG] ✅ Message finalized`);
  }

  private async insertDinaResponse(messageId: string, item: DinaChatQueueItem, response: string, now: string): Promise<void> {
    console.log(`[DINA-MSG] 📝 Inserting Dina response ${messageId}...`);

    // Build metadata with reply preview for visual threading
    const metadata = {
      isDinaResponse: true,
      originalQuery: item.query.substring(0, 200),
      respondingTo: item.username,
      replyPreview: {
        messageId: item.original_message_id,
        senderUsername: item.username,
        content: item.query.substring(0, 100) + (item.query.length > 100 ? '...' : ''),
      },
    };

    await DB.query(
      `INSERT INTO mirror_group_messages
       (id, group_id, sender_user_id, content, content_type, status, parent_message_id, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'text', 'sent', ?, ?, ?, ?)`,
      [
        messageId,
        item.group_id,
        this.DINA_USER_ID,
        response,
        item.original_message_id,
        JSON.stringify(metadata),
        now,
        now,
      ]
    );

    console.log(`[DINA-MSG] 📡 Broadcasting message to group...`);
    broadcastToGroup(item.group_id, {
      type: 'chat:message',
      payload: {
        id: messageId,
        groupId: item.group_id,
        senderUserId: this.DINA_USER_ID,
        senderUsername: this.DINA_USERNAME,
        content: response,
        contentType: 'text',
        parentMessageId: item.original_message_id,
        status: 'sent',
        createdAt: now,
        metadata,
      },
      timestamp: now,
    });
    console.log(`[DINA-MSG] ✅ Response inserted and broadcast`);
  }

  private async insertDinaErrorResponse(item: DinaChatQueueItem): Promise<void> {
    const response = `I apologize, @${item.username}, but I encountered an issue while processing your request. Please try again in a moment.`;
    const messageId = uuidv4();
    const now = getMySQLNow(); // MySQL-compatible datetime format

    console.log(`[DINA-MSG] ❌ Inserting error response for ${item.id}...`);

    // Build metadata with reply preview for visual threading
    const metadata = {
      isDinaResponse: true,
      isError: true,
      replyPreview: {
        messageId: item.original_message_id,
        senderUsername: item.username,
        content: item.query.substring(0, 100) + (item.query.length > 100 ? '...' : ''),
      },
    };

    await DB.query(
      `INSERT INTO mirror_group_messages
       (id, group_id, sender_user_id, content, content_type, status, parent_message_id, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'text', 'sent', ?, ?, ?, ?)`,
      [
        messageId,
        item.group_id,
        this.DINA_USER_ID,
        response,
        item.original_message_id,
        JSON.stringify(metadata),
        now,
        now,
      ]
    );

    broadcastToGroup(item.group_id, {
      type: 'chat:message',
      payload: {
        id: messageId,
        groupId: item.group_id,
        senderUserId: this.DINA_USER_ID,
        senderUsername: this.DINA_USERNAME,
        content: response,
        contentType: 'text',
        parentMessageId: item.original_message_id,
        status: 'sent',
        createdAt: now,
        metadata,
      },
      timestamp: now,
    });
  }

  // ============================================================================
  // DATABASE & UTILITY HELPERS
  // ============================================================================

  private async updateItemStatus(id: string, status: string, updates: Record<string, any> = {}): Promise<void> {
    const fields: string[] = ['status = ?', 'updated_at = NOW()'];
    const values: any[] = [status];

    for (const [key, value] of Object.entries(updates)) {
      if (value instanceof Date) {
        fields.push(`${key} = ?`);
        values.push(value);
      } else if (typeof value === 'object' && value !== null) {
        fields.push(`${key} = ?`);
        values.push(JSON.stringify(value));
      } else {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    values.push(id);

    await DB.query(
      `UPDATE mirror_dina_chat_queue SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
  }

  private calculateRetryDelay(retryCount: number): number {
    const exponentialDelay = this.config.baseRetryDelayMs * Math.pow(2, retryCount);
    const jitter = Math.random() * 1000;
    return Math.min(exponentialDelay + jitter, this.config.maxRetryDelayMs);
  }

  private updateAverageProcessingTime(newTime: number): void {
    const totalProcessed = this.stats.succeeded;
    if (totalProcessed === 0) {
      this.stats.averageProcessingTimeMs = newTime;
    } else {
      this.stats.averageProcessingTimeMs =
        (this.stats.averageProcessingTimeMs * (totalProcessed - 1) + newTime) / totalProcessed;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================================================
  // MONITORING & STATS
  // ============================================================================

  async getQueueStats(): Promise<{
    queue: { pending: number; processing: number; completed: number; failed: number };
    processor: ProcessorStats;
    health: { status: string; circuitBreaker: string; activeStreams: number };
  }> {
    const [rows]: any = await DB.query(
      `SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM mirror_dina_chat_queue
       WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)`
    );

    const queueStats = rows[0] || {};
    this.stats.circuitBreakerState = this.circuitBreaker.getState();

    return {
      queue: {
        pending: queueStats.pending || 0,
        processing: queueStats.processing || 0,
        completed: queueStats.completed || 0,
        failed: queueStats.failed || 0,
      },
      processor: { ...this.stats },
      health: {
        status: this.isRunning ? 'running' : 'stopped',
        circuitBreaker: this.circuitBreaker.getState(),
        activeStreams: this.activeStreams.size,
      },
    };
  }

  isActive(): boolean {
    return this.isRunning;
  }

  isStreamingEnabled(): boolean {
    return this.config.streaming.enabled;
  }

  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }
}

// ============================================================================
// SINGLETON & EXPORTS
// ============================================================================

let instance: DinaChatQueueProcessor | null = null;

export function getDinaChatQueueProcessor(): DinaChatQueueProcessor {
  if (!instance) {
    instance = new DinaChatQueueProcessor();
  }
  return instance;
}

export async function startDinaChatQueueProcessor(): Promise<DinaChatQueueProcessor> {
  const processor = getDinaChatQueueProcessor();
  await processor.start();
  return processor;
}

export async function stopDinaChatQueueProcessor(): Promise<void> {
  if (instance) {
    await instance.stop();
  }
}

export default DinaChatQueueProcessor;

// ============================================================================
// STANDALONE ENTRY POINT - Run as separate process via PM2/systemd
// ============================================================================
// Usage: npx ts-node workers/DinaChatQueueProcessor.ts
//    or: node dist/workers/DinaChatQueueProcessor.js (after compilation)
//
// PM2 example:
//   pm2 start dist/workers/DinaChatQueueProcessor.js --name "dina-chat-processor"
//
// This ensures the processor runs completely independently from mirror-server,
// providing true non-blocking async processing for @Dina chat messages.
// ============================================================================

if (require.main === module) {
  const dinaBaseUrl = process.env.DINA_BASE_URL || 'http://localhost:8445';
  const dinaWsUrl = process.env.DINA_WS_URL || 'wss://localhost:8445/dina/ws';
  const dinaChatEndpoint = process.env.DINA_ENDPOINT || `${dinaBaseUrl}/api/v1/models/mistral:7b/chat`;

  console.log('\n');
  console.log('='.repeat(60));
  console.log('🤖 @DINA CHAT QUEUE PROCESSOR - STANDALONE MODE');
  console.log('='.repeat(60));
  console.log(`📅 Started: ${new Date().toISOString()}`);
  console.log(`🌐 DINA Base URL: ${dinaBaseUrl}`);
  console.log(`🔌 DINA WebSocket: ${dinaWsUrl}`);
  console.log(`🎯 DINA Chat Endpoint: ${dinaChatEndpoint}`);
  console.log(`🌊 Streaming: ${process.env.DINA_STREAMING_ENABLED !== 'false' ? 'ENABLED' : 'DISABLED'}`);
  console.log(`⏱️  Poll Interval: ${process.env.DINA_CHAT_POLL_INTERVAL || '2000'}ms`);
  console.log(`📊 Max Concurrent: ${process.env.DINA_CHAT_MAX_CONCURRENT || '5'}`);
  console.log(`🔧 Log Level: ${process.env.DINA_LOG_LEVEL || 'debug'}`);
  console.log(`👤 DINA User ID: ${process.env.DINA_USER_ID_SQL || '59'}`);
  console.log('='.repeat(60));
  console.log('\n');

  // Keep the process alive
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  });

  // STANDALONE MODE: Create DCQP's own WebSocket connection
  // This is separate from mirror-server's connection since we're a different process
  console.log('─'.repeat(60));
  console.log('🔌 DCQP WEBSOCKET INITIALIZATION');
  console.log('─'.repeat(60));
  console.log(`   Target: ${dinaWsUrl}`);
  console.log('   Creating dedicated connection for DCQP...');

  // Create DCQP's own WebSocket instance using the shared handler
  dcqpWebSocket = createDinaWebSocket('DCQP', { url: dinaWsUrl });

  // Initialize the WebSocket connection, then start the processor
  dcqpWebSocket.initialize()
    .then(() => {
      console.log('─'.repeat(60));
      console.log('✅ [DCQP] WSS TO DINA-SERVER INITIATED');
      console.log('─'.repeat(60));
      console.log(`   Connection ID: ${dcqpWebSocket.getConnectionId()}`);
      console.log('─'.repeat(60) + '\n');
      return startDinaChatQueueProcessor();
    })
    .catch((wsError) => {
      console.log('─'.repeat(60));
      console.warn('⚠️ [DCQP] WSS TO DINA-SERVER FAILED');
      console.log('─'.repeat(60));
      console.warn(`   Error: ${wsError.message}`);
      console.warn('   Continuing with HTTP fallback...');
      console.log('─'.repeat(60) + '\n');
      // Still start processor - it will use HTTP fallback
      return startDinaChatQueueProcessor();
    })
    .then((processor) => {
      console.log('\n');
      console.log('✅'.repeat(30));
      console.log('✅ @DINA CHAT QUEUE PROCESSOR STARTED SUCCESSFULLY');
      console.log('✅'.repeat(30));
      console.log('📡 Polling queue for @Dina mentions...');
      console.log('💡 Press Ctrl+C to stop');
      console.log('\n');
    })
    .catch((error) => {
      console.error('\n');
      console.error('❌'.repeat(30));
      console.error('❌ FAILED TO START @DINA CHAT QUEUE PROCESSOR');
      console.error('❌'.repeat(30));
      console.error('Error:', error.message);
      console.error('Stack:', error.stack);
      console.error('\n');
      process.exit(1);
    });
}
