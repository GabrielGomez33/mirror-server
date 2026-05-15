// ============================================================================
// NOTIFICATION EMAIL FALLBACK (Phase 6c)
// ============================================================================
// File: services/notificationEmailFallback.ts
// Description: When a high-priority Web Push fails to deliver (sent=0
//              because the user has no active subscriptions, all
//              expired, or all skipped due to retry-after), fall back
//              to an email so the user still hears about the event.
//
// USAGE
//   The push dispatcher invokes this via DispatchOptions.onPushDispatched
//   after pushService.send() returns. The service inspects the push
//   result and decides whether an email is warranted.
//
//   Fire-and-forget: never throws to the caller; all errors are logged.
//
// HIGH-PRIORITY TYPES (only these qualify for fallback):
//   group_invite, peer_review_received, video_call_started, vote_proposed,
//   chat_mention, chat_reply, personal_analysis_complete, analysis_completed,
//   ts_review_received, ts_milestone_earned, ts_analysis_complete.
//
// SKIP CONDITIONS (in order — first match wins):
//   1. Push delivered to ≥1 device              → user got the push, no fallback
//   2. Event type not high-priority             → not eligible
//   3. Email service not configured             → no provider, can't send
//   4. User record missing / no email           → can't address it
//   5. Email not verified                       → don't email unverified addresses
//   6. Master toggle 'email_fallbacks' muted    → user opted out of all fallbacks
//   7. Push category for this event muted       → if push is muted, email is too
//                                                 (global OR per-group scope)
//   8. Per-user per-category cooldown active    → 30 min window — prevents bursts
//   9. Daily cap reached                        → 15 emails / user / day max
//
// SECURITY / ROBUSTNESS
//   - User record looked up by ID only; the from-address is server-controlled.
//   - HTML body uses an explicit escaper for every dynamic field (no
//     unescaped notification.content into the DOM).
//   - URL field is sanitized: only same-origin /Mirror/* or http(s) on a
//     whitelist of approved hosts; otherwise the deep-link is omitted.
//   - Cooldown + daily cap are bounded via Redis TTLs; on Redis failure
//     we FAIL CLOSED (skip the email) so we never spam the user.
//   - User lookups cached in-memory 60s (small LRU) to avoid hammering
//     the users table when many push events land for the same user.
// ============================================================================

import { DB } from '../db';
import { Logger } from '../utils/logger';
import { mirrorRedis } from '../config/redis';
import { emailService } from './emailService';
import {
	notificationPreferencesService,
	TYPE_TO_CATEGORY,
	GLOBAL_SCOPE,
} from './notificationPreferences';

const logger = new Logger('EmailFallback');

// ============================================================================
// CONFIG
// ============================================================================

const HIGH_PRIORITY_TYPES: ReadonlySet<string> = new Set<string>([
	'group_invite',
	'peer_review_received',
	'video_call_started',
	'vote_proposed',
	'chat_mention',
	'chat_reply',
	'personal_analysis_complete',
	'analysis_completed',
	'ts_review_received',
	'ts_milestone_earned',
	'ts_analysis_complete',
]);

// Sentinel category name for the master toggle. NOT in TYPE_TO_CATEGORY —
// it's controlled directly by the dispatcher logic below.
export const EMAIL_FALLBACK_MASTER_CATEGORY = 'email_fallbacks';

// Per-(user, category) cooldown. Prevents 10 chat_mentions in 5 minutes
// from generating 10 emails when push is down.
const COOLDOWN_SECONDS = parseInt(
	process.env.EMAIL_FALLBACK_COOLDOWN_SECONDS || '1800', // 30 min
	10,
);

// Daily per-user cap as a hard ceiling. Even with cooldowns, a user
// receiving events across many categories could pile up — cap protects
// the user and our sender reputation.
const DAILY_CAP = parseInt(process.env.EMAIL_FALLBACK_DAILY_CAP || '15', 10);

// User lookup cache.
const USER_CACHE_TTL_MS = 60_000;
const USER_CACHE_MAX = 2000;

interface UserCacheEntry {
	email: string | null;
	emailVerified: boolean;
	username: string | null;
	expiresAt: number;
}

const userCache = new Map<number, UserCacheEntry>();

function userCacheGet(userId: number): UserCacheEntry | null {
	const entry = userCache.get(userId);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		userCache.delete(userId);
		return null;
	}
	// LRU touch
	userCache.delete(userId);
	userCache.set(userId, entry);
	return entry;
}

function userCacheSet(userId: number, entry: UserCacheEntry): void {
	if (userCache.size >= USER_CACHE_MAX) {
		const oldest = userCache.keys().next().value;
		if (oldest !== undefined) userCache.delete(oldest);
	}
	userCache.set(userId, entry);
}

setInterval(() => {
	const now = Date.now();
	for (const [k, v] of userCache) if (v.expiresAt <= now) userCache.delete(k);
}, 300_000).unref();

// ============================================================================
// MINIMAL TYPES (decoupled from mirrorGroupNotifications.ts internals)
// ============================================================================

export interface FallbackableNotification {
	userId: string | number;
	type: string;
	content: {
		title: string;
		message: string;
		actionUrl?: string;
		metadata?: Record<string, unknown>;
	};
}

export interface FallbackableTemplate {
	channels: readonly string[];
	priority: 'immediate' | 'normal' | 'low';
}

export interface PushOutcome {
	sent: number;
	failed: number;
	expired: number;
	skipped: number;
}

// ============================================================================
// PUBLIC ENTRY POINT
// ============================================================================

/**
 * Inspect a completed push attempt and dispatch an email fallback if
 * warranted. Best-effort: never throws.
 */
export async function dispatchEmailFallback(
	notification: FallbackableNotification,
	template: FallbackableTemplate,
	pushResult: PushOutcome,
): Promise<void> {
	try {
		// 1. Push delivered → no fallback.
		if (pushResult.sent > 0) return;

		// 2. Only high-priority types qualify.
		if (!HIGH_PRIORITY_TYPES.has(notification.type)) return;

		// 3. Email service must be configured.
		if (!emailService.isEnabled()) {
			// Quiet path — emailService logs its own disabled warning on init.
			return;
		}

		// 4. Need a user id.
		const userId = toUserIdNumber(notification.userId);
		if (userId === null) {
			logger.warn('Email fallback skipped — invalid userId', {
				userId: notification.userId,
				type: notification.type,
			});
			return;
		}

		// 5. Lookup user (cached). Skip if missing / no email / unverified.
		const user = await loadUser(userId);
		if (!user || !user.email || !user.emailVerified) {
			return; // never email unverified addresses
		}

		// 6. Master toggle + 7. Category mute check.
		// Read mute set ONCE; check both keys against it.
		try {
			const muted = await notificationPreferencesService.getMutedSet(userId);
			if (muted.has(`${EMAIL_FALLBACK_MASTER_CATEGORY}:${GLOBAL_SCOPE}`)) {
				logger.info('Email fallback skipped — master toggle off', {
					userId,
					type: notification.type,
				});
				return;
			}
			const category = TYPE_TO_CATEGORY[notification.type];
			if (category) {
				if (muted.has(`${category}:${GLOBAL_SCOPE}`)) {
					logger.info('Email fallback skipped — category muted globally', {
						userId,
						type: notification.type,
						category,
					});
					return;
				}
				const groupId = stringOrUndef(
					(notification.content.metadata || {} as Record<string, unknown>).groupId,
				);
				if (groupId && muted.has(`${category}:${groupId}`)) {
					logger.info('Email fallback skipped — category muted for group', {
						userId,
						type: notification.type,
						category,
						groupId,
					});
					return;
				}
			}
		} catch (err) {
			// Mute lookup failed — FAIL CLOSED (don't email). User can't have
			// requested suppression we can't honor.
			logger.warn('Email fallback skipped — mute lookup failed', {
				userId,
				type: notification.type,
				error: (err as Error)?.message,
			});
			return;
		}

		// 8. Cooldown check (per user per category).
		const cooldownCategory = TYPE_TO_CATEGORY[notification.type] || notification.type;
		const cooldownActive = await checkAndSetCooldown(userId, cooldownCategory);
		if (cooldownActive) {
			logger.info('Email fallback skipped — cooldown active', {
				userId,
				type: notification.type,
				cooldownCategory,
			});
			return;
		}

		// 9. Daily cap check.
		const dailyCount = await incrementDailyCount(userId);
		if (dailyCount === null) {
			// Redis error → FAIL CLOSED.
			logger.warn('Email fallback skipped — daily counter unavailable', {
				userId,
				type: notification.type,
			});
			return;
		}
		if (dailyCount > DAILY_CAP) {
			logger.info('Email fallback skipped — daily cap reached', {
				userId,
				type: notification.type,
				dailyCount,
				cap: DAILY_CAP,
			});
			return;
		}

		// All gates passed — render and send.
		const { subject, html, text } = buildEmail(notification, user.username || 'there');
		const result = await emailService.send({
			to: user.email,
			subject,
			html,
			text,
			tags: ['notification_fallback', notification.type],
		});

		if (result.success) {
			logger.info('Email fallback sent', {
				userId,
				type: notification.type,
				messageId: result.messageId,
				dailyCount,
			});
		} else {
			logger.warn('Email fallback send failed', {
				userId,
				type: notification.type,
				error: result.error,
			});
		}
	} catch (err) {
		// Backstop. The dispatcher caller is fire-and-forget; we MUST NOT throw.
		logger.error('Email fallback threw', err as Error, {
			userId: notification.userId,
			type: notification.type,
		});
	}
}

// ============================================================================
// USER LOOKUP
// ============================================================================

async function loadUser(userId: number): Promise<UserCacheEntry | null> {
	const cached = userCacheGet(userId);
	if (cached) return cached;

	try {
		const [rows] = await DB.execute(
			`SELECT email, email_verified, username
			 FROM users
			 WHERE id = ?
			 LIMIT 1`,
			[userId],
		);
		const row = (rows as Array<{ email: string | null; email_verified: number; username: string | null }>)[0];
		if (!row) {
			// Cache the negative result briefly so we don't re-query for
			// deleted users.
			const entry: UserCacheEntry = {
				email: null,
				emailVerified: false,
				username: null,
				expiresAt: Date.now() + USER_CACHE_TTL_MS,
			};
			userCacheSet(userId, entry);
			return null;
		}
		const entry: UserCacheEntry = {
			email: row.email,
			emailVerified: !!row.email_verified,
			username: row.username,
			expiresAt: Date.now() + USER_CACHE_TTL_MS,
		};
		userCacheSet(userId, entry);
		return entry;
	} catch (err) {
		logger.error('Failed to load user for email fallback', err as Error, { userId });
		return null;
	}
}

// ============================================================================
// COOLDOWN + DAILY CAP (Redis-backed)
// ============================================================================

/**
 * Check whether a cooldown is active for (userId, category) AND set it if
 * not. Atomic via `SET NX EX` so concurrent attempts collapse to one.
 * Returns true if cooldown WAS active (i.e. caller should skip).
 *
 * On Redis error, returns true (FAIL CLOSED) — better to drop a fallback
 * than to spam.
 */
async function checkAndSetCooldown(userId: number, category: string): Promise<boolean> {
	const key = `email-fallback:cd:${userId}:${category}`;
	try {
		const client = (mirrorRedis as unknown as Record<string, unknown>).client as
			| { set?: (...args: unknown[]) => Promise<string | null> }
			| undefined;
		if (!client?.set) {
			// Fall back to non-atomic get/set via the public helper.
			const exists = await mirrorRedis.exists(key);
			if (exists) return true;
			await mirrorRedis.set(key, '1', COOLDOWN_SECONDS);
			return false;
		}
		// ioredis: SET key value NX EX seconds — returns 'OK' if set, null if it existed.
		const result = await client.set(key, '1', 'NX', 'EX', COOLDOWN_SECONDS);
		return result === null; // null => key existed => cooldown active
	} catch (err) {
		logger.warn('Cooldown check failed — failing closed', {
			userId,
			category,
			error: (err as Error)?.message,
		});
		return true; // fail closed
	}
}

/**
 * Increment the daily counter for this user. Returns the new count, or
 * null on Redis error (caller treats null as a hard skip).
 */
async function incrementDailyCount(userId: number): Promise<number | null> {
	const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
	const key = `email-fallback:daily:${userId}:${day}`;
	try {
		const client = (mirrorRedis as unknown as Record<string, unknown>).client as
			| {
					incr?: (key: string) => Promise<number>;
					expire?: (key: string, seconds: number) => Promise<number>;
			  }
			| undefined;
		if (client?.incr) {
			const n = await client.incr(key);
			if (n === 1 && client.expire) {
				// First increment of the day — set TTL ~25h so it rolls over cleanly.
				await client.expire(key, 25 * 60 * 60);
			}
			return n;
		}
		// Fallback path (non-atomic): read, set with TTL. Acceptable for an
		// approximate cap.
		const raw = await mirrorRedis.get(key);
		const current = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) || 0 : 0;
		const next = current + 1;
		await mirrorRedis.set(key, next, 25 * 60 * 60);
		return next;
	} catch (err) {
		logger.warn('Daily counter failed', {
			userId,
			error: (err as Error)?.message,
		});
		return null;
	}
}

// ============================================================================
// EMAIL RENDERING
// ============================================================================

const APP_URL = process.env.APP_URL || 'https://www.theundergroundrailroad.world/Mirror';
const SAFE_ABSOLUTE_HOST_PATTERN = /^https:\/\/(?:[a-z0-9-]+\.)*theundergroundrailroad\.world\//i;

function buildEmail(
	notification: FallbackableNotification,
	username: string,
): { subject: string; html: string; text: string } {
	const rawTitle = notification.content.title || 'Mirror notification';
	const rawMessage = notification.content.message || '';

	// Trim + truncate to defend against pathological payloads in the email body.
	const title = truncate(rawTitle.trim(), 120);
	const message = truncate(rawMessage.trim(), 600);
	const greetingName = truncate(username.trim() || 'there', 40);

	const ctaUrl = resolveActionUrl(notification.content.actionUrl);
	const settingsUrl = `${APP_URL}/notifications`;

	const subject = title;

	// Plain-text version (for clients that don't render HTML, and for
	// deliverability — providers downrank HTML-only emails).
	const text = [
		`Hi ${greetingName},`,
		'',
		title,
		'',
		message,
		'',
		`Open Mirror: ${ctaUrl}`,
		'',
		`You received this email because a Mirror push notification couldn't reach your devices.`,
		`Manage notification preferences: ${settingsUrl}`,
	].join('\n');

	const html = `
		<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #0a0a0f; color: #e0e0e0;">
			<div style="text-align: center; margin-bottom: 32px;">
				<h1 style="color: #ffffff; font-size: 28px; margin: 0;">Mirror</h1>
				<p style="color: #888; font-size: 13px; margin: 8px 0 0;">Notification fallback</p>
			</div>
			<div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 32px;">
				<p style="color: #ccc; margin: 0 0 8px;">Hi ${escapeHtml(greetingName)},</p>
				<h2 style="color: #fff; margin: 0 0 12px;">${escapeHtml(title)}</h2>
				<p style="color: #ccc; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(message)}</p>
				<div style="text-align: center; margin: 32px 0;">
					<a href="${escapeAttr(ctaUrl)}" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600;">Open Mirror</a>
				</div>
			</div>
			<p style="color: #666; font-size: 12px; text-align: center; margin-top: 32px; line-height: 1.5;">
				You received this email because a Mirror push notification couldn't reach your devices.
				<br/>
				<a href="${escapeAttr(settingsUrl)}" style="color: #8b5cf6; text-decoration: none;">Manage notification preferences</a>
			</p>
		</div>
	`;

	return { subject, html, text };
}

/**
 * Resolve the click-through URL. We accept:
 *   - undefined / empty           → fall back to APP_URL
 *   - '/Mirror/...' root-relative → prepend the same origin
 *   - https://<our host>/...      → pass through
 *   - anything else               → ignore (security: never link off-site
 *                                    via our reputable sender domain)
 */
function resolveActionUrl(raw: string | undefined): string {
	const fallback = APP_URL;
	if (!raw || typeof raw !== 'string') return fallback;
	const trimmed = raw.trim();
	if (!trimmed) return fallback;

	// Same-origin absolute under our domain — allow.
	if (SAFE_ABSOLUTE_HOST_PATTERN.test(trimmed)) return trimmed;

	// Root-relative under /Mirror — prefix with origin.
	if (trimmed.startsWith('/Mirror/')) {
		const origin = APP_URL.replace(/\/Mirror\/?$/, '');
		return `${origin}${trimmed}`;
	}

	// Bare path — prefix with APP_URL.
	if (trimmed.startsWith('/')) {
		const origin = APP_URL.replace(/\/Mirror\/?$/, '');
		return `${origin}/Mirror${trimmed}`;
	}

	return fallback;
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

/**
 * Escape user-controlled content for safe HTML body interpolation.
 * Covers the OWASP "HTML body context" set; emails are display-only so
 * we don't need the broader URL/JS contexts here — those have their own
 * escapers below.
 */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Stricter escaper for attribute contexts (href, etc.). Also drops any
 * control characters / quotes that could break out of the attribute.
 */
function escapeAttr(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		// strip control chars; defensive — these shouldn't be in a URL we control
		// eslint-disable-next-line no-control-regex
		.replace(/[\x00-\x1f\x7f]/g, '');
}