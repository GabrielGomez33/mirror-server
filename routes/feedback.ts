// ============================================================================
// USER FEEDBACK ROUTES
// ============================================================================
// File: routes/feedback.ts
// ----------------------------------------------------------------------------
// Surface for the in-app Feedback & Support page:
//   POST /mirror/api/feedback         — Submit rating / issue / recommendation / contact
//   GET  /mirror/api/feedback/mine    — Current user's submissions
//   GET  /mirror/api/feedback/stats   — Aggregate rating stats (auth-gated)
//   GET  /mirror/api/feedback/limits  — Current user's rate-limit budget
//
// All routes sit behind AuthMiddleware.verifyToken — mounted in index.ts.
// The subscription gate is intentionally NOT applied: users on free plans
// must always be able to reach customer service / report issues.
// ============================================================================

import express, { RequestHandler } from 'express';
import FeedbackController from '../controllers/feedbackController';

const router = express.Router();

router.post('/',      FeedbackController.create     as unknown as RequestHandler);
router.get('/mine',   FeedbackController.listMine   as unknown as RequestHandler);
router.get('/stats',  FeedbackController.ratingStats as unknown as RequestHandler);
router.get('/limits', FeedbackController.limits     as unknown as RequestHandler);

export default router;