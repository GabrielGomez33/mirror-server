// ============================================================================
// DINA MESSAGE UTILITIES - Standardized Message Creation for DUMP Protocol
// ============================================================================
// File: utils/dinaMessageUtils.ts
//
// Purpose: Provides utilities for creating properly formatted messages
// that comply with the DINA Universal Messaging Protocol (DUMP).
//
// This ensures consistent message structure when communicating with
// the DINA server's mirror module endpoints.
//
// Reference: dina-server/modules/mirror/processors/chatProcessor.ts
// Reference: dina-server/modules/mirror/processors/streamingChatProcessor.ts
// ============================================================================

import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// TYPES - Chat Context Structure (matches DINA server expectations)
// ============================================================================

/**
 * Group information for context building
 */
export interface DinaGroupInfo {
  name: string;
  description?: string;
  goal?: string;
}

/**
 * Group member information
 */
export interface DinaMemberInfo {
  username: string;
  role?: string;
}

/**
 * Recent message for conversation context
 */
export interface DinaRecentMessage {
  username: string;
  content: string;
  createdAt?: string;
}

/**
 * Full chat context as expected by DINA server
 * @see dina-server/modules/mirror/processors/chatProcessor.ts ChatContext
 */
export interface DinaChatContext {
  groupInfo?: DinaGroupInfo;
  members?: DinaMemberInfo[];
  recentMessages?: DinaRecentMessage[];
  originalContext?: Record<string, any>;
}

// ============================================================================
// TYPES - Request/Response Structures
// ============================================================================

/**
 * Chat query request for DINA server (non-streaming)
 * @see dina-server/modules/mirror/processors/chatProcessor.ts ChatQueryRequest
 */
export interface DinaChatRequest {
  requestId: string;
  groupId: string;
  userId: string;
  username: string;
  query: string;
  context: DinaChatContext;
}

/**
 * Streaming chat request for DINA server
 * @see dina-server/modules/mirror/processors/streamingChatProcessor.ts StreamingChatRequest
 */
export interface DinaStreamingChatRequest extends DinaChatRequest {
  streaming: boolean;
}

/**
 * DINA Universal Message structure (full DUMP envelope)
 * Used for Redis queue-based communication
 */
export interface DinaUniversalMessage {
  id: string;
  timestamp: string;
  source: {
    module: string;
    instance: string;
    version?: string;
  };
  target: {
    module: string;
    method: string;
    priority?: string;
  };
  payload: {
    data: Record<string, any>;
    metadata?: Record<string, any>;
  };
  security: {
    user_id: string;
    session_id?: string;
    security_level?: string;
  };
  trace: {
    request_id: string;
    queue_time_ms?: number;
    created_at?: string;
  };
}

/**
 * Response from DINA chat endpoint
 */
export interface DinaChatResponse {
  success: boolean;
  data?: {
    content: string;
    metadata?: {
      processingTimeMs: number;
      modelUsed?: string;
      confidence?: number;
      tokensUsed?: number;
    };
  };
  error?: string;
  synthesis?: string;  // Legacy field
  response?: string;   // Legacy field
}

// ============================================================================
// MESSAGE CREATION UTILITIES
// ============================================================================

/**
 * Creates a properly formatted chat request for DINA server
 *
 * @example
 * const request = createDinaChatRequest({
 *   groupId: 'group-123',
 *   userId: '456',
 *   username: 'john_doe',
 *   query: 'What is the purpose of our group?',
 *   context: {
 *     groupInfo: { name: 'Study Group', goal: 'Learn together' },
 *     members: [{ username: 'john_doe', role: 'member' }],
 *     recentMessages: [{ username: 'jane', content: 'Hello everyone!' }]
 *   }
 * });
 */
export function createDinaChatRequest(params: {
  requestId?: string;
  groupId: string;
  userId: string | number;
  username: string;
  query: string;
  context?: DinaChatContext;
}): DinaChatRequest {
  return {
    requestId: params.requestId || uuidv4(),
    groupId: params.groupId,
    userId: String(params.userId),
    username: params.username,
    query: params.query,
    context: params.context || {},
  };
}

/**
 * Creates a streaming chat request for DINA server
 *
 * @example
 * const request = createDinaStreamingChatRequest({
 *   groupId: 'group-123',
 *   userId: '456',
 *   username: 'john_doe',
 *   query: 'Tell me about our group dynamics',
 *   context: myContext,
 *   streaming: true
 * });
 */
export function createDinaStreamingChatRequest(params: {
  requestId?: string;
  groupId: string;
  userId: string | number;
  username: string;
  query: string;
  context?: DinaChatContext;
  streaming?: boolean;
}): DinaStreamingChatRequest {
  return {
    ...createDinaChatRequest(params),
    streaming: params.streaming !== false, // Default to true
  };
}

/**
 * DINA API Request - matches the format expected by DINA server's
 * /api/v1/models/:modelId/chat endpoint
 */
export interface DinaApiChatRequest {
  query: string;
  options?: {
    model_preference?: string;
    max_tokens?: number;
    temperature?: number;
    conversation_id?: string;
    include_context?: boolean;
    user_id?: string;
  };
}

/**
 * Creates a properly formatted request for DINA's LLM API
 * This is the format expected by /api/v1/models/:modelId/chat
 *
 * @param systemPrompt - Context/instructions for the LLM (prepended to query)
 * @param userQuery - The actual user question
 * @param options - Additional options for the LLM
 *
 * @example
 * const request = createDinaApiRequest(
 *   'You are Dina, a helpful assistant...',
 *   'What are our group strengths?',
 *   { max_tokens: 1500, user_id: 'user123' }
 * );
 */
export function createDinaApiRequest(
  systemPrompt: string,
  userQuery: string,
  options?: {
    model?: string;
    max_tokens?: number;
    temperature?: number;
    conversation_id?: string;
    user_id?: string;
  }
): DinaApiChatRequest {
  // Combine system prompt and user query for context-aware response
  const fullQuery = systemPrompt
    ? `${systemPrompt}\n\nUSER QUESTION:\n${userQuery}`
    : userQuery;

  return {
    query: fullQuery,
    options: {
      model_preference: options?.model || DINA_DEFAULT_MODEL,
      max_tokens: options?.max_tokens || 1500,
      temperature: options?.temperature || 0.7,
      conversation_id: options?.conversation_id,
      user_id: options?.user_id,
      include_context: false, // We handle context in the system prompt
    },
  };
}

/**
 * Builds the LLM endpoint URL for a specific model
 * @param baseUrl - The DINA server base URL
 * @param model - The model ID (e.g., 'llama2:70b', 'mistral:7b')
 */
export function buildDinaLlmEndpoint(baseUrl: string, model: string = DINA_DEFAULT_MODEL): string {
  return `${baseUrl}${DINA_ENDPOINTS.LLM_CHAT}/${model}/chat`;
}

/**
 * Builds the Mirror chat streaming endpoint URL
 * @param baseUrl - The DINA server base URL
 * @param streaming - Whether to use the streaming endpoint (default: true)
 */
export function buildMirrorChatEndpoint(baseUrl: string, streaming: boolean = true): string {
  const endpoint = streaming ? DINA_ENDPOINTS.MIRROR_CHAT_STREAM : DINA_ENDPOINTS.MIRROR_CHAT;
  return `${baseUrl}${endpoint}`;
}

/**
 * Creates a Mirror chat request payload for the new streaming endpoint
 * @param params - Chat request parameters
 */
export function createMirrorChatRequest(params: {
  requestId: string;
  groupId: string;
  userId: string | number;
  username: string;
  query: string;
  context?: {
    groupName?: string;
    groupGoal?: string;
    members?: string[];
    recentMessages?: Array<{ username: string; content: string; timestamp?: string }>;
    requestingUser?: string;
  };
  options?: {
    model?: string;
    max_tokens?: number;
    temperature?: number;
  };
}): Record<string, any> {
  return {
    requestId: params.requestId,
    groupId: params.groupId,
    userId: String(params.userId),
    username: params.username,
    query: params.query,
    context: params.context,
    options: {
      model_preference: params.options?.model || DINA_DEFAULT_MODEL,
      max_tokens: params.options?.max_tokens || 500,
      temperature: params.options?.temperature || 0.7,
    },
  };
}

/**
 * Creates a full DINA Universal Message (DUMP envelope)
 * Use this when sending messages through Redis queues
 *
 * @example
 * const message = createDinaUniversalMessage({
 *   method: 'mirror_chat',
 *   userId: '456',
 *   payload: chatRequest
 * });
 */
export function createDinaUniversalMessage(params: {
  method: string;
  userId: string | number;
  sessionId?: string;
  payload: Record<string, any>;
  priority?: 'critical' | 'high' | 'normal' | 'low' | 'batch';
  sourceModule?: string;
  sourceInstance?: string;
}): DinaUniversalMessage {
  const requestId = uuidv4();
  const timestamp = new Date().toISOString();

  return {
    id: requestId,
    timestamp,
    source: {
      module: params.sourceModule || 'mirror',
      instance: params.sourceInstance || 'mirror-server',
      version: '2.0.0',
    },
    target: {
      module: 'mirror',
      method: params.method,
      priority: params.priority || 'normal',
    },
    payload: {
      data: params.payload,
      metadata: {
        created_at: timestamp,
        request_type: params.method,
      },
    },
    security: {
      user_id: String(params.userId),
      session_id: params.sessionId || `session_${Date.now()}`,
      security_level: 'standard',
    },
    trace: {
      request_id: requestId,
      queue_time_ms: 0,
      created_at: timestamp,
    },
  };
}

// ============================================================================
// CONTEXT BUILDING UTILITIES
// ============================================================================

/**
 * Builds a rich DinaChatContext from raw database results
 *
 * @example
 * const context = buildDinaChatContext({
 *   groupInfo: dbGroupRow,
 *   members: dbMembersRows,
 *   recentMessages: dbMessagesRows,
 *   requestingUser: { id: 123, username: 'john' }
 * });
 */
export function buildDinaChatContext(params: {
  groupInfo?: { name?: string; description?: string; goal?: string } | null;
  members?: Array<{ username?: string; role?: string }> | null;
  recentMessages?: Array<{ username?: string; content?: string; created_at?: string }> | null;
  requestingUser?: { id?: number | string; username?: string };
  originalContext?: Record<string, any>;
}): DinaChatContext {
  const context: DinaChatContext = {};

  // Build group info
  if (params.groupInfo) {
    context.groupInfo = {
      name: params.groupInfo.name || 'Unknown Group',
      description: params.groupInfo.description,
      goal: params.groupInfo.goal,
    };
  }

  // Build members list
  if (params.members && params.members.length > 0) {
    context.members = params.members
      .filter(m => m.username)
      .map(m => ({
        username: m.username!,
        role: m.role,
      }));
  }

  // Build recent messages
  if (params.recentMessages && params.recentMessages.length > 0) {
    context.recentMessages = params.recentMessages
      .filter(m => m.username && m.content)
      .map(m => ({
        username: m.username!,
        content: m.content!,
        createdAt: m.created_at,
      }));
  }

  // Include original context if provided
  if (params.originalContext) {
    context.originalContext = params.originalContext;
  }

  return context;
}

// ============================================================================
// RESPONSE PARSING UTILITIES
// ============================================================================

/**
 * Extracts the response content from various DINA response formats
 * Handles both new format and legacy formats
 */
export function extractDinaResponseContent(response: DinaChatResponse | any): string {
  // New format
  if (response?.data?.content) {
    return response.data.content;
  }

  // Legacy formats
  if (response?.synthesis) {
    return response.synthesis;
  }

  if (response?.response) {
    return response.response;
  }

  // Direct content
  if (typeof response?.content === 'string') {
    return response.content;
  }

  // Fallback
  return 'I apologize, but I was unable to generate a response.';
}

/**
 * Safe JSON parse that handles both strings and already-parsed objects
 * Useful for handling MySQL JSON columns that may return objects or strings
 */
export function safeJsonParse<T>(value: any, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }

  // Already an object (parsed by MySQL)
  if (typeof value === 'object') {
    return value as T;
  }

  // String that needs parsing
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  return fallback;
}

// ============================================================================
// HTTP REQUEST UTILITIES
// ============================================================================

/**
 * Standard headers for DINA API requests
 */
export function getDinaRequestHeaders(requestId: string, source: string = 'mirror-server'): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Request-ID': requestId,
    'X-Source': source,
    'X-Protocol-Version': '2.0',
  };
}

/**
 * Creates fetch options for a DINA chat request
 */
export function createDinaFetchOptions(params: {
  requestId: string;
  body: DinaChatRequest | DinaStreamingChatRequest;
  source?: string;
  timeoutMs?: number;
}): RequestInit {
  const controller = new AbortController();

  if (params.timeoutMs) {
    setTimeout(() => controller.abort(), params.timeoutMs);
  }

  return {
    method: 'POST',
    headers: getDinaRequestHeaders(params.requestId, params.source),
    body: JSON.stringify(params.body),
    signal: controller.signal,
  };
}

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

/**
 * Validates a chat request has required fields
 */
export function validateDinaChatRequest(request: Partial<DinaChatRequest>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!request.groupId) {
    errors.push('groupId is required');
  }

  if (!request.userId) {
    errors.push('userId is required');
  }

  if (!request.query || typeof request.query !== 'string') {
    errors.push('query must be a non-empty string');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Sanitizes a query string for safe processing
 */
export function sanitizeDinaQuery(query: string, maxLength: number = 2000): string {
  if (!query || typeof query !== 'string') {
    return '';
  }

  return query
    .trim()
    .substring(0, maxLength)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
    .replace(/<[^>]*>/g, ''); // Remove HTML tags
}

// ============================================================================
// DATE/TIME UTILITIES
// ============================================================================

/**
 * Formats a Date object to MySQL DATETIME format
 * MySQL expects: 'YYYY-MM-DD HH:MM:SS' (no T, no Z, no milliseconds)
 *
 * @example
 * formatMySQLDateTime(new Date()) // '2026-01-08 00:33:23'
 */
export function formatMySQLDateTime(date: Date = new Date()): string {
  return date.toISOString()
    .replace('T', ' ')
    .replace('Z', '')
    .split('.')[0]; // Remove milliseconds
}

/**
 * Gets current timestamp in MySQL DATETIME format
 */
export function getMySQLNow(): string {
  return formatMySQLDateTime(new Date());
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const DINA_METHODS = {
  CHAT: 'mirror_chat',
  CHAT_STREAM: 'mirror_chat_stream',
  GET_INSIGHTS: 'mirror_get_insights',
  GET_PATTERNS: 'mirror_get_patterns',
  ANSWER_QUESTION: 'mirror_answer_question',
  SUBMIT_PROFILE: 'mirror_submit_profile',
  FEEDBACK: 'mirror_feedback',
} as const;

// DINA API v1 endpoints - use these for actual DINA server communication
export const DINA_ENDPOINTS = {
  // LLM endpoints - requires model parameter in URL
  LLM_CHAT: '/api/v1/models',  // Append /:modelId/chat
  LLM_EMBED: '/api/v1/models',  // Append /:modelId/embed

  // Mirror chat endpoints (NEW - for @Dina integration)
  MIRROR_CHAT: '/api/v1/mirror/chat',           // Non-streaming chat
  MIRROR_CHAT_STREAM: '/api/v1/mirror/chat/stream', // SSE streaming chat
  MIRROR_CHAT_HEALTH: '/api/v1/mirror/chat/health', // Health check

  // Mirror module endpoints
  MIRROR_STATUS: '/api/v1/mirror/status',
  MIRROR_SUBMIT: '/api/v1/mirror/submit',
  MIRROR_ANALYZE: '/api/v1/mirror/analyze',
  MIRROR_INSIGHTS: '/api/v1/mirror/insights',

  // Legacy paths (kept for backwards compatibility)
  CHAT: '/api/mirror/chat',
  CHAT_STREAM: '/api/mirror/chat/stream',
  INSIGHTS: '/api/mirror/insights',
  PATTERNS: '/api/mirror/patterns',
} as const;

// Default LLM model for chat
// Use Mistral 7b for faster responses (was llama2:70b)
export const DINA_DEFAULT_MODEL = 'mistral:7b';

export const DINA_DEFAULTS = {
  MAX_QUERY_LENGTH: 2000,
  MAX_RESPONSE_LENGTH: 10000,
  MAX_CONTEXT_MESSAGES: 20,
  MAX_MEMBERS_IN_CONTEXT: 20,
  TIMEOUT_MS: 30000,
  STREAM_DECISION_DELAY_MS: 250,
} as const;

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  // Message creation
  createDinaChatRequest,
  createDinaStreamingChatRequest,
  createDinaUniversalMessage,
  createDinaApiRequest,
  buildDinaLlmEndpoint,

  // Context building
  buildDinaChatContext,

  // Response handling
  extractDinaResponseContent,
  safeJsonParse,

  // HTTP utilities
  getDinaRequestHeaders,
  createDinaFetchOptions,

  // Validation
  validateDinaChatRequest,
  sanitizeDinaQuery,

  // Date/Time utilities
  formatMySQLDateTime,
  getMySQLNow,

  // Constants
  DINA_METHODS,
  DINA_ENDPOINTS,
  DINA_DEFAULTS,
};
