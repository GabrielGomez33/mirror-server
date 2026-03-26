// ============================================================================
// TRUTHSTREAM ROUTES - Mirror-Server Express Router
// ============================================================================
// File: routes/truthstream.ts
// Description: All TruthStream API endpoints.
//              Mounted at: APP.use('/mirror/api/truthstream', truthstreamRoutes)
//
// UPDATED: Added per-route server-side rate limiting for sensitive endpoints
//          and UUID validation middleware for parameterized routes.
//
// Pattern follows: routes/groups.ts
// Auth: AuthMiddleware.verifyToken on all routes
// ============================================================================

import express, { RequestHandler, Request, Response, NextFunction } from 'express';
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
  getAnalysisTrends,
  createFeedbackRequest,
  getMyFeedbackRequests,
  getFeedbackRequestsFeed,
  getStats,
  getMilestones,
  getQuestionnaire,
} from '../controllers/truthstreamController';

const router = express.Router();

// ============================================================================
// UTILITY: UUID format validator
// ============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUUIDParam(paramName: string): RequestHandler {
  return ((req: Request, res: Response, next: NextFunction) => {
    const value = req.params[paramName];
    if (!value || !UUID_REGEX.test(value)) {
      return res.status(400).json({
        error: `Invalid ${paramName} format.`,
        code: 'VALIDATION_ERROR'
      });
    }
    next();
  }) as RequestHandler;
}

// Validate numeric user ID
function validateNumericParam(paramName: string): RequestHandler {
  return ((req: Request, res: Response, next: NextFunction) => {
    const value = parseInt(req.params[paramName], 10);
    if (isNaN(value) || value <= 0) {
      return res.status(400).json({
        error: `Invalid ${paramName} format.`,
        code: 'VALIDATION_ERROR'
      });
    }
    next();
  }) as RequestHandler;
}

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
// Rate limit: Profile creation/update = 10 per 5 min (prevent spam)
// Rate limit: Profile read = 60 per min (standard)

router.post('/profile',
  AuthMiddleware.rateLimit(10, 300000) as RequestHandler,
  createProfile as RequestHandler
);

router.get('/profile',
  AuthMiddleware.rateLimit(60, 60000) as RequestHandler,
  getProfile as RequestHandler
);

router.put('/profile',
  AuthMiddleware.rateLimit(10, 300000) as RequestHandler,
  updateProfile as RequestHandler
);

router.get('/profile/:userId/card',
  validateNumericParam('userId'),
  AuthMiddleware.rateLimit(60, 60000) as RequestHandler,
  getTruthCard as RequestHandler
);

// ============================================================================
// REVIEW QUEUE
// ============================================================================
// Rate limit: Queue read = 60 per min
// Rate limit: Queue start/complete = 30 per 5 min (prevent rapid cycling)

router.get('/queue',
  AuthMiddleware.rateLimit(60, 60000) as RequestHandler,
  getQueue as RequestHandler
);

router.post('/queue/:queueId/start',
  validateUUIDParam('queueId'),
  AuthMiddleware.rateLimit(30, 300000) as RequestHandler,
  startQueueItem as RequestHandler
);

router.post('/queue/:queueId/complete',
  validateUUIDParam('queueId'),
  AuthMiddleware.rateLimit(30, 300000) as RequestHandler,
  completeQueueItem as RequestHandler
);

// ============================================================================
// REVIEWS
// ============================================================================
// Rate limit: Read reviews = 60 per min
// Rate limit: Helpful toggle = 30 per min (prevent abuse)
// Rate limit: Dialogue/flag = 20 per 5 min (prevent spam)

router.get('/reviews/received',
  AuthMiddleware.rateLimit(60, 60000) as RequestHandler,
  getReceivedReviews as RequestHandler
);

router.get('/reviews/given',
  AuthMiddleware.rateLimit(60, 60000) as RequestHandler,
  getGivenReviews as RequestHandler
);

router.post('/reviews/:reviewId/helpful',
  validateUUIDParam('reviewId'),
  AuthMiddleware.rateLimit(30, 60000) as RequestHandler,
  markHelpful as RequestHandler
);

router.delete('/reviews/:reviewId/helpful',
  validateUUIDParam('reviewId'),
  AuthMiddleware.rateLimit(30, 60000) as RequestHandler,
  unmarkHelpful as RequestHandler
);

router.post('/reviews/:reviewId/respond',
  validateUUIDParam('reviewId'),
  AuthMiddleware.rateLimit(20, 300000) as RequestHandler,
  addDialogueMessage as RequestHandler
);

router.get('/reviews/:reviewId/dialogue',
  validateUUIDParam('reviewId'),
  AuthMiddleware.rateLimit(60, 60000) as RequestHandler,
  getDialogue as RequestHandler
);

router.post('/reviews/:reviewId/flag',
  validateUUIDParam('reviewId'),
  AuthMiddleware.rateLimit(10, 300000) as RequestHandler,
  flagReview as RequestHandler
);

// ============================================================================
// ANALYSIS (triggers Dina via processing queue -> mirror module)
// ============================================================================
// Rate limit: Analysis read = 30 per min
// Rate limit: Analysis generation = 5 per hour (expensive LLM operation)

router.get('/analysis',
  AuthMiddleware.rateLimit(30, 60000) as RequestHandler,
  getAnalysis as RequestHandler
);

router.post('/analysis/generate',
  AuthMiddleware.rateLimit(5, 3600000) as RequestHandler,
  generateAnalysis as RequestHandler
);

router.get('/analysis/perception-gap',
  AuthMiddleware.rateLimit(30, 60000) as RequestHandler,
  getPerceptionGap as RequestHandler
);

router.get('/analysis/trends',
  AuthMiddleware.rateLimit(30, 60000) as RequestHandler,
  getAnalysisTrends as RequestHandler
);

// ============================================================================
// FEEDBACK REQUESTS
// ============================================================================
// Rate limit: Create = 10 per hour (prevent request spam)
// Rate limit: Read = 60 per min

router.post('/feedback-requests',
  AuthMiddleware.rateLimit(10, 3600000) as RequestHandler,
  createFeedbackRequest as RequestHandler
);

router.get('/feedback-requests',
  AuthMiddleware.rateLimit(60, 60000) as RequestHandler,
  getMyFeedbackRequests as RequestHandler
);

router.get('/feedback-requests/feed',
  AuthMiddleware.rateLimit(60, 60000) as RequestHandler,
  getFeedbackRequestsFeed as RequestHandler
);

// ============================================================================
// STATS & MILESTONES
// ============================================================================
// Rate limit: Standard read = 60 per min

router.get('/stats',
  AuthMiddleware.rateLimit(60, 60000) as RequestHandler,
  getStats as RequestHandler
);

router.get('/milestones',
  AuthMiddleware.rateLimit(60, 60000) as RequestHandler,
  getMilestones as RequestHandler
);

// ============================================================================
// QUESTIONNAIRE
// ============================================================================
// Rate limit: Standard read = 60 per min

router.get('/questionnaire/:goalCategory',
  AuthMiddleware.rateLimit(60, 60000) as RequestHandler,
  getQuestionnaire as RequestHandler
);

// ============================================================================
// EXPORT
// ============================================================================

export default router;
