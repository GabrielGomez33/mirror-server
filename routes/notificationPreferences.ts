// ============================================================================
// NOTIFICATION PREFERENCES ROUTES (Phase 6b)
// ============================================================================
// File: routes/notificationPreferences.ts
// Description: Endpoints the client uses to read/write the per-event-type
//              push opt-outs introduced in Phase 6b. Mount at
//              /mirror/api/user/notification-preferences.
//
// ROUTES
//   GET    /                            — fetch the user's current prefs
//                                          + the catalog of mutable categories
//   PUT    /                            — batch upsert/delete preferences
//
// AUTH
//   AuthMiddleware.verifyToken on both routes. Bearer-token auth, so no
//   CSRF surface; we still tighten body size as a parser-defense.
//
// RATE LIMITING
//   Sliding-window per (userId, action), matching routes/push.ts.
//     read   30 / minute  — UI may open settings repeatedly.
//     write  10 / minute  — typical use is a handful of toggles per session.
//
// BODY SIZE
//   4 KB ceiling on this router. The payload is a small JSON array of
//   {category, scope, muted}; 4 KB comfortably fits the entire catalog.
//
// INPUT VALIDATION
//   Strict — every category and scope is checked against the whitelist
//   defined in services/notificationPreferences.ts. Unknown values
//   produce 400, never silently pass through to the DB.
// ============================================================================

import express, { Request, Response, RequestHandler } from 'express';
import AuthMiddleware from '../middleware/authMiddleware';
import {
	notificationPreferencesService,
	CATEGORIES,
	GLOBAL_SCOPE,
	isValidCategory,
	isValidScope,
	type Category,
} from '../services/notificationPreferences';
import { Logger } from '../utils/logger';

const logger = new Logger('NotificationPrefsRoutes');
const router = express.Router();

router.use(express.json({ limit: '4kb', strict: true }));

// ============================================================================
// RATE LIMITER (matches routes/push.ts pattern)
// ============================================================================

const actionRateLimits = new Map<string, number[]>();
const ACTION_LIMITS: Record<string, { window: number; max: number }> = {
	read: { window: 60_000, max: 30 },
	write: { window: 60_000, max: 10 },
};

function checkActionRate(userId: number, action: string): boolean {
	const config = ACTION_LIMITS[action];
	if (!config) return true;
	const key = `${userId}:${action}`;
	const now = Date.now();
	const timestamps = (actionRateLimits.get(key) || []).filter(
		(t) => now - t < config.window,
	);
	if (timestamps.length >= config.max) return false;
	timestamps.push(now);
	actionRateLimits.set(key, timestamps);
	return true;
}

setInterval(() => {
	const now = Date.now();
	for (const [key, timestamps] of actionRateLimits) {
		const filtered = timestamps.filter((t) => now - t < 300_000);
		if (filtered.length === 0) actionRateLimits.delete(key);
		else actionRateLimits.set(key, filtered);
	}
}, 300_000).unref();

function rateLimit(action: string): RequestHandler {
	return (req, res, next) => {
		const userId = req.user?.id;
		if (!userId) {
			res.status(401).json({ error: 'Unauthorized' });
			return;
		}
		if (!checkActionRate(userId, action)) {
			res.status(429).json({
				error: 'Too many requests. Please slow down.',
				code: 'RATE_LIMITED',
			});
			return;
		}
		next();
	};
}

// ============================================================================
// LIMITS
// ============================================================================

// Defense-in-depth: bound the batch size beyond the 4 KB body limit so a
// pathological client can't spend O(N) DB roundtrips on a single request.
// CATEGORIES.length × ~50 scopes-per-user is a reasonable ceiling.
const MAX_BATCH_ENTRIES = 200;

// ============================================================================
// GET /  — fetch current preferences + catalog
// ============================================================================
//
// Response shape:
//   {
//     categories: [
//       { key: 'chat_messages', label: 'Group messages', perGroupAllowed: true },
//       ...
//     ],
//     muted: [
//       { category: 'chat_messages', scope: 'global' },
//       { category: 'chat_messages', scope: '42' },
//     ]
//   }
//
// The catalog lives server-side so the client doesn't have to encode the
// list of categories twice. Labels and per-group eligibility are
// presentation hints — the client renders the toggle list from this.

interface CategoryDescriptor {
	key: Category;
	label: string;
	description: string;
	perGroupAllowed: boolean;
}

const CATEGORY_CATALOG: readonly CategoryDescriptor[] = [
	{
		key: 'chat_messages',
		label: 'Group chat messages',
		description: 'New messages in groups you belong to.',
		perGroupAllowed: true,
	},
	{
		key: 'chat_mentions',
		label: '@-mentions',
		description: 'When someone @-mentions you in a group chat.',
		perGroupAllowed: true,
	},
	{
		key: 'chat_replies',
		label: 'Direct replies',
		description: 'When someone replies to one of your messages.',
		perGroupAllowed: true,
	},
	{
		key: 'chat_reactions',
		label: 'Reactions & read receipts',
		description: 'When someone reacts to your message or reads it.',
		perGroupAllowed: true,
	},
	{
		key: 'group_invites',
		label: 'Group invitations',
		description: 'When you receive a new group invitation.',
		perGroupAllowed: false,
	},
	{
		key: 'group_activity',
		label: 'Group membership changes',
		description: 'Members joining, leaving, or admin role changes.',
		perGroupAllowed: true,
	},
	{
		key: 'voting',
		label: 'Group votes & insights',
		description: 'New polls, vote results, and conversation summaries.',
		perGroupAllowed: true,
	},
	{
		key: 'video_calls',
		label: 'Video calls',
		description: 'When a group video call starts.',
		perGroupAllowed: true,
	},
	{
		key: 'drawing_sessions',
		label: 'Drawing sessions',
		description: 'When a group drawing session starts.',
		perGroupAllowed: true,
	},
	{
		key: 'peer_reviews',
		label: 'Peer reviews',
		description: 'When a peer reviews your work.',
		perGroupAllowed: false,
	},
	{
		key: 'compatibility',
		label: 'Compatibility updates',
		description: 'When your compatibility scores change.',
		perGroupAllowed: false,
	},
	{
		key: 'personal_analysis',
		label: 'Analysis complete',
		description: 'When your personal Truth Mirror or DINA analysis finishes.',
		perGroupAllowed: false,
	},
	{
		key: 'truthstream',
		label: 'TruthStream',
		description: 'Reviews, dialogue, classifications, queue, milestones.',
		perGroupAllowed: false,
	},
	// Phase 6c — master toggle for the email fallback channel.
	{
		key: 'email_fallbacks',
		label: 'Email fallback',
		description:
			'When a push notification can’t reach any of your devices, email me instead. Only for high-priority events; rate-limited.',
		perGroupAllowed: false,
	},
];

router.get(
	'/',
	AuthMiddleware.verifyToken as RequestHandler,
	rateLimit('read'),
	(async (req: Request, res: Response) => {
		const userId = req.user!.id;
		try {
			const muted = await notificationPreferencesService.listForUser(userId);
			res.json({
				categories: CATEGORY_CATALOG,
				muted,
			});
		} catch (err) {
			logger.error('Failed to fetch notification preferences', err as Error, { userId });
			res.status(500).json({ error: 'Failed to fetch preferences' });
		}
	}) as RequestHandler,
);

// ============================================================================
// PUT /  — batch upsert/delete preferences
// ============================================================================
//
// Body shape:
//   {
//     entries: [
//       { category: 'chat_messages', scope: 'global', muted: true },
//       { category: 'chat_messages', scope: '42',     muted: false },
//       ...
//     ]
//   }
//
// Returns the post-update muted list for the client to reconcile against.

interface RawEntry {
	category?: unknown;
	scope?: unknown;
	muted?: unknown;
}

function validateEntry(
	raw: RawEntry,
): { category: Category; scope: string; muted: boolean } | null {
	if (!raw || typeof raw !== 'object') return null;
	const { category, scope, muted } = raw;
	if (!isValidCategory(category)) return null;
	const scopeStr = scope === undefined || scope === null ? GLOBAL_SCOPE : String(scope);
	if (!isValidScope(scopeStr)) return null;
	if (typeof muted !== 'boolean') return null;
	return { category, scope: scopeStr, muted };
}

router.put(
	'/',
	AuthMiddleware.verifyToken as RequestHandler,
	rateLimit('write'),
	(async (req: Request, res: Response) => {
		const userId = req.user!.id;
		const body = req.body ?? {};
		const rawEntries = body.entries;

		if (!Array.isArray(rawEntries)) {
			res.status(400).json({
				error: 'entries must be an array',
				code: 'INVALID_BODY',
			});
			return;
		}

		if (rawEntries.length === 0) {
			// Idempotent no-op; just return current state.
			try {
				const muted = await notificationPreferencesService.listForUser(userId);
				res.json({ muted });
			} catch (err) {
				logger.error('Failed to fetch prefs (empty PUT)', err as Error, { userId });
				res.status(500).json({ error: 'Failed to fetch preferences' });
			}
			return;
		}

		if (rawEntries.length > MAX_BATCH_ENTRIES) {
			res.status(400).json({
				error: `Too many entries (max ${MAX_BATCH_ENTRIES})`,
				code: 'TOO_MANY_ENTRIES',
			});
			return;
		}

		const validated: Array<{ category: Category; scope: string; muted: boolean }> = [];
		for (let i = 0; i < rawEntries.length; i++) {
			const v = validateEntry(rawEntries[i]);
			if (!v) {
				res.status(400).json({
					error: `Invalid entry at index ${i}`,
					code: 'INVALID_ENTRY',
					index: i,
				});
				return;
			}
			validated.push(v);
		}

		try {
			await notificationPreferencesService.bulkSet(userId, validated);
			const muted = await notificationPreferencesService.listForUser(userId);
			res.json({ muted });
		} catch (err) {
			logger.error('Failed to update notification preferences', err as Error, { userId });
			res.status(500).json({ error: 'Failed to update preferences' });
		}
	}) as RequestHandler,
);

export { CATEGORY_CATALOG };
export default router;

// Silence unused-import warnings if a tool prunes them — CATEGORIES is
// imported for type clarity even though we don't enumerate it directly.
void CATEGORIES;