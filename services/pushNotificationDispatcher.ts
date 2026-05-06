// ============================================================================
// PUSH NOTIFICATION DISPATCHER (Phase 6a)
// ============================================================================
// File: services/pushNotificationDispatcher.ts
// Description: Bridge between mirror-server's central notification system
//              (mirrorGroupNotifications.ts) and the Web Push subscriptions
//              persisted by Phase 4 (services/pushService.ts).
//
// USAGE: called from mirrorGroupNotifications.sendNotification() AFTER the
//        WebSocket / queue paths complete. One line, fire-and-forget:
//
//          import { dispatchPushFromNotification } from '../services/pushNotificationDispatcher';
//          ...
//          // inside sendNotification(), after queueNotification(...) succeeds:
//          void dispatchPushFromNotification(notification, template);
//
// WHY A SEPARATE MODULE
//   - mirrorGroupNotifications.ts is 1025 lines and shouldn't grow another
//     concern (push payload construction, URL prefixing, tag derivation).
//   - Push delivery is purely additive: any error here MUST NOT propagate
//     to the WebSocket path. The dispatcher swallows everything.
//   - Per-event-type tag derivation, URL sanitization, and userId
//     conversion all live in one place — easy to audit / change.
//
// WHAT IT DOES
//   - Checks template.channels.includes('push'). If not, no-op.
//   - Converts userId string -> number (push_subscriptions.user_id is INT).
//   - Prefixes actionUrl with /Mirror/ so the SW's deep-link sanitizer accepts it.
//   - Builds a `tag` for OS-level notification dedup (e.g. 5 chat messages
//     in the same group collapse to one).
//   - Calls pushService.send(); logs the result; never throws.
// ============================================================================

import { pushService, PushPayload } from './pushService';
import { Logger } from '../utils/logger';

const logger = new Logger('PushDispatcher');

// ============================================================================
// MINIMAL TYPES (decoupled from mirrorGroupNotifications.ts internals)
// ============================================================================
//
// We intentionally accept the minimum shape we need rather than importing
// the full NotificationDelivery + template types from mirrorGroupNotifications.
// This keeps the dispatcher independent and avoids circular imports.

export interface DispatchableNotification {
	userId: string | number;
	type: string;
	content: {
		title: string;
		message: string;
		actionUrl?: string;
		metadata?: Record<string, unknown>;
	};
}

export interface DispatchableTemplate {
	channels: readonly string[];
	priority: 'immediate' | 'normal' | 'low';
}

// ============================================================================
// PUBLIC ENTRY POINT
// ============================================================================

/**
 * Dispatch a push notification corresponding to a server-side notification
 * event. Call AFTER the in-app (WebSocket / queue) path. Best-effort:
 * never throws; logs failures and returns.
 */
export async function dispatchPushFromNotification(
	notification: DispatchableNotification,
	template: DispatchableTemplate,
): Promise<void> {
	try {
		// Skip if push isn't a configured channel for this notification type.
		if (!template.channels.includes('push')) return;

		const userIdNum = toUserIdNumber(notification.userId);
		if (userIdNum === null) {
			logger.warn('Push dispatch skipped — invalid userId', {
				userId: notification.userId,
				type: notification.type,
			});
			return;
		}

		const payload = buildPushPayload(notification, template);

		// Fire-and-forget: pushService.send() already swallows per-device
		// failures and returns counts. We log + move on regardless.
		const result = await pushService.send(userIdNum, payload);
		if (result.sent === 0 && result.expired === 0 && result.skipped === 0) {
			// User has no active push subscriptions — common, not an error.
			return;
		}
		logger.info('Push dispatched', {
			userId: userIdNum,
			type: notification.type,
			sent: result.sent,
			expired: result.expired,
			skipped: result.skipped,
			failed: result.failed,
		});
	} catch (err) {
		// Absolute backstop: any unexpected error never reaches the caller.
		logger.error('Push dispatch threw', err as Error, {
			userId: notification.userId,
			type: notification.type,
		});
	}
}

// ============================================================================
// PAYLOAD CONSTRUCTION
// ============================================================================

function buildPushPayload(
	notification: DispatchableNotification,
	_template: DispatchableTemplate,
): PushPayload {
	return {
		title: truncate(notification.content.title || 'Mirror', 80),
		body: truncate(notification.content.message || '', 200),
		url: sanitizeAndPrefixUrl(notification.content.actionUrl),
		tag: deriveTag(notification),
		// Deep-link metadata for the SW notificationclick handler.
		data: {
			notificationType: notification.type,
			...(notification.content.metadata || {}),
		},
		// Render-on-screen hint: 'immediate' priority → require interaction
		// (won't auto-dismiss after a few seconds) so e.g. video call
		// invites don't disappear before the user can respond.
		requireInteraction: _template.priority === 'immediate',
	};
}

/**
 * Build a notification `tag` for OS-level dedup. Two pushes with the same
 * tag for the same user collapse into one notification on the device —
 * the latest wins. Strategy:
 *   - Per-group events: tag includes groupId so each group is a separate
 *     "stream" but bursts within a group collapse.
 *   - Per-thread/review events: tag includes the review/dialogue id so
 *     replies to the same thread collapse.
 *   - Type-only fallback: a single notification per type (e.g. one
 *     "Analysis ready" push, not five).
 */
function deriveTag(notification: DispatchableNotification): string {
	const type = notification.type;
	const meta = (notification.content.metadata || {}) as Record<string, unknown>;
	const groupId = stringOrUndef(meta.groupId);
	const sessionId = stringOrUndef(meta.sessionId);
	const reviewId = stringOrUndef(meta.reviewId);
	const dialogueId = stringOrUndef(meta.dialogueId);
	const messageId = stringOrUndef(meta.messageId);

	// Type-specific tag derivation. Order: most specific id wins.
	if (type === 'ts_dialogue_message' && dialogueId) return `${type}:${dialogueId}`;
	if (type === 'ts_review_received' && reviewId) return `${type}:${reviewId}`;
	if (type === 'ts_review_classified' && reviewId) return `${type}:${reviewId}`;
	if (type === 'chat_mention' && messageId) return `${type}:${messageId}`;
	if (type === 'chat_message' && groupId) return `${type}:${groupId}`;
	if (groupId) return `${type}:${groupId}`;
	if (sessionId) return `${type}:${sessionId}`;
	return type;
}

/**
 * Mirror's SW only deep-links to /Mirror/* paths (intentional security
 * boundary in src/sw.ts). Convert server-side template URLs like
 * '/groups/123/video/456' to '/Mirror/groups/123/video/456'.
 *
 * Returns undefined for empty / off-origin / malformed URLs — the SW
 * falls back to the app root in those cases.
 */
function sanitizeAndPrefixUrl(actionUrl: string | undefined): string | undefined {
	if (!actionUrl || typeof actionUrl !== 'string') return undefined;

	const trimmed = actionUrl.trim();
	if (!trimmed) return undefined;

	// Already prefixed.
	if (trimmed.startsWith('/Mirror/')) return trimmed;

	// Reject absolute URLs (off-origin) — SW would reject them anyway.
	if (/^https?:\/\//i.test(trimmed)) return undefined;

	// Root-relative path — prefix with /Mirror.
	if (trimmed.startsWith('/')) return `/Mirror${trimmed}`;

	// Bare path (no leading slash) — prefix with /Mirror/.
	return `/Mirror/${trimmed}`;
}

// ============================================================================
// HELPERS
// ============================================================================

function toUserIdNumber(userId: string | number): number | null {
	if (typeof userId === 'number') {
		return Number.isFinite(userId) && userId > 0 ? userId : null;
	}
	const n = parseInt(userId, 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function truncate(s: string, max: number): string {
	if (typeof s !== 'string') return '';
	return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function stringOrUndef(v: unknown): string | undefined {
	if (typeof v === 'string') return v;
	if (typeof v === 'number') return String(v);
	return undefined;
}
