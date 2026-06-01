// ============================================================================
// EmailCampaignWorker - Background Worker for Admin Email Broadcasts
// ============================================================================
// File: workers/EmailCampaignWorker.ts
// ----------------------------------------------------------------------------
// Polls for due scheduled campaigns and dispatches in-flight campaigns in
// rate-limited batches via emailBroadcastService.tick(). DB-driven and
// idempotent: all state lives in email_campaigns / email_campaign_recipients,
// so a restart resumes cleanly with no double-sends.
//
// PM2: started as `email-campaign-worker` (see ecosystem.config.js).
// Run standalone: node dist/workers/EmailCampaignWorker.js
// ============================================================================

// IMPORTANT: import db.ts FIRST. db.ts calls dotenv.config() at the top, which
// must run BEFORE mirrorRedis instantiates its ioredis client — otherwise the
// client connects without REDIS_PASSWORD and the worker dies on startup with
// NOAUTH. Every other worker imports DB first for the same reason.
import { DB } from '../db';
import { Logger } from '../utils/logger';
import { mirrorRedis } from '../config/redis';
import { tick } from '../services/emailBroadcastService';

const logger = new Logger('EmailCampaignWorker');

const POLL_INTERVAL_MS = Math.max(2000, parseInt(process.env.EMAIL_WORKER_POLL_MS || '15000', 10));

let running = true;
let inTick = false;
let pollTimer: NodeJS.Timeout | null = null;

async function runOnce(): Promise<void> {
  // Prevent overlapping ticks if a batch takes longer than the poll interval.
  if (inTick) return;
  inTick = true;
  try {
    const result = await tick();
    if (result.started > 0 || result.processed > 0) {
      logger.info('Tick complete', result);
    }
  } catch (err) {
    logger.error('Tick failed', err as Error);
  } finally {
    inTick = false;
  }
}

function start(): void {
  logger.info('Starting Email Campaign Worker', { pollIntervalMs: POLL_INTERVAL_MS });
  pollTimer = setInterval(runOnce, POLL_INTERVAL_MS);
  // Kick an immediate first pass.
  void runOnce();
}

async function shutdown(signal: string): Promise<void> {
  if (!running) return;
  running = false;
  logger.info(`${signal} received — shutting down Email Campaign Worker`);

  if (pollTimer) clearInterval(pollTimer);

  // Allow an in-flight batch to finish (PM2 kill_timeout gives us the window).
  const deadline = Date.now() + 12000;
  while (inTick && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
  }

  try {
    await mirrorRedis.shutdown();
  } catch { /* best effort */ }

  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection in worker', reason as Error);
});

if (require.main === module) {
  start();

  // Periodic heartbeat so the admin dashboard log panel shows liveness.
  setInterval(() => {
    if (running) logger.info('Email Campaign Worker heartbeat');
  }, 60000);
}