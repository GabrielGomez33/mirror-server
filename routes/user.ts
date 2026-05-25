// routes/user.ts
//
// CHANGES vs previous version (credential-change hardening):
//   - `POST /update-password` and `POST /update-email` were CRITICAL holes:
//     unauthenticated (mounted only behind the subscription gate, not
//     verifyToken) and they took the target `userId` from the request BODY.
//     Anyone could rotate any account's password or email by guessing an id —
//     full account takeover. They are now thin, JWT-gated aliases of the
//     canonical self-service handlers in authController, which derive identity
//     from req.user.id (never the body), re-auth with the current password,
//     validate inputs, and — for email — use the re-verify flow. The legacy
//     body-`userId` handlers have been deleted from userController.
//   - Prefer the canonical routes for new clients:
//       POST /mirror/api/auth/change-password
//       POST /mirror/api/auth/change-email  (+ /change-email/confirm)
//
// CHANGES vs Phase 2a (account deletion):
//   - Removed the legacy `POST /delete` route (same body-`userId` anti-pattern).
//     Canonical path: `DELETE /mirror/api/auth/delete-account`. deleteUserHandler
//     / deleteUserFromDB remain in userController for a future admin surface.

import express, { RequestHandler } from 'express';
import { searchUsersHandler } from '../controllers/userController';
import { changePassword, changeEmail } from '../controllers/authController';
import { exportUserData } from '../controllers/exportController';
import AuthMiddleware from '../middleware/authMiddleware';

const router = express.Router();

// Cast middleware to RequestHandler for TypeScript compatibility
const verified = AuthMiddleware.verifyToken as unknown as RequestHandler;

// Protected routes (require authentication)
router.get('/search', verified, searchUsersHandler);
router.get('/export', verified, exportUserData as unknown as RequestHandler);

// Credential changes — now authenticated and identity-from-JWT (see header).
// These delegate to the canonical authController handlers; the contract is
// { currentPassword, newPassword } and { newEmail, currentPassword }.
router.post('/update-password', verified, changePassword);
router.post('/update-email', verified, changeEmail);

export default router;