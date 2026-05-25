// controllers/consentController.ts
//
// Records and reads user acceptance of legal documents (Terms & Conditions,
// and later a separate Privacy Notice). Backs the registration consent
// checkbox and the client-side ConsentGate re-acceptance modal.
//
// Endpoints (wired in routes/auth.ts, both behind AuthMiddleware.verifyToken):
//   POST /mirror/api/auth/accept-terms     -> acceptTermsHandler
//   GET  /mirror/api/auth/consent-status   -> getConsentStatusHandler
//
// The audit row is written to the `user_consent` table (migration
// 012_user_consent.sql). The unique key (user_id, document, version) makes
// re-acceptance idempotent: the same version updates its timestamp, a new
// version inserts a new row, preserving the full history.

import { RequestHandler } from 'express';
import { RowDataPacket } from 'mysql2/promise';
import { DB } from '../db';

type LegalDocument = 'terms' | 'privacy';
const VALID_DOCUMENTS = new Set<LegalDocument>(['terms', 'privacy']);
const MAX_VERSION_LEN = 16;

interface ConsentRow extends RowDataPacket {
  document: LegalDocument;
  version: string;
  accepted_at: Date;
}

/** Pull the authenticated user id off the request (set by verifyToken). */
function getUserId(req: unknown): number | null {
  const id = (req as { user?: { id?: number } })?.user?.id;
  return typeof id === 'number' && id > 0 ? id : null;
}

/**
 * Resolve the real client IP.
 *
 * mirror-server runs behind a reverse proxy (Apache), so `req.ip` and
 * `req.socket.remoteAddress` are the proxy's loopback address (127.0.0.1) —
 * NOT the visitor. The genuine client IP is carried in the forwarded
 * headers the proxy appends. We read those first, then fall back to the
 * socket only when no proxy header is present (direct/local requests).
 *
 *   X-Forwarded-For: "<client>, <proxy1>, <proxy2>"  → take the first hop
 *   X-Real-IP:       "<client>"                       → single value
 *
 * NOTE: this trusts the proxy to set/append these headers correctly, which
 * is true for our Apache front end (the app is not exposed directly). If
 * you'd rather fix this globally for every IP-logging path, set
 * `app.set('trust proxy', true)` in index.ts and Express will populate
 * req.ip from X-Forwarded-For for you — see NOTES-consent-pipeline.md.
 */
function clientIp(req: {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string | null {
  const headers = req.headers || {};

  const xff = headers['x-forwarded-for'];
  const xffValue = Array.isArray(xff) ? xff[0] : xff;
  const fromXff = xffValue ? xffValue.split(',')[0] : '';

  const xReal = headers['x-real-ip'];
  const fromReal = Array.isArray(xReal) ? xReal[0] : xReal;

  const candidate = (fromXff || fromReal || req.ip || req.socket?.remoteAddress || '')
    .toString()
    .replace('::ffff:', '')
    .trim();

  return candidate.length > 0 ? candidate.slice(0, 45) : null;
}

/**
 * Core writer. Reused by handlers and available for direct server-side use
 * (e.g. if registration is ever made to record consent atomically).
 */
export async function recordConsent(
  userId: number,
  document: LegalDocument,
  version: string,
  ipAddress: string | null,
  userAgent: string | null
): Promise<void> {
  await DB.query(
    `INSERT INTO user_consent (user_id, document, version, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       accepted_at = CURRENT_TIMESTAMP,
       ip_address  = VALUES(ip_address),
       user_agent  = VALUES(user_agent)`,
    [userId, document, version, ipAddress, userAgent]
  );
}

// ---------------------------------------------------------------------------
// POST /mirror/api/auth/accept-terms
// Body: { document?: 'terms' | 'privacy', version: string }
// ---------------------------------------------------------------------------
export const acceptTermsHandler: RequestHandler = async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = (req.body ?? {}) as { document?: string; version?: string };
  const document = (body.document ?? 'terms') as LegalDocument;
  const version = body.version;

  if (!VALID_DOCUMENTS.has(document)) {
    res.status(400).json({ error: 'Invalid document', code: 'BAD_DOCUMENT' });
    return;
  }
  if (!version || typeof version !== 'string' || version.length > MAX_VERSION_LEN) {
    res.status(400).json({ error: 'Invalid version', code: 'BAD_VERSION' });
    return;
  }

  try {
    await recordConsent(
      userId,
      document,
      version,
      clientIp(req),
      (req.headers['user-agent'] || '').slice(0, 512) || null
    );
    res.status(200).json({ ok: true, document, version });
  } catch (err) {
    console.error('[Consent] Failed to record consent:', err);
    res.status(500).json({ error: 'Failed to record consent', code: 'CONSENT_WRITE_FAILED' });
  }
};

// ---------------------------------------------------------------------------
// GET /mirror/api/auth/consent-status
// Returns the latest accepted version per document for the current user:
//   { terms: { version, acceptedAt } | null, privacy: { ... } | null }
// ---------------------------------------------------------------------------
export const getConsentStatusHandler: RequestHandler = async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const [rows] = await DB.query<ConsentRow[]>(
      `SELECT document, version, accepted_at
         FROM user_consent
        WHERE user_id = ?
        ORDER BY accepted_at DESC`,
      [userId]
    );

    const latestFor = (doc: LegalDocument) => {
      const row = rows.find((r) => r.document === doc);
      return row ? { version: row.version, acceptedAt: row.accepted_at } : null;
    };

    res.status(200).json({
      terms: latestFor('terms'),
      privacy: latestFor('privacy'),
    });
  } catch (err) {
    console.error('[Consent] Failed to read consent status:', err);
    res.status(500).json({ error: 'Failed to read consent', code: 'CONSENT_READ_FAILED' });
  }
};