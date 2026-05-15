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
// IMPORTANT — no top-level import of '../systems/mirrorGroupNotifications'.
// That file imports THIS file (dispatchPushFromNotification), so a static
// import here creates a circular dependency. Under Node CommonJS the
// singleton would resolve to `undefined` at our load time and stay that
// way for the lifetime of the process — every push call would TypeError.
//
// Phase 6a.5 needs to check whether the user is currently active in the
// app before firing a push. Caller passes the check as an option (see
// DispatchOptions below). The dispatcher itself has no implicit deps.

const logger = new Logger('PushDispatcher');

// Phase 6a.5: notification types that should set requireInteraction:true
// on the OS notification. These are higher-stakes events the user should
// see / dismiss intentionally (vs. chat noise that auto-clears). Anything
// not in this list — including chat_message — uses the OS default
// (auto-dismiss after a few seconds).
const REQUIRE_INTERACTION_TYPES = new Set<string>([
	'group_invite',
	'video_call_started',
	'vote_proposed',
	'chat_mention',
	// Phase 6a.8: direct replies are high-signal (someone is engaging
	// with the user's specific message) — keep them on the lock screen
	// until tapped.
	'chat_reply',
	'personal_analysis_complete',
	'ts_review_received',
	'ts_milestone_earned',
	'ts_analysis_complete',
]);

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

/**
 * Phase 6a.5 / 6b / 6c: caller-provided dependencies. Avoids circular imports.
 *
 *   isUserActive — Phase 6a.5. Sync check; skip push when the user is
 *     foregrounded in the app (in-app WS notification covers that case).
 *
 *   isMuted — Phase 6b. Async check against the per-user notification
 *     preferences (services/notificationPreferences.ts). Skip push when
 *     the user has opted out of this event type — either globally or
 *     for this specific group. Failure to resolve (rejection) is
 *     treated as "not muted" so a transient DB hiccup doesn't silently
 *     drop notifications for everyone.
 *
 *   onPushOutcome — Phase 6c. Fired after pushService.send() returns
 *     (success OR all-zero). The email fallback service uses this to
 *     decide whether to send an email when push didn't reach any
 *     device. Errors inside the hook are swallowed.
 *
 * All are optional. If omitted, dispatcher falls back to the original
 * 6a behavior (always fire push when subscriptions exist).
 */
export interface DispatchOptions {
	isUserActive?: (userId: string) => boolean;
	isMuted?: (
		userId: string,
		eventType: string,
		groupId?: string,
	) => Promise<boolean>;
	onPushOutcome?: (
		notification: DispatchableNotification,
		template: DispatchableTemplate,
		result: { sent: number; failed: number; expired: number; skipped: number },
	) => void;
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
	options: DispatchOptions = {},
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

		// Phase 6a.5: skip push if the user is currently active in the app.
		// `isUserActive` is injected by the caller (see DispatchOptions).
		// If the check throws (defensive — caller bug, not ours), treat as
		// inactive and fire push so the notification isn't silently dropped.
		if (options.isUserActive) {
			let active = false;
			try {
				active = options.isUserActive(String(notification.userId));
			} catch (err) {
				logger.warn('isUserActive threw — proceeding with push', {
					userId: notification.userId,
					type: notification.type,
					message: (err as Error)?.message,
				});
			}
			if (active) {
				logger.info('Push skipped — user is active in app', {
					userId: notification.userId,
					type: notification.type,
				});
				return;
			}
		}

		// Phase 6b: skip push if the user has muted this event type
		// (globally or for the originating group). The check is async
		// and may hit the DB on cache miss; we ALWAYS wait for it so a
		// muted user doesn't get a stray push due to a race. Errors
		// fail-open (treat as not muted) so a transient DB issue
		// doesn't deny notifications wholesale.
		if (options.isMuted) {
			let muted = false;
			try {
				const groupId = stringOrUndef(
					(notification.content.metadata || {} as Record<string, unknown>).groupId,
				);
				muted = await options.isMuted(
					String(notification.userId),
					notification.type,
					groupId,
				);
			} catch (err) {
				logger.warn('isMuted threw — proceeding with push', {
					userId: notification.userId,
					type: notification.type,
					message: (err as Error)?.message,
				});
			}
			if (muted) {
				logger.info('Push skipped — user muted this category', {
					userId: notification.userId,
					type: notification.type,
				});
				return;
			}
		}

		const payload = buildPushPayload(notification, template);

		// Fire-and-forget: pushService.send() already swallows per-device
		// failures and returns counts. We log + move on regardless.
		const result = await pushService.send(userIdNum, payload);

		// Phase 6c: notify the caller of the push outcome BEFORE we
		// short-circuit on zero-counts. The email fallback service uses
		// this hook to decide whether to send an email when nothing
		// reached the user's devices. Errors inside the hook are
		// isolated — they MUST NOT affect push reporting.
		if (options.onPushOutcome) {
			try {
				options.onPushOutcome(notification, template, result);
			} catch (err) {
				logger.warn('onPushOutcome hook threw', {
					userId: notification.userId,
					type: notification.type,
					message: (err as Error)?.message,
				});
			}
		}

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
		url: deriveActionUrl(notification),
		tag: deriveTag(notification),
		// Deep-link metadata for the SW notificationclick handler.
		data: {
			notificationType: notification.type,
			...(notification.content.metadata || {}),
		},
		// Phase 6a.5: requireInteraction limited to high-stakes types
		// (invites, calls, votes, mentions, completed analyses). Chat
		// messages and reactions auto-dismiss like normal notifications;
		// previously every 'immediate' priority event persisted on the
		// lock screen which was annoying for active group chats.
		requireInteraction: REQUIRE_INTERACTION_TYPES.has(notification.type),
	};
}

/**
 * Phase 6a.6: derive a deep-link URL based on the notification type and
 * its metadata. The SW's notificationclick handler reads `payload.url`
 * and navigates the user there. Without this, every push opens the app
 * at /Mirror/ root.
 *
 * Mirrors the client-side mapping in NotificationContext.tsx
 * (truthStreamActionMap) so in-app and push deep-links stay consistent.
 *
 * Falls back to the notification's own `actionUrl` for types whose
 * templates set joinUrl (video calls, drawing sessions); falls back to
 * undefined when no specific URL applies — SW then opens /Mirror/.
 */
function deriveActionUrl(notification: DispatchableNotification): string | undefined {
	const meta = (notification.content.metadata || {}) as Record<string, unknown>;
	const type = notification.type;

	const groupId = stringOrUndef(meta.groupId);
	const messageId = stringOrUndef(meta.messageId);
	const reviewId = stringOrUndef(meta.reviewId);
	const recipientView = stringOrUndef(meta.recipientView);
	const analysisId = stringOrUndef(meta.analysisId);

	// TruthStream — mirror the client-side truthStreamActionMap.
	switch (type) {
		case 'ts_review_received':
			return '/Mirror/truthstream?view=received';
		case 'ts_dialogue_message': {
			const view = recipientView || 'received';
			return reviewId
				? `/Mirror/truthstream?view=${view}&reviewId=${reviewId}`
				: `/Mirror/truthstream?view=${view}`;
		}
		case 'ts_review_classified':
			return '/Mirror/truthstream?view=received';
		case 'ts_analysis_complete':
			return '/Mirror/truthstream?view=analysis';
		case 'ts_queue_assigned':
			return '/Mirror/truthstream?view=queue';
		case 'ts_milestone_earned':
			return '/Mirror/truthstream?view=overview';

		// Group invites land on the groups index where the user can accept/decline.
		case 'group_invite':
			return '/Mirror/groups';

		// Group activity → the specific group via ?groupId= query.
		// (The route is /Mirror/groups; the page reads groupId from the
		// query string and opens the corresponding GroupDetailView.)
		case 'member_joined':
		case 'analysis_completed':
		case 'compatibility_updated':
		case 'conversation_summary':
			return groupId ? `/Mirror/groups?groupId=${groupId}` : '/Mirror/groups';

		// Voting → same group page (vote details inside).
		case 'vote_proposed':
		case 'vote_completed':
			return groupId ? `/Mirror/groups?groupId=${groupId}` : '/Mirror/groups';

		// Chat: deep-link to the group via query string. Mentions and
		// replies additionally include the message ID so the chat view
		// can scroll-to-message on open.
		case 'chat_message':
			return groupId ? `/Mirror/groups?groupId=${groupId}` : '/Mirror/groups';
		case 'chat_mention':
			if (groupId && messageId) return `/Mirror/groups?groupId=${groupId}&messageId=${messageId}`;
			return groupId ? `/Mirror/groups?groupId=${groupId}` : '/Mirror/groups';
		// Phase 6a.8: chat_reply deep-links to the REPLY message itself
		// (not the parent) so the user sees the new content; their
		// existing parent message is in scrollback.
		case 'chat_reply':
			if (groupId && messageId) return `/Mirror/groups?groupId=${groupId}&messageId=${messageId}`;
			return groupId ? `/Mirror/groups?groupId=${groupId}` : '/Mirror/groups';

		// Personal analysis (DINA Truth Mirror Report).
		case 'personal_analysis_complete':
			return analysisId
				? `/Mirror/mymirror?analysisId=${analysisId}`
				: '/Mirror/mymirror';
	}

	// Templates that set joinUrl in their data payload (video_call_started,
	// drawing_session_started). The notify() flow puts this on
	// content.actionUrl. Sanitize + prefix as before.
	if (notification.content.actionUrl) {
		return sanitizeAndPrefixUrl(notification.content.actionUrl);
	}

	return undefined; // SW falls back to /Mirror/.
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
	const analysisId = stringOrUndef(meta.analysisId);

	// Type-specific tag derivation. Order: most specific id wins.
	if (type === 'ts_dialogue_message' && dialogueId) return `${type}:${dialogueId}`;
	if (type === 'ts_review_received' && reviewId) return `${type}:${reviewId}`;
	if (type === 'ts_review_classified' && reviewId) return `${type}:${reviewId}`;
	// Phase 6a.5: each personal analysis gets its own tag so multiple
	// completion notifications don't collapse into one on the device.
	if (type === 'personal_analysis_complete' && analysisId) return `${type}:${analysisId}`;
	// Mentions tagged per-message so each @-mention gets its own
	// notification (won't collapse with regular chat_message bursts).
	if (type === 'chat_mention' && messageId) return `${type}:${messageId}`;
	// Phase 6a.8: replies tagged per-reply-message so a thread of
	// replies doesn't collapse on the device — each reply is a
	// separate signal that someone engaged with the user's content.
	if (type === 'chat_reply' && messageId) return `${type}:${messageId}`;
	// Regular chat: collapse all messages from the same group into one
	// device-side notification (prevents 5 messages = 5 buzzes).
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