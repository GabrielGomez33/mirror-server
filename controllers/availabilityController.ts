// controllers/availabilityController.ts
//
// Real-time "is this username available?" check for the registration form's
// live availability indicator.
//
// DESIGN / SECURITY NOTES
//   - Usernames are PUBLIC in Mirror (user search, group rosters, @mentions),
//     so exposing their availability is NOT an account-enumeration concern.
//     Email is deliberately NOT checked here for the opposite reason — email
//     existence stays a submit-time reveal so this endpoint can't be used as an
//     email enumeration oracle.
//   - Unauthenticated by design (registration is pre-auth).
//   - Rate-limited at the route (see routes/auth.ts) to protect the DB from
//     as-you-type / scripted abuse.
//   - Case-insensitive uniqueness with the SAME rules as createUserInDB(), so
//     the answer here matches what registration will actually enforce. No drift.
//   - Fails SAFE: on an internal error we return 503 with available:null so the
//     client shows a neutral state and falls back to the authoritative
//     submit-time check (USERNAME_TAKEN). We never claim a name is free when we
//     could not actually verify it.
//   - Cache-Control: no-store — availability is volatile and must never be
//     cached (by the browser, a proxy, or the PWA service worker).

import { RequestHandler } from 'express';
import { DB } from '../db';
import { Logger } from '../utils/logger';

const logger = new Logger('AvailabilityController');

// Kept identical to createUserInDB() and the client (RegistrationStep).
const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
const USERNAME_RE = /^[a-zA-Z0-9_]+$/;

// Names we never hand out regardless of DB state — avoids impersonation of
// system/staff accounts and routes that could collide with reserved handles.
// Compared lowercase.
const RESERVED_USERNAMES = new Set<string>([
  'admin', 'administrator', 'root', 'support', 'help', 'helpdesk', 'system',
  'mirror', 'dina', 'moderator', 'mod', 'staff', 'team', 'official',
  'security', 'billing', 'no-reply', 'noreply', 'postmaster', 'webmaster',
  'anonymous', 'null', 'undefined', 'me', 'you', 'everyone',
]);

type Reason = 'taken' | 'invalid' | 'reserved';

/**
 * POST /mirror/api/auth/check-username   (public, rate-limited)
 * Body (preferred) or query: { username: string }
 *
 * Responses (always JSON):
 *   200 { available: true }
 *   200 { available: false, reason: 'taken' | 'reserved' | 'invalid' }
 *   400 { available: false, reason: 'invalid', error }   — empty/missing input
 *   429 (rate limited — emitted by the route middleware)
 *   503 { available: null, error }                       — could not verify
 */
export const checkUsernameAvailability: RequestHandler = async (req, res) => {
  try {
    // Accept POST body (preferred) or query string. POST keeps the value out of
    // URLs/logs and out of any GET response cache.
    const rawBody = (req.body && typeof req.body === 'object') ? (req.body as Record<string, unknown>).username : undefined;
    const rawQuery = typeof req.query?.username === 'string' ? req.query.username : undefined;
    const raw = typeof rawBody === 'string' ? rawBody : (rawQuery ?? '');
    const username = String(raw).trim();

    res.setHeader('Cache-Control', 'no-store');

    // ---- Presence ----
    if (!username) {
      res.status(400).json({ available: false, reason: 'invalid' as Reason, error: 'Username is required.' });
      return;
    }

    // ---- Format (mirrors createUserInDB + the client) ----
    if (username.length < USERNAME_MIN || username.length > USERNAME_MAX || !USERNAME_RE.test(username)) {
      res.status(200).json({ available: false, reason: 'invalid' as Reason });
      return;
    }

    // ---- Reserved handles ----
    if (RESERVED_USERNAMES.has(username.toLowerCase())) {
      res.status(200).json({ available: false, reason: 'reserved' as Reason });
      return;
    }

    // ---- Case-insensitive uniqueness (parameterized) ----
    const [rows] = await DB.query(
      'SELECT id FROM users WHERE LOWER(username) = ? LIMIT 1',
      [username.toLowerCase()],
    );
    const taken = (rows as unknown[]).length > 0;

    res.status(200).json(taken ? { available: false, reason: 'taken' as Reason } : { available: true });
  } catch (error) {
    // Never report a name as free that we couldn't actually verify — signal
    // "unknown" so the client stays neutral and relies on the submit-time gate.
    logger.error('Username availability check failed', error as Error);
    res.status(503).json({ available: null, error: 'Could not verify availability right now.' });
  }
};