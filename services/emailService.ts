// ============================================================================
// UNIVERSAL EMAIL SERVICE
// ============================================================================
// File: services/emailService.ts
// Provider-agnostic email sending with queue, retry, and template support.
// Supports: Resend, Brevo (Sendinblue). Add new providers via EmailProvider interface.
// ============================================================================

import { Logger } from '../utils/logger';
import { mirrorRedis } from '../config/redis';
import { DB } from '../db';

const logger = new Logger('EmailService');

// ============================================================================
// TYPES
// ============================================================================

export interface EmailProvider {
  name: string;
  send(email: EmailMessage): Promise<EmailSendResult>;
  verifyConnection(): Promise<boolean>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  tags?: string[];
}

export interface EmailSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface EmailQueueItem {
  id: string;
  message: EmailMessage;
  template?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  lastAttemptAt?: string;
  error?: string;
}

export type EmailTemplateName =
  | 'welcome'
  | 'email_verification'
  | 'payment_confirmed'
  | 'payment_failed'
  | 'trial_ending'
  | 'subscription_cancelled';

export interface EmailTemplateData {
  [key: string]: string | number | boolean | undefined;
}

// ============================================================================
// EMAIL TEMPLATES
// ============================================================================

const EMAIL_TEMPLATES: Record<EmailTemplateName, {
  subject: string;
  html: (data: EmailTemplateData) => string;
  text: (data: EmailTemplateData) => string;
}> = {
  welcome: {
    subject: 'Welcome to Mirror',
    html: (data) => `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #0a0a0f; color: #e0e0e0;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #ffffff; font-size: 28px; margin: 0;">Mirror</h1>
          <p style="color: #888; font-size: 14px; margin: 8px 0 0;">See yourself in the world, and the world in you</p>
        </div>
        <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 32px;">
          <h2 style="color: #fff; margin: 0 0 16px;">Welcome, ${data.username}!</h2>
          <p style="color: #ccc; line-height: 1.6;">Your Mirror account has been created. Start your journey of self-discovery by completing your intake assessment.</p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${data.appUrl}/dashboard" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600;">Go to Dashboard</a>
          </div>
        </div>
        <p style="color: #666; font-size: 12px; text-align: center; margin-top: 32px;">You received this because you registered at Mirror. If this wasn't you, please ignore this email.</p>
      </div>
    `,
    text: (data) => `Welcome to Mirror, ${data.username}! Start your journey at ${data.appUrl}/dashboard`,
  },

  email_verification: {
    subject: 'Verify your Mirror email',
    html: (data) => `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #0a0a0f; color: #e0e0e0;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #ffffff; font-size: 28px; margin: 0;">Mirror</h1>
        </div>
        <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 32px;">
          <h2 style="color: #fff; margin: 0 0 16px;">Verify your email</h2>
          <p style="color: #ccc; line-height: 1.6;">Click the button below to verify your email address. This link expires in 24 hours.</p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${data.verificationUrl}" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600;">Verify Email</a>
          </div>
          <p style="color: #888; font-size: 13px;">If the button doesn't work, copy this link: ${data.verificationUrl}</p>
        </div>
        <p style="color: #666; font-size: 12px; text-align: center; margin-top: 32px;">If you didn't create a Mirror account, ignore this email.</p>
      </div>
    `,
    text: (data) => `Verify your Mirror email by visiting: ${data.verificationUrl} — This link expires in 24 hours.`,
  },

  payment_confirmed: {
    subject: 'Payment confirmed — Mirror Premium',
    html: (data) => `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #0a0a0f; color: #e0e0e0;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #ffffff; font-size: 28px; margin: 0;">Mirror</h1>
        </div>
        <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 32px;">
          <h2 style="color: #fff; margin: 0 0 16px;">Payment confirmed</h2>
          <p style="color: #ccc; line-height: 1.6;">Your Mirror Premium subscription is active. Amount: <strong>$${data.amount}</strong></p>
          <p style="color: #ccc; line-height: 1.6;">Next billing date: <strong>${data.nextBillingDate}</strong></p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${data.appUrl}/dashboard" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600;">Explore Premium Features</a>
          </div>
        </div>
      </div>
    `,
    text: (data) => `Mirror Premium payment confirmed. Amount: $${data.amount}. Next billing: ${data.nextBillingDate}.`,
  },

  payment_failed: {
    subject: 'Action required — Mirror payment failed',
    html: (data) => `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #0a0a0f; color: #e0e0e0;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #ffffff; font-size: 28px; margin: 0;">Mirror</h1>
        </div>
        <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(139,92,246,0.3); border-radius: 12px; padding: 32px;">
          <h2 style="color: #f87171; margin: 0 0 16px;">Payment failed</h2>
          <p style="color: #ccc; line-height: 1.6;">We couldn't process your Mirror Premium payment. You have <strong>${data.graceDaysLeft} days</strong> to update your payment method before your Premium access is paused.</p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${data.updatePaymentUrl}" style="display: inline-block; background: linear-gradient(135deg, #ef4444, #f87171); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600;">Update Payment Method</a>
          </div>
        </div>
      </div>
    `,
    text: (data) => `Mirror Premium payment failed. You have ${data.graceDaysLeft} days to update your payment method. Visit: ${data.updatePaymentUrl}`,
  },

  trial_ending: {
    subject: 'Your Mirror Premium trial ends soon',
    html: (data) => `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #0a0a0f; color: #e0e0e0;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #ffffff; font-size: 28px; margin: 0;">Mirror</h1>
        </div>
        <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 32px;">
          <h2 style="color: #fff; margin: 0 0 16px;">Your trial ends in ${data.daysLeft} days</h2>
          <p style="color: #ccc; line-height: 1.6;">Subscribe now to keep access to unlimited journaling, AI analysis, TruthStream reports, and MirrorGroups creation.</p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${data.appUrl}/dashboard" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600;">Subscribe — $9.99/month</a>
          </div>
        </div>
      </div>
    `,
    text: (data) => `Your Mirror Premium trial ends in ${data.daysLeft} days. Subscribe at ${data.appUrl}/dashboard to keep Premium access.`,
  },

  subscription_cancelled: {
    subject: 'Mirror Premium cancelled',
    html: (data) => `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #0a0a0f; color: #e0e0e0;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #ffffff; font-size: 28px; margin: 0;">Mirror</h1>
        </div>
        <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 32px;">
          <h2 style="color: #fff; margin: 0 0 16px;">Subscription cancelled</h2>
          <p style="color: #ccc; line-height: 1.6;">Your Mirror Premium subscription has been cancelled. You'll continue to have Premium access until <strong>${data.accessUntil}</strong>.</p>
          <p style="color: #ccc; line-height: 1.6;">You can resubscribe anytime from your dashboard.</p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${data.appUrl}/dashboard" style="display: inline-block; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600;">Go to Dashboard</a>
          </div>
        </div>
      </div>
    `,
    text: (data) => `Mirror Premium cancelled. You have access until ${data.accessUntil}. Resubscribe anytime from your dashboard.`,
  },
};

// ============================================================================
// PROVIDER IMPLEMENTATIONS
// ============================================================================

class ResendProvider implements EmailProvider {
  name = 'resend';
  private apiKey: string;
  private apiBase = 'https://api.resend.com';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async send(email: EmailMessage): Promise<EmailSendResult> {
    try {
      const response = await fetch(`${this.apiBase}/emails`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: email.from || process.env.EMAIL_FROM_ADDRESS || 'Mirror <noreply@theundergroundrailroad.world>',
          to: [email.to],
          subject: email.subject,
          html: email.html,
          text: email.text,
          reply_to: email.replyTo,
          tags: email.tags?.map(t => ({ name: t, value: 'true' })),
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        return { success: false, error: `Resend API error ${response.status}: ${errorBody}` };
      }

      const result = await response.json() as { id: string };
      return { success: true, messageId: result.id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async verifyConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiBase}/domains`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

class BrevoProvider implements EmailProvider {
  name = 'brevo';
  private apiKey: string;
  private apiBase = 'https://api.brevo.com/v3';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async send(email: EmailMessage): Promise<EmailSendResult> {
    try {
      const fromAddress = email.from || process.env.EMAIL_FROM_ADDRESS || 'noreply@theundergroundrailroad.world';
      const fromName = process.env.EMAIL_FROM_NAME || 'Mirror';

      const response = await fetch(`${this.apiBase}/smtp/email`, {
        method: 'POST',
        headers: {
          'api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: fromName, email: fromAddress },
          to: [{ email: email.to }],
          subject: email.subject,
          htmlContent: email.html,
          textContent: email.text,
          replyTo: email.replyTo ? { email: email.replyTo } : undefined,
          tags: email.tags,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        return { success: false, error: `Brevo API error ${response.status}: ${errorBody}` };
      }

      const result = await response.json() as { messageId: string };
      return { success: true, messageId: result.messageId };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async verifyConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiBase}/account`, {
        headers: { 'api-key': this.apiKey, 'Accept': 'application/json' },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// EMAIL SERVICE CLASS
// ============================================================================

export class EmailService {
  private provider: EmailProvider | null = null;
  private fromAddress: string;
  private fromName: string;
  private appUrl: string;
  private enabled: boolean = false;

  constructor() {
    this.fromAddress = process.env.EMAIL_FROM_ADDRESS || 'noreply@theundergroundrailroad.world';
    this.fromName = process.env.EMAIL_FROM_NAME || 'Mirror';
    this.appUrl = process.env.APP_URL || 'https://www.theundergroundrailroad.world/Mirror';
    this.initializeProvider();
  }

  private initializeProvider(): void {
    const providerName = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
    const apiKey = process.env.EMAIL_API_KEY || process.env.RESEND_API_KEY || '';

    if (!apiKey) {
      logger.warn('Email service disabled — no API key found (set EMAIL_API_KEY or RESEND_API_KEY)');
      return;
    }

    switch (providerName) {
      case 'resend':
        this.provider = new ResendProvider(apiKey);
        break;
      case 'brevo':
        this.provider = new BrevoProvider(apiKey);
        break;
      default:
        logger.warn(`Unknown email provider: ${providerName}. Email service disabled.`);
        return;
    }

    this.enabled = true;
    logger.info(`Email service initialized with provider: ${providerName}`);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ========================================================================
  // DIRECT SEND
  // ========================================================================

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.provider) {
      logger.warn('Email send skipped — no provider configured', { to: message.to, subject: message.subject });
      return { success: false, error: 'Email service not configured' };
    }

    try {
      const result = await this.provider.send({
        ...message,
        from: message.from || `${this.fromName} <${this.fromAddress}>`,
      });

      if (result.success) {
        logger.info('Email sent', { to: message.to, subject: message.subject, messageId: result.messageId });
      } else {
        logger.error('Email send failed', new Error(result.error || 'Unknown error'), { to: message.to, subject: message.subject });
      }

      return result;
    } catch (error: any) {
      logger.error('Email send exception', error, { to: message.to });
      return { success: false, error: error.message };
    }
  }

  // ========================================================================
  // TEMPLATE SEND
  // ========================================================================

  async sendTemplate(
    to: string,
    templateName: EmailTemplateName,
    data: EmailTemplateData
  ): Promise<EmailSendResult> {
    const template = EMAIL_TEMPLATES[templateName];
    if (!template) {
      return { success: false, error: `Unknown template: ${templateName}` };
    }

    const enrichedData = { ...data, appUrl: this.appUrl };

    return this.send({
      to,
      subject: template.subject,
      html: template.html(enrichedData),
      text: template.text(enrichedData),
      tags: [templateName],
    });
  }

  // ========================================================================
  // QUEUED SEND (async, with retry)
  // ========================================================================

  async queueEmail(
    to: string,
    templateName: EmailTemplateName,
    data: EmailTemplateData
  ): Promise<boolean> {
    const template = EMAIL_TEMPLATES[templateName];
    if (!template) {
      logger.error('Unknown email template for queue', new Error(`Template: ${templateName}`));
      return false;
    }

    const enrichedData = { ...data, appUrl: this.appUrl };

    const item: EmailQueueItem = {
      id: `email_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      message: {
        to,
        subject: template.subject,
        html: template.html(enrichedData),
        text: template.text(enrichedData),
        tags: [templateName],
      },
      template: templateName,
      attempts: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
    };

    try {
      await mirrorRedis.set(`email:queue:${item.id}`, item, 86400);
      // Add to processing list
      const client = (mirrorRedis as any).client;
      if (client?.lpush) {
        await client.lpush('email:queue:pending', item.id);
      }
      return true;
    } catch (error) {
      // Fallback: send directly if Redis unavailable
      logger.warn('Email queue failed, sending directly', { to, template: templateName });
      const result = await this.send(item.message);
      return result.success;
    }
  }

  // ========================================================================
  // QUEUE PROCESSOR (call periodically or on event)
  // ========================================================================

  async processQueue(): Promise<number> {
    if (!this.enabled) return 0;

    let processed = 0;
    const maxBatch = 10;

    for (let i = 0; i < maxBatch; i++) {
      try {
        const client = (mirrorRedis as any).client;
        if (!client?.rpop) break;

        const itemId = await client.rpop('email:queue:pending');
        if (!itemId) break;

        const item: EmailQueueItem | null = await mirrorRedis.get(`email:queue:${itemId}`);
        if (!item) continue;

        item.attempts++;
        item.lastAttemptAt = new Date().toISOString();

        const result = await this.send(item.message);

        if (result.success) {
          await mirrorRedis.del(`email:queue:${itemId}`);
          processed++;
        } else {
          item.error = result.error;
          if (item.attempts < item.maxAttempts) {
            // Re-queue with backoff
            const backoffMs = Math.pow(2, item.attempts) * 5000;
            await mirrorRedis.set(`email:queue:${itemId}`, item, 86400);
            setTimeout(async () => {
              try {
                await client.lpush('email:queue:pending', itemId);
              } catch { /* queue retry failed, item will expire */ }
            }, backoffMs);
          } else {
            logger.error('Email permanently failed after max attempts', new Error(item.error || 'Unknown'), {
              to: item.message.to,
              template: item.template,
              attempts: item.attempts,
            });
            await mirrorRedis.del(`email:queue:${itemId}`);
          }
        }
      } catch (error) {
        logger.error('Email queue processing error', error as Error);
        break;
      }
    }

    return processed;
  }

  // ========================================================================
  // HEALTH CHECK
  // ========================================================================

  async healthCheck(): Promise<{ status: string; provider: string | null }> {
    if (!this.provider) {
      return { status: 'disabled', provider: null };
    }

    const connected = await this.provider.verifyConnection();
    return {
      status: connected ? 'healthy' : 'unhealthy',
      provider: this.provider.name,
    };
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const emailService = new EmailService();
