// routes/storage.ts
// Storage routes with query-token extraction for <img>/<audio> element authentication.
// The retrieve endpoint is authenticated so files are not publicly accessible.

import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  createDirectoriesHandler,
  storeDataHandler,
  retrieveDataHandler,
  listFilesHandler
} from '../controllers/storageController';
import AuthMiddleware from '../middleware/authMiddleware';
import { upload } from '../utils/multer';

const router = express.Router();
const verified = AuthMiddleware.verifyToken as unknown as RequestHandler;

// ============================================================================
// QUERY TOKEN EXTRACTION MIDDLEWARE
// ============================================================================
// HTML elements (<img>, <audio>) cannot send Authorization headers.
// The client appends ?token=<JWT> to the URL instead.
// This middleware promotes that query param to the Authorization header
// so the standard verifyToken middleware can handle it.
// ============================================================================
function extractQueryToken(req: Request, _res: Response, next: NextFunction): void {
  if (!req.headers.authorization && req.query.token && typeof req.query.token === 'string') {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}

// ============================================================================
// ROUTES
// ============================================================================

// Directory creation (requires auth)
router.post('/directories/create', verified, createDirectoriesHandler);

// File upload (requires auth, multipart)
router.post(
  '/store',
  verified,
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'data', maxCount: 1 },
  ]),
  (req: Request, _res: Response, next: NextFunction) => {
    // Normalize to req.file so the controller can keep its logic minimal
    const f =
      (req as any).files?.['file']?.[0] ??
      (req as any).files?.['data']?.[0] ??
      null;
    if (f && !(req as any).file) (req as any).file = f;
    next();
  },
  storeDataHandler
);

// File retrieval (requires auth — supports ?token= for <img>/<audio> elements)
router.get(
  '/retrieve/:userId/:tier/:filename',
  extractQueryToken,
  verified,
  retrieveDataHandler
);

// File listing (requires auth)
router.get('/list/:userId/:tier', verified, listFilesHandler);

export default router;
