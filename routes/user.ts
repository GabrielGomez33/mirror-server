// routes/user.ts

import express, { RequestHandler } from 'express';
import {
	updateUserPasswordHandler,
	updateUserEmailHandler,
	deleteUserHandler,
	searchUsersHandler
} from '../controllers/userController';
import AuthMiddleware from '../middleware/authMiddleware';

const router = express.Router();

// Cast middleware to RequestHandler for TypeScript compatibility
const verified = AuthMiddleware.verifyToken as unknown as RequestHandler;

// Protected routes (require authentication)
router.get('/search', verified, searchUsersHandler);

// Other routes
router.post('/update-password', updateUserPasswordHandler);
router.post('/update-email', updateUserEmailHandler);
router.post('/delete', deleteUserHandler);

export default router;
