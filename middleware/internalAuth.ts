// ============================================================================
// INTERNAL SERVICE AUTHENTICATION
// ============================================================================
// File: middleware/internalAuth.ts
// ----------------------------------------------------------------------------
// Guards the admin-only email endpoints that the TUGRR Admin Portal's
// admin-server calls server-to-server over localhost. This is NOT a user-facing
// auth layer — it is the trust boundary between two backend processes on the
// same host (admin-server :8446 -> mirror-server :8444).
//
// Trust model:
//   - admin-server already authenticates the human operator with its own JWT.
//   - admin-server then forwards the request to mirror-server with a shared
//     secret in the `x-internal-secret` header.
//   - mirror-server verifies that secret here with a timing-safe comparison.
//
// Hardening:
//   - Constant-time compare (crypto.timingSafeEqual) — no early-exit leak.
//   - Fails closed: if MIRROR_INTERNAL_SECRET is unset, every request is
//     rejected (we never silently allow when misconfigured).
//   - Pairs with binding the listener to 127.0.0.1 (already the case) so the
//     endpoints are unreachable from the public internet regardless.
// ============================================================================

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Logger } from '../utils/logger';

const logger = new Logger('InternalAuth');

/**
 * Timing-safe string equality. Returns false on any length mismatch without
 * leaking which one via timing.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws if lengths differ; hash both to a fixed length first
  // so the comparison itself is constant-time regardless of input length.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function requireInternalSecret(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.MIRROR_INTERNAL_SECRET || '';

  // Fail closed when unconfigured — never allow on misconfiguration.
  if (!expected) {
    logger.error('MIRROR_INTERNAL_SECRET is not set — rejecting internal request', new Error('missing_internal_secret'));
    res.status(503).json({ success: false, error: 'Internal email API not configured' });
    return;
  }

  const provided = req.header('x-internal-secret') || '';

  if (!provided || !safeEqual(provided, expected)) {
    logger.warn('Rejected internal request with invalid secret', {
      ip: req.ip,
      path: req.path,
    });
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  next();
}

export default requireInternalSecret;