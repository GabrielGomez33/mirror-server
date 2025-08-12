// controllers/debugController.ts
// Following existing pattern from authController and userController

import { RequestHandler } from 'express';
import { DB } from '../db';
import fs from 'fs/promises';
import { listTierFiles, TierType } from './directoryController';

// System status endpoint
export const getSystemStatusHandler: RequestHandler = async (req, res) => {
  try {
    const status = {
      server: 'mirror-server',
      timestamp: new Date().toISOString(),
      database_connected: !!DB,
      storage_path: process.env.MIRRORSTORAGE,
      storage_accessible: false,
      ssl_configured: !!(process.env.TUGRRPRIV && process.env.TUGRRCERT)
    };

    // Test storage access
    if (process.env.MIRRORSTORAGE) {
      try {
        await fs.access(process.env.MIRRORSTORAGE);
        status.storage_accessible = true;
      } catch {
        status.storage_accessible = false;
      }
    }

    res.json(status);
  } catch (error) {
    res.status(500).json({
      error: 'Status check failed',
      details: (error as Error).message
    });
  }
};

// User storage status endpoint
export const getUserStorageStatusHandler: RequestHandler = async (req, res) => {
  try {
    const { userId } = req.params;
    
    const status = {
      userId,
      directories: {} as any
    };

    // Use existing listTierFiles function to check each tier
    for (const tier of ['tier1', 'tier2', 'tier3']) {
      try {
        const files = await listTierFiles(userId, tier as TierType);
        status.directories[tier] = {
          accessible: true,
          fileCount: files.length,
          files: files.slice(0, 5) // Only show first 5 files
        };
      } catch (error) {
        status.directories[tier] = {
          accessible: false,
          error: (error as Error).message
        };
      }
    }

    res.json(status);
  } catch (error) {
    res.status(500).json({
      error: 'User storage check failed',
      details: (error as Error).message
    });
  }
};
