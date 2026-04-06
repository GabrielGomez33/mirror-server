// route/auth.ts
// UPDATED: Added email verification endpoints (Phase 0.2)

import express from 'express'
import { registerUser, loginUser, verifyToken, refreshToken } from '../controllers/authController'
import { sendVerificationEmail, verifyEmailToken, getVerificationStatus } from '../controllers/emailVerificationController'
import AuthMiddleware from '../middleware/authMiddleware'

const router = express.Router()

// Existing auth routes
router.post('/register', registerUser)
router.post('/login', loginUser)
router.post('/refresh', refreshToken)
router.get('/verify', verifyToken)

// Email verification routes (Phase 0.2)
router.post('/send-verification', AuthMiddleware.verifyToken as express.RequestHandler, sendVerificationEmail)
router.post('/verify-email', verifyEmailToken) // No auth required — token in body is the auth
router.get('/verification-status', AuthMiddleware.verifyToken as express.RequestHandler, getVerificationStatus)

export default router
