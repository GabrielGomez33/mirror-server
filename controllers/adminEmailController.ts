// ============================================================================
// ADMIN EMAIL CONTROLLER
// ============================================================================
// File: controllers/adminEmailController.ts
// ----------------------------------------------------------------------------
// Handlers behind /mirror/api/admin/email/* — reached only by the admin-server
// (internal-secret gated). Thin layer over emailBroadcastService.
// ============================================================================

import { Request, Response } from 'express';
import { DB } from '../db';
import { Logger } from '../utils/logger';
import { emailService } from '../services/emailService';
import {
  AudienceFilter,
  CampaignInput,
  ContentBlock,
  compile,
  createCampaign,
  getCampaign,
  listCampaigns,
  cancelCampaign,
  startCampaign,
  previewAudience,
  sendTest,
  validateBlocks,
  validateAttachments,
  unsubscribeUrl,
} from '../services/emailBroadcastService';

const logger = new Logger('AdminEmailController');

// The operator identity is forwarded by admin-server (already authenticated).
function operator(req: Request): string {
  return (req.header('x-admin-user') || 'admin').slice(0, 120);
}

function audit(action: string, req: Request, meta: Record<string, unknown>): void {
  logger.info(`ADMIN_EMAIL_AUDIT ${action}`, { operator: operator(req), ip: req.ip, ...meta });
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
export async function emailHealthHandler(_req: Request, res: Response): Promise<void> {
  try {
    const health = await emailService.healthCheck();
    res.json({ success: true, email: health, dryRunGlobal: (process.env.EMAIL_DRY_RUN || '').toLowerCase() === 'true' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to check email health' });
  }
}

// ---------------------------------------------------------------------------
// GET /users/search?q=
// ---------------------------------------------------------------------------
export async function searchRecipientsHandler(req: Request, res: Response): Promise<void> {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 20, 1), 50);
  if (q.length < 2) {
    res.status(400).json({ success: false, error: 'Query must be at least 2 characters' });
    return;
  }
  try {
    const pattern = `%${q}%`;
    const [rows] = await DB.query(
      `SELECT id, username, email, email_verified
         FROM users
        WHERE (username LIKE ? OR email LIKE ?)
        ORDER BY username ASC
        LIMIT ?`,
      [pattern, pattern, limit],
    );
    res.json({ success: true, users: rows });
  } catch (err) {
    logger.error('Recipient search failed', err as Error);
    res.status(500).json({ success: false, error: 'Search failed' });
  }
}

// ---------------------------------------------------------------------------
// POST /preview-audience   { audience }
// ---------------------------------------------------------------------------
export async function previewAudienceHandler(req: Request, res: Response): Promise<void> {
  try {
    const audience = req.body?.audience as AudienceFilter;
    if (!audience || typeof audience !== 'object' || !audience.mode) {
      res.status(400).json({ success: false, error: 'audience is required' });
      return;
    }
    const result = await previewAudience(audience);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('previewAudience failed', err as Error);
    res.status(500).json({ success: false, error: 'Failed to preview audience' });
  }
}

// ---------------------------------------------------------------------------
// POST /preview   { subject, blocks }
// Returns server-rendered HTML with sample merge values for the live preview.
// ---------------------------------------------------------------------------
export async function previewContentHandler(req: Request, res: Response): Promise<void> {
  try {
    const subject = String(req.body?.subject || '');
    const check = validateBlocks(req.body?.blocks);
    if (!check.ok) {
      res.status(400).json({ success: false, error: check.error });
      return;
    }
    const { html, text } = compile(subject, check.blocks);
    const sample = { username: 'Alex', email: 'alex@example.com', unsubscribeUrl: unsubscribeUrl('alex@example.com') };
    const rendered = html
      .replace(/\{\{\s*username\s*\}\}/g, sample.username)
      .replace(/\{\{\s*email\s*\}\}/g, sample.email)
      .replace(/\{\{\s*unsubscribe_url\s*\}\}/g, sample.unsubscribeUrl);
    res.json({ success: true, html: rendered, text });
  } catch (err) {
    logger.error('previewContent failed', err as Error);
    res.status(500).json({ success: false, error: 'Failed to render preview' });
  }
}

// ---------------------------------------------------------------------------
// POST /test   { subject, blocks, attachments?, testEmail, dryRun? }
// ---------------------------------------------------------------------------
export async function sendTestHandler(req: Request, res: Response): Promise<void> {
  try {
    const testEmail = String(req.body?.testEmail || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
      res.status(400).json({ success: false, error: 'A valid testEmail is required' });
      return;
    }
    const input = buildCampaignInput(req);
    const blocks = validateBlocks(input.blocks);
    if (!blocks.ok) {
      res.status(400).json({ success: false, error: blocks.error });
      return;
    }
    const att = validateAttachments(input.attachments);
    if (!att.ok) {
      res.status(400).json({ success: false, error: att.error });
      return;
    }
    audit('send_test', req, { testEmail });
    const result = await sendTest(input, testEmail);
    if (!result.success) {
      res.status(502).json({ success: false, error: result.error || 'Test send failed' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('sendTest failed', err as Error);
    res.status(500).json({ success: false, error: 'Failed to send test' });
  }
}

// ---------------------------------------------------------------------------
// POST /campaigns   { ...input, action: 'draft'|'send'|'schedule' }
// ---------------------------------------------------------------------------
export async function createCampaignHandler(req: Request, res: Response): Promise<void> {
  try {
    const action = String(req.body?.action || 'draft');
    const input = buildCampaignInput(req);

    if (action === 'schedule' && !input.scheduledAt) {
      res.status(400).json({ success: false, error: 'scheduledAt is required to schedule' });
      return;
    }
    if (action === 'schedule') {
      const when = new Date(input.scheduledAt as string).getTime();
      if (isNaN(when) || when <= Date.now()) {
        res.status(400).json({ success: false, error: 'scheduledAt must be a valid future time' });
        return;
      }
    }

    // For immediate send we create a draft (no scheduledAt) then start it.
    const createInput: CampaignInput = action === 'schedule'
      ? input
      : { ...input, scheduledAt: null };

    const id = await createCampaign(createInput);
    audit('create_campaign', req, { id, action });

    if (action === 'send') {
      const started = await startCampaign(id);
      if (!started.started) {
        res.status(409).json({ success: false, error: `Could not start: ${started.reason}`, campaignId: id });
        return;
      }
      audit('send_campaign', req, { id });
    }

    res.json({ success: true, campaignId: id, action });
  } catch (err) {
    const msg = (err as Error).message || 'Failed to create campaign';
    logger.error('createCampaign failed', err as Error);
    res.status(400).json({ success: false, error: msg });
  }
}

// ---------------------------------------------------------------------------
// POST /campaigns/:id/send   (start an existing draft immediately)
// ---------------------------------------------------------------------------
export async function startCampaignHandler(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      res.status(400).json({ success: false, error: 'Invalid campaign id' });
      return;
    }
    audit('send_campaign', req, { id });
    const result = await startCampaign(id);
    if (!result.started) {
      res.status(409).json({ success: false, error: `Could not start: ${result.reason}` });
      return;
    }
    res.json({ success: true, campaignId: id });
  } catch (err) {
    logger.error('startCampaign failed', err as Error);
    res.status(500).json({ success: false, error: 'Failed to start campaign' });
  }
}

// ---------------------------------------------------------------------------
// POST /campaigns/:id/cancel
// ---------------------------------------------------------------------------
export async function cancelCampaignHandler(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      res.status(400).json({ success: false, error: 'Invalid campaign id' });
      return;
    }
    const ok = await cancelCampaign(id);
    audit('cancel_campaign', req, { id, ok });
    if (!ok) {
      res.status(409).json({ success: false, error: 'Only draft or scheduled campaigns can be cancelled' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('cancelCampaign failed', err as Error);
    res.status(500).json({ success: false, error: 'Failed to cancel campaign' });
  }
}

// ---------------------------------------------------------------------------
// GET /campaigns
// ---------------------------------------------------------------------------
export async function listCampaignsHandler(req: Request, res: Response): Promise<void> {
  try {
    const limit = parseInt(String(req.query.limit)) || 50;
    const campaigns = await listCampaigns(limit);
    res.json({ success: true, campaigns });
  } catch (err) {
    logger.error('listCampaigns failed', err as Error);
    res.status(500).json({ success: false, error: 'Failed to list campaigns' });
  }
}

// ---------------------------------------------------------------------------
// GET /campaigns/:id
// ---------------------------------------------------------------------------
export async function getCampaignHandler(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      res.status(400).json({ success: false, error: 'Invalid campaign id' });
      return;
    }
    const campaign = await getCampaign(id);
    if (!campaign) {
      res.status(404).json({ success: false, error: 'Campaign not found' });
      return;
    }
    // Strip the compiled HTML from list payloads — large; fetch via preview.
    const { html_compiled, ...rest } = campaign as any;
    res.json({ success: true, campaign: rest, htmlAvailable: !!html_compiled });
  } catch (err) {
    logger.error('getCampaign failed', err as Error);
    res.status(500).json({ success: false, error: 'Failed to fetch campaign' });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function buildCampaignInput(req: Request): CampaignInput {
  const b = req.body || {};
  return {
    title: String(b.title || ''),
    subject: String(b.subject || ''),
    templateKey: b.templateKey ?? null,
    blocks: (b.blocks || []) as ContentBlock[],
    audience: (b.audience || { mode: 'all' }) as AudienceFilter,
    scheduledAt: b.scheduledAt ?? null,
    dryRun: !!b.dryRun,
    createdBy: operator(req),
    attachments: b.attachments,
  };
}