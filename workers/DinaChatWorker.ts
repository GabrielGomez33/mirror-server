// ============================================================================
// DINA CHAT WORKER - Worker Thread for Queue Processing
// ============================================================================
// File: workers/DinaChatWorker.ts
//
// Purpose: Runs as a Worker Thread, processing items from the Dina chat queue.
// Communicates with ProcessorOrchestrator via message passing.
//
// This file is spawned by ProcessorOrchestrator and should not be run directly.
// ============================================================================

import { parentPort, workerData } from 'worker_threads';
import { v4 as uuidv4 } from 'uuid';
import { DB } from '../db';

// ============================================================================
// TYPES
// ============================================================================

interface WorkerConfig {
  pollIntervalMs: number;
  maxConcurrent: number;
  maxRetries: number;
  streamingEnabled: boolean;
  timeoutMs: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
}

interface QueueItem {
  id: string;
  group_id: string;
  user_id: number;
  username: string;
  query: string;
  original_message_id: string;
  status: string;
  priority: number;
  retry_count: number;
  next_retry_at: Date | null;
  context: string | null;
}

interface StreamingState {
  messageId: string;
  groupId: string;
  accumulatedContent: string;
  chunkIndex: number;
  startTime: number;
}

// ============================================================================
// WORKER STATE
// ============================================================================

const { workerId, config: initialConfig } = workerData as { workerId: string; config: Partial<WorkerConfig> };

const config: WorkerConfig = {
  pollIntervalMs: initialConfig.pollIntervalMs || 2000,
  maxConcurrent: initialConfig.maxConcurrent || 3,
  maxRetries: initialConfig.maxRetries || 3,
  streamingEnabled: initialConfig.streamingEnabled !== false,
  timeoutMs: parseInt(process.env.DINA_TIMEOUT || '30000', 10),
  baseRetryDelayMs: 5000,
  maxRetryDelayMs: 60000,
};

const DINA_USER_ID = parseInt(process.env.DINA_USER_ID_SQL || '59', 10);
const DINA_USERNAME = 'Dina';
const DINA_SERVER_URL = process.env.DINA_BASE_URL || 'http://localhost:8445';
// Use Mirror chat streaming endpoint (NEW)
const DINA_CHAT_ENDPOINT_STREAM = process.env.DINA_CHAT_STREAM_ENDPOINT ||
  `${DINA_SERVER_URL}/api/v1/mirror/chat/stream`;
const DINA_CHAT_ENDPOINT = process.env.DINA_CHAT_ENDPOINT ||
  `${DINA_SERVER_URL}/api/v1/mirror/chat`;
// Default model: mistral:7b for faster responses
const DEFAULT_MODEL = 'mistral:7b';
const STREAM_DECISION_DELAY_MS = parseInt(process.env.DINA_STREAM_DECISION_DELAY || '250', 10);

let isRunning = true;
let processingCount = 0;
let pollTimer: NodeJS.Timeout | null = null;
let hasBroadcast = false;

// Pending rate limit requests
const pendingRateLimitChecks: Map<string, (canProcess: boolean) => void> = new Map();

// Stats
const stats = {
  processed: 0,
  succeeded: 0,
  failed: 0,
  streamed: 0,
};

// ============================================================================
// LOGGING
// ============================================================================

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: any): void {
  const timestamp = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  const formattedMsg = `[${timestamp}] [${level.toUpperCase()}] [Worker:${workerId.substring(0, 8)}] ${message}${metaStr}`;

  if (level === 'error') {
    console.error(formattedMsg);
  } else if (level === 'warn') {
    console.warn(formattedMsg);
  } else {
    console.log(formattedMsg);
  }
}

// ============================================================================
// MESSAGE HANDLING FROM ORCHESTRATOR
// ============================================================================

parentPort?.on('message', (message) => {
  switch (message.type) {
    case 'stop':
      log('info', 'Received stop signal');
      gracefulStop();
      break;

    case 'config':
      if (message.payload.hasBroadcast !== undefined) {
        hasBroadcast = message.payload.hasBroadcast;
      }
      break;

    case 'rate_limit_response':
      const resolver = pendingRateLimitChecks.get(message.requestId);
      if (resolver) {
        resolver(message.canProcess);
        pendingRateLimitChecks.delete(message.requestId);
      }
      break;
  }
});

// ============================================================================
// BROADCAST HELPER
// ============================================================================

function broadcast(groupId: string, payload: any): void {
  if (hasBroadcast) {
    parentPort?.postMessage({
      type: 'processed',
      broadcast: { groupId, payload },
    });
  }
}

// ============================================================================
// RATE LIMIT CHECK (Via Orchestrator)
// ============================================================================

async function checkRateLimit(userId: number): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = uuidv4();
    pendingRateLimitChecks.set(requestId, resolve);

    parentPort?.postMessage({
      type: 'rate_limit_check',
      userId,
      requestId,
    });

    // Timeout fallback - allow if no response
    setTimeout(() => {
      if (pendingRateLimitChecks.has(requestId)) {
        pendingRateLimitChecks.delete(requestId);
        resolve(true);
      }
    }, 1000);
  });
}

// ============================================================================
// POLLING LOOP
// ============================================================================

async function poll(): Promise<void> {
  if (!isRunning) return;

  try {
    if (processingCount >= config.maxConcurrent) {
      schedulePoll();
      return;
    }

    const availableSlots = config.maxConcurrent - processingCount;
    const items = await fetchPendingItems(availableSlots);

    if (items.length > 0) {
      log('debug', `Found ${items.length} pending items`);
      const promises = items.map(item => processItem(item));
      await Promise.allSettled(promises);
    }
  } catch (error) {
    log('error', 'Error in poll cycle', { error: (error as Error).message });
  }

  schedulePoll();
}

function schedulePoll(): void {
  if (isRunning && !pollTimer) {
    pollTimer = setTimeout(() => {
      pollTimer = null;
      poll();
    }, config.pollIntervalMs);
  }
}

async function fetchPendingItems(limit: number): Promise<QueueItem[]> {
  const [rows]: any = await DB.query(
    `SELECT * FROM mirror_dina_chat_queue
     WHERE status = 'pending'
       AND (next_retry_at IS NULL OR next_retry_at <= NOW())
     ORDER BY priority ASC, created_at ASC
     LIMIT ?
     FOR UPDATE SKIP LOCKED`,
    [limit]
  );
  return rows as QueueItem[];
}

// ============================================================================
// ITEM PROCESSING
// ============================================================================

async function processItem(item: QueueItem): Promise<void> {
  const startTime = Date.now();
  processingCount++;
  stats.processed++;

  log('info', 'Processing item', { itemId: item.id.substring(0, 8), userId: item.user_id });

  try {
    // Check rate limit via orchestrator
    const canProcess = await checkRateLimit(item.user_id);
    if (!canProcess) {
      log('warn', 'Rate limit exceeded', { userId: item.user_id });
      await updateItemStatus(item.id, 'pending', {
        next_retry_at: new Date(Date.now() + 60000),
        last_error: 'Rate limit exceeded',
      });
      return;
    }

    // Mark as processing
    await updateItemStatus(item.id, 'processing', { started_at: new Date() });

    // Sanitize query
    const query = sanitizeQuery(item.query);
    if (!query) {
      throw new Error('Invalid or empty query');
    }

    // Build context
    const context = await buildContext(item);

    // Create message ID
    const messageId = uuidv4();
    const now = new Date().toISOString();

    // Send typing indicator
    sendTypingIndicator(item.group_id, true);

    let response: string;
    let wasStreamed = false;

    if (config.streamingEnabled) {
      // Insert placeholder for streaming
      await insertPlaceholderMessage(messageId, item, now);

      // Process with delayed decision streaming
      const result = await processWithStreaming(item, messageId, context, query);
      response = result.response;
      wasStreamed = result.wasStreamed;

      // Finalize message
      await finalizeMessage(messageId, item, response);
    } else {
      // Non-streaming
      response = await getFullResponse(item, context, query);
      await insertDinaResponse(messageId, item, response, now);
    }

    // Stop typing
    sendTypingIndicator(item.group_id, false);

    const processingTimeMs = Date.now() - startTime;

    // Mark completed
    await updateItemStatus(item.id, 'completed', {
      response: response.substring(0, 8000),
      processing_time_ms: processingTimeMs,
      completed_at: new Date(),
    });

    stats.succeeded++;
    if (wasStreamed) stats.streamed++;

    log('info', 'Item processed successfully', { itemId: item.id.substring(0, 8), processingTimeMs, wasStreamed });

    // Notify orchestrator
    parentPort?.postMessage({ type: 'processed', itemId: item.id, success: true });

  } catch (error) {
    const errorMessage = (error as Error).message;
    log('error', 'Processing failed', { itemId: item.id.substring(0, 8), error: errorMessage });

    sendTypingIndicator(item.group_id, false);

    if (item.retry_count < config.maxRetries) {
      const retryDelay = calculateRetryDelay(item.retry_count);
      await updateItemStatus(item.id, 'pending', {
        retry_count: item.retry_count + 1,
        next_retry_at: new Date(Date.now() + retryDelay),
        last_error: errorMessage,
      });
    } else {
      await updateItemStatus(item.id, 'failed', {
        last_error: errorMessage,
        completed_at: new Date(),
      });
      stats.failed++;
      await insertErrorResponse(item);
    }

    parentPort?.postMessage({ type: 'error', itemId: item.id, error: errorMessage });

  } finally {
    processingCount--;
  }
}

// ============================================================================
// STREAMING PROCESSING
// ============================================================================

async function processWithStreaming(
  item: QueueItem,
  messageId: string,
  context: any,
  query: string
): Promise<{ response: string; wasStreamed: boolean }> {
  const systemPrompt = buildSystemPrompt(context);

  return new Promise(async (resolve, reject) => {
    let responseComplete = false;
    let fullResponse = '';
    let streamingStarted = false;
    let accumulatedChunks: string[] = [];

    const streamState: StreamingState = {
      messageId,
      groupId: item.group_id,
      accumulatedContent: '',
      chunkIndex: 0,
      startTime: Date.now(),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      // Build Mirror chat request with context
      // The DINA server's MirrorChatProcessor builds the system prompt
      const context = item.context ? JSON.parse(item.context) : {};

      const chatRequest = {
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
          model_preference: DEFAULT_MODEL,  // mistral:7b for fast responses
          max_tokens: 500,
          temperature: 0.7,
        },
      };

      log('info', `[DINA-STREAM] Fetching: ${DINA_CHAT_ENDPOINT_STREAM}`);

      const response = await fetch(DINA_CHAT_ENDPOINT_STREAM, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': item.id,
          'X-Worker-ID': workerId,
          'X-Group-ID': item.group_id,
          'X-Source': 'mirror-chat-worker',
        },
        body: JSON.stringify(chatRequest),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`DINA streaming error: ${response.status}`);
      }

      const contentType = response.headers.get('content-type');
      const isStreamingResponse = contentType?.includes('text/event-stream') ||
                                   contentType?.includes('application/x-ndjson');

      if (!isStreamingResponse) {
        const data = await response.json();
        fullResponse = data.data?.content || data.synthesis || data.response ||
          'I apologize, but I was unable to generate a response.';
        sendCompleteMessage(messageId, item.group_id, fullResponse);
        resolve({ response: fullResponse, wasStreamed: false });
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body reader');
      }

      const decoder = new TextDecoder();

      const readPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').filter(line => line.trim());

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'chunk' && data.content) {
                  accumulatedChunks.push(data.content);
                  fullResponse += data.content;

                  if (streamingStarted) {
                    emitStreamChunk(streamState, data.content);
                  }
                } else if (data.type === 'complete') {
                  responseComplete = true;
                  if (data.content) fullResponse = data.content;
                }
              } catch (e) {
                // Ignore parse errors
              }
            }
          }
        }
      })();

      // Wait for decision delay
      await sleep(STREAM_DECISION_DELAY_MS);

      if (responseComplete) {
        sendCompleteMessage(messageId, item.group_id, fullResponse);
        resolve({ response: fullResponse, wasStreamed: false });
        return;
      }

      // Start streaming
      log('debug', 'Starting streaming', { itemId: item.id.substring(0, 8) });
      streamingStarted = true;

      sendStreamingStarted(messageId, item.group_id);

      // Emit accumulated chunks
      for (const chunk of accumulatedChunks) {
        emitStreamChunk(streamState, chunk);
      }

      await readPromise;

      finalizeStream(messageId, streamState);

      resolve({ response: fullResponse, wasStreamed: true });

    } catch (error) {
      clearTimeout(timeoutId);
      reject(error);
    }
  });
}

async function getFullResponse(item: QueueItem, context: any, query: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    // Build Mirror chat request with context
    const chatRequest = {
      requestId: item.id,
      groupId: item.group_id,
      userId: String(item.user_id),
      username: item.username,
      query: query,
      context: {
        groupName: context?.groupInfo?.name,
        groupGoal: context?.groupInfo?.goal,
        members: context?.members?.map((m: any) => m.username),
        recentMessages: context?.recentMessages?.slice(-10).map((m: any) => ({
          username: m.username,
          content: m.content?.substring(0, 200),
          timestamp: m.createdAt,
        })),
        requestingUser: item.username,
      },
      options: {
        model_preference: DEFAULT_MODEL,  // mistral:7b for fast responses
        max_tokens: 500,
        temperature: 0.7,
      },
    };

    log('info', `[DINA-FULL] Fetching: ${DINA_CHAT_ENDPOINT}`);

    const response = await fetch(DINA_CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': item.id,
        'X-Worker-ID': workerId,
        'X-Group-ID': item.group_id,
        'X-Source': 'mirror-chat-worker',
      },
      body: JSON.stringify(chatRequest),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`DINA error: ${response.status}`);
    }

    const data = await response.json();
    // Extract response from Mirror chat format
    return data.response || data.data?.content || data.synthesis ||
      'I apologize, but I was unable to generate a response.';

  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// STREAMING HELPERS
// ============================================================================

function emitStreamChunk(state: StreamingState, chunk: string): void {
  state.accumulatedContent += chunk;
  state.chunkIndex++;

  broadcast(state.groupId, {
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

function sendStreamingStarted(messageId: string, groupId: string): void {
  broadcast(groupId, {
    type: 'dina:stream_start',
    payload: {
      messageId,
      senderUserId: DINA_USER_ID,
      senderUsername: DINA_USERNAME,
    },
    timestamp: new Date().toISOString(),
  });
}

function finalizeStream(messageId: string, state: StreamingState): void {
  broadcast(state.groupId, {
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

function sendCompleteMessage(messageId: string, groupId: string, content: string): void {
  broadcast(groupId, {
    type: 'chat:message',
    payload: {
      id: messageId,
      groupId,
      senderUserId: DINA_USER_ID,
      senderUsername: DINA_USERNAME,
      content,
      contentType: 'text',
      status: 'sent',
      createdAt: new Date().toISOString(),
      metadata: { isDinaResponse: true },
    },
    timestamp: new Date().toISOString(),
  });
}

function sendTypingIndicator(groupId: string, isTyping: boolean): void {
  broadcast(groupId, {
    type: 'chat:typing',
    payload: {
      groupId,
      userId: DINA_USER_ID,
      username: DINA_USERNAME,
      isTyping,
    },
    timestamp: new Date().toISOString(),
  });
}

// ============================================================================
// CONTEXT BUILDING
// ============================================================================

async function buildContext(item: QueueItem): Promise<any> {
  const [recentMessages]: any = await DB.query(
    `SELECT m.content, m.sender_user_id, u.username, m.created_at
     FROM mirror_group_messages m
     LEFT JOIN users u ON u.id = m.sender_user_id
     WHERE m.group_id = ? AND m.is_deleted = 0
     ORDER BY m.created_at DESC
     LIMIT 15`,
    [item.group_id]
  );

  const [groupInfo]: any = await DB.query(
    `SELECT name, description, goal FROM mirror_groups WHERE id = ?`,
    [item.group_id]
  );

  const [members]: any = await DB.query(
    `SELECT u.username, mgm.role
     FROM mirror_group_members mgm
     LEFT JOIN users u ON u.id = mgm.user_id
     WHERE mgm.group_id = ? AND mgm.status = 'active'
     LIMIT 20`,
    [item.group_id]
  );

  return {
    groupId: item.group_id,
    groupInfo: groupInfo[0] || {},
    members,
    recentMessages: (recentMessages || []).reverse(),
    requestingUser: {
      id: item.user_id,
      username: item.username,
    },
  };
}

function buildSystemPrompt(context: any): string {
  const recentMessagesText = context.recentMessages
    ?.slice(-10)
    .map((m: any) => `${m.username}: ${m.content?.substring(0, 200)}`)
    .join('\n') || 'No recent messages';

  return `You are Dina, an intelligent and friendly AI assistant integrated into Mirror, a group chat application focused on personal growth.

CONTEXT:
- Group: "${context.groupInfo?.name || 'Unknown Group'}"
- Goal: "${context.groupInfo?.goal || 'General discussion'}"
- User asking: ${context.requestingUser?.username}

RECENT CONVERSATION:
${recentMessagesText}

GUIDELINES:
- Be helpful, concise, and friendly
- Keep responses under 500 words
- Use a warm but professional tone`;
}

// ============================================================================
// DATABASE HELPERS
// ============================================================================

async function insertPlaceholderMessage(messageId: string, item: QueueItem, now: string): Promise<void> {
  await DB.query(
    `INSERT INTO mirror_group_messages
     (id, group_id, sender_user_id, content, content_type, status, parent_message_id, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'text', 'sending', ?, ?, ?, ?)`,
    [
      messageId,
      item.group_id,
      DINA_USER_ID,
      '',
      item.original_message_id,
      JSON.stringify({ isDinaResponse: true, isStreaming: true }),
      now,
      now,
    ]
  );
}

async function finalizeMessage(messageId: string, item: QueueItem, content: string): Promise<void> {
  await DB.query(
    `UPDATE mirror_group_messages
     SET content = ?, status = 'sent', metadata = ?, updated_at = ?
     WHERE id = ?`,
    [
      content,
      JSON.stringify({ isDinaResponse: true, isStreaming: false }),
      new Date().toISOString(),
      messageId,
    ]
  );
}

async function insertDinaResponse(messageId: string, item: QueueItem, response: string, now: string): Promise<void> {
  await DB.query(
    `INSERT INTO mirror_group_messages
     (id, group_id, sender_user_id, content, content_type, status, parent_message_id, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'text', 'sent', ?, ?, ?, ?)`,
    [
      messageId,
      item.group_id,
      DINA_USER_ID,
      response,
      item.original_message_id,
      JSON.stringify({ isDinaResponse: true }),
      now,
      now,
    ]
  );

  sendCompleteMessage(messageId, item.group_id, response);
}

async function insertErrorResponse(item: QueueItem): Promise<void> {
  const response = `I apologize, @${item.username}, but I encountered an issue. Please try again.`;
  const messageId = uuidv4();
  const now = new Date().toISOString();

  await DB.query(
    `INSERT INTO mirror_group_messages
     (id, group_id, sender_user_id, content, content_type, status, parent_message_id, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'text', 'sent', ?, ?, ?, ?)`,
    [
      messageId,
      item.group_id,
      DINA_USER_ID,
      response,
      item.original_message_id,
      JSON.stringify({ isDinaResponse: true, isError: true }),
      now,
      now,
    ]
  );

  sendCompleteMessage(messageId, item.group_id, response);
}

async function updateItemStatus(id: string, status: string, updates: Record<string, any> = {}): Promise<void> {
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

// ============================================================================
// UTILITIES
// ============================================================================

function sanitizeQuery(input: string): string {
  if (!input || typeof input !== 'string') return '';
  return input.replace(/\0/g, '').replace(/\s+/g, ' ').trim().substring(0, 4000);
}

function calculateRetryDelay(retryCount: number): number {
  const exponentialDelay = config.baseRetryDelayMs * Math.pow(2, retryCount);
  const jitter = Math.random() * 1000;
  return Math.min(exponentialDelay + jitter, config.maxRetryDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function gracefulStop(): Promise<void> {
  log('info', 'Initiating graceful stop');
  isRunning = false;

  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  // Wait for current processing to complete
  const maxWait = 30000;
  const startWait = Date.now();

  while (processingCount > 0 && Date.now() - startWait < maxWait) {
    log('debug', `Waiting for ${processingCount} items to complete`);
    await sleep(1000);
  }

  // Send final stats
  parentPort?.postMessage({
    type: 'stats',
    stats: { ...stats },
  });

  log('info', 'Worker stopped', { stats });
  process.exit(0);
}

// ============================================================================
// STARTUP
// ============================================================================

async function start(): Promise<void> {
  log('info', 'Worker starting', { config });

  // Signal ready to orchestrator
  parentPort?.postMessage({ type: 'ready' });

  // Start polling
  poll();

  // Periodic stats reporting
  setInterval(() => {
    parentPort?.postMessage({
      type: 'stats',
      stats: { ...stats },
    });
  }, 30000);
}

// Start the worker
start().catch(error => {
  log('error', 'Worker failed to start', { error: error.message });
  process.exit(1);
});
