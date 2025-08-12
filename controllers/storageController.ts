// controllers/storageController.ts
// Following existing pattern from authController and userController

import { RequestHandler } from 'express';
import { 
  createUserDirectories, 
  writeToTier, 
  readFromTier, 
  listTierFiles,
  TierType
} from './directoryController';

// Create user directories endpoint
export const createDirectoriesHandler: RequestHandler = async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      res.status(400).json({ 
        success: false, 
        error: 'userId is required' 
      });
      return;
    }

    await createUserDirectories(userId);
    
    res.json({
      success: true,
      message: `Directories created for user ${userId}`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[STORAGE] Directory creation failed:', error);
    res.status(500).json({
      success: false,
      error: 'Directory creation failed',
      details: (error as Error).message
    });
  }
};

// Store data endpoint
export const storeDataHandler: RequestHandler = async (req, res) => {
  try {
    const { userId, tier, filename, data, metadata } = req.body;
    
    if (!userId || !tier || !filename || !data) {
      res.status(400).json({ 
        success: false, 
        error: 'userId, tier, filename, and data are required' 
      });
      return;
    }

    const dataBuffer = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
    const result = await writeToTier(userId, tier as TierType, filename, dataBuffer, metadata);
    
    res.json({
      success: true,
      fileId: filename,
      result,
      size: dataBuffer.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[STORAGE] Data storage failed:', error);
    res.status(500).json({
      success: false,
      error: 'Data storage failed',
      details: (error as Error).message
    });
  }
};

// Retrieve data endpoint
export const retrieveDataHandler: RequestHandler = async (req, res) => {
  try {
    const { userId, tier, filename } = req.params;
    
    const data = await readFromTier(userId, tier as TierType, filename);
    
    res.json({
      success: true,
      fileId: filename,
      data: data.toString(),
      retrieved: new Date().toISOString()
    });
  } catch (error) {
    console.error('[STORAGE] Data retrieval failed:', error);
    res.status(500).json({
      success: false,
      error: 'Data retrieval failed',
      details: (error as Error).message
    });
  }
};

// List files endpoint
export const listFilesHandler: RequestHandler = async (req, res) => {
  try {
    const { userId, tier } = req.params;
    
    const files = await listTierFiles(userId, tier as TierType);
    
    res.json({
      success: true,
      userId,
      tier,
      files,
      count: files.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[STORAGE] File listing failed:', error);
    res.status(500).json({
      success: false,
      error: 'File listing failed',
      details: (error as Error).message
    });
  }
};
