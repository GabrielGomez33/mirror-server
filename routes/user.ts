// routes/user.ts

import express from 'express';
import {
  updateUserPasswordHandler,
  updateUserEmailHandler,
  deleteUserHandler,
  searchUsersHandler,
  getUserByIdHandler
} from '../controllers/userController';
import { authMiddleware } from '../controllers/authController';

const router = express.Router();

// User management (existing)
router.post('/update-password', updateUserPasswordHandler);
router.post('/update-email', updateUserEmailHandler);
router.post('/delete', deleteUserHandler);

// User search and lookup (protected - requires authentication)
router.get('/search', authMiddleware, searchUsersHandler);
router.get('/:userId', authMiddleware, getUserByIdHandler);

export default router;
