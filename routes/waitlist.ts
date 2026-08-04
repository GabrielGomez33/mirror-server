// ============================================================================
// PUBLIC WAITLIST ROUTES
// ============================================================================
// File: routes/waitlist.ts
// ----------------------------------------------------------------------------
// Mounted at /mirror/api/waitlist WITHOUT any auth/subscription gate: the
// caller is an anonymous visitor on the public marketing landing page
// (theundergroundrailroad.world). See the controller for the protections
// (email validation, per-IP rate limit, idempotent upsert). CORS is already
// restricted to the production origins in index.ts.
// ============================================================================

import express, { RequestHandler } from 'express';
import WaitlistController from '../controllers/waitlistController';

const router = express.Router();

// POST /mirror/api/waitlist — capture a prospect email from the landing form.
router.post('/', WaitlistController.subscribe.bind(WaitlistController) as RequestHandler);

export default router;
