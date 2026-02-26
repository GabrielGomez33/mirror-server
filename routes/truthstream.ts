// ============================================================================
// TRUTHSTREAM ROUTES - Mirror-Server Express Router
// ============================================================================
// File: routes/truthstream.ts
// Description: All TruthStream API endpoints.
//              Mounted at: APP.use('/mirror/api/truthstream', truthstreamRoutes)
//
// Pattern follows: routes/groups.ts
// Auth: AuthMiddleware.verifyToken on all routes
// ============================================================================

import express, { RequestHandler } from 'express';
import AuthMiddleware from '../middleware/authMiddleware';
import { DB } from '../db';
import {
  createProfile,
  getProfile,
  updateProfile,
  getTruthCard,
  getQueue,
  startQueueItem,
  completeQueueItem,
  getReceivedReviews,
  getGivenReviews,
  markHelpful,
  unmarkHelpful,
  addDialogueMessage,
  getDialogue,
  flagReview,
  getAnalysis,
  generateAnalysis,
  getPerceptionGap,
  createFeedbackRequest,
  getMyFeedbackRequests,
  getFeedbackRequestsFeed,
  getStats,
  getMilestones,
  getQuestionnaire,
} from '../controllers/truthstreamController';

const router = express.Router();

// ============================================================================
// MIDDLEWARE: Authenticate all TruthStream routes
// ============================================================================

router.use(AuthMiddleware.verifyToken as RequestHandler);

// ============================================================================
// MIDDLEWARE: Update last_active on every authenticated API request
// ============================================================================

router.use(((req, _res, next) => {
  const user = (req as any).user;
  if (user?.id) {
    DB.query(
      'UPDATE users SET last_active = NOW() WHERE id = ? AND (last_active IS NULL OR last_active < DATE_SUB(NOW(), INTERVAL 30 SECOND))',
      [user.id]
    ).catch(() => {});
  }
  next();
}) as RequestHandler);

// ============================================================================
// PROFILE / TRUTH CARD
// ============================================================================

router.post('/profile', createProfile as RequestHandler);
router.get('/profile', getProfile as RequestHandler);
router.put('/profile', updateProfile as RequestHandler);
router.get('/profile/:userId/card', getTruthCard as RequestHandler);

// ============================================================================
// REVIEW QUEUE
// ============================================================================

router.get('/queue', getQueue as RequestHandler);
router.post('/queue/:queueId/start', startQueueItem as RequestHandler);
router.post('/queue/:queueId/complete', completeQueueItem as RequestHandler);

// ============================================================================
// REVIEWS
// ============================================================================

router.get('/reviews/received', getReceivedReviews as RequestHandler);
router.get('/reviews/given', getGivenReviews as RequestHandler);
router.post('/reviews/:reviewId/helpful', markHelpful as RequestHandler);
router.delete('/reviews/:reviewId/helpful', unmarkHelpful as RequestHandler);
router.post('/reviews/:reviewId/respond', addDialogueMessage as RequestHandler);
router.get('/reviews/:reviewId/dialogue', getDialogue as RequestHandler);
router.post('/reviews/:reviewId/flag', flagReview as RequestHandler);

// ============================================================================
// ANALYSIS (triggers Dina via processing queue → mirror module)
// ============================================================================

router.get('/analysis', getAnalysis as RequestHandler);
router.post('/analysis/generate', generateAnalysis as RequestHandler);
router.get('/analysis/perception-gap', getPerceptionGap as RequestHandler);

// ============================================================================
// FEEDBACK REQUESTS
// ============================================================================

router.post('/feedback-requests', createFeedbackRequest as RequestHandler);
router.get('/feedback-requests', getMyFeedbackRequests as RequestHandler);
router.get('/feedback-requests/feed', getFeedbackRequestsFeed as RequestHandler);

// ============================================================================
// STATS & MILESTONES
// ============================================================================

router.get('/stats', getStats as RequestHandler);
router.get('/milestones', getMilestones as RequestHandler);

// ============================================================================
// QUESTIONNAIRE
// ============================================================================

router.get('/questionnaire/:goalCategory', getQuestionnaire as RequestHandler);

// ============================================================================
// EXPORT
// ============================================================================

export default router;
