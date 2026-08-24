// routes/intake.ts
// Intake data routes following existing patterns from routes/storage.ts and routes/auth.ts

import express from 'express';
import AuthMiddleware from '../middleware/authMiddleware';
import {
  storeIntakeDataHandler,
  retrieveIntakeDataHandler,
  listUserIntakesHandler,
  getLatestIntakeHandler
} from '../controllers/intakeController';
import { getIqNormsHandler } from '../controllers/iqNormsController';

const router = express.Router();

// ----------------------------------------------------------------------------
// AUTH POSTURE (security-critical)
//   Intake is user-scoped, mutating data. Prior to this router these handlers
//   were reachable UNAUTHENTICATED (the app mount at index.ts had no guard and
//   this file added none), so any caller could write/complete ANY user's intake
//   by putting a userId in the body — a textbook IDOR. Every user-scoped route
//   below now requires a valid token AND asserts the target user is the caller.
//   The identity comes from the JWT (req.user.id); body/param userId is only
//   ever compared to it, never trusted.
// ----------------------------------------------------------------------------
const verify = AuthMiddleware.verifyToken as express.RequestHandler;
const selfParam = AuthMiddleware.assertSelfParam('userId') as express.RequestHandler;
const selfBody = AuthMiddleware.assertSelfBody('userId') as express.RequestHandler;

// ============================================================================
// INTAKE DATA ROUTES (authenticated, self-only)
// ============================================================================

/**
 * Store complete intake data
 * POST /api/intake/store  (auth + self)
 * Body: { userId: string, intakeData: IntakeDataStructure }
 */
router.post('/store', verify, selfBody, storeIntakeDataHandler);

/**
 * Retrieve specific intake data by ID
 * GET /api/intake/retrieve/:userId/:intakeId  (auth + self)
 */
router.get('/retrieve/:userId/:intakeId', verify, selfParam, retrieveIntakeDataHandler);

/**
 * List all intake submissions for a user
 * GET /api/intake/list/:userId  (auth + self)
 */
router.get('/list/:userId', verify, selfParam, listUserIntakesHandler);

/**
 * Get the latest intake data for a user
 * GET /api/intake/latest/:userId  (auth + self)
 */
router.get('/latest/:userId', verify, selfParam, getLatestIntakeHandler);

/**
 * Get IQ self-norm percentile for a raw score, relative to other Mirror users.
 * GET /api/intake/iq/norms?rawScore=&itemSetVersion=&age=
 * PUBLIC BY DESIGN: returns only an aggregate population percentile for a
 * client-supplied raw score. It carries no user id, exposes no other user's
 * data, and the IQ step fetches it without a token. Do NOT add user-scoped
 * data to this handler without also gating it.
 */
router.get('/iq/norms', getIqNormsHandler);

export default router;