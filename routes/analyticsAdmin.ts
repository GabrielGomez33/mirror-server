// routes/analyticsAdmin.ts
// ----------------------------------------------------------------------------
// ADMIN-ONLY conversion-analytics + compliance endpoints. Mounted at
// /mirror/api/admin/analytics behind requireInternalSecret — only the
// admin-server (server-to-server, localhost) can reach these, exactly like the
// admin email + simulation routers. The human operator is already authenticated
// by admin-server; their identity arrives in `x-admin-user` and every read is
// audit-logged.
//
// Endpoints:
//   GET /funnel?sinceDays=30   — aggregate funnel counts (no row-level data)
//   GET /compliance            — the machine-readable compliance record,
//                                generated from the LIVE schema
// ----------------------------------------------------------------------------

import express, { Request, Response } from 'express';
import { requireInternalSecret } from '../middleware/internalAuth';
import { Logger } from '../utils/logger';
import { getFunnelAggregate } from '../services/conversionAnalytics';
import { buildComplianceRecord } from '../services/complianceRecord';

const router = express.Router();
const logger = new Logger('AdminAnalyticsRoute');

router.use(requireInternalSecret);

function operator(req: Request): string {
  return (req.header('x-admin-user') || 'admin').slice(0, 120);
}
function audit(action: string, req: Request, meta: Record<string, unknown>): void {
  logger.info(`ANALYTICS_AUDIT ${action}`, { operator: operator(req), ip: req.ip, ...meta });
}

// GET /funnel?sinceDays=30 — aggregate stage counts + distinct sessions.
router.get('/funnel', async (req: Request, res: Response) => {
  const sinceDays = Math.min(365, Math.max(1, parseInt(String(req.query.sinceDays ?? '30'), 10) || 30));
  try {
    const data = await getFunnelAggregate(sinceDays);
    audit('funnel_read', req, { sinceDays, totalEvents: data.totalEvents });
    res.json({ success: true, data });
  } catch (err) {
    logger.error('Failed to read funnel aggregate', err as Error);
    res.status(500).json({ success: false, error: 'Failed to read funnel aggregate' });
  }
});

// GET /compliance — the live, drift-proof compliance record for entities/auditors.
router.get('/compliance', async (req: Request, res: Response) => {
  try {
    const record = await buildComplianceRecord();
    audit('compliance_read', req, {
      noPersonalData: record.conversionAnalytics.noPersonalData,
      piiSuspects: record.conversionAnalytics.inventory.piiSuspectColumns.length,
    });
    res.json({ success: true, data: record });
  } catch (err) {
    logger.error('Failed to build compliance record', err as Error);
    res.status(500).json({ success: false, error: 'Failed to build compliance record' });
  }
});

export default router;
