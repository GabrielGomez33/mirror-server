// routes/auth.ts
//
// CHANGES vs previous version (Phase 2b — mobile registration hardening):
//   - POST /register is now IP-rate-limited (5 registrations per 15 min
//     per IP). The endpoint is unauthenticated so AuthMiddleware.rateLimit
//     falls through to `req.ip` as the identifier — which is why this
//     server REQUIRES `app.set('trust proxy', ...)` to be configured for
//     the deployment topology (Apache → Node), otherwise every request
//     looks like it came from 127.0.0.1 and the limit becomes a global
//     5-per-15-min cap. See index.ts: app.set('trust proxy', 1).
//   - POST /login is also IP-rate-limited at a more generous 10/15 min
//     (legitimate users mistype their password a few times; a real attack
//     gets caught long before exhausting that budget).
//
// CHANGES vs Phase 2a (consent pipeline):
//   - Added POST /accept-terms (authenticated) — records the user's
//     acceptance of a legal document version into user_consent.
//   - Added GET /consent-status (authenticated) — returns the latest
//     accepted version per document, used by the client ConsentGate.
//
// CHANGES vs previous version (Phase 2a — account deletion):
//   - Added DELETE /delete-account (authenticated, password re-prompt + typed
//     "DELETE" confirmation). Wipes the user from this server AND fires a
//     best-effort purge notification at the Dina mirror module so Dina-side
//     analyses, contexts, embeddings, notifications etc. are cleared too.
//
// CHANGES vs Phase 0.3:
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
  deleteAccount,
  changePassword,
  changeEmail,
  confirmEmailChange,
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
import {
  acceptTermsHandler,
  getConsentStatusHandler,
} from '../controllers/consentController';
import AuthMiddleware from '../middleware/authMiddleware';

const router = express.Router();

// ----------------------------------------------------------------------------
// Core auth
// ----------------------------------------------------------------------------
//
// Rate limits on the unauthenticated entry points. AuthMiddleware.rateLimit
// uses req.user.id when present and falls back to req.securityContext?.ipAddress
// then req.ip — for these routes there's no req.user, so the identifier is the
// IP. A burst of 5 registrations per 15-minute window from one IP covers a
// family on the same NAT (rare for registration) but stops scripted spam dead.
// Login gets 10 per 15-min to absorb honest mistypes.
//
// CRITICAL: requires Express `trust proxy` to be set correctly upstream of
// this router (Apache → Node behind reverse proxy). Without it, req.ip
// collapses to 127.0.0.1 for every request and the limit becomes a global
// cap instead of a per-IP one. See mirror-server/index.ts.
const REGISTER_RATE = AuthMiddleware.rateLimit(5, 15 * 60 * 1000) as express.RequestHandler;
const LOGIN_RATE    = AuthMiddleware.rateLimit(10, 15 * 60 * 1000) as express.RequestHandler;

router.post('/register', REGISTER_RATE, registerUser);
router.post('/login', LOGIN_RATE, loginUser);
router.post('/refresh', refreshToken);
router.get('/verify', verifyToken);
router.post('/logout', logoutUser);
router.post('/logout-all', logoutAllDevices);

// ----------------------------------------------------------------------------
// Account deletion
// ----------------------------------------------------------------------------
// Always requires a valid JWT — the body's password is a *second* factor,
// not a substitute. Body must also include `confirmation: "DELETE"` to defeat
// accidental triggering. The handler deletes local data first (source of
// truth) then best-effort notifies the Dina mirror module to purge its side.
router.delete(
  '/delete-account',
  AuthMiddleware.verifyToken as express.RequestHandler,
  deleteAccount
);

// ----------------------------------------------------------------------------
// Self-service credential changes
// ----------------------------------------------------------------------------
// /change-password      — authenticated. Body carries the current password
//                         (re-auth) + the new password. Rotating the password
//                         revokes all OTHER device sessions.
// /change-email         — authenticated. Body carries the new address + current
//                         password (re-auth). Stages a pending change and emails
//                         a single-use confirmation link to the NEW address;
//                         users.email is untouched until that link is clicked.
// /change-email/confirm — UNauthenticated by design: the emailed token is the
//                         credential (same model as /verify-email).
router.post(
  '/change-password',
  AuthMiddleware.verifyToken as express.RequestHandler,
  changePassword
);
router.post(
  '/change-email',
  AuthMiddleware.verifyToken as express.RequestHandler,
  changeEmail
);
router.post('/change-email/confirm', confirmEmailChange);

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

// ----------------------------------------------------------------------------
// Consent (Terms & Conditions acceptance)
// ----------------------------------------------------------------------------
// Both require a valid JWT — the user must be authenticated to record or read
// their own consent. The registration flow calls /accept-terms immediately
// after sign-up; the client ConsentGate uses /consent-status to detect users
// who must (re-)accept the current version.
router.post(
  '/accept-terms',
  AuthMiddleware.verifyToken as express.RequestHandler,
  acceptTermsHandler
);
router.get(
  '/consent-status',
  AuthMiddleware.verifyToken as express.RequestHandler,
  getConsentStatusHandler
);

export default router;