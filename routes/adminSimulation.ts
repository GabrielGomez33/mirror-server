// ============================================================================
// ADMIN INTAKE-SIMULATION ROUTES
// ============================================================================
// File: routes/adminSimulation.ts
// ----------------------------------------------------------------------------
// Mounted at /mirror/api/admin/simulation behind requireInternalSecret. Only the
// admin-server (server-to-server, localhost) can reach these — the same trust
// boundary used by the admin email API. The human operator is already
// authenticated by admin-server; their identity arrives in `x-admin-user` and
// is recorded on every run for audit.
//
// Endpoints:
//   GET  /health        — readiness (DB reachable, env configured, run state)
//   POST /intake/run    — run a full end-to-end intake simulation, then delete
//                         the throwaway user. Body: { dryRun?, skipCleanup?, label? }
//   GET  /intake/runs           — recent run history (from the audit table)
//   GET  /intake/runs/:runId    — a single run report
//   POST /intake/cleanup        — sweep orphaned simulation users.
//                                 Body: { maxAgeMinutes? }
//   GET    /intake/users               — list kept sim users + file footprint
//   GET    /intake/users/:id/verify    — prove a user's DB+disk footprint (R/O)
//   GET    /intake/users/:id/truthstream — a user's card + reviews + report (R/O)
//   POST   /intake/users/:id/reset-password — set a new password { password? }
//   DELETE /intake/users/:id           — delete one sim user, then verify purge
//   GET    /intake/reviewable-users    — sim users (+ TruthStream profile flag)
//   GET    /intake/users-with-profile  — any user (sim/real) with a TS profile
//   GET    /intake/user-search?q=      — search any user for a reviewee
//   POST   /intake/reviews/run         — run one targeted TruthStream review
//   POST   /intake/reviews/run-batch   — many reviewers (+ helpers) -> 1 reviewee
// ============================================================================

import express, { Request, Response } from 'express';
import { requireInternalSecret } from '../middleware/internalAuth';
import { Logger } from '../utils/logger';
import {
  runIntakeSimulation,
  cleanupOrphans,
  simulationHealth,
  listRuns,
  getRun,
  listSimUsers,
  verifyUserPurged,
  resetSimUserPassword,
  deleteSimUser,
  listReviewableUsers,
  searchUsers,
  runTargetedReview,
  getUserTruthStreamReport,
  listUsersWithTruthStreamProfile,
  runReviewBatch,
  SimulationBusyError,
} from '../controllers/intakeSimulationController';

const router = express.Router();
const logger = new Logger('AdminSimulationRoute');

// Every route in this router requires the internal shared secret.
router.use(requireInternalSecret);

// The operator identity is forwarded by admin-server (already authenticated).
function operator(req: Request): string {
  return (req.header('x-admin-user') || 'admin').slice(0, 120);
}

function audit(action: string, req: Request, meta: Record<string, unknown>): void {
  logger.info(`INTAKE_SIM_AUDIT ${action}`, { operator: operator(req), ip: req.ip, ...meta });
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const health = await simulationHealth();
    res.json({ success: true, data: health });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to read simulation health' });
  }
});

// ---------------------------------------------------------------------------
// POST /intake/run
// ---------------------------------------------------------------------------
router.post('/intake/run', async (req: Request, res: Response) => {
  const op = operator(req);
  const dryRun = req.body?.dryRun === true;
  const skipCleanup = req.body?.skipCleanup === true;
  const label = typeof req.body?.label === 'string' ? req.body.label : undefined;
  // Optional password for a kept test user. Never logged.
  const password =
    typeof req.body?.password === 'string' && req.body.password.length > 0 ? req.body.password : undefined;
  // Optional email local part for a memorable test account (domain is forced to
  // the reserved sim domain server-side).
  const emailLocalPart =
    typeof req.body?.emailLocalPart === 'string' && req.body.emailLocalPart.length > 0 ? req.body.emailLocalPart : undefined;
  // Optionally build a TruthStream report card for a kept user.
  const truthCard = req.body?.truthCard === true;
  const reviewTone = typeof req.body?.reviewTone === 'string' ? req.body.reviewTone : undefined;

  audit('run_started', req, { dryRun, skipCleanup, label, customPassword: !!password, customEmail: !!emailLocalPart, truthCard, reviewTone });

  try {
    const report = await runIntakeSimulation({ dryRun, skipCleanup, password, emailLocalPart, label, truthCard, reviewTone }, op);
    audit('run_finished', req, {
      runId: report.runId,
      status: report.status,
      cleanedUp: report.cleanedUp,
      durationMs: report.durationMs,
    });
    // The run "completing" (even failed) is a successful API call; the run
    // outcome lives in report.status. Surface a 200 with the full report so the
    // UI can render each step. Only a genuinely unexpected throw becomes 5xx.
    res.json({ success: report.status !== 'failed', data: report });
  } catch (err) {
    if (err instanceof SimulationBusyError) {
      res.status(409).json({ success: false, error: err.message, code: 'SIMULATION_BUSY' });
      return;
    }
    logger.error('Unexpected error running intake simulation', err as Error);
    res.status(500).json({ success: false, error: 'Intake simulation crashed unexpectedly' });
  }
});

// ---------------------------------------------------------------------------
// GET /intake/runs
// ---------------------------------------------------------------------------
router.get('/intake/runs', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(String(req.query.limit ?? '20'), 10) || 20;
    const runs = await listRuns(limit);
    res.json({ success: true, data: runs });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to list simulation runs' });
  }
});

// ---------------------------------------------------------------------------
// GET /intake/runs/:runId
// ---------------------------------------------------------------------------
router.get('/intake/runs/:runId', async (req: Request, res: Response) => {
  try {
    const run = await getRun(String(req.params.runId));
    if (!run) {
      res.status(404).json({ success: false, error: 'Run not found' });
      return;
    }
    res.json({ success: true, data: run });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch simulation run' });
  }
});

// ---------------------------------------------------------------------------
// POST /intake/cleanup — sweep orphaned simulation users
// ---------------------------------------------------------------------------
router.post('/intake/cleanup', async (req: Request, res: Response) => {
  const op = operator(req);
  const maxAgeMinutes = Number.isFinite(req.body?.maxAgeMinutes) ? Number(req.body.maxAgeMinutes) : 0;
  audit('cleanup_started', req, { maxAgeMinutes });
  try {
    const result = await cleanupOrphans(maxAgeMinutes);
    audit('cleanup_finished', req, { scanned: result.scanned, purged: result.purged, failures: result.failures.length });
    res.json({ success: result.failures.length === 0, data: result });
  } catch (err) {
    logger.error('Orphan sweep failed', err as Error);
    res.status(500).json({ success: false, error: 'Orphan sweep failed' });
  }
});

// ---------------------------------------------------------------------------
// TEST-USER MANAGER
//   GET    /intake/users              — list kept sim users (+ file footprint)
//   GET    /intake/users/:id/verify   — prove a user's DB+disk footprint (R/O)
//   POST   /intake/users/:id/reset-password  — set a new password { password? }
//   DELETE /intake/users/:id          — delete one sim user, then verify purge
// Each helper re-checks the reserved-namespace guard server-side, so none of
// these can act on a real account.
// ---------------------------------------------------------------------------

// Parse a positive integer :id, or send a 400 and return null.
function parseUserId(req: Request, res: Response): number | null {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ success: false, error: 'Invalid user id' });
    return null;
  }
  return id;
}

router.get('/intake/users', async (req: Request, res: Response) => {
  try {
    const users = await listSimUsers();
    audit('users_listed', req, { count: users.length });
    res.json({ success: true, data: users });
  } catch (err) {
    logger.error('Failed to list sim users', err as Error);
    res.status(500).json({ success: false, error: 'Failed to list test users' });
  }
});

router.get('/intake/users/:id/verify', async (req: Request, res: Response) => {
  const id = parseUserId(req, res);
  if (id === null) return;
  try {
    const verification = await verifyUserPurged(id);
    audit('user_verified', req, { userId: id, clean: verification.clean, residue: verification.dbResidue.length, scanned: verification.dbTablesScanned });
    res.json({ success: true, data: verification });
  } catch (err) {
    logger.error('Failed to verify sim user', err as Error);
    res.status(500).json({ success: false, error: 'Failed to verify test user' });
  }
});

router.get('/intake/users/:id/truthstream', async (req: Request, res: Response) => {
  const id = parseUserId(req, res);
  if (id === null) return;
  try {
    const report = await getUserTruthStreamReport(id);
    audit('user_truthstream_viewed', req, { userId: id, hasProfile: report.hasProfile, received: report.receivedReviews.length, hasAnalysis: !!report.analysis });
    res.json({ success: true, data: report });
  } catch (err) {
    logger.error('Failed to read TruthStream report', err as Error);
    res.status(500).json({ success: false, error: 'Failed to read TruthStream report' });
  }
});

router.post('/intake/users/:id/reset-password', async (req: Request, res: Response) => {
  const id = parseUserId(req, res);
  if (id === null) return;
  const password =
    typeof req.body?.password === 'string' && req.body.password.length > 0 ? req.body.password : undefined;
  audit('user_password_reset', req, { userId: id, customPassword: !!password });
  try {
    const credentials = await resetSimUserPassword(id, password);
    res.json({ success: true, data: credentials });
  } catch (err) {
    const msg = (err as Error).message || 'Failed to reset password';
    const safety = /safety stop|not a simulation user|not found/i.test(msg);
    logger.error('Failed to reset sim user password', err as Error);
    res.status(safety ? 400 : 500).json({ success: false, error: msg });
  }
});

router.delete('/intake/users/:id', async (req: Request, res: Response) => {
  const id = parseUserId(req, res);
  if (id === null) return;
  audit('user_delete_started', req, { userId: id });
  try {
    const result = await deleteSimUser(id);
    audit('user_delete_finished', req, {
      userId: id,
      deleted: result.deleted,
      clean: result.verification.clean,
      dbResidue: result.verification.dbResidue.length,
      tablesScanned: result.verification.dbTablesScanned,
      storageClean: result.verification.storageClean,
      dinaNotified: result.dinaNotified,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    const msg = (err as Error).message || 'Failed to delete test user';
    const safety = /safety stop|not a simulation user/i.test(msg);
    logger.error('Failed to delete sim user', err as Error);
    res.status(safety ? 400 : 500).json({ success: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// TRUTHSTREAM REVIEW RUNNER
//   GET  /intake/reviewable-users  — sim users (+ whether they have a profile)
//   GET  /intake/user-search?q=    — search any user (sim or real) for a reviewee
//   POST /intake/reviews/run       — run one targeted review { reviewerId,
//                                    revieweeId, tone }
// The reviewer must be a sim user (enforced in the controller); a real reviewee
// is allowed but flagged in the response.
// ---------------------------------------------------------------------------

router.get('/intake/reviewable-users', async (req: Request, res: Response) => {
  try {
    const users = await listReviewableUsers();
    audit('reviewable_users_listed', req, { count: users.length });
    res.json({ success: true, data: users });
  } catch (err) {
    logger.error('Failed to list reviewable users', err as Error);
    res.status(500).json({ success: false, error: 'Failed to list reviewable users' });
  }
});

router.get('/intake/user-search', async (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2) {
    res.status(400).json({ success: false, error: 'Search query must be at least 2 characters' });
    return;
  }
  try {
    const users = await searchUsers(q, 25);
    audit('user_search', req, { q, count: users.length });
    res.json({ success: true, data: users });
  } catch (err) {
    logger.error('User search failed', err as Error);
    res.status(500).json({ success: false, error: 'User search failed' });
  }
});

router.get('/intake/users-with-profile', async (req: Request, res: Response) => {
  try {
    const users = await listUsersWithTruthStreamProfile();
    audit('users_with_profile_listed', req, { count: users.length });
    res.json({ success: true, data: users });
  } catch (err) {
    logger.error('Failed to list users with TruthStream profile', err as Error);
    res.status(500).json({ success: false, error: 'Failed to list users with a TruthStream profile' });
  }
});

router.post('/intake/reviews/run-batch', async (req: Request, res: Response) => {
  const revieweeId = Number(req.body?.revieweeId);
  const reviewerIds = Array.isArray(req.body?.reviewerIds) ? req.body.reviewerIds : [];
  const addHelpers = Number(req.body?.addHelpers) || 0;
  const tone = typeof req.body?.tone === 'string' ? req.body.tone : undefined;
  if (!Number.isInteger(revieweeId) || revieweeId <= 0) {
    res.status(400).json({ success: false, error: 'revieweeId must be a positive integer' });
    return;
  }
  audit('review_batch_started', req, { revieweeId, reviewerCount: reviewerIds.length, addHelpers, tone });
  try {
    const result = await runReviewBatch({ reviewerIds, revieweeId, tone, addHelpers });
    audit('review_batch_finished', req, {
      revieweeId, succeeded: result.succeeded, attempted: result.results.length,
      totalReceivedAfter: result.totalReceivedAfter, reportReady: result.reportReady,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    const msg = (err as Error).message || 'Failed to run review batch';
    const client = /Invalid|at least one|not found|no TruthStream profile|refusing/i.test(msg);
    logger.error('Review batch failed', err as Error);
    res.status(client ? 400 : 500).json({ success: false, error: msg });
  }
});

router.post('/intake/reviews/run', async (req: Request, res: Response) => {
  const reviewerId = Number(req.body?.reviewerId);
  const revieweeId = Number(req.body?.revieweeId);
  const tone = typeof req.body?.tone === 'string' ? req.body.tone : undefined;
  if (!Number.isInteger(reviewerId) || reviewerId <= 0 || !Number.isInteger(revieweeId) || revieweeId <= 0) {
    res.status(400).json({ success: false, error: 'reviewerId and revieweeId must be positive integers' });
    return;
  }
  audit('review_run_started', req, { reviewerId, revieweeId, tone });
  try {
    const result = await runTargetedReview({ reviewerId, revieweeId, tone });
    audit('review_run_finished', req, {
      reviewerId, revieweeId, revieweeIsSim: result.revieweeIsSim,
      reviewId: result.reviewId, qualityScore: result.qualityScore,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    const msg = (err as Error).message || 'Failed to run review';
    // Validation / safety stops are client errors, not server faults.
    const client = /not a simulation user|cannot review themselves|not found|no TruthStream profile|Invalid review|refusing/i.test(msg);
    logger.error('Targeted review failed', err as Error);
    res.status(client ? 400 : 500).json({ success: false, error: msg });
  }
});

export default router;