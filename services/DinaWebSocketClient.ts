// ============================================================================
// DINA WEBSOCKET CLIENT - Shared WSS Handler for Mirror Services
// ============================================================================
// File: services/DinaWebSocketClient.ts
//
// Purpose: Provides a consistent WebSocket connection handler for all Mirror
// services that need to communicate with DINA server.
//
// Usage:
//   // In mirror-server (uses singleton):
//   import { dinaWebSocket } from './services/DinaWebSocketClient';
//   await dinaWebSocket.initialize();
//
//   // In DCQP or other services (create own instance):
//   import { createDinaWebSocket } from './services/DinaWebSocketClient';
//   const wsClient = createDinaWebSocket('DCQP');
//   await wsClient.initialize();
//
// Features:
// - Configurable service name for log identification
// - Automatic reconnection with exponential backoff
// - DUMP protocol message formatting
// - Request/response correlation via requestId
// - Streaming chat support with chunk callbacks
// - Heartbeat/pong response handling
// ============================================================================

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// TYPES
// ============================================================================

export interface DinaConnectionConfig {
  url: string;
  reconnectIntervalMs: number;
  maxReconnectAttempts: number;
  heartbeatIntervalMs: number;
  requestTimeoutMs: number;
}

export interface DumpMessage {
  id: string;
  timestamp: string;
  version: string;
  source: {
    module: string;
    instance: string;
    version: string;
  };
  target: {
    module: string;
    method: string;
    priority: number;
  };
  security: {
    user_id?: string;
    session_id?: string;
    clearance: string;
    sanitized: boolean;
  };
  payload: {
    data: any;
    context?: any;
    metadata?: { size_bytes?: number };
  };
  qos: {
    delivery_mode: string;
    timeout_ms: number;
    retry_count: number;
    max_retries: number;
    require_ack: boolean;
  };
  trace: {
    created_at: number;
    route: string[];
    request_chain: string[];
    performance_target_ms: number;
  };
  method: string;
}

export interface DinaResponse {
  request_id: string;
  sourceRequestId: string;
  id: string;
  timestamp: string;
  status: 'success' | 'error' | 'processing' | 'queued';
  payload: { data: any; metadata?: any };
  error?: { code: string; message: string; details?: any };
  metrics: { processing_time_ms: number; queue_time_ms?: number };
}

export interface StreamingChunk {
  type: 'start' | 'chunk' | 'done' | 'error';
  sourceRequestId: string;
  requestId: string;
  content?: string;
  chunkIndex?: number;
  metadata?: any;
  error?: string;
}

type StreamCallback = (chunk: StreamingChunk) => void;

interface PendingRequest {
  resolve: (response: DinaResponse) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
  streamCallback?: StreamCallback;
}

// ============================================================================
// DINA WEBSOCKET CLIENT
// ============================================================================

export class DinaWebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: DinaConnectionConfig;
  private serviceName: string;
  private connectionId: string | null = null;
  private sessionId: string;
  private isConnected: boolean = false;
  private isConnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private streamCallbacks: Map<string, StreamCallback> = new Map();

  // ================================
  // CONSTRUCTOR
  // ================================

  /**
   * Create a new DinaWebSocketClient instance
   * @param serviceName - Identifier for this service (e.g., 'mirror-server', 'DCQP')
   * @param config - Optional connection configuration
   */
  constructor(serviceName: string = 'mirror', config?: Partial<DinaConnectionConfig>) {
    super();
    this.serviceName = serviceName;
    this.sessionId = uuidv4();

    this.config = {
      url: config?.url || process.env.DINA_WS_URL || 'wss://localhost:8445/dina/ws',
      reconnectIntervalMs: config?.reconnectIntervalMs || 5000,
      maxReconnectAttempts: config?.maxReconnectAttempts || 10,
      heartbeatIntervalMs: config?.heartbeatIntervalMs || 25000,
      requestTimeoutMs: config?.requestTimeoutMs || 120000,
    };

    this.log('Client created', {
      url: this.config.url,
      reconnectInterval: this.config.reconnectIntervalMs,
      maxAttempts: this.config.maxReconnectAttempts,
    });
  }

  // ================================
  // LOGGING HELPER
  // ================================

  private log(message: string, data?: any): void {
    const prefix = `[DinaWS:${this.serviceName}]`;
    if (data) {
      console.log(`${prefix} ${message}`, data);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  private logError(message: string, error?: any): void {
    const prefix = `[DinaWS:${this.serviceName}]`;
    if (error) {
      console.error(`${prefix} ❌ ${message}:`, error);
    } else {
      console.error(`${prefix} ❌ ${message}`);
    }
  }

  private logWarn(message: string, data?: any): void {
    const prefix = `[DinaWS:${this.serviceName}]`;
    if (data) {
      console.warn(`${prefix} ⚠️ ${message}:`, data);
    } else {
      console.warn(`${prefix} ⚠️ ${message}`);
    }
  }

  // ================================
  // CONNECTION MANAGEMENT
  // ================================

  /**
   * Initialize and connect (called once on service startup)
   */
  public async initialize(): Promise<void> {
    this.log('Initializing connection to DINA server...');
    return this.connect();
  }

  /**
   * Connect to DINA WebSocket server
   */
  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isConnected) {
        this.log('Already connected');
        resolve();
        return;
      }

      if (this.isConnecting) {
        this.log('Connection already in progress');
        resolve();
        return;
      }

      this.isConnecting = true;
      this.log(`Connecting to ${this.config.url}...`);

      try {
        this.ws = new WebSocket(this.config.url, {
          rejectUnauthorized: false, // Allow self-signed certs
          handshakeTimeout: 10000,
        });

        this.ws.on('open', () => {
          this.log('WebSocket connection opened');
          this.isConnecting = false;
          // Don't set isConnected yet - wait for welcome message
        });

        this.ws.on('message', (data: Buffer) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          this.log(`Connection closed: ${code} - ${reason.toString()}`);
          this.handleDisconnect();
        });

        this.ws.on('error', (error: Error) => {
          this.logError('WebSocket error', error.message);
          this.isConnecting = false;
          if (!this.isConnected) {
            reject(error);
          }
        });

        this.ws.on('ping', () => {
          this.ws?.pong();
        });

        // Set initial connection timeout
        const connectionTimeout = setTimeout(() => {
          if (!this.isConnected) {
            this.logError('Connection timeout');
            this.ws?.terminate();
            this.isConnecting = false;
            reject(new Error('Connection timeout'));
          }
        }, 15000);

        // Wait for welcome message to confirm connection
        this.once('connected', () => {
          clearTimeout(connectionTimeout);
          resolve();
        });

      } catch (error) {
        this.isConnecting = false;
        this.logError('Failed to create WebSocket', error);
        reject(error);
      }
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(data: Buffer): void {
    try {
      const message = JSON.parse(data.toString());
      const timestamp = new Date().toISOString();

      // Handle welcome message
      if (message.request_id === 'connection' && message.payload?.data?.connection_id) {
        console.log(`\n📥 [${timestamp}] [${this.serviceName}] DINA ← WELCOME MESSAGE`);
        console.log(`   Connection ID: ${message.payload.data.connection_id}`);
        console.log(`   Mode: ${message.payload.data.operating_mode}`);
        this.handleWelcome(message);
        return;
      }

      // Handle streaming chat chunks
      if (message.type === 'chunk' || message.type === 'mirror_chat_stream') {
        console.log(`📥 [${timestamp}] [${this.serviceName}] DINA ← STREAM CHUNK #${message.chunk_index || 0}`);
        console.log(`   Request: ${message.request_id}`);
        console.log(`   Content: "${(message.content || '').substring(0, 50)}${message.content?.length > 50 ? '...' : ''}"`);
        console.log(`   Done: ${message.done || false}`);
        this.handleStreamingChunk(message);
        return;
      }

      // Handle standard responses
      if (message.request_id) {
        console.log(`\n📥 [${timestamp}] [${this.serviceName}] DINA ← RESPONSE`);
        console.log(`   Request ID: ${message.request_id}`);
        console.log(`   Status: ${message.status}`);
        if (message.error) {
          console.log(`   Error: ${message.error.code} - ${message.error.message}`);
        }
        if (message.payload?.data?.type === 'complete') {
          console.log(`   Completed: ${message.payload.data.total_chunks} chunks in ${message.payload.data.processing_time_ms}ms`);
        }
        this.handleResponse(message);
        return;
      }

      console.log(`\n📥 [${timestamp}] [${this.serviceName}] DINA ← UNKNOWN MESSAGE TYPE`);
      console.log(`   Raw: ${JSON.stringify(message).substring(0, 200)}`);

    } catch (error) {
      this.logError('Failed to parse message', error);
    }
  }

  /**
   * Handle welcome message from DINA server
   */
  private handleWelcome(message: any): void {
    this.connectionId = message.payload.data.connection_id;
    this.isConnected = true;
    this.isConnecting = false;
    this.reconnectAttempts = 0;

    console.log('─'.repeat(50));
    console.log(`✅ [${this.serviceName}] WSS TO DINA-SERVER INITIATED`);
    console.log('─'.repeat(50));
    console.log(`   Service: ${this.serviceName}`);
    console.log(`   Connection ID: ${this.connectionId}`);
    console.log(`   Operating Mode: ${message.payload.data.operating_mode}`);
    console.log(`   Redis: ${message.payload.data.redis_enabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`   Capabilities: ${message.payload.data.capabilities?.join(', ')}`);
    console.log('─'.repeat(50));

    // Start heartbeat
    this.startHeartbeat();

    this.emit('connected', {
      connectionId: this.connectionId,
      operatingMode: message.payload.data.operating_mode,
      capabilities: message.payload.data.capabilities,
    });
  }

  /**
   * Handle streaming chunk
   */
  private handleStreamingChunk(chunk: StreamingChunk): void {
    const callback = this.streamCallbacks.get(chunk.requestId);
    if (callback) {
      callback(chunk);

      // Clean up on done or error
      if (chunk.type === 'done' || chunk.type === 'error') {
        this.streamCallbacks.delete(chunk.requestId);

        // Also resolve any pending request
        const pending = this.pendingRequests.get(chunk.requestId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          this.pendingRequests.delete(chunk.requestId);

          if (chunk.type === 'error') {
            pending.reject(new Error(chunk.error || 'Streaming failed'));
          } else {
            pending.resolve({
              sourceRequestId: chunk.sourceRequestId,
              request_id: chunk.requestId,
              id: uuidv4(),
              timestamp: new Date().toISOString(),
              status: 'success',
              payload: { data: chunk.metadata },
              metrics: { processing_time_ms: chunk.metadata?.processingTime || 0 },
            });
          }
        }
      }
    }
  }

  /**
   * Handle standard response
   */
  private handleResponse(response: DinaResponse): void {
    console.log(
      `[services/DinaWebsocketClient.ts/handleResponse()]: Contents of response -> ${JSON.stringify(response)}`
    );
  
    console.log(
      `[services/DinaWebsocketClient.ts/handleResponse()]: contents of PendingRequests -> ${this.pendingRequests}`
    );
  
    this.pendingRequests.forEach((value, key) => {
      const safeValue = { ...value };
      console.log(`Key: ${key}, Value: ${safeValue}`);
    });
  
    console.log(
      `[services/DinaWebsocketClient.ts/handleResponse()]: Response status -> ${response.status}`
    );
  
    const sourceRequestId =
      response.payload?.data?.metadata?.sourceRequestId ??
      response.payload?.metadata?.sourceRequestId ??
      null;
  
    console.log(
      `[services/DinaWebsocketClient.ts/handleResponse()]: Extracted sourceRequestId -> ${sourceRequestId}`
    );
  
    if (!sourceRequestId) {
      this.log(
        `Received response without sourceRequestId (status=${response.status}, request_id=${response.request_id})`
      );
      return;
    }
  
    const pending = this.pendingRequests.get(sourceRequestId);
  
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(sourceRequestId);
  
      if (response.status === 'error') {
        pending.reject(
          new Error(response.error?.message || 'Request failed')
        );
      } else {
        pending.resolve(response);
      }
    } else {
      this.log(`Received response for unknown request: ${sourceRequestId}`);
    }
  }
  

  /**
   * Handle disconnection
   */
  private handleDisconnect(): void {
    this.isConnected = false;
    this.connectionId = null;
    this.stopHeartbeat();

    // Reject all pending requests
    this.pendingRequests.forEach((pending, requestId) => {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Connection lost'));
    });
    this.pendingRequests.clear();
    this.streamCallbacks.clear();

    this.emit('disconnected');

    // Attempt reconnection
    this.scheduleReconnect();
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.logError('Max reconnection attempts reached');
      this.emit('reconnect_failed');
      return;
    }

    const delay = Math.min(
      this.config.reconnectIntervalMs * Math.pow(2, this.reconnectAttempts),
      60000 // Max 60 seconds
    );

    this.reconnectAttempts++;
    this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        this.logError('Reconnection failed', error);
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Start heartbeat timer
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
        // Send ping message
//        this.send({
//          target: { module: 'core', method: 'ping', priority: 1 },
//          payload: { data: { timestamp: Date.now() } },
//        }).catch(err => {
//          this.logWarn('Heartbeat ping failed', err.message);
//        });
      }
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * Stop heartbeat timer
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ================================
  // PUBLIC API
  // ================================

  /**
   * Send a message to DINA and wait for response
   */
  public async send(params: {
    target: { module: string; method: string; priority?: number };
    payload: { data: any; context?: any };
    security?: { user_id?: string; session_id?: string };
    timeoutMs?: number;
  }): Promise<DinaResponse> {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to DINA server');
    }

    const requestId = uuidv4();
    const message = this.createDumpMessage(requestId, params);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timeout after ${params.timeoutMs || this.config.requestTimeoutMs}ms`));
      }, params.timeoutMs || this.config.requestTimeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeoutId });

      try {
        const timestamp = new Date().toISOString();
        console.log(`\n📤 [${timestamp}] [${this.serviceName}] MIRROR → DINA`);
        console.log(`   Request ID: ${requestId}`);
        console.log(`   Target: ${params.target.module}.${params.target.method}`);
        console.log(`   Priority: ${params.target.priority || 5}`);
        console.log(`   Payload Size: ${JSON.stringify(params.payload.data).length} bytes`);

        this.ws!.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  /**
   * Send a streaming chat request
   * Returns immediately, chunks delivered via callback
   */
  public async sendStreamingChat(params: {
    requestId?: string;
    groupId: string;
    userId: string;
    username: string;
    query: string;
    context?: any;
    options?: { model?: string; maxTokens?: number; temperature?: number };
    onChunk: StreamCallback;
  }): Promise<void> {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to DINA server');
    }

    const requestId = params.requestId || uuidv4();

    // Register stream callback
    this.streamCallbacks.set(requestId, params.onChunk);

    const message = this.createDumpMessage(requestId, {
      target: {
        module: 'mirror',
        method: 'mirror_chat_stream',
        priority: 7,
      },
      payload: {
          requestId,
          groupId: params.groupId,
          userId: params.userId,
          username: params.username,
          query: params.query,
          context: params.context,
          options: {
            model_preference: params.options?.model || 'mistral:7b',
            max_tokens: params.options?.maxTokens || 500,
            temperature: params.options?.temperature || 0.7,
          },
        
      },
      security: { user_id: params.userId },
    });
    ;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.streamCallbacks.delete(requestId);
        reject(new Error('Streaming request timeout'));
      }, this.config.requestTimeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: () => resolve(),
        reject,
        timeoutId,
        streamCallback: params.onChunk,
      });

      try {
        const timestamp = new Date().toISOString();
        console.log(`\n📤 [${timestamp}] [${this.serviceName}] MIRROR → DINA [STREAMING CHAT]`);
        console.log(`   Request ID: ${requestId}`);
        console.log(`   Group: ${params.groupId}`);
        console.log(`   User: ${params.username} (${params.userId})`);
        //console.log(`   Query: "${message.payload.query.substring(0, 80)}${params.query.length > 80 ? '...' : ''}"`);
        console.log(`   Model: ${params.options?.model || 'mistral:7b'}`);
        console.log(`   Target: mirror.mirror_chat_stream`);

        this.ws!.send(JSON.stringify(message));
        console.log(`   ✅ Message sent, awaiting stream response...`);
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(requestId);
        this.streamCallbacks.delete(requestId);
        reject(error);
      }
    });
  }

  /**
   * Create a DUMP protocol compliant message
   */
  private createDumpMessage(
    requestId: string,
    params: {
      target: { module: string; method: string; priority?: number };
      payload: any;
      security?: { user_id?: string; session_id?: string };
    }
  ): DumpMessage {
    const now = Date.now();
  
    const safeData = params.payload?.data ?? {};
    console.log(`Creating DUMP compliant message using -> ${JSON.stringify(params)}`);
  
    return {
      id: requestId,
      timestamp: new Date().toISOString(),
      version: '2.0.0',
  
      source: {
        module: this.serviceName,
        instance: this.connectionId || this.sessionId,
        version: '1.0.0',
      },
  
      target: {
        module: params.target.module,
        method: params.target.method,
        priority: params.target.priority ?? 5,
      },
  
      security: {
        user_id: params.security?.user_id,
        session_id: params.security?.session_id ?? this.sessionId,
        clearance: 'public',
        sanitized: false,
      },
  
      payload: {
        ...params.payload, // ✅ everything lives here
        metadata: {
          size_bytes: JSON.stringify(safeData).length,
        },
      },
  
      qos: {
        delivery_mode: 'at_least_once',
        timeout_ms: 30000,
        retry_count: 0,
        max_retries: 3,
        require_ack: true,
      },
  
      trace: {
        created_at: now,
        route: [this.serviceName],
        request_chain: [],
        performance_target_ms: 1000,
      },
  
      method: params.target.method,
    };
  }
  

  // ================================
  // STATUS
  // ================================

  /**
   * Check if connected
   */
  public get connected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection ID
   */
  public getConnectionId(): string | null {
    return this.connectionId;
  }

  /**
   * Get service name
   */
  public getServiceName(): string {
    return this.serviceName;
  }

  /**
   * Get connection status
   */
  public getStatus(): {
    connected: boolean;
    connectionId: string | null;
    serviceName: string;
    pendingRequests: number;
    activeStreams: number;
    reconnectAttempts: number;
  } {
    return {
      connected: this.connected,
      connectionId: this.connectionId,
      serviceName: this.serviceName,
      pendingRequests: this.pendingRequests.size,
      activeStreams: this.streamCallbacks.size,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * Graceful shutdown
   */
  public async shutdown(): Promise<void> {
    this.log('Shutting down...');

    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject pending requests
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Client shutting down'));
    });
    this.pendingRequests.clear();
    this.streamCallbacks.clear();

    if (this.ws) {
      this.ws.close(1000, 'Client shutdown');
      this.ws = null;
    }

    this.isConnected = false;
    this.connectionId = null;

    this.log('Shutdown complete');
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a new DinaWebSocketClient instance
 * Use this when you need a dedicated connection (e.g., in a separate process)
 *
 * @param serviceName - Identifier for logging (e.g., 'DCQP', 'analyzer')
 * @param config - Optional connection configuration overrides
 * @returns A new DinaWebSocketClient instance
 *
 * @example
 * const wsClient = createDinaWebSocket('DCQP');
 * await wsClient.initialize();
 */
export function createDinaWebSocket(
  serviceName: string,
  config?: Partial<DinaConnectionConfig>
): DinaWebSocketClient {
  return new DinaWebSocketClient(serviceName, config);
}

// ============================================================================
// SINGLETON EXPORT (for mirror-server backwards compatibility)
// ============================================================================

// Default singleton instance for mirror-server
const mirrorServerInstance = new DinaWebSocketClient('mirror-server');

export const dinaWebSocket = mirrorServerInstance;

export default dinaWebSocket;
