// ============================================================================
// FEEDBACK NOTIFIER SERVICE
// ============================================================================
// File: services/feedbackNotifier.ts
// ----------------------------------------------------------------------------
// Owns operator-inbox + user-ack email delivery for the /mirror/api/feedback
// flow. Idempotent on retry — every send goes through user_feedback_email_log
// with a UNIQUE(feedback_id, channel) gate, so duplicate worker runs are safe.
//
// The page itself does NOT block on email. The controller responds 201 the
// moment the row is persisted; this service runs as a fire-and-forget
// background task (per request, await-not-required). Failures are logged
// to user_feedback_email_log so they can be replayed by an admin tool.
//
// ARCHITECTURE NOTE: All email goes through the existing universal email
// service (services/emailService.ts) — no new provider plumbing.
// ============================================================================

import { DB } from '../db';
import { Logger } from '../utils/logger';
import { emailService } from './emailService';

const logger = new Logger('FeedbackNotifier');

// ============================================================================
// CONFIG
// ============================================================================

const SUPPORT_INBOX = (process.env.SUPPORT_INBOX_EMAIL || 'support@mirror.com').trim();
const APP_URL       = (process.env.APP_URL || 'https://mirror.example.com').replace(/\/+$/, '');

// ============================================================================
// TYPES
// ============================================================================

export type FeedbackKind = 'rating' | 'issue' | 'recommendation' | 'contact';

export interface FeedbackSummary {
  id: number;
  userId: number;
  username: string | null;
  userEmail: string | null;
  kind: FeedbackKind;
  rating: number | null;
  subject: string | null;
  message: string | null;
  contactEmail: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical' | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ============================================================================
// HTML / TEXT TEMPLATES
// ============================================================================
// The aesthetic intentionally mirrors emailService.ts existing templates:
// dark glass card on near-black bg, indigo→violet primary gradient.

function escapeHtml(input: string | null | undefined): string {
  if (input == null) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function kindLabel(kind: FeedbackKind): string {
  switch (kind) {
    case 'rating':         return 'App Rating';
    case 'issue':          return 'Issue Report';
    case 'recommendation': return 'Recommendation';
    case 'contact':        return 'Contact Support';
  }
}

function kindAccent(kind: FeedbackKind): string {
  // Aligned with the personal-analysis colour wheel in MyMirror.
  switch (kind) {
    case 'rating':         return '#f472b6'; // pink
    case 'issue':          return '#fb923c'; // orange
    case 'recommendation': return '#4ade80'; // green
    case 'contact':        return '#60a5fa'; // blue
  }
}

function stars(rating: number | null): string {
  if (!rating) return '—';
  const filled = '★'.repeat(Math.max(0, Math.min(5, rating)));
  const empty  = '☆'.repeat(Math.max(0, 5 - (rating || 0)));
  return `${filled}${empty} (${rating}/5)`;
}

function operatorEmailHtml(f: FeedbackSummary): string {
  const accent = kindAccent(f.kind);
  const metaJson = f.metadata ? JSON.stringify(f.metadata, null, 2) : '';

  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 40px 20px; background: #0a0a0f; color: #e0e0e0;">
    <div style="text-align: center; margin-bottom: 24px;">
      <h1 style="color: #ffffff; font-size: 26px; margin: 0;">Mirror Feedback</h1>
      <p style="color: #888; font-size: 13px; margin: 6px 0 0;">New submission · ${escapeHtml(kindLabel(f.kind))}</p>
    </div>

    <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 28px;">
      <div style="display: inline-block; padding: 4px 12px; border-radius: 999px; background: ${accent}22; color: ${accent}; font-size: 11px; letter-spacing: 0.6px; text-transform: uppercase; font-weight: 600; margin-bottom: 16px;">
        ${escapeHtml(kindLabel(f.kind))}${f.severity ? ' · ' + escapeHtml(f.severity) : ''}
      </div>

      <h2 style="color: #fff; margin: 0 0 12px; font-size: 18px;">
        ${escapeHtml(f.subject || (f.kind === 'rating' ? `Star rating from ${f.username || 'user'}` : 'No subject'))}
      </h2>

      <table style="width: 100%; border-collapse: collapse; margin: 12px 0 20px;">
        <tbody>
          <tr><td style="padding: 6px 0; color: #888; font-size: 12px; width: 120px;">Feedback ID</td><td style="padding: 6px 0; color: #ddd; font-size: 13px; font-family: monospace;">#${f.id}</td></tr>
          <tr><td style="padding: 6px 0; color: #888; font-size: 12px;">From user</td><td style="padding: 6px 0; color: #ddd; font-size: 13px;">${escapeHtml(f.username || '—')} (id ${f.userId})</td></tr>
          <tr><td style="padding: 6px 0; color: #888; font-size: 12px;">Account email</td><td style="padding: 6px 0; color: #ddd; font-size: 13px;">${escapeHtml(f.userEmail || '—')}</td></tr>
          <tr><td style="padding: 6px 0; color: #888; font-size: 12px;">Reply-to</td><td style="padding: 6px 0; color: #ddd; font-size: 13px;">${escapeHtml(f.contactEmail || f.userEmail || '—')}</td></tr>
          ${f.kind === 'rating' ? `<tr><td style="padding: 6px 0; color: #888; font-size: 12px;">Rating</td><td style="padding: 6px 0; color: ${accent}; font-size: 14px; font-weight: 600;">${escapeHtml(stars(f.rating))}</td></tr>` : ''}
          <tr><td style="padding: 6px 0; color: #888; font-size: 12px;">Submitted</td><td style="padding: 6px 0; color: #ddd; font-size: 13px;">${escapeHtml(f.createdAt)}</td></tr>
        </tbody>
      </table>

      ${f.message ? `
        <div style="border-top: 1px solid rgba(255,255,255,0.08); padding-top: 16px;">
          <p style="color: #888; font-size: 12px; margin: 0 0 6px;">Message</p>
          <p style="color: #ddd; line-height: 1.6; white-space: pre-wrap; margin: 0;">${escapeHtml(f.message)}</p>
        </div>
      ` : ''}

      ${metaJson ? `
        <details style="margin-top: 20px;">
          <summary style="cursor: pointer; color: #888; font-size: 12px;">Submission metadata</summary>
          <pre style="margin: 8px 0 0; padding: 12px; background: rgba(0,0,0,0.3); border-radius: 8px; color: #aaa; font-size: 11px; overflow-x: auto;">${escapeHtml(metaJson)}</pre>
        </details>
      ` : ''}

      <div style="text-align: center; margin-top: 28px;">
        <a href="${APP_URL}/admin/feedback/${f.id}" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">Open in admin</a>
      </div>
    </div>

    <p style="color: #555; font-size: 11px; text-align: center; margin-top: 28px;">Mirror operator notification · do not reply directly.</p>
  </div>`;
}

function operatorEmailText(f: FeedbackSummary): string {
  return [
    `New Mirror feedback (${kindLabel(f.kind)})`,
    `Feedback ID: #${f.id}`,
    `From user: ${f.username || '—'} (id ${f.userId})`,
    `Account email: ${f.userEmail || '—'}`,
    `Reply-to: ${f.contactEmail || f.userEmail || '—'}`,
    f.kind === 'rating' ? `Rating: ${stars(f.rating)}` : null,
    f.severity ? `Severity: ${f.severity}` : null,
    f.subject ? `Subject: ${f.subject}` : null,
    f.message ? `\nMessage:\n${f.message}` : null,
    `\nSubmitted: ${f.createdAt}`,
    `\nOpen in admin: ${APP_URL}/admin/feedback/${f.id}`,
  ].filter(Boolean).join('\n');
}

function userAckHtml(f: FeedbackSummary): string {
  const accent = kindAccent(f.kind);
  const nicePerson = f.username || 'there';
  const intro = f.kind === 'rating'
    ? "Thanks for taking a moment to rate Mirror — your feedback shapes what we build next."
    : f.kind === 'recommendation'
    ? "Thanks for the recommendation — every great feature starts with a note from a member."
    : f.kind === 'issue'
    ? "Sorry you ran into trouble. We've logged your report and a human will take a look as soon as we can."
    : "Thanks for reaching out — we've received your message and will reply by email shortly.";

  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #0a0a0f; color: #e0e0e0;">
    <div style="text-align: center; margin-bottom: 24px;">
      <h1 style="color: #ffffff; font-size: 26px; margin: 0;">Mirror</h1>
      <p style="color: #888; font-size: 13px; margin: 6px 0 0;">We hear you.</p>
    </div>

    <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 32px;">
      <div style="display: inline-block; padding: 4px 12px; border-radius: 999px; background: ${accent}22; color: ${accent}; font-size: 11px; letter-spacing: 0.6px; text-transform: uppercase; font-weight: 600; margin-bottom: 16px;">
        ${escapeHtml(kindLabel(f.kind))} received
      </div>

      <h2 style="color: #fff; margin: 0 0 12px;">Hi ${escapeHtml(nicePerson)},</h2>
      <p style="color: #ccc; line-height: 1.6;">${escapeHtml(intro)}</p>

      ${f.subject ? `
        <div style="margin-top: 20px; padding: 14px 16px; background: rgba(255,255,255,0.03); border-left: 3px solid ${accent}; border-radius: 8px;">
          <p style="color: #888; font-size: 11px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.4px;">Your subject</p>
          <p style="color: #ddd; margin: 0; font-size: 14px;">${escapeHtml(f.subject)}</p>
        </div>
      ` : ''}

      <p style="color: #888; font-size: 13px; line-height: 1.6; margin-top: 24px;">
        Reference ID:&nbsp;<span style="color: #ddd; font-family: monospace;">#${f.id}</span>
      </p>

      <div style="text-align: center; margin: 28px 0 8px;">
        <a href="${APP_URL}/dashboard" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px;">Back to Mirror</a>
      </div>
    </div>

    <p style="color: #555; font-size: 11px; text-align: center; margin-top: 24px;">You can reply directly to this email if you'd like to add more detail.</p>
  </div>`;
}

function userAckText(f: FeedbackSummary): string {
  const lines = [
    `Hi ${f.username || 'there'},`,
    '',
    f.kind === 'rating' ?
      "Thanks for taking a moment to rate Mirror — your feedback shapes what we build next." :
    f.kind === 'recommendation' ?
      "Thanks for the recommendation — every great feature starts with a note from a member." :
    f.kind === 'issue' ?
      "Sorry you ran into trouble. We've logged your report and a human will take a look as soon as we can." :
      "Thanks for reaching out — we've received your message and will reply by email shortly.",
    '',
    `Reference ID: #${f.id}`,
    '',
    'You can reply directly to this email to add more detail.',
    '',
    '— The Mirror team',
  ];
  return lines.join('\n');
}

// ============================================================================
// IDEMPOTENT SEND PRIMITIVE
// ============================================================================

async function tryClaimChannel(feedbackId: number, channel: 'operator_inbox' | 'user_ack'): Promise<boolean> {
  // INSERT IGNORE is idempotent on UNIQUE(feedback_id, channel). Returns
  // affectedRows=1 the first time, 0 on every replay — that's our claim flag.
  try {
    const [result]: any = await DB.query(
      `INSERT IGNORE INTO user_feedback_email_log (feedback_id, channel, status) VALUES (?, ?, 'queued')`,
      [feedbackId, channel],
    );
    return Boolean(result?.affectedRows);
  } catch (err) {
    logger.warn(`Failed to claim email channel ${channel} for feedback ${feedbackId}`, err as Error);
    return false;
  }
}

async function markLog(
  feedbackId: number,
  channel: 'operator_inbox' | 'user_ack',
  status: 'sent' | 'failed' | 'skipped',
  providerMessageId?: string,
  error?: string,
): Promise<void> {
  try {
    await DB.query(
      `UPDATE user_feedback_email_log
          SET status = ?,
              provider_message_id = ?,
              error = ?,
              sent_at = CASE WHEN ? IN ('sent','skipped') THEN CURRENT_TIMESTAMP ELSE sent_at END
        WHERE feedback_id = ? AND channel = ?`,
      [status, providerMessageId || null, error ? String(error).slice(0, 500) : null, status, feedbackId, channel],
    );
  } catch (err) {
    logger.warn(`Failed to update email log for feedback ${feedbackId} channel ${channel}`, err as Error);
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export const feedbackNotifier = {
  /**
   * Fire both notification emails. Always returns — never throws. Designed to
   * be invoked without `await` from the controller (the user response should
   * not be coupled to email I/O latency).
   */
  async notify(feedback: FeedbackSummary): Promise<void> {
    await Promise.allSettled([
      sendOperatorEmail(feedback),
      sendUserAck(feedback),
    ]);
  },
};

async function sendOperatorEmail(f: FeedbackSummary): Promise<void> {
  const claimed = await tryClaimChannel(f.id, 'operator_inbox');
  if (!claimed) {
    logger.info(`operator_inbox already claimed for feedback ${f.id}, skipping send`);
    return;
  }

  if (!SUPPORT_INBOX) {
    await markLog(f.id, 'operator_inbox', 'skipped', undefined, 'SUPPORT_INBOX_EMAIL not configured');
    return;
  }

  try {
    const result = await emailService.send({
      to:      SUPPORT_INBOX,
      replyTo: f.contactEmail || f.userEmail || undefined,
      subject: `[Mirror Feedback] ${kindLabel(f.kind)}${f.subject ? ' — ' + f.subject : ''} (#${f.id})`,
      html:    operatorEmailHtml(f),
      text:    operatorEmailText(f),
      tags:    ['feedback', f.kind],
    });

    if (result.success) {
      await markLog(f.id, 'operator_inbox', 'sent', result.messageId);
    } else {
      await markLog(f.id, 'operator_inbox', 'failed', undefined, result.error || 'Unknown email error');
    }
  } catch (err: any) {
    logger.error(`Operator-inbox email failed for feedback ${f.id}`, err);
    await markLog(f.id, 'operator_inbox', 'failed', undefined, err?.message || String(err));
  }
}

async function sendUserAck(f: FeedbackSummary): Promise<void> {
  const to = (f.contactEmail || f.userEmail || '').trim();
  if (!to) return; // No address to ack — nothing to log.

  const claimed = await tryClaimChannel(f.id, 'user_ack');
  if (!claimed) {
    logger.info(`user_ack already claimed for feedback ${f.id}, skipping send`);
    return;
  }

  try {
    const result = await emailService.send({
      to,
      replyTo: SUPPORT_INBOX || undefined,
      subject: f.kind === 'rating'
        ? "Thanks for your Mirror rating"
        : f.kind === 'recommendation'
        ? "We got your recommendation"
        : f.kind === 'issue'
        ? "We got your issue report"
        : "We got your message",
      html: userAckHtml(f),
      text: userAckText(f),
      tags: ['feedback-ack', f.kind],
    });

    if (result.success) {
      await markLog(f.id, 'user_ack', 'sent', result.messageId);
    } else {
      await markLog(f.id, 'user_ack', 'failed', undefined, result.error || 'Unknown email error');
    }
  } catch (err: any) {
    logger.error(`User-ack email failed for feedback ${f.id}`, err);
    await markLog(f.id, 'user_ack', 'failed', undefined, err?.message || String(err));
  }
}