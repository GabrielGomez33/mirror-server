// ============================================================================
// PROCESSOR ORCHESTRATOR - Dynamic Auto-Scaling "Breathing" System
// ============================================================================
// File: workers/ProcessorOrchestrator.ts
//
// Purpose: Dynamically scales DinaChatQueueProcessor workers based on load.
// Like breathing - expands when more oxygen (requests) needed, contracts when idle.
//
// Features:
// - Monitors queue depth in real-time
// - Spawns new workers when load increases
// - Gracefully terminates workers when load decreases
// - Per-user state tracking across all workers
// - Configurable min/max workers and scaling thresholds
// - Cooldown periods to prevent thrashing
// - Health monitoring and metrics
//
// Copy to: /var/www/mirror-server/workers/ProcessorOrchestrator.ts
// ============================================================================

import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import { DB as pool } from '../db';
import path from 'path';

// ============================================================================
// TYPES
// ============================================================================

interface OrchestratorConfig {
  minWorkers: number;
  maxWorkers: number;
  scaleUpThreshold: number;      // Pending items per worker to trigger scale up
  scaleDownThreshold: number;    // Pending items per worker to trigger scale down
  monitorIntervalMs: number;     // How often to check queue depth
  scaleUpCooldownMs: number;     // Cooldown after scaling up
  scaleDownCooldownMs: number;   // Cooldown after scaling down
  workerIdleTimeoutMs: number;   // How long a worker can be idle before termination
  gracefulShutdownMs: number;    // Time to wait for workers to finish
}

interface WorkerInfo {
  id: string;
  worker: Worker;
  status: 'starting' | 'running' | 'stopping' | 'stopped';
  startedAt: Date;
  lastActiveAt: Date;
  processedCount: number;
  errorCount: number;
}

interface UserState {
  userId: number;
  requestCount: number;
  lastRequestAt: number;
  circuitBreakerFailures: number;
  circuitBreakerOpenedAt: number | null;
}

interface OrchestratorStats {
  activeWorkers: number;
  totalWorkersSpawned: number;
  totalWorkersTerminated: number;
  currentQueueDepth: number;
  totalProcessed: number;
  lastScaleUpAt: Date | null;
  lastScaleDownAt: Date | null;
  uptime: number;
}

interface ScalingDecision {
  action: 'scale_up' | 'scale_down' | 'none';
  reason: string;
  currentWorkers: number;
  targetWorkers: number;
  queueDepth: number;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ============================================================================
// LOGGER
// ============================================================================

class OrchestratorLogger {
  private context: string;
  private minLevel: LogLevel;
  private readonly levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

  constructor(context: string, minLevel: LogLevel = 'info') {
    this.context = context;
    this.minLevel = minLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levels[level] >= this.levels[this.minLevel];
  }

  private format(level: LogLevel, message: string, meta?: Record<string, any>): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] [${this.context}] ${message}${metaStr}`;
  }

  debug(message: string, meta?: Record<string, any>): void {
    if (this.shouldLog('debug')) console.log(this.format('debug', message, meta));
  }

  info(message: string, meta?: Record<string, any>): void {
    if (this.shouldLog('info')) console.log(this.format('info', message, meta));
  }

  warn(message: string, meta?: Record<string, any>): void {
    if (this.shouldLog('warn')) console.warn(this.format('warn', message, meta));
  }

  error(message: string, error?: Error, meta?: Record<string, any>): void {
    if (this.shouldLog('error')) {
      const errorMeta = error ? { error: error.message, stack: error.stack, ...meta } : meta;
      console.error(this.format('error', message, errorMeta));
    }
  }
}

// ============================================================================
// PROCESSOR ORCHESTRATOR CLASS
// ============================================================================

export class ProcessorOrchestrator extends EventEmitter {
  private workers: Map<string, WorkerInfo> = new Map();
  private userStates: Map<number, UserState> = new Map();
  private isRunning: boolean = false;
  private isShuttingDown: boolean = false;
  private monitorTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private lastScaleUpAt: number = 0;
  private lastScaleDownAt: number = 0;
  private startedAt: Date | null = null;

  private readonly config: OrchestratorConfig;
  private readonly logger: OrchestratorLogger;
  private readonly stats: OrchestratorStats;

  private broadcastFunction: ((groupId: string, payload: any) => void) | null = null;

  constructor(config?: Partial<OrchestratorConfig>) {
    super();

    this.config = {
      minWorkers: parseInt(process.env.DINA_MIN_WORKERS || '1', 10),
      maxWorkers: parseInt(process.env.DINA_MAX_WORKERS || '5', 10),
      scaleUpThreshold: parseInt(process.env.DINA_SCALE_UP_THRESHOLD || '5', 10),
      scaleDownThreshold: parseInt(process.env.DINA_SCALE_DOWN_THRESHOLD || '1', 10),
      monitorIntervalMs: parseInt(process.env.DINA_MONITOR_INTERVAL || '5000', 10),
      scaleUpCooldownMs: parseInt(process.env.DINA_SCALE_UP_COOLDOWN || '15000', 10),
      scaleDownCooldownMs: parseInt(process.env.DINA_SCALE_DOWN_COOLDOWN || '30000', 10),
      workerIdleTimeoutMs: parseInt(process.env.DINA_WORKER_IDLE_TIMEOUT || '60000', 10),
      gracefulShutdownMs: parseInt(process.env.DINA_GRACEFUL_SHUTDOWN || '30000', 10),
      ...config,
    };

    const logLevel = (process.env.DINA_ORCHESTRATOR_LOG_LEVEL || 'info') as LogLevel;
    this.logger = new OrchestratorLogger('ProcessorOrchestrator', logLevel);

    this.stats = {
      activeWorkers: 0,
      totalWorkersSpawned: 0,
      totalWorkersTerminated: 0,
      currentQueueDepth: 0,
      totalProcessed: 0,
      lastScaleUpAt: null,
      lastScaleDownAt: null,
      uptime: 0,
    };

    this.logger.info('ProcessorOrchestrator initialized', {
      config: {
        minWorkers: this.config.minWorkers,
        maxWorkers: this.config.maxWorkers,
        scaleUpThreshold: this.config.scaleUpThreshold,
        scaleDownThreshold: this.config.scaleDownThreshold,
        monitorIntervalMs: this.config.monitorIntervalMs,
      },
    });
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Orchestrator already running');
      return;
    }

    this.logger.info('Starting ProcessorOrchestrator...');
    this.isRunning = true;
    this.isShuttingDown = false;
    this.startedAt = new Date();

    // Spawn minimum workers
    for (let i = 0; i < this.config.minWorkers; i++) {
      await this.spawnWorker();
    }

    // Start monitoring loop
    this.startMonitoring();

    // Start user state cleanup
    this.cleanupTimer = setInterval(() => {
      this.cleanupUserStates();
    }, 60000);

    this.registerShutdownHandlers();
    this.emit('started');
    this.logger.info('ProcessorOrchestrator started', { workers: this.workers.size });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.logger.info('Stopping ProcessorOrchestrator...');
    this.isRunning = false;
    this.isShuttingDown = true;

    // Stop monitoring
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Gracefully stop all workers
    const stopPromises = Array.from(this.workers.values()).map(info =>
      this.terminateWorker(info.id, true)
    );

    await Promise.allSettled(stopPromises);

    this.emit('stopped');
    this.logger.info('ProcessorOrchestrator stopped');
  }

  private registerShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      this.logger.info(`Received ${signal}, initiating graceful shutdown...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  // ============================================================================
  // WORKER MANAGEMENT
  // ============================================================================

  private async spawnWorker(): Promise<string> {
    const workerId = `worker_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    this.logger.info('Spawning new worker', { workerId });

    const workerPath = path.join(__dirname, 'DinaChatWorker.js');

    const worker = new Worker(workerPath, {
      workerData: {
        workerId,
        config: {
          pollIntervalMs: parseInt(process.env.DINA_CHAT_POLL_INTERVAL || '2000', 10),
          maxConcurrent: parseInt(process.env.DINA_CHAT_MAX_CONCURRENT || '3', 10),
          maxRetries: parseInt(process.env.DINA_CHAT_MAX_RETRIES || '3', 10),
          streamingEnabled: process.env.DINA_STREAMING_ENABLED !== 'false',
        },
      },
    });

    const workerInfo: WorkerInfo = {
      id: workerId,
      worker,
      status: 'starting',
      startedAt: new Date(),
      lastActiveAt: new Date(),
      processedCount: 0,
      errorCount: 0,
    };

    this.workers.set(workerId, workerInfo);

    // Set up worker event handlers
    worker.on('message', (message) => this.handleWorkerMessage(workerId, message));
    worker.on('error', (error) => this.handleWorkerError(workerId, error));
    worker.on('exit', (code) => this.handleWorkerExit(workerId, code));

    // Send broadcast function reference (as a serializable config)
    if (this.broadcastFunction) {
      worker.postMessage({
        type: 'config',
        payload: { hasBroadcast: true },
      });
    }

    this.stats.totalWorkersSpawned++;
    this.stats.activeWorkers = this.workers.size;
    this.emit('worker:spawned', { workerId });

    return workerId;
  }

  private async terminateWorker(workerId: string, graceful: boolean = true): Promise<void> {
    const workerInfo = this.workers.get(workerId);
    if (!workerInfo) return;

    this.logger.info('Terminating worker', { workerId, graceful });
    workerInfo.status = 'stopping';

    if (graceful) {
      // Send stop signal and wait for graceful shutdown
      workerInfo.worker.postMessage({ type: 'stop' });

      // Wait for worker to finish with timeout
      await Promise.race([
        new Promise<void>((resolve) => {
          workerInfo.worker.once('exit', () => resolve());
        }),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            this.logger.warn('Worker did not exit gracefully, forcing termination', { workerId });
            workerInfo.worker.terminate();
            resolve();
          }, this.config.gracefulShutdownMs);
        }),
      ]);
    } else {
      await workerInfo.worker.terminate();
    }

    this.workers.delete(workerId);
    this.stats.totalWorkersTerminated++;
    this.stats.activeWorkers = this.workers.size;
    this.emit('worker:terminated', { workerId });
  }

  private handleWorkerMessage(workerId: string, message: any): void {
    const workerInfo = this.workers.get(workerId);
    if (!workerInfo) return;

    workerInfo.lastActiveAt = new Date();

    switch (message.type) {
      case 'ready':
        workerInfo.status = 'running';
        this.logger.info('Worker ready', { workerId });
        break;

      case 'processed':
        workerInfo.processedCount++;
        this.stats.totalProcessed++;

        // Forward broadcast messages to main thread
        if (message.broadcast && this.broadcastFunction) {
          this.broadcastFunction(message.broadcast.groupId, message.broadcast.payload);
        }
        break;

      case 'error':
        workerInfo.errorCount++;
        this.logger.error('Worker reported error', undefined, { workerId, error: message.error });
        break;

      case 'rate_limit_check':
        // Handle per-user rate limit check from worker
        const canProcess = this.checkUserRateLimit(message.userId);
        workerInfo.worker.postMessage({
          type: 'rate_limit_response',
          requestId: message.requestId,
          canProcess,
        });
        break;

      case 'user_state_update':
        // Update user state from worker
        this.updateUserState(message.userId, message.state);
        break;

      case 'stats':
        // Worker stats update
        this.logger.debug('Worker stats', { workerId, stats: message.stats });
        break;
    }
  }

  private handleWorkerError(workerId: string, error: Error): void {
    const workerInfo = this.workers.get(workerId);
    this.logger.error('Worker error', error, { workerId });

    if (workerInfo) {
      workerInfo.errorCount++;
      workerInfo.status = 'stopped';
    }

    // Remove failed worker and potentially spawn replacement
    this.workers.delete(workerId);
    this.stats.activeWorkers = this.workers.size;

    if (this.isRunning && !this.isShuttingDown && this.workers.size < this.config.minWorkers) {
      this.logger.info('Spawning replacement worker after error');
      this.spawnWorker();
    }

    this.emit('worker:error', { workerId, error });
  }

  private handleWorkerExit(workerId: string, code: number): void {
    this.logger.info('Worker exited', { workerId, code });

    this.workers.delete(workerId);
    this.stats.activeWorkers = this.workers.size;

    // Spawn replacement if below minimum and not shutting down
    if (this.isRunning && !this.isShuttingDown && this.workers.size < this.config.minWorkers) {
      this.logger.info('Spawning replacement worker to maintain minimum');
      this.spawnWorker();
    }

    this.emit('worker:exit', { workerId, code });
  }

  // ============================================================================
  // MONITORING & AUTO-SCALING
  // ============================================================================

  private startMonitoring(): void {
    this.monitorTimer = setInterval(async () => {
      try {
        await this.monitorAndScale();
      } catch (error) {
        this.logger.error('Error in monitoring cycle', error as Error);
      }
    }, this.config.monitorIntervalMs);
  }

  private async monitorAndScale(): Promise<void> {
    const queueDepth = await this.getQueueDepth();
    this.stats.currentQueueDepth = queueDepth;

    const decision = this.makeScalingDecision(queueDepth);

    if (decision.action === 'scale_up') {
      await this.scaleUp(decision);
    } else if (decision.action === 'scale_down') {
      await this.scaleDown(decision);
    }

    // Log periodic stats
    if (Date.now() % 30000 < this.config.monitorIntervalMs) {
      this.logger.info('Orchestrator stats', {
        workers: this.workers.size,
        queueDepth,
        totalProcessed: this.stats.totalProcessed,
      });
    }
  }

  private async getQueueDepth(): Promise<number> {
    const [rows]: any = await pool.query(
      `SELECT COUNT(*) as count FROM mirror_dina_chat_queue
       WHERE status = 'pending'
       AND (next_retry_at IS NULL OR next_retry_at <= NOW())`
    );
    return rows[0]?.count || 0;
  }

  private makeScalingDecision(queueDepth: number): ScalingDecision {
    const currentWorkers = this.workers.size;
    const now = Date.now();

    // Calculate effective load per worker
    const loadPerWorker = currentWorkers > 0 ? queueDepth / currentWorkers : queueDepth;

    // Check scale up conditions
    if (
      loadPerWorker >= this.config.scaleUpThreshold &&
      currentWorkers < this.config.maxWorkers &&
      now - this.lastScaleUpAt >= this.config.scaleUpCooldownMs
    ) {
      return {
        action: 'scale_up',
        reason: `Load per worker (${loadPerWorker.toFixed(1)}) >= threshold (${this.config.scaleUpThreshold})`,
        currentWorkers,
        targetWorkers: currentWorkers + 1,
        queueDepth,
      };
    }

    // Check scale down conditions
    if (
      loadPerWorker <= this.config.scaleDownThreshold &&
      currentWorkers > this.config.minWorkers &&
      now - this.lastScaleDownAt >= this.config.scaleDownCooldownMs
    ) {
      // Find the most idle worker
      const idleWorker = this.findMostIdleWorker();
      if (idleWorker && now - idleWorker.lastActiveAt.getTime() >= this.config.workerIdleTimeoutMs / 2) {
        return {
          action: 'scale_down',
          reason: `Load per worker (${loadPerWorker.toFixed(1)}) <= threshold (${this.config.scaleDownThreshold})`,
          currentWorkers,
          targetWorkers: currentWorkers - 1,
          queueDepth,
        };
      }
    }

    return {
      action: 'none',
      reason: 'No scaling needed',
      currentWorkers,
      targetWorkers: currentWorkers,
      queueDepth,
    };
  }

  private async scaleUp(decision: ScalingDecision): Promise<void> {
    this.logger.info('Scaling UP', {
      reason: decision.reason,
      from: decision.currentWorkers,
      to: decision.targetWorkers,
      queueDepth: decision.queueDepth,
    });

    await this.spawnWorker();
    this.lastScaleUpAt = Date.now();
    this.stats.lastScaleUpAt = new Date();
    this.emit('scaled:up', decision);
  }

  private async scaleDown(decision: ScalingDecision): Promise<void> {
    const idleWorker = this.findMostIdleWorker();
    if (!idleWorker) return;

    this.logger.info('Scaling DOWN', {
      reason: decision.reason,
      from: decision.currentWorkers,
      to: decision.targetWorkers,
      queueDepth: decision.queueDepth,
      terminatingWorker: idleWorker.id,
    });

    await this.terminateWorker(idleWorker.id, true);
    this.lastScaleDownAt = Date.now();
    this.stats.lastScaleDownAt = new Date();
    this.emit('scaled:down', decision);
  }

  private findMostIdleWorker(): WorkerInfo | null {
    let mostIdle: WorkerInfo | null = null;
    let oldestActivity = Date.now();

    for (const info of this.workers.values()) {
      if (info.status === 'running' && info.lastActiveAt.getTime() < oldestActivity) {
        oldestActivity = info.lastActiveAt.getTime();
        mostIdle = info;
      }
    }

    return mostIdle;
  }

  // ============================================================================
  // USER STATE MANAGEMENT (Shared Across Workers)
  // ============================================================================

  private checkUserRateLimit(userId: number): boolean {
    const state = this.userStates.get(userId);
    const now = Date.now();
    const windowMs = parseInt(process.env.DINA_RATE_LIMIT_WINDOW || '60000', 10);
    const limit = parseInt(process.env.DINA_RATE_LIMIT_PER_USER || '10', 10);

    if (!state) {
      this.userStates.set(userId, {
        userId,
        requestCount: 1,
        lastRequestAt: now,
        circuitBreakerFailures: 0,
        circuitBreakerOpenedAt: null,
      });
      return true;
    }

    // Reset count if window has passed
    if (now - state.lastRequestAt > windowMs) {
      state.requestCount = 1;
      state.lastRequestAt = now;
      return true;
    }

    // Check if under limit
    if (state.requestCount < limit) {
      state.requestCount++;
      state.lastRequestAt = now;
      return true;
    }

    return false;
  }

  private updateUserState(userId: number, updates: Partial<UserState>): void {
    const state = this.userStates.get(userId);
    if (state) {
      Object.assign(state, updates);
    } else {
      this.userStates.set(userId, {
        userId,
        requestCount: 0,
        lastRequestAt: Date.now(),
        circuitBreakerFailures: 0,
        circuitBreakerOpenedAt: null,
        ...updates,
      });
    }
  }

  private cleanupUserStates(): void {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes

    for (const [userId, state] of this.userStates) {
      if (now - state.lastRequestAt > maxAge) {
        this.userStates.delete(userId);
      }
    }

    this.logger.debug('Cleaned up user states', { remaining: this.userStates.size });
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  setBroadcastFunction(fn: (groupId: string, payload: any) => void): void {
    this.broadcastFunction = fn;

    // Notify all workers
    for (const info of this.workers.values()) {
      info.worker.postMessage({
        type: 'config',
        payload: { hasBroadcast: true },
      });
    }
  }

  async getStats(): Promise<OrchestratorStats & { workers: WorkerInfo[] }> {
    const workerList = Array.from(this.workers.values()).map(info => ({
      id: info.id,
      status: info.status,
      startedAt: info.startedAt,
      lastActiveAt: info.lastActiveAt,
      processedCount: info.processedCount,
      errorCount: info.errorCount,
    }));

    return {
      ...this.stats,
      uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
      workers: workerList as any,
    };
  }

  getWorkerCount(): number {
    return this.workers.size;
  }

  getQueueDepthSync(): number {
    return this.stats.currentQueueDepth;
  }

  isActive(): boolean {
    return this.isRunning;
  }

  // Force scale to specific worker count (for manual intervention)
  async setWorkerCount(count: number): Promise<void> {
    const targetCount = Math.max(this.config.minWorkers, Math.min(this.config.maxWorkers, count));
    const currentCount = this.workers.size;

    this.logger.info('Manual scaling', { from: currentCount, to: targetCount });

    if (targetCount > currentCount) {
      for (let i = 0; i < targetCount - currentCount; i++) {
        await this.spawnWorker();
      }
    } else if (targetCount < currentCount) {
      const toTerminate = currentCount - targetCount;
      const workers = Array.from(this.workers.values())
        .sort((a, b) => a.lastActiveAt.getTime() - b.lastActiveAt.getTime())
        .slice(0, toTerminate);

      for (const worker of workers) {
        await this.terminateWorker(worker.id, true);
      }
    }
  }
}

// ============================================================================
// SINGLETON & EXPORTS
// ============================================================================

let orchestratorInstance: ProcessorOrchestrator | null = null;

export function getOrchestrator(): ProcessorOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new ProcessorOrchestrator();
  }
  return orchestratorInstance;
}

export async function startOrchestrator(): Promise<ProcessorOrchestrator> {
  const orchestrator = getOrchestrator();
  await orchestrator.start();
  return orchestrator;
}

export async function stopOrchestrator(): Promise<void> {
  if (orchestratorInstance) {
    await orchestratorInstance.stop();
  }
}

export default ProcessorOrchestrator;
