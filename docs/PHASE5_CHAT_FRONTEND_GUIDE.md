# Phase 5: MirrorGroups Real-Time Chat Infrastructure
## Frontend Integration Guide

---

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Authentication](#authentication)
4. [REST API Endpoints](#rest-api-endpoints)
5. [WebSocket Protocol](#websocket-protocol)
6. [TypeScript Interfaces](#typescript-interfaces)
7. [Real-Time Events](#real-time-events)
8. [Encryption](#encryption)
9. [Mobile-First Considerations](#mobile-first-considerations)
10. [Error Handling](#error-handling)
11. [Implementation Examples](#implementation-examples)

---

## Overview

Phase 5 implements a complete real-time chat system for MirrorGroups with:

- **End-to-end encryption** using AES-256-GCM
- **Real-time messaging** via WebSocket
- **Message threading** with parent/child relationships
- **Typing indicators** with 5-second auto-expiry
- **Presence status** (online/away/busy/offline)
- **Emoji reactions** with real-time updates
- **Read receipts** with batch processing
- **Pinned messages** with ordering
- **Full-text search** on message content
- **Cursor-based pagination** for efficient mobile scrolling
- **Rate limiting** (30 messages/min HTTP, 10/sec WebSocket)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND APP                              │
├─────────────────────────────────────────────────────────────────┤
│  ChatContext / ChatProvider (State Management)                   │
│    ├── messages: Map<groupId, ChatMessage[]>                    │
│    ├── typingUsers: Map<groupId, TypingUser[]>                  │
│    ├── presence: Map<userId, PresenceStatus>                    │
│    ├── unreadCounts: Map<groupId, number>                       │
│    └── connectionStatus: 'connected' | 'connecting' | 'error'  │
├─────────────────────────────────────────────────────────────────┤
│  WebSocket Manager (Single Connection)                           │
│    └── wss://server/mirror/groups/chat?token=JWT                │
├─────────────────────────────────────────────────────────────────┤
│  REST API Client (HTTP Fallback & Initial Load)                  │
│    └── /mirror/api/groups/:groupId/chat/*                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      BACKEND SERVER                              │
├─────────────────────────────────────────────────────────────────┤
│  WebSocket: /mirror/groups/chat                                  │
│  REST API: /mirror/api/groups/:groupId/chat/*                   │
│  Encryption: GroupEncryptionManager (AES-256-GCM)               │
│  Caching: Redis (messages, typing, presence)                    │
│  Database: MySQL (persistent storage)                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Authentication

### JWT Token Requirements

All requests require a valid JWT token obtained from `/mirror/api/auth/login`.

**HTTP Requests:**
```typescript
headers: {
  'Authorization': 'Bearer <jwt_token>',
  'Content-Type': 'application/json'
}
```

**WebSocket Connection:**
```typescript
const ws = new WebSocket('wss://server/mirror/groups/chat?token=<jwt_token>');
```

### Token Payload Structure
```typescript
interface JWTPayload {
  id: number;           // User ID
  username: string;     // Username
  email: string;        // Email
  sessionId: string;    // Session identifier
  iat: number;          // Issued at
  exp: number;          // Expiration
}
```

---

## REST API Endpoints

Base URL: `/mirror/api/groups/:groupId/chat`

### Messages

#### GET `/messages`
Fetch messages with cursor-based pagination.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cursor` | string | null | Message ID to paginate from |
| `limit` | number | 50 | Messages per page (max 100) |
| `direction` | 'before' \| 'after' | 'before' | Pagination direction |

**Response:**
```typescript
{
  success: true,
  data: {
    messages: ChatMessage[],
    pagination: {
      hasMore: boolean,
      nextCursor: string | null,
      prevCursor: string | null
    }
  }
}
```

#### POST `/messages`
Send a new message.

**Request Body:**
```typescript
{
  content: string;                    // Message text (max 10000 chars)
  contentType?: 'text' | 'image' | 'file' | 'voice' | 'system';
  parentMessageId?: string;           // For threading/replies
  clientMessageId?: string;           // Client-generated UUID for deduplication
  metadata?: {
    mentions?: Array<{
      userId: number;
      username: string;
      startIndex: number;
      endIndex: number;
      type: 'user' | 'everyone';
    }>;
  };
}
```

**Response:**
```typescript
{
  success: true,
  data: {
    message: ChatMessage
  }
}
```

#### PUT `/messages/:messageId`
Edit an existing message (only own messages, within 24 hours).

**Request Body:**
```typescript
{
  content: string;  // New message content
}
```

#### DELETE `/messages/:messageId`
Soft-delete a message (only own messages).

---

### Reactions

#### POST `/messages/:messageId/reactions`
Add a reaction to a message.

**Request Body:**
```typescript
{
  emoji: string;  // Single emoji character (e.g., "👍", "❤️")
}
```

#### DELETE `/messages/:messageId/reactions/:emoji`
Remove your reaction from a message.

---

### Read Receipts

#### POST `/messages/read`
Mark messages as read (batch operation).

**Request Body:**
```typescript
{
  messageIds: string[];  // Array of message IDs (max 100)
}
```

#### GET `/unread-count`
Get unread message count for the group.

**Response:**
```typescript
{
  success: true,
  data: {
    count: number
  }
}
```

---

### Typing Indicators

#### POST `/typing/start`
Signal that user started typing.

#### POST `/typing/stop`
Signal that user stopped typing.

---

### Presence

#### PUT `/presence`
Update user's presence status.

**Request Body:**
```typescript
{
  status: 'online' | 'away' | 'busy' | 'offline';
}
```

#### GET `/presence`
Get presence status for all group members.

**Response:**
```typescript
{
  success: true,
  data: {
    presence: Array<{
      odejId: number,
      status: PresenceStatus,
      lastSeen: string
    }>
  }
}
```

---

### Thread Messages

#### GET `/messages/:messageId/thread`
Get all replies to a specific message.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Messages per page |
| `cursor` | string | null | Pagination cursor |

---

### Pinned Messages

#### GET `/pinned`
Get all pinned messages for the group.

#### POST `/messages/:messageId/pin`
Pin a message.

**Request Body:**
```typescript
{
  note?: string;  // Optional pin note/reason
}
```

#### DELETE `/messages/:messageId/pin`
Unpin a message.

---

### Search

#### GET `/search`
Search messages in the group.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Search query (required) |
| `limit` | number | Results per page (default 20) |
| `cursor` | string | Pagination cursor |

---

## WebSocket Protocol

### Connection

```typescript
const ws = new WebSocket('wss://server/mirror/groups/chat?token=<jwt_token>');

ws.onopen = () => {
  console.log('Connected to chat');
  // Join specific group(s)
  ws.send(JSON.stringify({
    type: 'chat:join_group',
    payload: { groupId: 'group-uuid' }
  }));
};
```

### Message Format

All WebSocket messages follow this structure:

```typescript
interface WSMessage {
  type: string;           // Message type
  payload: object;        // Message data
  requestId?: string;     // Optional: for request-response matching
}
```

### Client → Server Messages

#### `chat:join_group`
Join a group's chat room to receive real-time updates.
```typescript
{
  type: 'chat:join_group',
  payload: { groupId: string }
}
```

#### `chat:leave_group`
Leave a group's chat room.
```typescript
{
  type: 'chat:leave_group',
  payload: { groupId: string }
}
```

#### `chat:send_message`
Send a message via WebSocket (alternative to REST).
```typescript
{
  type: 'chat:send_message',
  payload: {
    groupId: string,
    content: string,
    contentType?: MessageContentType,
    parentMessageId?: string,
    clientMessageId?: string,
    metadata?: MessageMetadata
  },
  requestId: string  // For matching response
}
```

#### `chat:typing_start`
Signal typing started.
```typescript
{
  type: 'chat:typing_start',
  payload: { groupId: string }
}
```

#### `chat:typing_stop`
Signal typing stopped.
```typescript
{
  type: 'chat:typing_stop',
  payload: { groupId: string }
}
```

#### `chat:presence_update`
Update presence status.
```typescript
{
  type: 'chat:presence_update',
  payload: {
    groupId: string,
    status: 'online' | 'away' | 'busy' | 'offline'
  }
}
```

#### `chat:mark_read`
Mark messages as read.
```typescript
{
  type: 'chat:mark_read',
  payload: {
    groupId: string,
    messageIds: string[]
  }
}
```

#### `ping`
Keep connection alive (send every 30 seconds).
```typescript
{
  type: 'ping'
}
```

### Server → Client Messages

#### `chat:message`
New message received.
```typescript
{
  type: 'chat:message',
  payload: {
    message: ChatMessage,
    groupId: string
  }
}
```

#### `chat:message_edited`
Message was edited.
```typescript
{
  type: 'chat:message_edited',
  payload: {
    messageId: string,
    groupId: string,
    content: string,
    editedAt: string,
    editedBy: number
  }
}
```

#### `chat:message_deleted`
Message was deleted.
```typescript
{
  type: 'chat:message_deleted',
  payload: {
    messageId: string,
    groupId: string,
    deletedBy: number
  }
}
```

#### `chat:typing`
User typing status update.
```typescript
{
  type: 'chat:typing',
  payload: {
    groupId: string,
    userId: number,
    username: string,
    isTyping: boolean
  }
}
```

#### `chat:presence`
User presence update.
```typescript
{
  type: 'chat:presence',
  payload: {
    groupId: string,
    userId: number,
    status: PresenceStatus,
    lastSeen: string
  }
}
```

#### `chat:reactions_updated`
Reactions on a message changed.
```typescript
{
  type: 'chat:reactions_updated',
  payload: {
    messageId: string,
    groupId: string,
    reactions: ReactionSummary[]
  }
}
```

#### `chat:message_read`
Message read receipts update.
```typescript
{
  type: 'chat:message_read',
  payload: {
    messageIds: string[],
    groupId: string,
    userId: number,
    readAt: string
  }
}
```

#### `chat:mention`
User was mentioned in a message.
```typescript
{
  type: 'chat:mention',
  payload: {
    message: ChatMessage,
    groupId: string,
    mentionType: 'user' | 'everyone'
  }
}
```

#### `pong`
Response to ping.
```typescript
{
  type: 'pong',
  payload: { timestamp: number }
}
```

#### `error`
Error occurred.
```typescript
{
  type: 'error',
  payload: {
    code: string,
    message: string,
    requestId?: string
  }
}
```

---

## TypeScript Interfaces

```typescript
// ============================================================================
// CORE TYPES
// ============================================================================

export type MessageContentType = 'text' | 'image' | 'file' | 'voice' | 'system';
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
export type PresenceStatus = 'online' | 'away' | 'busy' | 'offline';

// ============================================================================
// MESSAGE
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

export interface MessageMetadata {
  mentions?: MentionInfo[];
  links?: LinkPreview[];
  formatting?: FormattingInfo;
  replyPreview?: ReplyPreview;
  custom?: Record<string, any>;
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
  bold?: Array<[number, number]>;      // [startIndex, endIndex]
  italic?: Array<[number, number]>;
  code?: Array<[number, number]>;
  links?: Array<[number, number, string]>;  // [start, end, url]
}

export interface ReplyPreview {
  messageId: string;
  senderUsername: string;
  content: string;  // Truncated to ~100 chars
}

// ============================================================================
// REACTIONS
// ============================================================================

export interface ReactionSummary {
  emoji: string;
  count: number;
  users: Array<{
    userId: number;
    username: string;
  }>;
  hasReacted: boolean;  // Current user has reacted with this emoji
}

// ============================================================================
// ATTACHMENTS
// ============================================================================

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
  duration?: number | null;  // For audio/video
  isEncrypted: boolean;
  processingStatus: 'pending' | 'processing' | 'completed' | 'failed';
}

// ============================================================================
// TYPING & PRESENCE
// ============================================================================

export interface TypingUser {
  userId: number;
  username: string;
  startedAt: Date;
}

export interface UserPresence {
  userId: number;
  username: string;
  status: PresenceStatus;
  lastSeen: Date;
}

// ============================================================================
// PAGINATION
// ============================================================================

export interface PaginatedMessages {
  messages: ChatMessage[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    prevCursor: string | null;
  };
}

// ============================================================================
// API RESPONSES
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}
```

---

## Real-Time Events

### Event Flow Diagram

```
User A types message
        │
        ▼
┌───────────────────┐
│ WebSocket/REST    │
│ send_message      │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Server processes: │
│ - Encrypt content │
│ - Store in MySQL  │
│ - Cache in Redis  │
│ - Queue delivery  │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Broadcast to all  │
│ group members via │
│ WebSocket         │
└───────────────────┘
        │
        ├──────────────────┐
        ▼                  ▼
┌─────────────┐    ┌─────────────┐
│ User B gets │    │ User C gets │
│ chat:message│    │ chat:message│
└─────────────┘    └─────────────┘
```

### Recommended Event Handlers

```typescript
// WebSocket event handler setup
function setupChatWebSocket(ws: WebSocket, dispatch: Dispatch) {
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);

    switch (message.type) {
      case 'chat:message':
        dispatch({ type: 'ADD_MESSAGE', payload: message.payload });
        // Play notification sound if not from current user
        break;

      case 'chat:message_edited':
        dispatch({ type: 'UPDATE_MESSAGE', payload: message.payload });
        break;

      case 'chat:message_deleted':
        dispatch({ type: 'REMOVE_MESSAGE', payload: message.payload });
        break;

      case 'chat:typing':
        dispatch({ type: 'UPDATE_TYPING', payload: message.payload });
        break;

      case 'chat:presence':
        dispatch({ type: 'UPDATE_PRESENCE', payload: message.payload });
        break;

      case 'chat:reactions_updated':
        dispatch({ type: 'UPDATE_REACTIONS', payload: message.payload });
        break;

      case 'chat:message_read':
        dispatch({ type: 'UPDATE_READ_RECEIPTS', payload: message.payload });
        break;

      case 'chat:mention':
        dispatch({ type: 'ADD_MENTION_NOTIFICATION', payload: message.payload });
        break;

      case 'error':
        dispatch({ type: 'HANDLE_ERROR', payload: message.payload });
        break;

      case 'pong':
        // Connection alive confirmation
        break;
    }
  };
}
```

---

## Encryption

### How It Works

1. **Server-side encryption**: Messages are encrypted using AES-256-GCM before storage
2. **Group-specific keys**: Each group has its own encryption key managed by `GroupEncryptionManager`
3. **Transparent to frontend**: The backend handles all encryption/decryption
4. **Frontend receives decrypted content**: Messages are decrypted before being sent to clients

### Security Considerations for Frontend

- Always use HTTPS/WSS in production
- Store JWT tokens securely (not in localStorage for sensitive apps)
- Implement token refresh before expiration
- Clear sensitive data on logout
- Don't log message content in production

---

## Mobile-First Considerations

### 1. Cursor-Based Pagination
Instead of page numbers, use message IDs as cursors for efficient infinite scroll:

```typescript
// Initial load
const { messages, pagination } = await fetchMessages(groupId, { limit: 50 });

// Load more (scrolling up for older messages)
if (pagination.hasMore) {
  const older = await fetchMessages(groupId, {
    cursor: pagination.nextCursor,
    direction: 'before',
    limit: 50
  });
}
```

### 2. Optimistic Updates
Show messages immediately, update status after server confirmation:

```typescript
// 1. Generate client ID
const clientMessageId = uuid();

// 2. Add to UI immediately with 'sending' status
dispatch({
  type: 'ADD_MESSAGE',
  payload: {
    ...messageData,
    clientMessageId,
    status: 'sending'
  }
});

// 3. Send to server
const response = await sendMessage({ ...messageData, clientMessageId });

// 4. Update with server response
dispatch({
  type: 'UPDATE_MESSAGE_STATUS',
  payload: {
    clientMessageId,
    id: response.data.message.id,
    status: 'sent'
  }
});
```

### 3. Debounced Typing Indicators
```typescript
const sendTypingStart = useMemo(
  () => debounce(() => {
    ws.send(JSON.stringify({ type: 'chat:typing_start', payload: { groupId } }));
  }, 300),
  [groupId]
);

const sendTypingStop = useMemo(
  () => debounce(() => {
    ws.send(JSON.stringify({ type: 'chat:typing_stop', payload: { groupId } }));
  }, 1000),
  [groupId]
);
```

### 4. Connection Management
```typescript
// Reconnection with exponential backoff
function createReconnectingWebSocket(url: string) {
  let ws: WebSocket;
  let reconnectAttempts = 0;
  const maxAttempts = 5;
  const baseDelay = 1000;

  function connect() {
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectAttempts = 0;
      // Rejoin all active groups
    };

    ws.onclose = () => {
      if (reconnectAttempts < maxAttempts) {
        const delay = baseDelay * Math.pow(2, reconnectAttempts);
        setTimeout(connect, delay);
        reconnectAttempts++;
      }
    };
  }

  connect();
  return ws;
}
```

### 5. Offline Support
```typescript
// Queue messages when offline
const messageQueue: QueuedMessage[] = [];

function sendMessage(message: MessagePayload) {
  if (navigator.onLine && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat:send_message', payload: message }));
  } else {
    messageQueue.push({ ...message, queuedAt: new Date() });
    // Store in IndexedDB for persistence
  }
}

// Flush queue when back online
window.addEventListener('online', () => {
  messageQueue.forEach(msg => sendMessage(msg));
  messageQueue.length = 0;
});
```

---

## Error Handling

### Error Codes

| Code | Description | Action |
|------|-------------|--------|
| `UNAUTHORIZED` | Invalid/expired token | Redirect to login |
| `FORBIDDEN` | Not a group member | Remove group from UI |
| `NOT_FOUND` | Message/group doesn't exist | Refresh data |
| `RATE_LIMITED` | Too many requests | Show cooldown UI |
| `VALIDATION_ERROR` | Invalid input | Show field errors |
| `MESSAGE_TOO_OLD` | Can't edit (>24h) | Disable edit |
| `SERVER_ERROR` | Internal error | Retry with backoff |

### HTTP Error Response Format
```typescript
{
  success: false,
  error: {
    code: 'RATE_LIMITED',
    message: 'Too many messages. Please wait before sending more.',
    details: {
      retryAfter: 60  // seconds
    }
  }
}
```

### WebSocket Error Handling
```typescript
ws.onerror = (error) => {
  console.error('WebSocket error:', error);
  // Attempt reconnection
};

ws.onclose = (event) => {
  if (event.code === 4001) {
    // Authentication failed - redirect to login
  } else if (event.code === 4003) {
    // Forbidden - user removed from group
  } else {
    // Attempt reconnection
  }
};
```

---

## Implementation Examples

### React Context Setup

```typescript
// ChatContext.tsx
import React, { createContext, useContext, useReducer, useEffect } from 'react';

interface ChatState {
  messages: Map<string, ChatMessage[]>;
  typingUsers: Map<string, TypingUser[]>;
  presence: Map<number, UserPresence>;
  unreadCounts: Map<string, number>;
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
}

const initialState: ChatState = {
  messages: new Map(),
  typingUsers: new Map(),
  presence: new Map(),
  unreadCounts: new Map(),
  connectionStatus: 'connecting'
};

type ChatAction =
  | { type: 'ADD_MESSAGE'; payload: { groupId: string; message: ChatMessage } }
  | { type: 'SET_MESSAGES'; payload: { groupId: string; messages: ChatMessage[] } }
  | { type: 'UPDATE_MESSAGE'; payload: Partial<ChatMessage> & { id: string } }
  | { type: 'REMOVE_MESSAGE'; payload: { groupId: string; messageId: string } }
  | { type: 'UPDATE_TYPING'; payload: { groupId: string; userId: number; username: string; isTyping: boolean } }
  | { type: 'UPDATE_PRESENCE'; payload: UserPresence }
  | { type: 'SET_CONNECTION_STATUS'; payload: ChatState['connectionStatus'] };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'ADD_MESSAGE': {
      const { groupId, message } = action.payload;
      const existing = state.messages.get(groupId) || [];
      // Deduplicate by clientMessageId or id
      const filtered = existing.filter(m =>
        m.id !== message.id && m.clientMessageId !== message.clientMessageId
      );
      return {
        ...state,
        messages: new Map(state.messages).set(groupId, [...filtered, message])
      };
    }
    // ... other cases
    default:
      return state;
  }
}

export const ChatContext = createContext<{
  state: ChatState;
  dispatch: React.Dispatch<ChatAction>;
  sendMessage: (groupId: string, content: string, options?: SendMessageOptions) => Promise<void>;
  loadMessages: (groupId: string, cursor?: string) => Promise<void>;
} | null>(null);

export function ChatProvider({ children, authToken }: { children: React.ReactNode; authToken: string }) {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(`wss://your-server/mirror/groups/chat?token=${authToken}`);
    wsRef.current = ws;

    ws.onopen = () => dispatch({ type: 'SET_CONNECTION_STATUS', payload: 'connected' });
    ws.onclose = () => dispatch({ type: 'SET_CONNECTION_STATUS', payload: 'disconnected' });
    ws.onerror = () => dispatch({ type: 'SET_CONNECTION_STATUS', payload: 'error' });

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      // Handle messages as shown in Real-Time Events section
    };

    // Ping every 30 seconds
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);

    return () => {
      clearInterval(pingInterval);
      ws.close();
    };
  }, [authToken]);

  const sendMessage = async (groupId: string, content: string, options?: SendMessageOptions) => {
    const clientMessageId = crypto.randomUUID();

    // Optimistic update
    dispatch({
      type: 'ADD_MESSAGE',
      payload: {
        groupId,
        message: {
          id: clientMessageId,
          clientMessageId,
          groupId,
          content,
          status: 'sending',
          // ... other fields
        }
      }
    });

    // Send via WebSocket
    wsRef.current?.send(JSON.stringify({
      type: 'chat:send_message',
      payload: { groupId, content, clientMessageId, ...options },
      requestId: clientMessageId
    }));
  };

  return (
    <ChatContext.Provider value={{ state, dispatch, sendMessage, loadMessages }}>
      {children}
    </ChatContext.Provider>
  );
}
```

### Message List Component

```typescript
// MessageList.tsx
function MessageList({ groupId }: { groupId: string }) {
  const { state, loadMessages } = useChat();
  const messages = state.messages.get(groupId) || [];
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Infinite scroll for older messages
  const handleScroll = useCallback(async () => {
    if (listRef.current?.scrollTop === 0 && !loading) {
      setLoading(true);
      await loadMessages(groupId, messages[0]?.id);
      setLoading(false);
    }
  }, [groupId, messages, loading]);

  return (
    <div ref={listRef} onScroll={handleScroll} className="message-list">
      {loading && <LoadingSpinner />}
      {messages.map(message => (
        <MessageBubble key={message.id} message={message} />
      ))}
    </div>
  );
}
```

### Message Input Component

```typescript
// MessageInput.tsx
function MessageInput({ groupId }: { groupId: string }) {
  const [content, setContent] = useState('');
  const { sendMessage } = useChat();
  const ws = useWebSocket();

  const handleTyping = useMemo(
    () => debounce(() => {
      ws.send(JSON.stringify({ type: 'chat:typing_start', payload: { groupId } }));
    }, 300),
    [groupId]
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;

    await sendMessage(groupId, content);
    setContent('');
    ws.send(JSON.stringify({ type: 'chat:typing_stop', payload: { groupId } }));
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          handleTyping();
        }}
        placeholder="Type a message..."
        maxLength={10000}
      />
      <button type="submit">Send</button>
    </form>
  );
}
```

---

## Database Schema Reference

For reference, here are the 10 tables created for Phase 5:

1. **mirror_group_messages** - Core messages table
2. **mirror_group_message_reads** - Read receipt tracking
3. **mirror_group_message_reactions** - Emoji reactions
4. **mirror_group_chat_attachments** - File attachments
5. **mirror_group_typing_indicators** - Typing status (mostly Redis-backed)
6. **mirror_group_chat_preferences** - User notification preferences
7. **mirror_group_message_mentions** - @mention tracking
8. **mirror_group_pinned_messages** - Pinned message ordering
9. **mirror_group_chat_presence** - Online status
10. **mirror_group_message_delivery_queue** - Offline message queue

---

## Summary

This chat infrastructure provides:

- Real-time bidirectional communication via WebSocket
- RESTful API fallback for all operations
- End-to-end encryption (handled server-side)
- Mobile-optimized pagination and offline support
- Rich features: threading, reactions, mentions, pins, search
- Rate limiting and error handling built-in

The frontend should prioritize WebSocket for real-time updates while using REST API for initial data loading and as a fallback when WebSocket is unavailable.
