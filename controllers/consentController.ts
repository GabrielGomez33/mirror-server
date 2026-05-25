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

/** Normalize an IP, stripping the IPv4-mapped-IPv6 prefix. */
function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string | null {
  const raw = req.ip || req.socket?.remoteAddress || '';
  const cleaned = raw.replace('::ffff:', '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 45) : null;
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