// ============================================================================
// NOTIFICATION PREFERENCES SERVICE (Phase 6b)
// ============================================================================
// File: services/notificationPreferences.ts
// Description: Per-user, per-category, optionally per-group opt-outs for
//              push notifications. The dispatcher consults this service
//              before firing a Web Push; in-app WebSocket delivery is
//              never gated (the in-app notification panel always shows).
//
// API
//   getMutedSet(userId)       — returns Set<"category:scope"> (e.g. "chat_messages:global"
//                                or "chat_messages:42"). Cached in-memory.
//   isMuted(userId, eventType, groupId?)
//                              — convenience used by the dispatcher.
//   listForUser(userId)        — full list of muted rows for the settings UI.
//   setMuted(userId, category, scope, muted)
//                              — single upsert; invalidates the cache.
//   bulkSet(userId, entries)   — atomic batch update; invalidates the cache.
//   invalidate(userId)         — drop the cache entry (e.g. on user delete).
//
// DESIGN
//   - Default = "not muted". Only muted rows exist in the table, so the
//     read path is one indexed SELECT per cache miss.
//   - In-memory cache: ttl 60s, max 5000 users (LRU-ish — eviction on
//     insert when full). Push fan-out hits getMutedSet() once per send,
//     so high-traffic users (chat-heavy groups) would otherwise hammer
//     the DB. Cache is invalidated on every write.
//   - Categories are a fixed set defined here (CATEGORIES). The route
//     layer rejects unknown categories at the boundary. The dispatcher
//     maps event_type → category via TYPE_TO_CATEGORY. Categories not
//     covered by the map are always delivered (fail-open: missing
//     coverage shouldn't silently drop notifications).
//   - All DB errors are caught and logged; on failure we fail-open
//     (treat the user as having no mutes) so a transient DB issue
//     doesn't deny notifications to everyone.
// ============================================================================

import { DB } from '../db';
import { Logger } from '../utils/logger';

const logger = new Logger('NotificationPreferences');

// ============================================================================
// CATEGORIES — the set of user-facing buckets exposed to the settings UI.
// ============================================================================
//
// Each category groups one or more raw event types. The UI surfaces
// one toggle per category; the dispatcher uses TYPE_TO_CATEGORY to
// translate at dispatch time. Adding a new event type only requires
// adding it to TYPE_TO_CATEGORY (and optionally a new category here).

export const CATEGORIES = [
	'chat_messages',
	'chat_mentions',
	'chat_replies',
	'chat_reactions',
	'group_invites',
	'group_activity',
	'voting',
	'video_calls',
	'drawing_sessions',
	'peer_reviews',
	'compatibility',
	'personal_analysis',
	'truthstream',
	// Phase 6c: master toggle for the email fallback channel. Not in
	// TYPE_TO_CATEGORY — controlled directly by the email-fallback service.
	// Muting this disables ALL email fallbacks for the user (push category
	// mutes additionally suppress email per-category).
	'email_fallbacks',
] as const;

export type Category = (typeof CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set<string>(CATEGORIES);

export function isValidCategory(s: unknown): s is Category {
	return typeof s === 'string' && CATEGORY_SET.has(s);
}

/**
 * Raw event type → user-facing category. Event types NOT in this map
 * are always delivered (fail-open). Add new types here when adding
 * new templates in mirrorGroupNotifications.ts.
 */
export const TYPE_TO_CATEGORY: Readonly<Record<string, Category>> = {
	// Chat
	chat_message: 'chat_messages',
	chat_message_edited: 'chat_messages',
	chat_message_deleted: 'chat_messages',
	chat_mention: 'chat_mentions',
	chat_reply: 'chat_replies',
	chat_reactions_updated: 'chat_reactions',
	chat_message_read: 'chat_reactions', // bundled with reactions (low-signal UX events)

	// Group lifecycle
	group_invite: 'group_invites',
	member_joined: 'group_activity',
	member_left: 'group_activity',
	admin_promoted: 'group_activity',
	admin_demoted: 'group_activity',

	// Voting
	vote_proposed: 'voting',
	vote_completed: 'voting',
	conversation_insight: 'voting',
	conversation_summary: 'voting',

	// Sessions
	video_call_started: 'video_calls',
	drawing_session_started: 'drawing_sessions',

	// Reviews
	peer_review_received: 'peer_reviews',
	compatibility_updated: 'compatibility',

	// Analysis
	analysis_completed: 'personal_analysis',
	personal_analysis_complete: 'personal_analysis',

	// TruthStream
	ts_review_received: 'truthstream',
	ts_review_classified: 'truthstream',
	ts_analysis_complete: 'truthstream',
	ts_dialogue_message: 'truthstream',
	ts_queue_assigned: 'truthstream',
	ts_milestone_earned: 'truthstream',
};

// ============================================================================
// SCOPE
// ============================================================================

export const GLOBAL_SCOPE = 'global';

const MAX_SCOPE_LEN = 40;
const SCOPE_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Validate a scope value. Accepts the literal 'global' OR a bounded
 * alphanumeric token (group_id, etc.). Rejects anything that could
 * trigger injection or DB pathology.
 */
export function isValidScope(s: unknown): s is string {
	if (typeof s !== 'string') return false;
	if (s.length === 0 || s.length > MAX_SCOPE_LEN) return false;
	if (s === GLOBAL_SCOPE) return true;
	return SCOPE_PATTERN.test(s);
}

function muteKey(category: string, scope: string): string {
	return `${category}:${scope}`;
}

// ============================================================================
// IN-MEMORY CACHE (per-user; TTL 60s; bounded size)
// ============================================================================

interface CacheEntry {
	muted: Set<string>; // "category:scope"
	expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 5000;
const cache = new Map<number, CacheEntry>();

function cacheGet(userId: number): Set<string> | null {
	const entry = cache.get(userId);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		cache.delete(userId);
		return null;
	}
	// LRU touch — re-insert moves to end of insertion order.
	cache.delete(userId);
	cache.set(userId, entry);
	return entry.muted;
}

function cacheSet(userId: number, muted: Set<string>): void {
	if (cache.size >= CACHE_MAX_ENTRIES) {
		// Evict the oldest (first inserted) entry. JS Maps preserve
		// insertion order; the first key from .keys() is the oldest.
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(userId, { muted, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheInvalidate(userId: number): void {
	cache.delete(userId);
}

// Periodic sweep to bound memory on long-running processes whose
// users churn (rare but cheap to defend against).
setInterval(() => {
	const now = Date.now();
	for (const [userId, entry] of cache) {
		if (entry.expiresAt <= now) cache.delete(userId);
	}
}, 300_000).unref();

// ============================================================================
// ROW SHAPE
// ============================================================================

interface PreferenceRow {
	category: string;
	scope: string;
	muted: number; // tinyint
}

// ============================================================================
// PUBLIC API
// ============================================================================

export const notificationPreferencesService = {
	CATEGORIES,
	GLOBAL_SCOPE,

	/**
	 * Returns the set of muted "category:scope" keys for a user. Cached;
	 * safe to call on every push dispatch. Fail-open: on DB error, returns
	 * an empty set (i.e. nothing muted) so users still get notifications.
	 */
	async getMutedSet(userId: string | number): Promise<Set<string>> {
		const uid = toUserId(userId);
		if (uid === null) return new Set();

		const cached = cacheGet(uid);
		if (cached) return cached;

		try {
			const [rows] = await DB.execute(
				`SELECT category, scope, muted
				 FROM notification_preferences
				 WHERE user_id = ?`,
				[uid],
			);
			const set = new Set<string>();
			for (const row of rows as PreferenceRow[]) {
				if (row.muted) set.add(muteKey(row.category, row.scope));
			}
			cacheSet(uid, set);
			return set;
		} catch (err) {
			logger.error('Failed to load notification preferences', err as Error, { userId: uid });
			// Fail-open: empty set means nothing is muted.
			return new Set();
		}
	},

	/**
	 * Convenience for the dispatcher. Maps event_type → category and
	 * checks BOTH the global mute and (if provided) the per-group mute.
	 * Returns true iff the user has muted this category for either
	 * scope. Unknown event types are never muted (fail-open).
	 */
	async isMuted(
		userId: string | number,
		eventType: string,
		groupId?: string | number | null,
	): Promise<boolean> {
		const category = TYPE_TO_CATEGORY[eventType];
		if (!category) return false; // unknown event types fall through
		const muted = await this.getMutedSet(userId);
		if (muted.has(muteKey(category, GLOBAL_SCOPE))) return true;
		if (groupId !== undefined && groupId !== null) {
			const scope = String(groupId);
			if (isValidScope(scope) && muted.has(muteKey(category, scope))) return true;
		}
		return false;
	},

	/**
	 * Settings UI fetch. Returns the raw rows for the user as plain
	 * objects suitable for JSON. Excludes muted=0 rows (the table only
	 * ever holds muted=1 rows in practice, but we filter defensively).
	 */
	async listForUser(userId: string | number): Promise<
		Array<{ category: Category; scope: string }>
	> {
		const uid = toUserId(userId);
		if (uid === null) return [];

		try {
			const [rows] = await DB.execute(
				`SELECT category, scope, muted
				 FROM notification_preferences
				 WHERE user_id = ? AND muted = 1`,
				[uid],
			);
			const out: Array<{ category: Category; scope: string }> = [];
			for (const row of rows as PreferenceRow[]) {
				if (isValidCategory(row.category) && isValidScope(row.scope)) {
					out.push({ category: row.category, scope: row.scope });
				}
			}
			return out;
		} catch (err) {
			logger.error('Failed to list notification preferences', err as Error, { userId: uid });
			return [];
		}
	},

	/**
	 * Set the muted state for a single (category, scope). muted=true
	 * upserts the row; muted=false deletes it (default behavior =
	 * "not muted"). Throws on DB failure so the route can return 500.
	 */
	async setMuted(
		userId: string | number,
		category: Category,
		scope: string,
		muted: boolean,
	): Promise<void> {
		const uid = toUserId(userId);
		if (uid === null) throw new Error('Invalid userId');
		if (!isValidCategory(category)) throw new Error('Invalid category');
		if (!isValidScope(scope)) throw new Error('Invalid scope');

		if (muted) {
			await DB.execute(
				`INSERT INTO notification_preferences (user_id, category, scope, muted)
				 VALUES (?, ?, ?, 1)
				 ON DUPLICATE KEY UPDATE muted = 1`,
				[uid, category, scope],
			);
		} else {
			await DB.execute(
				`DELETE FROM notification_preferences
				 WHERE user_id = ? AND category = ? AND scope = ?`,
				[uid, category, scope],
			);
		}
		cacheInvalidate(uid);
	},

	/**
	 * Apply a batch of mute changes atomically. Each entry is
	 * { category, scope, muted }; muted=true upserts, muted=false deletes.
	 * Throws on any invalid entry BEFORE touching the DB; on DB failure
	 * the transaction is rolled back so the caller sees an all-or-nothing
	 * outcome.
	 */
	async bulkSet(
		userId: string | number,
		entries: Array<{ category: Category; scope: string; muted: boolean }>,
	): Promise<void> {
		const uid = toUserId(userId);
		if (uid === null) throw new Error('Invalid userId');
		if (!Array.isArray(entries) || entries.length === 0) return;

		// Validate every entry up-front; bail before touching the DB.
		for (const e of entries) {
			if (!isValidCategory(e.category)) throw new Error(`Invalid category: ${e.category}`);
			if (!isValidScope(e.scope)) throw new Error(`Invalid scope: ${e.scope}`);
			if (typeof e.muted !== 'boolean') throw new Error('muted must be boolean');
		}

		const conn = await DB.getConnection();
		try {
			await conn.beginTransaction();
			for (const e of entries) {
				if (e.muted) {
					await conn.execute(
						`INSERT INTO notification_preferences (user_id, category, scope, muted)
						 VALUES (?, ?, ?, 1)
						 ON DUPLICATE KEY UPDATE muted = 1`,
						[uid, e.category, e.scope],
					);
				} else {
					await conn.execute(
						`DELETE FROM notification_preferences
						 WHERE user_id = ? AND category = ? AND scope = ?`,
						[uid, e.category, e.scope],
					);
				}
			}
			await conn.commit();
			cacheInvalidate(uid);
		} catch (err) {
			try {
				await conn.rollback();
			} catch {
				// rollback failures aren't useful to surface
			}
			throw err;
		} finally {
			conn.release();
		}
	},

	/**
	 * Drop the cache entry for a user. Exposed for tests and for the
	 * (rare) case where another process has updated prefs out-of-band.
	 */
	invalidate(userId: string | number): void {
		const uid = toUserId(userId);
		if (uid !== null) cacheInvalidate(uid);
	},
};

// ============================================================================
// HELPERS
// ============================================================================

function toUserId(userId: string | number): number | null {
	if (typeof userId === 'number') {
		return Number.isFinite(userId) && userId > 0 ? userId : null;
	}
	const n = parseInt(userId, 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}