// ============================================================================
// PUBLIC EMAIL ROUTES (unsubscribe + provider webhooks)
// ============================================================================
// File: routes/emailPublic.ts
// ----------------------------------------------------------------------------
// Mounted at /mirror/api/email WITHOUT any auth/subscription gate, because the
// callers are email recipients and provider webhooks. See controller for the
// per-endpoint protections (HMAC token / shared secret).
// ============================================================================

import express from 'express';
import { unsubscribeHandler, webhookHandler } from '../controllers/emailPublicController';

const router = express.Router();

// One-click (POST, RFC 8058) and human (GET) unsubscribe.
router.get('/unsubscribe', unsubscribeHandler);
router.post('/unsubscribe', unsubscribeHandler);

// Provider bounce/complaint webhooks.
router.post('/webhook/:provider', webhookHandler);

export default router;