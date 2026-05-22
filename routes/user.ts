// routes/user.ts
//
// CHANGES vs previous version (Phase 2a — account deletion):
//   - Removed the legacy `POST /delete` route. It accepted a `userId` in the
//     body and was NOT gated by AuthMiddleware.verifyToken, meaning any
//     anonymous caller could delete any user by guessing IDs. The canonical
//     self-service path is now `DELETE /mirror/api/auth/delete-account`
//     (authenticated JWT + password re-prompt + typed "DELETE" confirmation).
//     Admin-driven deletion can be re-introduced behind a verifyToken +
//     admin-role check if needed; deleteUserHandler / deleteUserFromDB are
//     preserved in userController.ts for that future surface.

import express, { RequestHandler } from 'express';
import {
	updateUserPasswordHandler,
	updateUserEmailHandler,
	searchUsersHandler
} from '../controllers/userController';
import { exportUserData } from '../controllers/exportController';
import AuthMiddleware from '../middleware/authMiddleware';

const router = express.Router();

// Cast middleware to RequestHandler for TypeScript compatibility
const verified = AuthMiddleware.verifyToken as unknown as RequestHandler;

// Protected routes (require authentication)
router.get('/search', verified, searchUsersHandler);
router.get('/export', verified, exportUserData as unknown as RequestHandler);

// Other routes
router.post('/update-password', updateUserPasswordHandler);
router.post('/update-email', updateUserEmailHandler);

export default router;