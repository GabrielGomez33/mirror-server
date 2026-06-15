// routes/intake.ts
// Intake data routes following existing patterns from routes/storage.ts and routes/auth.ts

import express from 'express';
import {
  storeIntakeDataHandler,
  retrieveIntakeDataHandler,
  listUserIntakesHandler,
  getLatestIntakeHandler
} from '../controllers/intakeController';
import { getIqNormsHandler } from '../controllers/iqNormsController';

const router = express.Router();

// ============================================================================
// INTAKE DATA ROUTES
// ============================================================================

/**
 * Store complete intake data
 * POST /api/intake/store
 * Body: { userId: string, intakeData: IntakeDataStructure }
 */
router.post('/store', storeIntakeDataHandler);

/**
 * Retrieve specific intake data by ID
 * GET /api/intake/retrieve/:userId/:intakeId
 */
router.get('/retrieve/:userId/:intakeId', retrieveIntakeDataHandler);

/**
 * List all intake submissions for a user
 * GET /api/intake/list/:userId
 */
router.get('/list/:userId', listUserIntakesHandler);

/**
 * Get the latest intake data for a user
 * GET /api/intake/latest/:userId
 */
router.get('/latest/:userId', getLatestIntakeHandler);

/**
 * Get IQ self-norm percentile for a raw score, relative to other Mirror users
 * GET /api/intake/iq/norms?rawScore=&itemSetVersion=&age=
 */
router.get('/iq/norms', getIqNormsHandler);

export default router;