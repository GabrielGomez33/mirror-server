// ============================================================================
// PUBLIC EMAIL CONTROLLER (unsubscribe + provider webhooks)
// ============================================================================
// File: controllers/emailPublicController.ts
// ----------------------------------------------------------------------------
// These endpoints are intentionally UNAUTHENTICATED (a recipient clicking a
// link in their inbox has no session), but are protected by:
//   - Unsubscribe: a stateless HMAC token bound to the email address.
//   - Webhook:     a shared secret (EMAIL_WEBHOOK_SECRET) + provider parsing.
// They must be mounted BEFORE any subscription/auth gate in index.ts.
// ============================================================================

import { Request, Response } from 'express';
import crypto from 'crypto';
import { Logger } from '../utils/logger';
import { addSuppression, verifyUnsubscribe } from '../services/emailBroadcastService';

const logger = new Logger('EmailPublic');

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${title}</title></head>
<body style="margin:0;background:#0a0a0f;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:80px auto;padding:40px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:12px;text-align:center;">
    <h1 style="color:#fff;font-size:24px;margin:0 0 16px;">Mirror</h1>
    <h2 style="color:#fff;font-size:18px;margin:0 0 12px;">${title}</h2>
    <p style="color:#ccc;line-height:1.6;">${message}</p>
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// GET/POST /mirror/api/email/unsubscribe?e=<email>&t=<token>
// ---------------------------------------------------------------------------
export async function unsubscribeHandler(req: Request, res: Response): Promise<void> {
  const email = String((req.query.e ?? (req.body && req.body.e)) || '').trim().toLowerCase();
  const token = String((req.query.t ?? (req.body && req.body.t)) || '').trim();

  if (!email || !token || !verifyUnsubscribe(email, token)) {
    // One-click POST expects a 2xx even on bad input; keep GET human-friendly.
    if (req.method === 'POST') {
      res.status(400).json({ success: false, error: 'Invalid unsubscribe link' });
      return;
    }
    res.status(400).send(page('Invalid link', 'This unsubscribe link is invalid or has expired. If you keep receiving emails, contact support.'));
    return;
  }

  try {
    await addSuppression(email, 'unsubscribe', null, 'self-service unsubscribe');
    logger.info('User unsubscribed', { email });
  } catch (err) {
    logger.error('Failed to record unsubscribe', err as Error, { email });
    if (req.method === 'POST') {
      res.status(500).json({ success: false });
      return;
    }
    res.status(500).send(page('Something went wrong', 'We could not process your request right now. Please try again later.'));
    return;
  }

  if (req.method === 'POST') {
    res.status(200).json({ success: true });
    return;
  }
  res.status(200).send(page('You have been unsubscribed', 'You will no longer receive broadcast emails from Mirror. Account and security emails (like password resets) will still be delivered.'));
}

// ---------------------------------------------------------------------------
// POST /mirror/api/email/webhook/:provider
// Auto-suppress hard bounces and spam complaints.
// ---------------------------------------------------------------------------
function verifyWebhookSecret(req: Request): boolean {
  const expected = process.env.EMAIL_WEBHOOK_SECRET || '';
  if (!expected) return false; // fail closed
  const provided = String(req.header('x-webhook-secret') || req.query.secret || '');
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(provided).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function webhookHandler(req: Request, res: Response): Promise<void> {
  if (!verifyWebhookSecret(req)) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const provider = String(req.params.provider || '').toLowerCase();
  const body: any = req.body || {};

  try {
    // Normalise across providers to { type, email }.
    let type = '';
    let email = '';

    if (provider === 'resend') {
      type = String(body.type || '');                       // e.g. 'email.bounced', 'email.complained'
      email = String(body.data?.to?.[0] || body.data?.email || '');
    } else if (provider === 'brevo') {
      type = String(body.event || '');                      // e.g. 'hard_bounce', 'spam'
      email = String(body.email || '');
    } else {
      res.status(400).json({ success: false, error: 'Unknown provider' });
      return;
    }

    email = email.trim().toLowerCase();
    const isBounce = /bounce/i.test(type) || type === 'hard_bounce';
    const isComplaint = /complain|spam/i.test(type);

    if (email && (isBounce || isComplaint)) {
      await addSuppression(email, isComplaint ? 'complaint' : 'bounce', null, `${provider}:${type}`);
      logger.info('Suppressed via webhook', { provider, type, email });
    }

    // Always 200 so the provider stops retrying once we've accepted it.
    res.status(200).json({ success: true });
  } catch (err) {
    logger.error('Webhook processing failed', err as Error, { provider });
    res.status(200).json({ success: true }); // swallow to avoid retry storms
  }
}