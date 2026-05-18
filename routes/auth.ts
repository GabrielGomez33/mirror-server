// routes/auth.ts
//
// CHANGES vs previous version (Phase 0.3):
//   - Added /forgot-password (request reset link)
//   - Added /reset-password (apply new password with token)
//   - Added /reset-password/validate (GET — does NOT consume the token)
//   - Wired /logout and /logout-all (the controllers existed, but no routes
//     pointed at them — the frontend's logoutApi was hitting a 404).
//
// All previously-existing routes are preserved.

import express from 'express';
import {
  registerUser,
  loginUser,
  verifyToken,
  refreshToken,
  logoutUser,
  logoutAllDevices,
} from '../controllers/authController';
import {
  sendVerificationEmail,
  verifyEmailToken,
  getVerificationStatus,
} from '../controllers/emailVerificationController';
import {
  requestPasswordReset,
  resetPassword,
  validateResetToken,
} from '../controllers/passwordResetController';
import AuthMiddleware from '../middleware/authMiddleware';

const router = express.Router();

// ----------------------------------------------------------------------------
// Core auth
// ----------------------------------------------------------------------------
router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/refresh', refreshToken);
router.get('/verify', verifyToken);
router.post('/logout', logoutUser);
router.post('/logout-all', logoutAllDevices);

// ----------------------------------------------------------------------------
// Email verification
// ----------------------------------------------------------------------------
// /send-verification — must be authenticated (logged-in user requests a new
//                      verification email for THEIR account)
// /verify-email      — token in body acts as the auth credential, so no JWT
// /verification-status — authenticated read of current status
router.post(
  '/send-verification',
  AuthMiddleware.verifyToken as express.RequestHandler,
  sendVerificationEmail
);
router.post('/verify-email', verifyEmailToken);
router.get(
  '/verification-status',
  AuthMiddleware.verifyToken as express.RequestHandler,
  getVerificationStatus
);

// ----------------------------------------------------------------------------
// Forgotten-password flow
// ----------------------------------------------------------------------------
// All three are unauthenticated by design — the token itself (in the email)
// is the credential. Controllers enforce rate limits, generic responses, and
// per-user resend cooldowns.
router.post('/forgot-password', requestPasswordReset);
router.get('/reset-password/validate', validateResetToken);
router.post('/reset-password', resetPassword);

export default router;
