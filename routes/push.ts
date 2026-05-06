// ============================================================================
// PUSH NOTIFICATION ROUTES
// ============================================================================
// File: routes/push.ts
// Description: Endpoints the client calls to manage Web Push subscriptions.
//              Mounted at /mirror/api/push.
//
// ROUTES
//   GET    /vapid-public-key   — public, no auth (used by client before
//                                 it can ask the user for permission).
//   POST   /subscribe          — auth required; persists a PushSubscription.
//   DELETE /subscribe          — auth required; removes a subscription.
//   GET    /devices            — auth required; how many active devices.
//
// AUTH
//   AuthMiddleware.verifyToken populates req.user. Bearer-token auth means
//   CSRF is not a concern (no ambient credentials), but we keep an
//   explicit body size limit to defend against parser pathologies.
//
// RATE LIMITING
//   Per-action sliding-window in-memory limiter, matching the project
//   pattern from truthstreamController.ts. Keyed by `${userId}:${action}`.
//   Cleaned up every 5 minutes. Returns 429 + RATE_LIMITED on hit.
//
//     subscribe   10 / minute  — typical legitimate use is 1-2 per device
//                                 install; bursting indicates a bug.
//     unsubscribe 10 / minute
//     devices     30 / minute  — UI may poll on settings panel open.
//
// BODY SIZE
//   Push subscriptions are tiny (~500-1500B). We accept up to 4 KB on this
//   router specifically; the global parser at index.ts uses 100 KB and we
//   want a tighter ceiling here to defend against a misbehaving client.
// ============================================================================

import express, { Request, Response, RequestHandler } from 'express';
import AuthMiddleware from '../middleware/authMiddleware';
import {
  pushService,
  getVapidPublicKey,
  PushDeviceLimitError,
} from '../services/pushService';
import { Logger } from '../utils/logger';

const logger = new Logger('PushRoutes');
const router = express.Router();

// Tighter body limit just for this router. Push subscription JSON is small;
// no legitimate request needs the global 100 KB.
router.use(express.json({ limit: '4kb', strict: true }));

// ============================================================================
// RATE LIMITER (matches project pattern: in-memory sliding-window per user+action)
// ============================================================================

const actionRateLimits = new Map<string, number[]>();
const ACTION_LIMITS: Record<string, { window: number; max: number }> = {
  subscribe:   { window: 60_000, max: 10 },
  unsubscribe: { window: 60_000, max: 10 },
  devices:     { window: 60_000, max: 30 },
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

// Periodic cleanup so the Map doesn't leak memory for users that never
// return. Mirrors the truthstreamController interval (5 min, 5 min cutoff).
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of actionRateLimits) {
    const filtered = timestamps.filter((t) => now - t < 300_000);
    if (filtered.length === 0) actionRateLimits.delete(key);
    else actionRateLimits.set(key, filtered);
  }
}, 300_000).unref();

// ============================================================================
// HELPERS
// ============================================================================

function clientIp(req: Request): string | null {
  // Match authController.ts pattern; index.ts must have `app.set('trust proxy', ...)`
  // configured for req.ip to reflect the real client IP behind a proxy.
  const ip = req.ip || req.socket?.remoteAddress || null;
  return ip ? ip.replace(/^::ffff:/, '') : null;
}

function rateLimit(action: string): RequestHandler {
  return (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) {
      // verifyToken should have set this; defensive 401.
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
// GET /vapid-public-key   (public)
// ============================================================================
// The browser needs this to call PushManager.subscribe({ applicationServerKey }).
// Not a secret — it identifies your server to push services. Cacheable; we
// set a long max-age so clients don't keep re-fetching.
router.get('/vapid-public-key', ((req: Request, res: Response) => {
  const key = getVapidPublicKey();
  if (!key) {
    res.status(503).json({ error: 'Push not configured', code: 'PUSH_DISABLED' });
    return;
  }
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ publicKey: key });
}) as RequestHandler);

// ============================================================================
// POST /subscribe   { endpoint, keys: { p256dh, auth } }
// ============================================================================
router.post(
  '/subscribe',
  AuthMiddleware.verifyToken as RequestHandler,
  rateLimit('subscribe'),
  (async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { endpoint, keys } = req.body ?? {};

    // Basic shape validation. Push endpoints from real browsers are always
    // https://. p256dh is base64url-encoded P-256 public key (~88 chars).
    // auth is base64url-encoded 16 bytes (~22 chars). We don't enforce
    // exact lengths because the spec leaves room for future curves, but
    // we do bound them to defend against absurd inputs.
    const isValid =
      typeof endpoint === 'string' &&
      endpoint.startsWith('https://') &&
      endpoint.length <= 2048 &&
      keys &&
      typeof keys.p256dh === 'string' &&
      keys.p256dh.length > 0 &&
      keys.p256dh.length <= 255 &&
      typeof keys.auth === 'string' &&
      keys.auth.length > 0 &&
      keys.auth.length <= 255;

    if (!isValid) {
      res.status(400).json({
        error: 'Invalid subscription payload',
        code: 'INVALID_SUBSCRIPTION',
      });
      return;
    }

    try {
      const userAgent =
        (req.headers['user-agent'] || '').toString().slice(0, 500) || null;
      await pushService.upsert(userId, { endpoint, keys }, userAgent, clientIp(req));

      const active = await pushService.countActive(userId);
      res.status(201).json({ ok: true, activeDevices: active });
    } catch (err) {
      if (err instanceof PushDeviceLimitError) {
        res.status(409).json({
          error: err.message,
          code: err.code,
          limit: err.limit,
        });
        return;
      }
      logger.error('Failed to upsert push subscription', err as Error, { userId });
      res.status(500).json({ error: 'Failed to save subscription' });
    }
  }) as RequestHandler,
);

// ============================================================================
// DELETE /subscribe   { endpoint }
// ============================================================================
router.delete(
  '/subscribe',
  AuthMiddleware.verifyToken as RequestHandler,
  rateLimit('unsubscribe'),
  (async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { endpoint } = req.body ?? {};

    if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 2048) {
      res.status(400).json({ error: 'endpoint required', code: 'INVALID_ENDPOINT' });
      return;
    }

    try {
      await pushService.remove(userId, endpoint);
      res.json({ ok: true });
    } catch (err) {
      logger.error('Failed to remove push subscription', err as Error, { userId });
      res.status(500).json({ error: 'Failed to remove subscription' });
    }
  }) as RequestHandler,
);

// ============================================================================
// GET /devices   (active device count)
// ============================================================================
// Useful for the settings UI: "Notifications enabled on N device(s)".
// Returns just the count, not endpoints — endpoints are device-identifying
// data we shouldn't surface to other origins or include in API responses
// unnecessarily.
router.get(
  '/devices',
  AuthMiddleware.verifyToken as RequestHandler,
  rateLimit('devices'),
  (async (req: Request, res: Response) => {
    const userId = req.user!.id;
    try {
      const active = await pushService.countActive(userId);
      res.json({ activeDevices: active });
    } catch (err) {
      logger.error('Failed to count active push devices', err as Error, { userId });
      res.status(500).json({ error: 'Failed to count devices' });
    }
  }) as RequestHandler,
);

export default router;
