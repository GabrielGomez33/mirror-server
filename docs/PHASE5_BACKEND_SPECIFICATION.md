# MirrorGroups Phase 5: Real-Time Chat Backend Specification
## Complete Frontend Integration Reference

---

# Table of Contents

1. [System Overview](#1-system-overview)
2. [Authentication](#2-authentication)
3. [Database Schema](#3-database-schema)
4. [REST API Endpoints](#4-rest-api-endpoints)
5. [WebSocket Protocol](#5-websocket-protocol)
6. [TypeScript Interfaces](#6-typescript-interfaces)
7. [Real-Time Event System](#7-real-time-event-system)
8. [Error Handling](#8-error-handling)
9. [Rate Limiting](#9-rate-limiting)
10. [Encryption](#10-encryption)
11. [Mobile-First Design Patterns](#11-mobile-first-design-patterns)
12. [Implementation Checklist](#12-implementation-checklist)

---

# 1. System Overview

## 1.1 Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND APPLICATION                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │  Chat Context   │  │  WebSocket      │  │  REST API Client            │  │
│  │  (State Mgmt)   │  │  Manager        │  │  (axios/fetch)              │  │
│  │                 │  │                 │  │                             │  │
│  │  - messages     │  │  - connection   │  │  - sendMessage()           │  │
│  │  - typing       │  │  - reconnect    │  │  - getMessages()           │  │
│  │  - presence     │  │  - heartbeat    │  │  - editMessage()           │  │
│  │  - unread       │  │  - handlers     │  │  - deleteMessage()         │  │
│  └────────┬────────┘  └────────┬────────┘  └─────────────┬───────────────┘  │
│           │                    │                         │                   │
└───────────┼────────────────────┼─────────────────────────┼───────────────────┘
            │                    │                         │
            │         WebSocket  │              HTTP/REST  │
            │    wss://server/mirror/groups/chat          │
            │                    │                         │
            │                    ▼                         ▼
┌───────────┼────────────────────────────────────────────────────────────────┐
│           │                 BACKEND SERVER                                  │
├───────────┼────────────────────────────────────────────────────────────────┤
│           │                                                                 │
│  ┌────────▼────────┐  ┌─────────────────┐  ┌─────────────────────────────┐ │
│  │  ChatWSHandler  │  │  ChatController │  │  ChatMessageManager         │ │
│  │                 │  │                 │  │                             │ │
│  │  - registerUser │  │  - sendMessage  │  │  - sendMessage()           │ │
│  │  - handleMsg    │  │  - getMessages  │  │  - getMessages()           │ │
│  │  - broadcast    │  │  - editMessage  │  │  - editMessage()           │ │
│  │  - rateLimit    │  │  - reactions    │  │  - encryption              │ │
│  └────────┬────────┘  └────────┬────────┘  └─────────────┬───────────────┘ │
│           │                    │                         │                  │
│           └────────────────────┴─────────────────────────┘                  │
│                                │                                            │
│           ┌────────────────────┼────────────────────┐                       │
│           ▼                    ▼                    ▼                       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │
│  │     Redis       │  │     MySQL       │  │  Notification   │             │
│  │  (Cache/Pub)    │  │   (Storage)     │  │    System       │             │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 1.2 Technology Stack

| Component | Technology | Version |
|-----------|------------|---------|
| Server | Express.js | 5.1.0 |
| Language | TypeScript | 5.8.3 |
| Database | MySQL | 8.x |
| Cache | Redis (ioredis) | 5.3.2 |
| WebSocket | ws | 8.14.2 |
| Authentication | JWT | jsonwebtoken 9.0.2 |
| Encryption | AES-256-GCM | Node.js crypto |

## 1.3 Base URLs

```
REST API:    https://your-server/mirror/api/groups/{groupId}/chat/
WebSocket:   wss://your-server/mirror/groups/chat?token={jwt_token}
```

---

# 2. Authentication

## 2.1 JWT Token Structure

All requests require a valid JWT token obtained from the authentication endpoint.

### Login Endpoint
```
POST /mirror/api/auth/login
```

### Request Body
```json
{
  "email": "user@example.com",
  "password": "securepassword"
}
```

### Response
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": 123,
      "username": "johndoe",
      "email": "user@example.com"
    }
  }
}
```

### JWT Payload Structure
```typescript
interface JWTPayload {
  id: number;           // User's unique ID
  username: string;     // Display username
  email: string;        // User's email
  sessionId: string;    // Unique session identifier
  iat: number;          // Issued at (Unix timestamp)
  exp: number;          // Expiration (Unix timestamp)
}
```

## 2.2 HTTP Authentication

Include the JWT token in the Authorization header:

```typescript
const headers = {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json'
};
```

## 2.3 WebSocket Authentication

Pass the token as a query parameter when connecting:

```typescript
const ws = new WebSocket(`wss://server/mirror/groups/chat?token=${token}`);
```

**Important:** The WebSocket connection will be rejected with code `4001` if the token is invalid or expired.

---

# 3. Database Schema

## 3.1 Entity Relationship Diagram

```
┌──────────────────────┐       ┌──────────────────────┐
│    mirror_groups     │       │        users         │
├──────────────────────┤       ├──────────────────────┤
│ id (PK, VARCHAR(36)) │       │ id (PK, INT)         │
│ name                 │       │ username             │
│ description          │       │ email                │
│ ...                  │       │ ...                  │
└──────────┬───────────┘       └──────────┬───────────┘
           │                              │
           │ 1:N                          │ 1:N
           ▼                              ▼
┌──────────────────────────────────────────────────────┐
│              mirror_group_messages                    │
├──────────────────────────────────────────────────────┤
│ id (PK, VARCHAR(36))                                 │
│ group_id (FK → mirror_groups.id)                     │
│ sender_user_id (FK → users.id)                       │
│ content (TEXT, encrypted)                            │
│ content_type (ENUM)                                  │
│ parent_message_id (FK → self, nullable)              │
│ thread_root_id (FK → self, nullable)                 │
│ thread_reply_count (INT)                             │
│ metadata (JSON)                                      │
│ status (ENUM: sending, sent, delivered, failed)      │
│ is_edited (BOOLEAN)                                  │
│ edited_at (TIMESTAMP)                                │
│ is_deleted (BOOLEAN)                                 │
│ deleted_at (TIMESTAMP)                               │
│ encryption_key_id (VARCHAR(36))                      │
│ client_message_id (VARCHAR(64))                      │
│ created_at (TIMESTAMP)                               │
│ updated_at (TIMESTAMP)                               │
└──────────────────────────────────────────────────────┘
           │
           │ 1:N
           ▼
┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│   mirror_group_message_reactions    │  │    mirror_group_message_reads       │
├─────────────────────────────────────┤  ├─────────────────────────────────────┤
│ id (PK)                             │  │ id (PK)                             │
│ message_id (FK)                     │  │ message_id (FK)                     │
│ user_id (FK)                        │  │ user_id (FK)                        │
│ group_id (FK)                       │  │ group_id (FK)                       │
│ emoji (VARCHAR(32))                 │  │ read_at (TIMESTAMP)                 │
│ created_at                          │  │                                     │
└─────────────────────────────────────┘  └─────────────────────────────────────┘

┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│   mirror_group_pinned_messages      │  │   mirror_group_chat_presence        │
├─────────────────────────────────────┤  ├─────────────────────────────────────┤
│ id (PK)                             │  │ id (PK)                             │
│ message_id (FK)                     │  │ user_id (FK)                        │
│ group_id (FK)                       │  │ group_id (FK)                       │
│ pinned_by_user_id (FK)              │  │ status (ENUM: online/away/busy/off) │
│ pin_order (INT)                     │  │ last_seen_at (TIMESTAMP)            │
│ pin_note (VARCHAR(255))             │  │ device_type (ENUM)                  │
│ pinned_at (TIMESTAMP)               │  │ updated_at (TIMESTAMP)              │
└─────────────────────────────────────┘  └─────────────────────────────────────┘

┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│  mirror_group_chat_preferences      │  │   mirror_group_message_mentions     │
├─────────────────────────────────────┤  ├─────────────────────────────────────┤
│ id (PK)                             │  │ id (PK)                             │
│ group_id (FK)                       │  │ message_id (FK)                     │
│ user_id (FK)                        │  │ mentioned_user_id (FK)              │
│ muted_until (TIMESTAMP)             │  │ group_id (FK)                       │
│ notification_level (ENUM)           │  │ mention_type (ENUM)                 │
│ last_read_message_id (VARCHAR(36))  │  │ notified (BOOLEAN)                  │
│ unread_count (INT)                  │  │ created_at (TIMESTAMP)              │
└─────────────────────────────────────┘  └─────────────────────────────────────┘
```

## 3.2 All 10 Tables Summary

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `mirror_group_messages` | Core message storage | id, group_id, sender_user_id, content, content_type |
| `mirror_group_message_reads` | Read receipts | message_id, user_id, read_at |
| `mirror_group_message_reactions` | Emoji reactions | message_id, user_id, emoji |
| `mirror_group_chat_attachments` | File attachments | message_id, file_name, file_path |
| `mirror_group_typing_indicators` | Typing status | group_id, user_id, expires_at |
| `mirror_group_chat_preferences` | User settings | group_id, user_id, notification_level |
| `mirror_group_message_mentions` | @mentions tracking | message_id, mentioned_user_id |
| `mirror_group_pinned_messages` | Pinned messages | message_id, pin_order |
| `mirror_group_chat_presence` | Online status | user_id, group_id, status |
| `mirror_group_message_delivery_queue` | Offline delivery | message_id, recipient_user_id, status |

---

# 4. REST API Endpoints

## 4.1 Response Format

All API responses follow this structure:

### Success Response
```typescript
{
  success: true,
  data: { ... },
  timestamp: "2025-12-08T12:00:00.000Z"
}
```

### Error Response
```typescript
{
  success: false,
  error: "Human-readable error message",
  code: "ERROR_CODE",
  details?: { ... },
  validationErrors?: [
    { field: "content", message: "content is required" }
  ],
  timestamp: "2025-12-08T12:00:00.000Z"
}
```

## 4.2 Messages API

### 4.2.1 Send Message

**Endpoint:** `POST /mirror/api/groups/:groupId/chat/messages`

**Headers:**
```
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**
```typescript
{
  // REQUIRED
  content: string;              // Message text (1-10000 characters)

  // OPTIONAL
  contentType?: 'text' | 'image' | 'file' | 'audio' | 'video' | 'system' | 'reply';
  parentMessageId?: string;     // UUID - for threading/replies
  clientMessageId?: string;     // UUID - client-generated for deduplication
  metadata?: {
    mentions?: Array<{
      userId: number;
      username: string;
      startIndex: number;       // Position in content string
      endIndex: number;
      type: 'user' | 'everyone';
    }>;
    links?: Array<{
      url: string;
      title?: string;
      description?: string;
      image?: string;
      startIndex: number;
      endIndex: number;
    }>;
    formatting?: {
      bold?: Array<[number, number]>;      // [startIndex, endIndex]
      italic?: Array<[number, number]>;
      code?: Array<[number, number]>;
    };
    replyPreview?: {
      messageId: string;
      senderUsername: string;
      content: string;          // Truncated preview (~100 chars)
    };
    custom?: Record<string, any>;
  };
}
```

**Success Response (201):**
```typescript
{
  success: true,
  data: {
    message: {
      id: "550e8400-e29b-41d4-a716-446655440000",
      groupId: "group-uuid",
      senderUserId: 123,
      senderUsername: "johndoe",
      content: "Hello everyone!",
      contentType: "text",
      parentMessageId: null,
      threadRootId: null,
      threadReplyCount: 0,
      metadata: {},
      status: "sent",
      isEdited: false,
      editedAt: null,
      isDeleted: false,
      deletedAt: null,
      clientMessageId: "client-uuid",
      createdAt: "2025-12-08T12:00:00.000Z",
      updatedAt: "2025-12-08T12:00:00.000Z",
      reactions: [],
      attachments: []
    }
  },
  timestamp: "2025-12-08T12:00:00.000Z"
}
```

**Error Responses:**

| Status | Code | Description |
|--------|------|-------------|
| 400 | `VALIDATION_ERROR` | Invalid input (content too long, invalid UUID) |
| 401 | `UNAUTHORIZED` | Missing or invalid token |
| 403 | `FORBIDDEN` | Not a member of this group |
| 429 | `RATE_LIMIT_EXCEEDED` | Too many messages (30/min limit) |
| 500 | `SEND_FAILED` | Server error |

---

### 4.2.2 Get Messages (Paginated)

**Endpoint:** `GET /mirror/api/groups/:groupId/chat/messages`

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Messages per page (1-100) |
| `before` | string | - | Message UUID cursor (older messages) |
| `after` | string | - | Message UUID cursor (newer messages) |
| `threadRootId` | string | - | Get replies to specific thread |
| `includeReactions` | boolean | false | Include reaction data |
| `includeReadBy` | boolean | false | Include read receipt data |

**Example Request:**
```
GET /mirror/api/groups/abc123/chat/messages?limit=50&before=msg-uuid&includeReactions=true
```

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    messages: [
      {
        id: "msg-uuid-1",
        groupId: "group-uuid",
        senderUserId: 123,
        senderUsername: "johndoe",
        content: "Hello!",
        contentType: "text",
        parentMessageId: null,
        threadRootId: null,
        threadReplyCount: 2,
        metadata: {},
        status: "delivered",
        isEdited: false,
        editedAt: null,
        isDeleted: false,
        deletedAt: null,
        createdAt: "2025-12-08T12:00:00.000Z",
        updatedAt: "2025-12-08T12:00:00.000Z",
        reactions: [
          {
            emoji: "👍",
            count: 3,
            users: [123, 456, 789],
            hasReacted: true  // Current user reacted
          }
        ]
      },
      // ... more messages (ordered by createdAt DESC)
    ],
    hasMore: true,
    nextCursor: "oldest-msg-uuid-in-batch"
  },
  timestamp: "2025-12-08T12:00:00.000Z"
}
```

**Pagination Strategy:**

```typescript
// Initial load - get most recent messages
const initial = await fetch(`/api/groups/${groupId}/chat/messages?limit=50`);

// Load older messages (scrolling up)
const older = await fetch(`/api/groups/${groupId}/chat/messages?limit=50&before=${oldestMessageId}`);

// Load newer messages (checking for new messages)
const newer = await fetch(`/api/groups/${groupId}/chat/messages?limit=50&after=${newestMessageId}`);
```

---

### 4.2.3 Get Single Message

**Endpoint:** `GET /mirror/api/groups/:groupId/chat/messages/:messageId`

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    message: {
      // Full ChatMessage object with reactions and readBy populated
    }
  }
}
```

---

### 4.2.4 Edit Message

**Endpoint:** `PUT /mirror/api/groups/:groupId/chat/messages/:messageId`

**Constraints:**
- Only the message sender can edit
- Message must not be deleted
- No time limit enforced (but UI may show "edited" indicator)

**Request Body:**
```typescript
{
  content: string;  // New message content (1-10000 chars)
}
```

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    message: {
      id: "msg-uuid",
      content: "Updated message content",
      isEdited: true,
      editedAt: "2025-12-08T12:05:00.000Z",
      // ... other fields
    }
  }
}
```

**Error Responses:**

| Status | Code | Description |
|--------|------|-------------|
| 403 | `FORBIDDEN` | Can only edit your own messages |
| 404 | `NOT_FOUND` | Message not found |

---

### 4.2.5 Delete Message

**Endpoint:** `DELETE /mirror/api/groups/:groupId/chat/messages/:messageId`

**Constraints:**
- Message sender can delete their own messages
- Group admins can delete any message
- Soft delete (is_deleted = true, content preserved for compliance)

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    deleted: true,
    messageId: "msg-uuid"
  }
}
```

---

## 4.3 Reactions API

### 4.3.1 Add Reaction

**Endpoint:** `POST /mirror/api/groups/:groupId/chat/messages/:messageId/reactions`

**Request Body:**
```typescript
{
  emoji: string;  // Unicode emoji (e.g., "👍", "❤️", "😂") - max 32 chars
}
```

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    reactions: [
      {
        emoji: "👍",
        count: 4,
        users: [123, 456, 789, 101],
        hasReacted: true
      },
      {
        emoji: "❤️",
        count: 2,
        users: [123, 456],
        hasReacted: true
      }
    ]
  }
}
```

**Note:** If user already reacted with same emoji, this is a no-op (returns current state).

---

### 4.3.2 Remove Reaction

**Endpoint:** `DELETE /mirror/api/groups/:groupId/chat/messages/:messageId/reactions/:emoji`

**Note:** The emoji in the URL must be URL-encoded (e.g., `%F0%9F%91%8D` for 👍)

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    reactions: [
      // Updated reaction list without user's reaction
    ]
  }
}
```

---

### 4.3.3 Get Reactions

**Endpoint:** `GET /mirror/api/groups/:groupId/chat/messages/:messageId/reactions`

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    reactions: [
      {
        emoji: "👍",
        count: 3,
        users: [123, 456, 789],
        hasReacted: false
      }
    ]
  }
}
```

---

## 4.4 Read Receipts API

### 4.4.1 Mark Messages as Read

**Endpoint:** `POST /mirror/api/groups/:groupId/chat/read`

**Request Body:**
```typescript
{
  messageId: string;  // Mark all messages UP TO this ID as read
}
```

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    marked: true,
    upToMessageId: "msg-uuid"
  }
}
```

**Frontend Implementation:**
```typescript
// Call when user scrolls to/views a message
const markAsRead = debounce(async (lastVisibleMessageId: string) => {
  await api.post(`/groups/${groupId}/chat/read`, {
    messageId: lastVisibleMessageId
  });
}, 1000);  // Debounce to avoid excessive calls
```

---

### 4.4.2 Get Unread Count

**Endpoint:** `GET /mirror/api/groups/:groupId/chat/unread`

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    groupId: "group-uuid",
    unreadCount: 5
  }
}
```

---

## 4.5 Typing Indicators API

### 4.5.1 Set Typing Status

**Endpoint:** `POST /mirror/api/groups/:groupId/chat/typing`

**Request Body:**
```typescript
{
  isTyping: boolean;
}
```

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    groupId: "group-uuid",
    isTyping: true
  }
}
```

**Note:** Prefer WebSocket for typing indicators (lower latency). HTTP is a fallback.

---

### 4.5.2 Get Typing Users

**Endpoint:** `GET /mirror/api/groups/:groupId/chat/typing`

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    typingUsers: [
      {
        userId: 456,
        username: "janedoe",
        groupId: "group-uuid",
        isTyping: true,
        startedAt: "2025-12-08T12:00:00.000Z"
      }
    ]
  }
}
```

---

## 4.6 Presence API

### 4.6.1 Update Presence

**Endpoint:** `POST /mirror/api/groups/:groupId/chat/presence`

**Request Body:**
```typescript
{
  status: 'online' | 'away' | 'busy' | 'offline';
  deviceType?: 'web' | 'mobile_ios' | 'mobile_android' | 'desktop';
}
```

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    groupId: "group-uuid",
    status: "online",
    deviceType: "web"
  }
}
```

---

### 4.6.2 Get Group Presence

**Endpoint:** `GET /mirror/api/groups/:groupId/chat/presence`

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    presence: [
      {
        userId: 123,
        username: "johndoe",
        groupId: "group-uuid",
        status: "online",
        lastSeenAt: "2025-12-08T12:00:00.000Z",
        deviceType: "web"
      },
      {
        userId: 456,
        username: "janedoe",
        groupId: "group-uuid",
        status: "away",
        lastSeenAt: "2025-12-08T11:55:00.000Z",
        deviceType: "mobile_ios"
      }
    ]
  }
}
```

---

## 4.7 Pinned Messages API

### 4.7.1 Pin Message

**Endpoint:** `POST /mirror/api/groups/:groupId/chat/messages/:messageId/pin`

**Permissions:** Group admins only

**Request Body:**
```typescript
{
  note?: string;  // Optional note explaining why pinned (max 255 chars)
}
```

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    pinned: true,
    messageId: "msg-uuid"
  }
}
```

---

### 4.7.2 Unpin Message

**Endpoint:** `DELETE /mirror/api/groups/:groupId/chat/messages/:messageId/pin`

**Permissions:** Group admins only

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    unpinned: true,
    messageId: "msg-uuid"
  }
}
```

---

### 4.7.3 Get Pinned Messages

**Endpoint:** `GET /mirror/api/groups/:groupId/chat/pinned`

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    pinnedMessages: [
      {
        id: "msg-uuid",
        groupId: "group-uuid",
        senderUserId: 123,
        senderUsername: "johndoe",
        content: "Important announcement...",
        contentType: "text",
        metadata: {
          pinNote: "Weekly meeting reminder",
          pinnedAt: "2025-12-08T12:00:00.000Z",
          pinnedBy: 789
        },
        // ... other message fields
      }
    ],
    count: 3
  }
}
```

---

## 4.8 Search API

### 4.8.1 Search Messages

**Endpoint:** `GET /mirror/api/groups/:groupId/chat/search`

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Search query (min 2 chars) |
| `limit` | number | No | Results per page (default 20, max 50) |
| `offset` | number | No | Pagination offset (default 0) |

**Example Request:**
```
GET /mirror/api/groups/abc123/chat/search?q=meeting&limit=20&offset=0
```

**Success Response (200):**
```typescript
{
  success: true,
  data: {
    messages: [
      {
        id: "msg-uuid",
        content: "Let's schedule a meeting tomorrow",
        // ... full message object
      }
    ],
    query: "meeting",
    count: 15
  }
}
```

---

# 5. WebSocket Protocol

## 5.1 Connection Setup

### Connection URL
```
wss://your-server/mirror/groups/chat?token={jwt_token}
```

### Connection Code Example
```typescript
class ChatWebSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private pingInterval: number | null = null;

  connect(token: string): void {
    this.ws = new WebSocket(`wss://server/mirror/groups/chat?token=${token}`);

    this.ws.onopen = () => {
      console.log('Connected to chat');
      this.reconnectAttempts = 0;
      this.startPing();
    };

    this.ws.onclose = (event) => {
      this.stopPing();
      this.handleClose(event);
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      this.send({ type: 'ping', payload: {} });
    }, 30000);  // Ping every 30 seconds
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private handleClose(event: CloseEvent): void {
    if (event.code === 4001) {
      // Authentication failed - don't reconnect, redirect to login
      return;
    }

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = Math.pow(2, this.reconnectAttempts) * 1000;
      setTimeout(() => {
        this.reconnectAttempts++;
        this.connect(this.token);
      }, delay);
    }
  }

  send(message: { type: string; payload: any; requestId?: string }): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
}
```

## 5.2 WebSocket Close Codes

| Code | Meaning | Action |
|------|---------|--------|
| 1000 | Normal closure | Reconnect if needed |
| 1001 | Server going away | Reconnect with backoff |
| 4001 | Authentication failed | Redirect to login |
| 4003 | Forbidden (not a member) | Remove group from UI |
| 4429 | Rate limited | Wait and retry |

## 5.3 Message Format

All WebSocket messages use this structure:

```typescript
interface WebSocketMessage {
  type: string;           // Message type identifier
  payload: any;           // Message data
  requestId?: string;     // Optional: for request-response correlation
}
```

## 5.4 Client → Server Messages

### 5.4.1 Join Group
Subscribe to real-time updates for a group.

```typescript
{
  type: 'chat:join_group',
  payload: {
    groupId: string
  },
  requestId?: string
}
```

**Server Response:**
```typescript
{
  type: 'chat:group_joined',
  payload: {
    groupId: string,
    subscriberCount: number
  },
  requestId?: string
}
```

---

### 5.4.2 Leave Group
Unsubscribe from a group's updates.

```typescript
{
  type: 'chat:leave_group',
  payload: {
    groupId: string
  },
  requestId?: string
}
```

---

### 5.4.3 Send Message
Send a message via WebSocket (alternative to REST).

```typescript
{
  type: 'chat:send_message',
  payload: {
    groupId: string,
    content: string,
    contentType?: 'text' | 'image' | 'file' | 'audio' | 'video' | 'reply',
    parentMessageId?: string,
    clientMessageId?: string,
    metadata?: MessageMetadata
  },
  requestId: string  // Required for matching acknowledgment
}
```

**Server Acknowledgment:**
```typescript
{
  type: 'chat:ack',
  payload: {
    success: true,
    messageId: string,        // Server-generated UUID
    clientMessageId: string   // Echo back for matching
  },
  requestId: string
}
```

---

### 5.4.4 Edit Message

```typescript
{
  type: 'chat:edit_message',
  payload: {
    messageId: string,
    groupId: string,
    content: string
  },
  requestId: string
}
```

---

### 5.4.5 Delete Message

```typescript
{
  type: 'chat:delete_message',
  payload: {
    messageId: string,
    groupId: string
  },
  requestId: string
}
```

---

### 5.4.6 Typing Start

```typescript
{
  type: 'chat:typing_start',
  payload: {
    groupId: string
  }
}
```

---

### 5.4.7 Typing Stop

```typescript
{
  type: 'chat:typing_stop',
  payload: {
    groupId: string
  }
}
```

---

### 5.4.8 Presence Update

```typescript
{
  type: 'chat:presence_update',
  payload: {
    groupId: string,
    status: 'online' | 'away' | 'busy' | 'offline',
    deviceType?: string
  }
}
```

---

### 5.4.9 Mark Read

```typescript
{
  type: 'chat:mark_read',
  payload: {
    groupId: string,
    messageId: string
  },
  requestId?: string
}
```

---

### 5.4.10 Add Reaction

```typescript
{
  type: 'chat:add_reaction',
  payload: {
    messageId: string,
    groupId: string,
    emoji: string
  },
  requestId?: string
}
```

---

### 5.4.11 Remove Reaction

```typescript
{
  type: 'chat:remove_reaction',
  payload: {
    messageId: string,
    groupId: string,
    emoji: string
  },
  requestId?: string
}
```

---

### 5.4.12 Ping (Heartbeat)

```typescript
{
  type: 'ping',
  payload: {}
}
```

**Server Response:**
```typescript
{
  type: 'pong',
  payload: {
    timestamp: number
  }
}
```

---

## 5.5 Server → Client Messages

### 5.5.1 New Message

Received when another user sends a message.

```typescript
{
  type: 'chat:message',
  payload: {
    id: string,
    groupId: string,
    senderUserId: number,
    senderUsername: string,
    contentType: string,
    parentMessageId: string | null,
    threadRootId: string | null,
    metadata: MessageMetadata,
    status: string,
    clientMessageId: string | null,
    createdAt: string,        // ISO timestamp
    encryptedContent: true    // Content NOT included - fetch via REST
  }
}
```

**Important:** For security, message content is NOT broadcast. Clients must fetch via REST API to get decrypted content.

---

### 5.5.2 Message Edited

```typescript
{
  type: 'chat:message_edited',
  payload: {
    messageId: string,
    groupId: string,
    editedAt: string          // ISO timestamp
  }
}
```

**Frontend Action:** Fetch updated message content via REST.

---

### 5.5.3 Message Deleted

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

---

### 5.5.4 Typing Indicator

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

**Frontend Handling:**
```typescript
// Typing indicators auto-expire after 5 seconds
// Clear typing indicator if no update received
```

---

### 5.5.5 Presence Update

```typescript
{
  type: 'chat:presence',
  payload: {
    groupId: string,
    userId: number,
    username: string,
    status: 'online' | 'away' | 'busy' | 'offline',
    lastSeenAt: string
  }
}
```

---

### 5.5.6 Reactions Updated

```typescript
{
  type: 'chat:reactions_updated',
  payload: {
    messageId: string,
    groupId: string,
    reactions: Array<{
      emoji: string,
      count: number,
      users: number[],
      hasReacted: boolean
    }>
  }
}
```

---

### 5.5.7 Message Read

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

---

### 5.5.8 Mention Notification

Sent when current user is mentioned.

```typescript
{
  type: 'chat:mention',
  payload: {
    message: ChatMessage,     // Full message object
    groupId: string,
    mentionType: 'user' | 'everyone'
  }
}
```

---

### 5.5.9 Error

```typescript
{
  type: 'chat:error',
  payload: {
    error: string,            // Error message
    code?: string             // Error code
  },
  requestId?: string          // If responding to specific request
}
```

---

### 5.5.10 Acknowledgment

```typescript
{
  type: 'chat:ack',
  payload: {
    success: boolean,
    // Additional data depending on operation
  },
  requestId: string
}
```

---

# 6. TypeScript Interfaces

## 6.1 Core Types

```typescript
// ============================================================================
// ENUMS & LITERAL TYPES
// ============================================================================

export type MessageContentType =
  | 'text'
  | 'image'
  | 'file'
  | 'audio'
  | 'video'
  | 'system'
  | 'reply';

export type MessageStatus =
  | 'sending'   // Client-side only, before server confirms
  | 'sent'      // Server received
  | 'delivered' // Delivered to recipients
  | 'failed';   // Failed to send

export type PresenceStatus =
  | 'online'
  | 'away'
  | 'busy'
  | 'offline';

export type NotificationLevel =
  | 'all'       // All messages
  | 'mentions'  // Only @mentions
  | 'none';     // Muted

export type DeviceType =
  | 'web'
  | 'mobile_ios'
  | 'mobile_android'
  | 'desktop';

// ============================================================================
// MAIN ENTITIES
// ============================================================================

export interface ChatMessage {
  id: string;                              // UUID
  groupId: string;                         // UUID
  senderUserId: number;
  senderUsername?: string;
  content: string;                         // Decrypted content
  contentType: MessageContentType;
  parentMessageId?: string | null;         // For replies
  threadRootId?: string | null;            // Root of thread chain
  threadReplyCount?: number;               // Number of replies
  metadata?: MessageMetadata;
  status: MessageStatus;
  isEdited: boolean;
  editedAt?: Date | string | null;
  isDeleted: boolean;
  deletedAt?: Date | string | null;
  encryptionKeyId?: string | null;
  clientMessageId?: string | null;         // Client-generated UUID
  createdAt: Date | string;
  updatedAt: Date | string;
  reactions?: ReactionSummary[];
  attachments?: ChatAttachment[];
  readBy?: number[];                       // User IDs who read
}

export interface MessageMetadata {
  mentions?: MentionInfo[];
  links?: LinkPreview[];
  formatting?: FormattingInfo;
  replyPreview?: ReplyPreview;
  custom?: Record<string, any>;
  // Pin-related (only on pinned messages)
  pinNote?: string | null;
  pinnedAt?: Date | string | null;
  pinnedBy?: number | null;
}

export interface MentionInfo {
  userId: number;
  username: string;
  startIndex: number;                      // Position in content
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
  bold?: Array<[number, number]>;          // [startIndex, endIndex]
  italic?: Array<[number, number]>;
  code?: Array<[number, number]>;
  links?: Array<[number, number, string]>; // [start, end, url]
}

export interface ReplyPreview {
  messageId: string;
  senderUsername: string;
  content: string;                         // Truncated (~100 chars)
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  users?: number[];                        // User IDs
  hasReacted?: boolean;                    // Current user reacted
}

export interface ChatAttachment {
  id: string;
  messageId: string;
  fileName: string;
  fileType: string;                        // MIME type
  fileSize: number;                        // Bytes
  filePath: string;
  thumbnailPath?: string | null;
  width?: number | null;                   // For images/video
  height?: number | null;
  duration?: number | null;                // For audio/video (seconds)
  isEncrypted: boolean;
  processingStatus: 'pending' | 'processing' | 'completed' | 'failed';
}

// ============================================================================
// TYPING & PRESENCE
// ============================================================================

export interface TypingIndicator {
  userId: number;
  username: string;
  groupId: string;
  isTyping: boolean;
  startedAt: Date | string;
}

export interface UserPresence {
  userId: number;
  username?: string;
  groupId: string;
  status: PresenceStatus;
  customStatus?: string;
  lastSeenAt: Date | string;
  deviceType?: DeviceType;
}

// ============================================================================
// CHAT PREFERENCES
// ============================================================================

export interface ChatPreferences {
  groupId: string;
  userId: number;
  mutedUntil?: Date | string | null;
  notificationLevel: NotificationLevel;
  pinned: boolean;                         // Pinned in chat list
  archived: boolean;
  lastReadMessageId?: string | null;
  lastReadAt?: Date | string | null;
  unreadCount: number;
  showPreviews: boolean;
}

// ============================================================================
// API REQUEST/RESPONSE TYPES
// ============================================================================

export interface SendMessageRequest {
  content: string;
  contentType?: MessageContentType;
  parentMessageId?: string;
  clientMessageId?: string;
  metadata?: Partial<MessageMetadata>;
}

export interface GetMessagesRequest {
  limit?: number;
  before?: string;
  after?: string;
  threadRootId?: string;
  includeReactions?: boolean;
  includeReadBy?: boolean;
}

export interface GetMessagesResponse {
  messages: ChatMessage[];
  hasMore: boolean;
  nextCursor?: string | null;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  validationErrors?: Array<{
    field: string;
    message: string;
  }>;
  timestamp: string;
}

// ============================================================================
// WEBSOCKET TYPES
// ============================================================================

export type WSMessageType =
  // Client → Server
  | 'chat:join_group'
  | 'chat:leave_group'
  | 'chat:send_message'
  | 'chat:edit_message'
  | 'chat:delete_message'
  | 'chat:typing_start'
  | 'chat:typing_stop'
  | 'chat:presence_update'
  | 'chat:mark_read'
  | 'chat:add_reaction'
  | 'chat:remove_reaction'
  | 'ping'
  // Server → Client
  | 'chat:message'
  | 'chat:message_edited'
  | 'chat:message_deleted'
  | 'chat:typing'
  | 'chat:presence'
  | 'chat:reactions_updated'
  | 'chat:message_read'
  | 'chat:mention'
  | 'chat:group_joined'
  | 'chat:group_left'
  | 'chat:ack'
  | 'chat:error'
  | 'pong';

export interface WSMessage<T = any> {
  type: WSMessageType;
  payload: T;
  requestId?: string;
}
```

---

# 7. Real-Time Event System

## 7.1 Event Flow Diagrams

### Message Send Flow
```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   User A    │         │   Server    │         │   User B    │
│  (Sender)   │         │             │         │ (Recipient) │
└──────┬──────┘         └──────┬──────┘         └──────┬──────┘
       │                       │                       │
       │ 1. send_message       │                       │
       │ (WS or REST)          │                       │
       │──────────────────────>│                       │
       │                       │                       │
       │                       │ 2. Validate & encrypt │
       │                       │    Store in MySQL     │
       │                       │    Cache in Redis     │
       │                       │                       │
       │ 3. chat:ack           │                       │
       │<──────────────────────│                       │
       │ (success + messageId) │                       │
       │                       │                       │
       │                       │ 4. chat:message       │
       │                       │──────────────────────>│
       │                       │ (broadcast to group)  │
       │                       │                       │
       │                       │                       │ 5. Fetch message
       │                       │                       │    via REST API
       │                       │<──────────────────────│
       │                       │                       │
       │                       │ 6. Return decrypted   │
       │                       │──────────────────────>│
       │                       │                       │
```

### Typing Indicator Flow
```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   User A    │         │   Server    │         │   User B    │
└──────┬──────┘         └──────┬──────┘         └──────┬──────┘
       │                       │                       │
       │ typing_start          │                       │
       │──────────────────────>│                       │
       │                       │ chat:typing           │
       │                       │ (isTyping: true)      │
       │                       │──────────────────────>│
       │                       │                       │
       │                       │   [5 second TTL]      │
       │                       │                       │
       │ typing_stop           │                       │
       │──────────────────────>│                       │
       │         OR            │ chat:typing           │
       │   [Auto-expire]       │ (isTyping: false)     │
       │                       │──────────────────────>│
```

## 7.2 Recommended Frontend Event Handlers

```typescript
// chatEventHandlers.ts

import { ChatMessage, TypingIndicator, UserPresence, ReactionSummary } from './types';

interface ChatEventHandlers {
  onMessage: (groupId: string, message: ChatMessage) => void;
  onMessageEdited: (groupId: string, messageId: string, editedAt: string) => void;
  onMessageDeleted: (groupId: string, messageId: string) => void;
  onTyping: (groupId: string, indicator: TypingIndicator) => void;
  onPresence: (groupId: string, presence: UserPresence) => void;
  onReactionsUpdated: (groupId: string, messageId: string, reactions: ReactionSummary[]) => void;
  onMessageRead: (groupId: string, messageIds: string[], userId: number) => void;
  onMention: (groupId: string, message: ChatMessage, mentionType: string) => void;
  onError: (error: string, requestId?: string) => void;
}

function createEventRouter(handlers: ChatEventHandlers) {
  return (message: WSMessage) => {
    const { type, payload, requestId } = message;

    switch (type) {
      case 'chat:message':
        // New message received - fetch content and add to state
        handlers.onMessage(payload.groupId, payload);
        break;

      case 'chat:message_edited':
        // Message edited - fetch updated content
        handlers.onMessageEdited(payload.groupId, payload.messageId, payload.editedAt);
        break;

      case 'chat:message_deleted':
        // Message deleted - remove from UI or show "deleted" placeholder
        handlers.onMessageDeleted(payload.groupId, payload.messageId);
        break;

      case 'chat:typing':
        // Typing indicator - update typing users list
        handlers.onTyping(payload.groupId, {
          userId: payload.userId,
          username: payload.username,
          groupId: payload.groupId,
          isTyping: payload.isTyping,
          startedAt: new Date()
        });
        break;

      case 'chat:presence':
        // Presence update - update user status
        handlers.onPresence(payload.groupId, payload);
        break;

      case 'chat:reactions_updated':
        // Reactions changed - update message reactions
        handlers.onReactionsUpdated(payload.groupId, payload.messageId, payload.reactions);
        break;

      case 'chat:message_read':
        // Read receipts - update message read status
        handlers.onMessageRead(payload.groupId, payload.messageIds, payload.userId);
        break;

      case 'chat:mention':
        // User mentioned - show notification
        handlers.onMention(payload.groupId, payload.message, payload.mentionType);
        break;

      case 'chat:error':
        // Error received
        handlers.onError(payload.error, requestId);
        break;

      case 'chat:ack':
        // Acknowledgment - update optimistic message status
        // Handle in pending message queue
        break;

      case 'pong':
        // Heartbeat response - connection alive
        break;
    }
  };
}
```

---

# 8. Error Handling

## 8.1 Error Codes Reference

| Code | HTTP Status | Description | Frontend Action |
|------|-------------|-------------|-----------------|
| `UNAUTHORIZED` | 401 | Invalid/expired token | Redirect to login |
| `FORBIDDEN` | 403 | Not a group member | Remove group, show error |
| `NOT_FOUND` | 404 | Message/resource not found | Remove from UI |
| `VALIDATION_ERROR` | 400 | Invalid input data | Show field errors |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests | Show cooldown, disable input |
| `SEND_FAILED` | 500 | Failed to send message | Retry button |
| `EDIT_FAILED` | 500 | Failed to edit message | Retry or cancel |
| `DELETE_FAILED` | 500 | Failed to delete | Retry |
| `REACTION_FAILED` | 500 | Failed to add/remove reaction | Silent retry |
| `SEARCH_FAILED` | 500 | Search error | Show error, allow retry |
| `PIN_FAILED` | 500 | Failed to pin message | Show error |

## 8.2 Validation Error Format

```typescript
{
  success: false,
  error: "Validation failed",
  code: "VALIDATION_ERROR",
  validationErrors: [
    { field: "content", message: "content must be at least 1 character" },
    { field: "groupId", message: "groupId must be a valid UUID" }
  ],
  timestamp: "2025-12-08T12:00:00.000Z"
}
```

## 8.3 Frontend Error Handling Pattern

```typescript
async function sendMessage(groupId: string, content: string): Promise<ChatMessage | null> {
  try {
    const response = await api.post(`/groups/${groupId}/chat/messages`, { content });

    if (!response.data.success) {
      handleApiError(response.data);
      return null;
    }

    return response.data.data.message;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const data = error.response?.data;

      switch (status) {
        case 401:
          // Token expired - refresh or redirect to login
          await refreshToken();
          return sendMessage(groupId, content);  // Retry

        case 403:
          showError('You are no longer a member of this group');
          removeGroupFromState(groupId);
          break;

        case 429:
          const retryAfter = data?.details?.retryAfter || 60;
          showError(`Please wait ${retryAfter} seconds before sending more messages`);
          setRateLimited(true, retryAfter);
          break;

        default:
          showError('Failed to send message. Please try again.');
      }
    }
    return null;
  }
}
```

---

# 9. Rate Limiting

## 9.1 Rate Limits by Endpoint

### HTTP API Limits

| Endpoint Category | Limit | Window | Response on Exceed |
|-------------------|-------|--------|-------------------|
| Send Message | 30 requests | 1 minute | 429 + RATE_LIMIT_EXCEEDED |
| Edit Message | 10 requests | 1 minute | 429 |
| Reactions | 60 requests | 1 minute | 429 |
| Search | 20 requests | 1 minute | 429 |
| Other | 100 requests | 1 minute | 429 |

### WebSocket Limits

| Operation | Limit | Window |
|-----------|-------|--------|
| Messages | 10 | 1 second |
| Typing updates | 5 | 1 second |
| Reactions | 20 | 1 second |

## 9.2 Handling Rate Limits

```typescript
// Rate limit response
{
  success: false,
  error: "Rate limit exceeded. Please slow down.",
  code: "RATE_LIMIT_EXCEEDED",
  details: {
    retryAfter: 60,        // Seconds until limit resets
    limit: 30,             // Max requests
    remaining: 0,          // Requests remaining
    resetAt: "2025-12-08T12:01:00.000Z"
  },
  timestamp: "2025-12-08T12:00:00.000Z"
}
```

## 9.3 Frontend Rate Limit Handling

```typescript
class RateLimiter {
  private messageQueue: Array<{ content: string; resolve: Function; reject: Function }> = [];
  private isProcessing = false;
  private rateLimitedUntil: number | null = null;

  async sendMessage(content: string): Promise<void> {
    if (this.rateLimitedUntil && Date.now() < this.rateLimitedUntil) {
      const waitTime = Math.ceil((this.rateLimitedUntil - Date.now()) / 1000);
      throw new Error(`Rate limited. Please wait ${waitTime} seconds.`);
    }

    return new Promise((resolve, reject) => {
      this.messageQueue.push({ content, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.messageQueue.length === 0) return;
    this.isProcessing = true;

    while (this.messageQueue.length > 0) {
      const item = this.messageQueue.shift()!;

      try {
        await this.doSend(item.content);
        item.resolve();
      } catch (error: any) {
        if (error.code === 'RATE_LIMIT_EXCEEDED') {
          // Put back in queue and wait
          this.messageQueue.unshift(item);
          this.rateLimitedUntil = Date.now() + (error.retryAfter * 1000);
          await this.sleep(error.retryAfter * 1000);
          this.rateLimitedUntil = null;
        } else {
          item.reject(error);
        }
      }

      // Small delay between messages to avoid bursting
      await this.sleep(100);
    }

    this.isProcessing = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

---

# 10. Encryption

## 10.1 How Encryption Works

The backend handles all encryption/decryption transparently:

1. **On Send:** Message content is encrypted with AES-256-GCM using group-specific keys
2. **On Storage:** Encrypted content is stored in MySQL
3. **On Retrieve:** Content is decrypted before sending to authorized users
4. **Key Management:** `GroupEncryptionManager` handles key rotation and storage

## 10.2 Frontend Considerations

- **No client-side encryption needed** - Backend handles everything
- **Always use HTTPS/WSS** - Protects data in transit
- **WebSocket broadcasts don't include content** - Prevents unauthorized decryption
- **Fetch decrypted content via REST** - Ensures proper authorization check

## 10.3 Security Best Practices for Frontend

```typescript
// DO: Store tokens securely
const storeToken = (token: string) => {
  // For web: Use httpOnly cookies if possible
  // For mobile: Use secure storage (Keychain/Keystore)
  sessionStorage.setItem('auth_token', token);  // Better than localStorage
};

// DO: Clear sensitive data on logout
const logout = () => {
  sessionStorage.removeItem('auth_token');
  // Clear all message content from memory
  chatStore.clearAllMessages();
  // Close WebSocket connection
  ws.close();
};

// DON'T: Log message content
console.log(message.content);  // NEVER in production

// DO: Sanitize displayed content (XSS prevention)
const displayMessage = (content: string) => {
  return DOMPurify.sanitize(content);
};
```

---

# 11. Mobile-First Design Patterns

## 11.1 Cursor-Based Pagination

Unlike offset pagination, cursor-based pagination is efficient for:
- Real-time data (new messages don't shift pages)
- Infinite scroll
- Large datasets

```typescript
// Pagination state
interface PaginationState {
  messages: ChatMessage[];
  oldestCursor: string | null;  // For loading older
  newestCursor: string | null;  // For loading newer
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
}

// Load initial messages
async function loadInitialMessages(groupId: string): Promise<void> {
  const response = await api.get(`/groups/${groupId}/chat/messages?limit=50`);

  setState({
    messages: response.data.data.messages,
    oldestCursor: response.data.data.nextCursor,
    newestCursor: response.data.data.messages[0]?.id || null,
    hasMoreOlder: response.data.data.hasMore,
    hasMoreNewer: false,  // We loaded the newest
    isLoadingOlder: false,
    isLoadingNewer: false
  });
}

// Load older messages (scrolling up)
async function loadOlderMessages(groupId: string): Promise<void> {
  if (!state.hasMoreOlder || state.isLoadingOlder) return;

  setState({ isLoadingOlder: true });

  const response = await api.get(
    `/groups/${groupId}/chat/messages?limit=50&before=${state.oldestCursor}`
  );

  setState({
    messages: [...state.messages, ...response.data.data.messages],
    oldestCursor: response.data.data.nextCursor,
    hasMoreOlder: response.data.data.hasMore,
    isLoadingOlder: false
  });
}

// Load newer messages (polling or after reconnect)
async function loadNewerMessages(groupId: string): Promise<void> {
  if (!state.newestCursor) return;

  const response = await api.get(
    `/groups/${groupId}/chat/messages?limit=50&after=${state.newestCursor}`
  );

  if (response.data.data.messages.length > 0) {
    setState({
      messages: [...response.data.data.messages, ...state.messages],
      newestCursor: response.data.data.messages[0].id
    });
  }
}
```

## 11.2 Optimistic Updates

Show changes immediately, sync with server in background:

```typescript
interface PendingMessage {
  clientMessageId: string;
  content: string;
  status: 'sending' | 'sent' | 'failed';
  createdAt: Date;
  retryCount: number;
}

async function sendMessageOptimistically(groupId: string, content: string): Promise<void> {
  const clientMessageId = crypto.randomUUID();

  // 1. Add to UI immediately
  const optimisticMessage: ChatMessage = {
    id: clientMessageId,  // Temporary ID
    clientMessageId,
    groupId,
    senderUserId: currentUser.id,
    senderUsername: currentUser.username,
    content,
    contentType: 'text',
    status: 'sending',
    isEdited: false,
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    reactions: []
  };

  addMessageToState(optimisticMessage);
  scrollToBottom();

  // 2. Send to server
  try {
    const response = await api.post(`/groups/${groupId}/chat/messages`, {
      content,
      clientMessageId
    });

    // 3. Update with server response
    updateMessageInState(clientMessageId, {
      id: response.data.data.message.id,
      status: 'sent',
      createdAt: response.data.data.message.createdAt
    });

  } catch (error) {
    // 4. Mark as failed
    updateMessageInState(clientMessageId, { status: 'failed' });

    // 5. Show retry option
    showRetryButton(clientMessageId);
  }
}

async function retryMessage(clientMessageId: string): Promise<void> {
  const message = getMessageByClientId(clientMessageId);
  if (!message) return;

  updateMessageInState(clientMessageId, { status: 'sending' });

  try {
    const response = await api.post(`/groups/${message.groupId}/chat/messages`, {
      content: message.content,
      clientMessageId
    });

    updateMessageInState(clientMessageId, {
      id: response.data.data.message.id,
      status: 'sent'
    });
  } catch (error) {
    updateMessageInState(clientMessageId, { status: 'failed' });
  }
}
```

## 11.3 Debounced Typing Indicators

```typescript
import { useMemo, useRef, useEffect } from 'react';
import debounce from 'lodash/debounce';

function useTypingIndicator(groupId: string, ws: WebSocket) {
  const isTypingRef = useRef(false);
  const stopTypingTimeoutRef = useRef<number | null>(null);

  const sendTypingStart = useMemo(
    () => debounce(() => {
      if (!isTypingRef.current) {
        isTypingRef.current = true;
        ws.send(JSON.stringify({
          type: 'chat:typing_start',
          payload: { groupId }
        }));
      }

      // Auto-stop after 5 seconds of no typing
      if (stopTypingTimeoutRef.current) {
        clearTimeout(stopTypingTimeoutRef.current);
      }
      stopTypingTimeoutRef.current = setTimeout(() => {
        sendTypingStop();
      }, 5000);
    }, 300),
    [groupId, ws]
  );

  const sendTypingStop = () => {
    if (isTypingRef.current) {
      isTypingRef.current = false;
      ws.send(JSON.stringify({
        type: 'chat:typing_stop',
        payload: { groupId }
      }));
    }

    if (stopTypingTimeoutRef.current) {
      clearTimeout(stopTypingTimeoutRef.current);
      stopTypingTimeoutRef.current = null;
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      sendTypingStop();
      sendTypingStart.cancel();
    };
  }, []);

  return {
    onKeyPress: sendTypingStart,
    onBlur: sendTypingStop,
    onSubmit: sendTypingStop
  };
}
```

## 11.4 Offline Support & Message Queue

```typescript
interface QueuedMessage {
  id: string;
  groupId: string;
  content: string;
  contentType: MessageContentType;
  metadata?: MessageMetadata;
  queuedAt: Date;
  retryCount: number;
}

class OfflineMessageQueue {
  private queue: QueuedMessage[] = [];
  private isOnline: boolean = navigator.onLine;

  constructor() {
    // Listen for online/offline events
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());

    // Load persisted queue from storage
    this.loadFromStorage();
  }

  private handleOnline(): void {
    this.isOnline = true;
    this.flushQueue();
  }

  private handleOffline(): void {
    this.isOnline = false;
  }

  async enqueue(message: Omit<QueuedMessage, 'id' | 'queuedAt' | 'retryCount'>): Promise<void> {
    const queuedMessage: QueuedMessage = {
      ...message,
      id: crypto.randomUUID(),
      queuedAt: new Date(),
      retryCount: 0
    };

    this.queue.push(queuedMessage);
    this.saveToStorage();

    // Try to send immediately if online
    if (this.isOnline) {
      await this.flushQueue();
    }
  }

  private async flushQueue(): Promise<void> {
    while (this.queue.length > 0 && this.isOnline) {
      const message = this.queue[0];

      try {
        await api.post(`/groups/${message.groupId}/chat/messages`, {
          content: message.content,
          contentType: message.contentType,
          clientMessageId: message.id,
          metadata: message.metadata
        });

        // Success - remove from queue
        this.queue.shift();
        this.saveToStorage();

      } catch (error) {
        message.retryCount++;

        if (message.retryCount >= 3) {
          // Max retries exceeded - move to failed
          this.queue.shift();
          this.handleFailedMessage(message);
        } else {
          // Wait before retry
          await this.sleep(Math.pow(2, message.retryCount) * 1000);
        }
      }
    }
  }

  private loadFromStorage(): void {
    const stored = localStorage.getItem('offline_message_queue');
    if (stored) {
      this.queue = JSON.parse(stored);
    }
  }

  private saveToStorage(): void {
    localStorage.setItem('offline_message_queue', JSON.stringify(this.queue));
  }

  private handleFailedMessage(message: QueuedMessage): void {
    // Show notification to user
    showNotification(`Failed to send message: "${message.content.substring(0, 50)}..."`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

## 11.5 Connection Recovery

```typescript
class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private activeGroups: Set<string> = new Set();
  private pendingSubscriptions: Set<string> = new Set();
  private token: string;
  private handlers: Map<string, Function[]> = new Map();

  connect(token: string): void {
    this.token = token;
    this.ws = new WebSocket(`wss://server/mirror/groups/chat?token=${token}`);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;

      // Rejoin all active groups
      for (const groupId of this.activeGroups) {
        this.joinGroup(groupId);
      }

      // Process pending subscriptions
      for (const groupId of this.pendingSubscriptions) {
        this.joinGroup(groupId);
      }
      this.pendingSubscriptions.clear();

      // Start heartbeat
      this.startHeartbeat();

      // Emit connected event
      this.emit('connected');
    };

    this.ws.onclose = (event) => {
      console.log('WebSocket closed:', event.code, event.reason);
      this.stopHeartbeat();

      // Don't reconnect for auth errors
      if (event.code === 4001) {
        this.emit('authError');
        return;
      }

      // Attempt reconnect with exponential backoff
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        console.log(`Reconnecting in ${delay}ms...`);

        setTimeout(() => {
          this.reconnectAttempts++;
          this.connect(this.token);
        }, delay);

        this.emit('reconnecting', { attempt: this.reconnectAttempts + 1, delay });
      } else {
        this.emit('maxReconnectAttemptsReached');
      }
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.emit('error', error);
    };
  }

  joinGroup(groupId: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.activeGroups.add(groupId);
      this.send({
        type: 'chat:join_group',
        payload: { groupId }
      });
    } else {
      // Queue for when connection is restored
      this.pendingSubscriptions.add(groupId);
    }
  }

  leaveGroup(groupId: string): void {
    this.activeGroups.delete(groupId);
    this.pendingSubscriptions.delete(groupId);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        type: 'chat:leave_group',
        payload: { groupId }
      });
    }
  }

  // ... other methods
}
```

---

# 12. Implementation Checklist

## 12.1 Core Features

- [ ] **Authentication**
  - [ ] Login and token storage
  - [ ] Token refresh mechanism
  - [ ] Logout and cleanup

- [ ] **WebSocket Connection**
  - [ ] Initial connection with JWT
  - [ ] Heartbeat (ping every 30s)
  - [ ] Reconnection with exponential backoff
  - [ ] Group subscription management
  - [ ] Event routing

- [ ] **Message Display**
  - [ ] Message list with virtualization
  - [ ] Cursor-based pagination (older messages)
  - [ ] Pull-to-refresh (newer messages)
  - [ ] Message grouping by date
  - [ ] Sender avatars/names
  - [ ] Timestamps
  - [ ] Message status indicators (sending/sent/delivered/failed)
  - [ ] Edited indicator
  - [ ] Deleted message placeholder

- [ ] **Message Sending**
  - [ ] Text input with character limit (10000)
  - [ ] Optimistic updates
  - [ ] Retry failed messages
  - [ ] Offline queue

- [ ] **Threading/Replies**
  - [ ] Reply to message
  - [ ] Thread view
  - [ ] Reply preview in parent

## 12.2 Rich Features

- [ ] **Reactions**
  - [ ] Emoji picker
  - [ ] Add reaction
  - [ ] Remove reaction
  - [ ] Reaction display with counts
  - [ ] "You reacted" indicator

- [ ] **Typing Indicators**
  - [ ] Debounced typing start/stop
  - [ ] Display typing users
  - [ ] Auto-clear after 5s

- [ ] **Presence**
  - [ ] Online/away/busy/offline states
  - [ ] Status indicators in member list
  - [ ] Last seen timestamps

- [ ] **Read Receipts**
  - [ ] Mark messages as read (debounced)
  - [ ] Display who read (optional)
  - [ ] Unread count badges

- [ ] **Pinned Messages**
  - [ ] Pin button (admin only)
  - [ ] Pinned messages list/panel
  - [ ] Pin indicator on messages

- [ ] **Search**
  - [ ] Search input
  - [ ] Search results display
  - [ ] Jump to message in context

- [ ] **Mentions**
  - [ ] @user autocomplete
  - [ ] @everyone support
  - [ ] Mention highlighting
  - [ ] Mention notifications

## 12.3 UX Considerations

- [ ] **Loading States**
  - [ ] Initial load skeleton
  - [ ] Loading older messages indicator
  - [ ] Sending message indicator

- [ ] **Error States**
  - [ ] Network error handling
  - [ ] Rate limit feedback
  - [ ] Validation error display

- [ ] **Notifications**
  - [ ] New message notifications
  - [ ] Mention notifications
  - [ ] Sound/vibration options

- [ ] **Accessibility**
  - [ ] Screen reader support
  - [ ] Keyboard navigation
  - [ ] Focus management

---

# Appendix: Quick Reference

## API Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/groups/:groupId/chat/messages` | Send message |
| GET | `/groups/:groupId/chat/messages` | Get messages |
| GET | `/groups/:groupId/chat/messages/:id` | Get single message |
| PUT | `/groups/:groupId/chat/messages/:id` | Edit message |
| DELETE | `/groups/:groupId/chat/messages/:id` | Delete message |
| POST | `/groups/:groupId/chat/messages/:id/reactions` | Add reaction |
| DELETE | `/groups/:groupId/chat/messages/:id/reactions/:emoji` | Remove reaction |
| GET | `/groups/:groupId/chat/messages/:id/reactions` | Get reactions |
| POST | `/groups/:groupId/chat/read` | Mark as read |
| GET | `/groups/:groupId/chat/unread` | Get unread count |
| POST | `/groups/:groupId/chat/typing` | Set typing |
| GET | `/groups/:groupId/chat/typing` | Get typing users |
| POST | `/groups/:groupId/chat/presence` | Update presence |
| GET | `/groups/:groupId/chat/presence` | Get presence |
| POST | `/groups/:groupId/chat/messages/:id/pin` | Pin message |
| DELETE | `/groups/:groupId/chat/messages/:id/pin` | Unpin message |
| GET | `/groups/:groupId/chat/pinned` | Get pinned |
| GET | `/groups/:groupId/chat/search` | Search messages |

## WebSocket Messages Summary

**Client → Server:**
`chat:join_group`, `chat:leave_group`, `chat:send_message`, `chat:edit_message`, `chat:delete_message`, `chat:typing_start`, `chat:typing_stop`, `chat:presence_update`, `chat:mark_read`, `chat:add_reaction`, `chat:remove_reaction`, `ping`

**Server → Client:**
`chat:message`, `chat:message_edited`, `chat:message_deleted`, `chat:typing`, `chat:presence`, `chat:reactions_updated`, `chat:message_read`, `chat:mention`, `chat:group_joined`, `chat:group_left`, `chat:ack`, `chat:error`, `pong`

---

*Document Version: 1.0*
*Last Updated: December 8, 2025*
*Backend Branch: `claude/websocket-chat-infrastructure-017f2PV2q2VFoaG82TmCG6TA`*
