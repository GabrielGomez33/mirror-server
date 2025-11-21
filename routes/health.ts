/**
 * Health Check Endpoints
 *
 * Provides health status for various system components:
 * - Database connectivity
 * - Redis connectivity
 * - DINA LLM connector status
 * - Queue processor status
 *
 * @module routes/health
 */

import { Router } from 'express';
import { DB } from '../db';
import { mirrorRedis } from '../config/redis';
import { dinaLLMConnector } from '../integrations/DINALLMConnector';

const router = Router();

/**
 * Overall system health
 * GET /health
 */
router.get('/', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      components: {} as any
    };

    // Check database
    try {
      await DB.query('SELECT 1');
      health.components.database = { status: 'healthy' };
    } catch (error) {
      health.components.database = { status: 'unhealthy', error: String(error) };
      health.status = 'degraded';
    }

    // Check Redis
    try {
      const redisHealth = await mirrorRedis.getHealth();
      health.components.redis = redisHealth;
      if (redisHealth.status !== 'healthy') {
        health.status = 'degraded';
      }
    } catch (error) {
      health.components.redis = { status: 'unhealthy', error: String(error) };
      health.status = 'degraded';
    }

    // Return overall health
    res.status(health.status === 'healthy' ? 200 : 503).json(health);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Health check failed',
      error: String(error)
    });
  }
});

/**
 * Database health
 * GET /health/database
 */
router.get('/database', async (req, res) => {
  try {
    const startTime = Date.now();
    await DB.query('SELECT 1 as health');
    const latency = Date.now() - startTime;

    res.json({
      status: 'healthy',
      latency: `${latency}ms`
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: String(error)
    });
  }
});

/**
 * Redis health
 * GET /health/redis
 */
router.get('/redis', async (req, res) => {
  try {
    const health = await mirrorRedis.getHealth();
    res.status(health.status === 'healthy' ? 200 : 503).json(health);
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: String(error)
    });
  }
});

/**
 * DINA LLM Connector health
 * GET /health/dina
 */
router.get('/dina', async (req, res) => {
  try {
    const health = await dinaLLMConnector.getHealth();
    const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 503 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    res.status(503).json({
      status: 'error',
      message: 'Failed to check DINA health',
      error: String(error)
    });
  }
});

/**
 * Analysis queue health
 * GET /health/queue
 */
router.get('/queue', async (req, res) => {
  try {
    // Get queue statistics
    const [pendingRows] = await DB.query(`
      SELECT COUNT(*) as count
      FROM mirror_group_analysis_queue
      WHERE status = 'pending'
    `);

    const [processingRows] = await DB.query(`
      SELECT COUNT(*) as count
      FROM mirror_group_analysis_queue
      WHERE status = 'processing'
    `);

    const [failedRows] = await DB.query(`
      SELECT COUNT(*) as count, MAX(created_at) as last_failure
      FROM mirror_group_analysis_queue
      WHERE status = 'failed'
        AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `);

    const [completedRows] = await DB.query(`
      SELECT
        COUNT(*) as count,
        AVG(TIMESTAMPDIFF(SECOND, started_at, completed_at)) as avg_duration
      FROM mirror_group_analysis_queue
      WHERE status = 'completed'
        AND completed_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `);

    const pending = (pendingRows as any[])[0];
    const processing = (processingRows as any[])[0];
    const failed = (failedRows as any[])[0];
    const completed = (completedRows as any[])[0];

    const health = {
      status: 'healthy' as 'healthy' | 'degraded',
      queue: {
        pending: pending.count,
        processing: processing.count,
        failed_last_hour: failed.count,
        completed_last_hour: completed.count,
        avg_processing_time: completed.avg_duration ? Math.round(completed.avg_duration) + 's' : 'N/A'
      }
    };

    // Degraded if too many pending or recent failures
    if (pending.count > 50 || failed.count > 10) {
      health.status = 'degraded';
    }

    res.status(health.status === 'healthy' ? 200 : 503).json(health);
  } catch (error) {
    res.status(503).json({
      status: 'error',
      error: String(error)
    });
  }
});

export default router;
