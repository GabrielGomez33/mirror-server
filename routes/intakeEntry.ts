// routes/intakeEntry.ts
// ----------------------------------------------------------------------------
// ENTRY intake router — its own pipeline, mounted at /mirror/api/intake/entry.
// Authenticated; user resolved from the JWT (req.user.id), so no :userId param
// and no IDOR surface. Kept separate from routes/intake.ts to keep the Entry
// and Core concerns in distinct modules.
// ----------------------------------------------------------------------------

import express from 'express';
import AuthMiddleware from '../middleware/authMiddleware';
import { submitEntryHandler, getEntryStatusHandler } from '../controllers/intakeEntryController';

const router = express.Router();
const verify = AuthMiddleware.verifyToken as express.RequestHandler;

/** Store the Entry result + mark initial_intake_completed. */
router.post('/submit', verify, submitEntryHandler);

/** Read Entry completion + result (for gating + the dashboard teaser). */
router.get('/status', verify, getEntryStatusHandler);

export default router;
