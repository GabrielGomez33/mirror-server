// controllers/conversionAnalyticsController.ts
// ----------------------------------------------------------------------------
// HTTP ingest for anonymous conversion-funnel events. PUBLIC + UNAUTHENTICATED
// by design — the caller is an anonymous visitor (often pre-signup), exactly
// like the waitlist endpoint. Hardening:
//   * Body is normalized by sanitizeConversionEvent (utils/conversionFunnel),
//     which allowlists fields — no PII or unknown key can be stored.
//   * A per-IP in-memory sliding-window rate limit (the IP is a limiter KEY
//     only; it is truncated and NEVER stored or logged with the event).
//   * Best-effort store: a well-formed event returns 204 even if the DB write
//     fails, so this fire-and-forget beacon can never break or block the client.
//   * No reflection: the response carries no request-derived data.
// ----------------------------------------------------------------------------

import type { Request, Response } from 'express';
import { sanitizeConversionEvent } from '../utils/conversionFunnel';
import { recordConversionEvent } from '../services/conversionAnalytics';
import { Logger } from '../utils/logger';

const logger = new Logger('ConversionAnalytics');

// ---- In-memory per-IP rate limit (process-local, mirrors waitlistController) --
const RATE_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_MAX = Math.max(1, parseInt(process.env.CONVERSION_RATE_LIMIT || '60', 10));

interface RateWindow { count: number; windowStart: number }
const windows = new Map<string, RateWindow>();

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [k, w] of windows) if (w.windowStart < cutoff) windows.delete(k);
}, RATE_WINDOW_MS).unref?.();

function allow(key: string): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.windowStart > RATE_WINDOW_MS) {
    windows.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (w.count >= RATE_MAX) return false;
  w.count += 1;
  return true;
}

// Coarse IP key for rate limiting ONLY — never persisted. /24 (IPv4) or /48 (IPv6).
function ipKey(raw: string | undefined): string {
  if (!raw) return 'unknown';
  let ip = raw.trim();
  const v4 = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4) ip = v4[1];
  if (ip.includes('.')) {
    const p = ip.split('.');
    return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0` : 'unknown';
  }
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::`;
  return 'unknown';
}

/**
 * POST /mirror/api/analytics/conversion
 * Body: { stage, sessionToken?, utmSource?, utmMedium?, utmCampaign?, surface? }
 *   204 — accepted (well-formed stage); store is best-effort.
 *   400 — stage missing / not an allowlisted funnel stage.
 *   429 — rate limited.
 */
export async function ingestConversionEventHandler(req: Request, res: Response): Promise<void> {
  if (!allow(`conv:${ipKey(req.ip || req.socket?.remoteAddress)}`)) {
    res.status(429).end();
    return;
  }
  const clean = sanitizeConversionEvent(req.body);
  if (!clean) {
    res.status(400).json({ success: false, error: 'Unknown funnel stage.' });
    return;
  }
  // Accept immediately; persist best-effort. A storage failure must NOT surface
  // to an anonymous beacon (and keeps the pipeline green before migration 023 is
  // applied to a given environment).
  res.status(204).end();
  try {
    await recordConversionEvent(clean);
  } catch (err) {
    logger.warn('conversion event store failed (non-fatal)', { error: (err as Error).message });
  }
}
