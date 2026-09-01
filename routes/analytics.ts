// routes/analytics.ts
// ----------------------------------------------------------------------------
// PUBLIC anonymous conversion-funnel ingest. Mounted at /mirror/api/analytics
// WITHOUT any auth/subscription gate — the caller is an anonymous visitor
// (often pre-signup), like the waitlist endpoint. Protections live in the
// controller (allowlist sanitizer, per-IP rate limit, best-effort store). CORS
// is already restricted to the production origins in index.ts.
//
// The admin-only aggregate + compliance endpoints live in a SEPARATE router
// (routes/analyticsAdmin.ts) behind the internal-secret gate — never here.
// ----------------------------------------------------------------------------

import express, { RequestHandler } from 'express';
import { ingestConversionEventHandler } from '../controllers/conversionAnalyticsController';

const router = express.Router();

// POST /mirror/api/analytics/conversion — record one anonymous funnel event.
router.post('/conversion', ingestConversionEventHandler as RequestHandler);

export default router;
