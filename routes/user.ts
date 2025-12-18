// routes/user.ts

import express, { RequestHandler } from 'express';
import {
  updateUserPasswordHandler,
  updateUserEmailHandler,
  deleteUserHandler,
  searchUsersHandler,
  getUserByIdHandler
} from '../controllers/userController';
import AuthMiddleware from '../middleware/authMiddleware';

const router = express.Router();

// Auth middleware
const verified = AuthMiddleware.verifyToken as unknown as RequestHandler;

// User management (existing)
router.post('/update-password', updateUserPasswordHandler);
router.post('/update-email', updateUserEmailHandler);
router.post('/delete', deleteUserHandler);

// User search and lookup (protected - requires authentication)
router.get('/search', verified, searchUsersHandler);
router.get('/:userId', verified, getUserByIdHandler);

export default router;
