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

  audit('run_started', req, { dryRun, skipCleanup, label, customPassword: !!password, customEmail: !!emailLocalPart });

  try {
    const report = await runIntakeSimulation({ dryRun, skipCleanup, password, emailLocalPart, label }, op);
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

export default router;