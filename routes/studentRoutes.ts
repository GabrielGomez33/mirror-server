// ============================================================================
// STUDENT ACCESS ROUTES
// ============================================================================
// File: routes/studentRoutes.ts
// Mounted at /mirror/api/student (see index.ts). NO umbrella subscription gate
// here — these endpoints are how a free user BECOMES premium, so gating them
// behind premium would be a chicken-and-egg lockout.
//
//   POST /request  — authenticated; per-user rate-limited. Starts verification.
//   POST /verify   — UNauthenticated (emailed token is the credential);
//                    per-IP rate-limited to blunt brute force (token space is
//                    2^256, but defense-in-depth).
//   GET  /status   — authenticated; UI reads current student state.
// ============================================================================

import express, { Router } from 'express';
import AuthMiddleware from '../middleware/authMiddleware';
import { createStudentVerificationHandlers } from '../controllers/studentVerificationController';
import type { SubscriptionService } from '../paywall/services/subscription.service';
import type { StudentConfig } from '../paywall/student.config';

export function createStudentRoutes(
  subscriptionService: SubscriptionService,
  config: StudentConfig,
): Router {
  const router = Router();
  const { requestVerification, verifyToken, getStatus } =
    createStudentVerificationHandlers(subscriptionService, config);

  // verifyToken FIRST so the per-user limiter can key on req.user.id.
  const REQUEST_RATE = AuthMiddleware.rateLimit(5, 15 * 60 * 1000) as express.RequestHandler;
  // Per-IP for the unauthenticated confirm endpoint.
  const VERIFY_RATE = AuthMiddleware.rateLimit(20, 15 * 60 * 1000) as express.RequestHandler;

  router.post(
    '/request',
    AuthMiddleware.verifyToken as express.RequestHandler,
    REQUEST_RATE,
    requestVerification,
  );

  router.post('/verify', VERIFY_RATE, verifyToken);

  router.get(
    '/status',
    AuthMiddleware.verifyToken as express.RequestHandler,
    getStatus,
  );

  return router;
}
