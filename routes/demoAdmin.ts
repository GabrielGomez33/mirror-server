// routes/demoAdmin.ts
// ----------------------------------------------------------------------------
// ADMIN-ONLY demo/trial account endpoints. Mounted at /mirror/api/admin/demo
// behind requireInternalSecret — only the admin-server (server-to-server,
// localhost) can reach these, exactly like the admin email / simulation /
// analytics routers. The human operator is already authenticated by
// admin-server; their identity arrives in `x-admin-user` and every action is
// audit-logged. The provision response carries a one-time password that is
// NEVER written to the audit log.
//
//   POST /provision   { label? }        -> create one demo account, return creds
//   GET  /list                          -> list demo accounts (no passwords)
//   POST /revoke      { userId }         -> delete a demo account (guarded)
// ----------------------------------------------------------------------------

import express, { Request, Response } from 'express';
import { requireInternalSecret } from '../middleware/internalAuth';
import { Logger } from '../utils/logger';
import { provisionDemoAccount, listDemoAccounts, revokeDemoAccount } from '../controllers/demoAccountController';

const router = express.Router();
const logger = new Logger('DemoAdminRoute');

router.use(requireInternalSecret);

function operator(req: Request): string {
  return (req.header('x-admin-user') || 'admin').slice(0, 120);
}

// POST /provision — mint one demo account.
router.post('/provision', async (req: Request, res: Response) => {
  try {
    const label = typeof req.body?.label === 'string' && req.body.label.trim() ? req.body.label.trim() : null;
    // Optional: email the tester their credentials. Passed through only when the
    // key is present, so provisioning without email stays the default.
    const deliverTo = typeof req.body?.deliverTo === 'string' && req.body.deliverTo.trim()
      ? req.body.deliverTo.trim() : undefined;
    const acct = await provisionDemoAccount({ label, createdBy: operator(req), deliverTo });
    // Audit WITHOUT the password (acct.password is intentionally omitted here).
    logger.info('DEMO_AUDIT provision', {
      operator: operator(req), userId: acct.userId, username: acct.username, label: acct.label,
      emailedTo: acct.emailDelivery?.to || null, emailSent: !!acct.emailDelivery?.sent,
    });
    res.json({ success: true, data: acct });
  } catch (err) {
    logger.error('Failed to provision demo account', err as Error);
    res.status(500).json({ success: false, error: 'Failed to provision demo account' });
  }
});

// GET /list — enumerate demo accounts (no credentials).
router.get('/list', async (req: Request, res: Response) => {
  try {
    const data = await listDemoAccounts();
    res.json({ success: true, data });
  } catch (err) {
    logger.error('Failed to list demo accounts', err as Error);
    res.status(500).json({ success: false, error: 'Failed to list demo accounts' });
  }
});

// POST /revoke — delete a demo account (guarded to the demo registry).
router.post('/revoke', async (req: Request, res: Response) => {
  const userId = Number(req.body?.userId);
  try {
    const result = await revokeDemoAccount(userId, operator(req));
    logger.info('DEMO_AUDIT revoke', { operator: operator(req), userId });
    res.json({ success: true, data: result });
  } catch (err) {
    const msg = (err as Error)?.message || 'revoke failed';
    const clientError = /^refused:|^invalid user id/.test(msg);
    if (!clientError) logger.error('Failed to revoke demo account', err as Error);
    res.status(clientError ? 400 : 500).json({ success: false, error: clientError ? msg : 'Failed to revoke demo account' });
  }
});

export default router;
