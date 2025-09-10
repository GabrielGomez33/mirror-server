// controllers/intakeController.ts
// Hybrid intake data storage leveraging existing multipart system for binary files
// Following existing patterns from directoryController and storageController

import { RequestHandler } from 'express';
import crypto from 'crypto';
import { DB } from '../db';
import {
  writeToTier,
  readFromTier,
  createUserDirectories,
  DataAccessContext,
  TierType,
} from './directoryController';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// TYPES FOR INTAKE DATA WITH FILE REFERENCES
// ============================================================================

interface FileReference {
  filename: string;
  tier: TierType;
  size: number;
  mimetype: string;
  uploadedAt: string;
  originalname?: string;
}

interface VoiceFileReference extends FileReference {
  duration: number;
  deviceInfo?: {
    isMobile: boolean;
    platform: string;
    browser: string;
  };
}

interface IntakeDataStructure {
  userLoggedIn: boolean;
  name: string;

  // File references (uploaded via existing multipart system)
  photoFileRef?: FileReference;
  voiceFileRef?: VoiceFileReference;

  // Structured data (stored as JSON in tier3)
  faceAnalysis?: {
    detection: any;
    landmarks: any;
    unshiftedLandmarks: any;
    alignedRect: any;
    angle: {
      roll: number;
      pitch: number;
      yaw: number;
    };
    expressions: {
      neutral: number;
      happy: number;
      sad: number;
      angry: number;
      fearful: number;
      disgusted: number;
      surprised: number;
    };
  };

  progress?: {
    lastStep: string;
    completed: boolean;
    steps: Record<string, { completed: boolean; data: any }>;
  };

  voiceMetadata?: {
    mimeType: string;
    duration: number;
    size: number;
    deviceInfo: any;
  };

  iqResults?: {
    rawScore: number;
    totalQuestions: number;
    iqScore: number;
    category: string;
    strengths: string[];
    description: string;
  };
  iqAnswers?: Record<string, string>;

  astrologicalResult?: {
    western: any;
    chinese: any;
    african: any;
    numerology: any;
    synthesis: any;
  };

  personalityResult?: {
    big5Profile: {
      openness: number;
      conscientiousness: number;
      extraversion: number;
      agreeableness: number;
      neuroticism: number;
    };
    mbtiType: string;
    dominantTraits: string[];
    description: string;
  };
  personalityAnswers?: Record<string, any>;
}

interface IntakeStorageMetadata {
  intakeId: string;
  userId: string;
  submissionDate: Date;
  dataVersion: string;
  encryptionLevel: string;
  hasPhoto: boolean;
  hasVoice: boolean;
  fileReferences: {
    photo?: FileReference;
    voice?: VoiceFileReference;
  };
  dataIntegrity: {
    checksum: string;
    componentChecksums: Record<string, string>;
  };
  componentStructure: {
    mainFile: string;
    faceAnalysisFile?: string;
    voiceMetadataFile?: string;
    iqDataFile?: string;
    personalityDataFile?: string;
    astrologicalDataFile?: string;
  };
}

// ============================================================================
// CORE STORAGE LOGIC (HYBRID APPROACH)
// ============================================================================

export class IntakeDataManager {
  private static readonly TIER: TierType = 'tier3'; // Highest encryption for metadata
  private static readonly DATA_VERSION = '2.0.0';
  private static readonly BASE_FILENAME_PREFIX = 'intake_data';

  /**
   * Store intake data with file references (assumes binary files already uploaded)
   */
  static async storeIntakeData(
    userId: string,
    intakeData: IntakeDataStructure,
    context: DataAccessContext
  ): Promise<{ intakeId: string; storagePaths: string[] }> {
    const intakeId = uuidv4();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const storagePaths: string[] = [];

    // Ensure we always use a string for FS/object storage calls
    const uidStr = String(userId);

    try {
      console.log(
        `[IntakeController]: Starting hybrid intake data storage for user ${uidStr}, intake ID: ${intakeId}`
      );


      // 1. Store main intake data (core info + file references)
      const mainData = {
        intakeId,
        userId: uidStr,
        userLoggedIn: intakeData.userLoggedIn,
        name: intakeData.name,
        progress: intakeData.progress,
        submissionDate: new Date(),
        dataVersion: this.DATA_VERSION,
        // File references (not binary data)
        fileReferences: {
          photo: intakeData.photoFileRef,
          voice: intakeData.voiceFileRef,
        },
        // Component file mapping
        componentFiles: {
          faceAnalysis: intakeData.faceAnalysis
            ? `${this.BASE_FILENAME_PREFIX}_face_${intakeId}_${timestamp}.json`
            : null,
          voiceMetadata: intakeData.voiceMetadata
            ? `${this.BASE_FILENAME_PREFIX}_voice_meta_${intakeId}_${timestamp}.json`
            : null,
          iqData:
            intakeData.iqResults || intakeData.iqAnswers
              ? `${this.BASE_FILENAME_PREFIX}_iq_${intakeId}_${timestamp}.json`
              : null,
          personalityData:
            intakeData.personalityResult || intakeData.personalityAnswers
              ? `${this.BASE_FILENAME_PREFIX}_personality_${intakeId}_${timestamp}.json`
              : null,
          astrologicalData: intakeData.astrologicalResult
            ? `${this.BASE_FILENAME_PREFIX}_astrology_${intakeId}_${timestamp}.json`
            : null,
        },
      };

      const mainFilename = `${this.BASE_FILENAME_PREFIX}_main_${intakeId}_${timestamp}.json`;
      await writeToTier(uidStr, this.TIER, mainFilename, JSON.stringify(mainData, null, 2), {
        ...context,
        // do NOT override context.userId (it is a number). Only set reason.
        reason: 'intake_data_main_storage',
      });
      storagePaths.push(mainFilename);

      // 2. Store component data separately (structured metadata only)

      // Face analysis
      if (intakeData.faceAnalysis && mainData.componentFiles.faceAnalysis) {
        await writeToTier(
          uidStr,
          this.TIER,
          mainData.componentFiles.faceAnalysis,
          JSON.stringify(
            {
              intakeId,
              component: 'faceAnalysis',
              data: intakeData.faceAnalysis,
              relatedFiles: intakeData.photoFileRef ? [intakeData.photoFileRef] : [],
              timestamp: new Date(),
            },
            null,
            2
          ),
          { ...context, reason: 'intake_face_analysis_storage' }
        );
        storagePaths.push(mainData.componentFiles.faceAnalysis);
      }

      // Voice metadata (separate from voice file)
      if (intakeData.voiceMetadata && mainData.componentFiles.voiceMetadata) {
        await writeToTier(
          uidStr,
          this.TIER,
          mainData.componentFiles.voiceMetadata,
          JSON.stringify(
            {
              intakeId,
              component: 'voiceMetadata',
              data: intakeData.voiceMetadata,
              relatedFiles: intakeData.voiceFileRef ? [intakeData.voiceFileRef] : [],
              timestamp: new Date(),
            },
            null,
            2
          ),
          { ...context, reason: 'intake_voice_metadata_storage' }
        );
        storagePaths.push(mainData.componentFiles.voiceMetadata);
      }

      // IQ data
      if ((intakeData.iqResults || intakeData.iqAnswers) && mainData.componentFiles.iqData) {
        await writeToTier(
          uidStr,
          this.TIER,
          mainData.componentFiles.iqData,
          JSON.stringify(
            {
              intakeId,
              component: 'iqData',
              data: {
                iqResults: intakeData.iqResults,
                iqAnswers: intakeData.iqAnswers,
              },
              timestamp: new Date(),
            },
            null,
            2
          ),
          { ...context, reason: 'intake_iq_data_storage' }
        );
        storagePaths.push(mainData.componentFiles.iqData);
      }

      // Personality data
      if (
        (intakeData.personalityResult || intakeData.personalityAnswers) &&
        mainData.componentFiles.personalityData
      ) {
        await writeToTier(
          uidStr,
          this.TIER,
          mainData.componentFiles.personalityData,
          JSON.stringify(
            {
              intakeId,
              component: 'personalityData',
              data: {
                personalityResult: intakeData.personalityResult,
                personalityAnswers: intakeData.personalityAnswers,
              },
              timestamp: new Date(),
            },
            null,
            2
          ),
          { ...context, reason: 'intake_personality_data_storage' }
        );
        storagePaths.push(mainData.componentFiles.personalityData);
      }

      // Astrological data
      if (intakeData.astrologicalResult && mainData.componentFiles.astrologicalData) {
        await writeToTier(
          uidStr,
          this.TIER,
          mainData.componentFiles.astrologicalData,
          JSON.stringify(
            {
              intakeId,
              component: 'astrologicalData',
              data: intakeData.astrologicalResult,
              timestamp: new Date(),
            },
            null,
            2
          ),
          { ...context, reason: 'intake_astrological_data_storage' }
        );
        storagePaths.push(mainData.componentFiles.astrologicalData);
      }

      // 3. Store metadata record in database for quick access
      await this.storeIntakeMetadata(uidStr, intakeId, mainData, storagePaths);

      console.log(
        `[IntakeController]: Successfully stored intake data for user ${uidStr}, files: ${storagePaths.length}`
      );

      return { intakeId, storagePaths };
    } catch (error) {
      console.error(
        `[IntakeController ERROR]: Failed to store intake data for user ${userId}:`,
        error
      );
      throw new Error(`Intake data storage failed: ${(error as Error).message}`);
    }
  }

  /**
   * Retrieve complete intake data including file references
   */
  static async retrieveIntakeData(
    userId: string,
    intakeId: string,
    context: DataAccessContext,
    includeFileContents: boolean = false
  ): Promise<{
    intakeData: IntakeDataStructure;
    fileReferences: { photo?: FileReference; voice?: VoiceFileReference };
    fileContents?: { photo?: Buffer; voice?: Buffer };
  } | null> {
    const uidStr = String(userId);

    try {
      console.log(
        `[IntakeController]: Retrieving intake data for user ${uidStr}, intake ID: ${intakeId}`
      );

      // 1. Get metadata from database
      const metadata = await this.getIntakeMetadata(uidStr, intakeId);
      if (!metadata) {
        console.log(`[IntakeController]: No metadata found for intake ${intakeId}`);
        return null;
      }

      // 2. Retrieve main data file
      const mainDataStr = await readFromTier(uidStr, this.TIER, metadata.componentStructure.mainFile, {
        ...context,
        reason: 'intake_data_main_retrieval',
      });

      if (!mainDataStr) {
        console.log(`[IntakeController]: Main data file not found for intake ${intakeId}`);
        return null;
      }

      const mainData = JSON.parse(mainDataStr as unknown as string);
      const intakeData: Partial<IntakeDataStructure> = {
        userLoggedIn: mainData.userLoggedIn,
        name: mainData.name,
        progress: mainData.progress,
        photoFileRef: mainData.fileReferences?.photo,
        voiceFileRef: mainData.fileReferences?.voice,
      };

      // 3. Retrieve component data files
      const components = [
        { key: 'faceAnalysis', file: metadata.componentStructure.faceAnalysisFile },
        { key: 'voiceMetadata', file: metadata.componentStructure.voiceMetadataFile },
        { key: 'iqData', file: metadata.componentStructure.iqDataFile },
        { key: 'personalityData', file: metadata.componentStructure.personalityDataFile },
        { key: 'astrologicalData', file: metadata.componentStructure.astrologicalDataFile },
      ] as const;

      for (const component of components) {
        if (component.file) {
          try {
            const componentDataStr = await readFromTier(uidStr, this.TIER, component.file, {
              ...context,
              reason: `intake_component_${component.key}_retrieval`,
            });
            if (componentDataStr) {
              const componentData = JSON.parse(componentDataStr as unknown as string);

              if (component.key === 'iqData') {
                intakeData.iqResults = componentData.data.iqResults;
                intakeData.iqAnswers = componentData.data.iqAnswers;
              } else if (component.key === 'personalityData') {
                intakeData.personalityResult = componentData.data.personalityResult;
                intakeData.personalityAnswers = componentData.data.personalityAnswers;
              } else if (component.key === 'voiceMetadata') {
                intakeData.voiceMetadata = componentData.data;
              } else {
                (intakeData as any)[component.key] = componentData.data;
              }
            }
          } catch (error) {
            console.warn(`[IntakeController]: Could not retrieve ${component.key}: ${error}`);
          }
        }
      }

      // 4. Optionally retrieve binary file contents via existing system
      const fileContents: { photo?: Buffer; voice?: Buffer } = {};
      if (includeFileContents) {
        if (intakeData.photoFileRef) {
          try {
            const photoData = await readFromTier(
              uidStr,
              intakeData.photoFileRef.tier,
              intakeData.photoFileRef.filename,
              { ...context, reason: 'intake_photo_file_retrieval' }
            );
            if (photoData) {
              fileContents.photo = Buffer.isBuffer(photoData)
                ? (photoData as Buffer)
                : Buffer.from(photoData as unknown as string);
            }
          } catch (error) {
            console.warn(`[IntakeController]: Could not retrieve photo file: ${error}`);
          }
        }

        if (intakeData.voiceFileRef) {
          try {
            const voiceData = await readFromTier(
              uidStr,
              intakeData.voiceFileRef.tier,
              intakeData.voiceFileRef.filename,
              { ...context, reason: 'intake_voice_file_retrieval' }
            );
            if (voiceData) {
              fileContents.voice = Buffer.isBuffer(voiceData)
                ? (voiceData as Buffer)
                : Buffer.from(voiceData as unknown as string);
            }
          } catch (error) {
            console.warn(`[IntakeController]: Could not retrieve voice file: ${error}`);
          }
        }
      }

      console.log(`[IntakeController]: Successfully retrieved intake data for user ${uidStr}`);

      return {
        intakeData: intakeData as IntakeDataStructure,
        fileReferences: {
          photo: intakeData.photoFileRef,
          voice: intakeData.voiceFileRef,
        },
        ...(includeFileContents && { fileContents }),
      };
    } catch (error) {
      console.error(
        `[IntakeController ERROR]: Failed to retrieve intake data for user ${uidStr}:`,
        error
      );
      throw new Error(`Intake data retrieval failed: ${(error as Error).message}`);
    }
  }

  /**
   * List all intake submissions for a user with file reference summary
   */
  static async listUserIntakes(userId: string): Promise<IntakeStorageMetadata[]> {
    try {
      const [rows] = await DB.query(
        `
        SELECT 
          intake_id,
          user_id,
          submission_date,
          data_version,
          encryption_level,
          has_photo,
          has_voice,
          file_references,
          component_structure,
          data_integrity
        FROM intake_metadata 
        WHERE user_id = ? 
        ORDER BY submission_date DESC
      `,
        [String(userId)]
      );

      return (rows as any[]).map((row) => ({
        intakeId: row.intake_id,
        userId: row.user_id,
        submissionDate: row.submission_date,
        dataVersion: row.data_version,
        encryptionLevel: row.encryption_level,
        hasPhoto: Boolean(row.has_photo),
        hasVoice: Boolean(row.has_voice),
        fileReferences: typeof row.file_references === 'string' ? JSON.parse(row.file_references || '{}') : (row.file_references || {}),
        componentStructure: typeof row.component_structure === 'string' ? JSON.parse(row.component_structure) : (row.component_structure || {}),
        dataIntegrity: typeof row.data_integrity === 'string' ? JSON.parse(row.data_integrity) : (row.data_integrity || {}),
      }));
    } catch (error) {
      console.error(`[IntakeController ERROR]: Failed to list intakes for user ${userId}:`, error);
      throw new Error(`Failed to list user intakes: ${(error as Error).message}`);
    }
  }

  /**
   * Get the latest intake data for a user
   */
  static async getLatestIntakeData(
    userId: string,
    context: DataAccessContext,
    includeFileContents: boolean = false
  ): Promise<{
    intakeData: IntakeDataStructure;
    fileReferences: { photo?: FileReference; voice?: VoiceFileReference };
    fileContents?: { photo?: Buffer; voice?: Buffer };
  } | null> {
    try {
      const intakes = await this.listUserIntakes(userId);
      if (intakes.length === 0) {
        return null;
      }

      const latestIntake = intakes[0];
      return await this.retrieveIntakeData(
        userId,
        latestIntake.intakeId,
        context,
        includeFileContents
      );
    } catch (error) {
      console.error(
        `[IntakeController ERROR]: Failed to get latest intake for user ${userId}:`,
        error
      );
      throw new Error(`Failed to get latest intake: ${(error as Error).message}`);
    }
  }

  // ========================================================================
  // PRIVATE HELPER METHODS
  // ========================================================================

  private static async storeIntakeMetadata(
    userId: string,
    intakeId: string,
    mainData: any,
    storagePaths: string[]
  ): Promise<void> {
    const metadata: IntakeStorageMetadata = {
      intakeId,
      userId,
      submissionDate: new Date(),
      dataVersion: this.DATA_VERSION,
      encryptionLevel: this.TIER,
      hasPhoto: Boolean(mainData.fileReferences?.photo),
      hasVoice: Boolean(mainData.fileReferences?.voice),
      fileReferences: mainData.fileReferences || {},
      dataIntegrity: {
        checksum: crypto.createHash('sha256').update(JSON.stringify(mainData)).digest('hex'),
        componentChecksums: {},
      },
      componentStructure: {
        mainFile: storagePaths[0] || '',
        faceAnalysisFile: mainData.componentFiles.faceAnalysis || '',
        voiceMetadataFile: mainData.componentFiles.voiceMetadata || '',
        iqDataFile: mainData.componentFiles.iqData || '',
        personalityDataFile: mainData.componentFiles.personalityData || '',
        astrologicalDataFile: mainData.componentFiles.astrologicalData || '',
      },
    };

    // Ensure intake_metadata table exists with file reference support
    await DB.query(`
      CREATE TABLE IF NOT EXISTS intake_metadata (
        id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
        intake_id VARCHAR(36) NOT NULL UNIQUE,
        user_id VARCHAR(64) NOT NULL,
        submission_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        data_version VARCHAR(16) NOT NULL,
        encryption_level VARCHAR(16) NOT NULL,
        has_photo BOOLEAN DEFAULT FALSE,
        has_voice BOOLEAN DEFAULT FALSE,
        file_references JSON,
        component_structure JSON NOT NULL,
        data_integrity JSON NOT NULL,
        INDEX idx_user_submissions (user_id, submission_date),
        INDEX idx_intake_lookup (intake_id),
        INDEX idx_submission_date (submission_date),
        INDEX idx_has_files (has_photo, has_voice)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await DB.query(
      `
      INSERT INTO intake_metadata (
        intake_id, user_id, submission_date, data_version, 
        encryption_level, has_photo, has_voice, file_references,
        component_structure, data_integrity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        intakeId,
        userId,
        metadata.submissionDate,
        metadata.dataVersion,
        metadata.encryptionLevel,
        metadata.hasPhoto,
        metadata.hasVoice,
        JSON.stringify(metadata.fileReferences),
        JSON.stringify(metadata.componentStructure),
        JSON.stringify(metadata.dataIntegrity),
      ]
    );
  }

  private static async getIntakeMetadata(
    userId: string,
    intakeId: string
  ): Promise<IntakeStorageMetadata | null> {
    const [rows] = await DB.query(
      `
      SELECT * FROM intake_metadata 
      WHERE user_id = ? AND intake_id = ?
    `,
      [String(userId), String(intakeId)]
    );

    if ((rows as any[]).length === 0) {
      return null;
    }

    const row = (rows as any[])[0];
    return {
      intakeId: row.intake_id,
      userId: row.user_id,
      submissionDate: row.submission_date,
      dataVersion: row.data_version,
      encryptionLevel: row.encryption_level,
      hasPhoto: Boolean(row.has_photo),
      hasVoice: Boolean(row.has_voice),
	  fileReferences: typeof row.file_references === 'string' ? JSON.parse(row.file_references || '{}') : (row.file_references || {}),
	  componentStructure: typeof row.component_structure === 'string' ? JSON.parse(row.component_structure) : (row.component_structure || {}),
	  dataIntegrity: typeof row.data_integrity === 'string' ? JSON.parse(row.data_integrity) : (row.data_integrity || {}),
    };
  }
}

// ============================================================================
// REQUEST HANDLERS FOLLOWING EXISTING PATTERNS
// ============================================================================

/**
 * Store intake data with file references (binary files should be uploaded first)
 */
export const storeIntakeDataHandler: RequestHandler = async (req, res) => {
  try {
    const { userId, intakeData } = req.body as { userId?: string | number; intakeData?: IntakeDataStructure };

    if (!userId || !intakeData) {
      res.status(400).json({
        success: false,
        error: 'userId and intakeData are required',
      });
      return;
    }

    // Boundary: string for storage layer, number for DataAccessContext
    const uidStr = String(userId);
    const uidNum = Number(userId);
    const sessionId = (req.headers['x-session-id'] as string) || '';

    const context: DataAccessContext = {
      userId: Number.isFinite(uidNum) ? uidNum : 0,
      accessedBy: Number.isFinite(uidNum) ? uidNum : 0,
      sessionId,
      ipAddress: (req.ip || (req.connection as any)?.remoteAddress || '') as string,
      userAgent: req.headers['user-agent'] || '',
      reason: 'intake_data_submission',
    };

    const result = await IntakeDataManager.storeIntakeData(uidStr, intakeData, context);

    res.json({
      success: true,
      intakeId: result.intakeId,
      storedFiles: result.storagePaths.length,
      hasPhoto: Boolean(intakeData.photoFileRef),
      hasVoice: Boolean(intakeData.voiceFileRef),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[storeIntakeDataHandler ERROR]:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to store intake data',
      details: (error as Error).message,
    });
  }
};

/**
 * Retrieve intake data with optional file contents
 */
export const retrieveIntakeDataHandler: RequestHandler = async (req, res) => {
  try {
    const { userId, intakeId } = req.params as { userId?: string; intakeId?: string };
    const includeFiles = req.query.includeFiles === 'true';

    if (!userId || !intakeId) {
      res.status(400).json({
        success: false,
        error: 'userId and intakeId are required',
      });
      return;
    }

    const uidNum = Number(userId);
    const sessionId = (req.headers['x-session-id'] as string) || '';

    const context: DataAccessContext = {
      userId: Number.isFinite(uidNum) ? uidNum : 0,
      accessedBy: Number.isFinite(uidNum) ? uidNum : 0,
      sessionId,
      ipAddress: (req.ip || (req.connection as any)?.remoteAddress || '') as string,
      userAgent: req.headers['user-agent'] || '',
      reason: 'intake_data_retrieval',
    };

    const result = await IntakeDataManager.retrieveIntakeData(
      String(userId),
      String(intakeId),
      context,
      includeFiles
    );

    if (!result) {
      res.status(404).json({
        success: false,
        error: 'Intake data not found',
      });
      return;
    }

    res.json({
      success: true,
      intakeData: result.intakeData,
      fileReferences: result.fileReferences,
      ...(includeFiles &&
        result.fileContents && {
          fileContents: {
            photo: result.fileContents.photo?.toString('base64'),
            voice: result.fileContents.voice?.toString('base64'),
          },
        }),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[retrieveIntakeDataHandler ERROR]:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve intake data',
      details: (error as Error).message,
    });
  }
};

/**
 * List user intakes with file reference summary
 */
export const listUserIntakesHandler: RequestHandler = async (req, res) => {
  try {
    const { userId } = req.params as { userId?: string };

    if (!userId) {
      res.status(400).json({
        success: false,
        error: 'userId is required',
      });
      return;
    }

    const intakes = await IntakeDataManager.listUserIntakes(String(userId));

    res.json({
      success: true,
      intakes,
      count: intakes.length,
      summary: {
        total: intakes.length,
        withPhotos: intakes.filter((i) => i.hasPhoto).length,
        withVoice: intakes.filter((i) => i.hasVoice).length,
        complete: intakes.filter((i) => i.hasPhoto && i.hasVoice).length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[listUserIntakesHandler ERROR]:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list user intakes',
      details: (error as Error).message,
    });
  }
};

/**
 * Get latest intake data with optional file contents
 */
export const getLatestIntakeHandler: RequestHandler = async (req, res) => {
  try {
    const { userId } = req.params as { userId?: string };
    const includeFiles = req.query.includeFiles === 'true';

    if (!userId) {
      res.status(400).json({
        success: false,
        error: 'userId is required',
      });
      return;
    }

    const uidNum = Number(userId);
    const sessionId = (req.headers['x-session-id'] as string) || '';

    const context: DataAccessContext = {
      userId: Number.isFinite(uidNum) ? uidNum : 0,
      accessedBy: Number.isFinite(uidNum) ? uidNum : 0,
      sessionId,
      ipAddress: (req.ip || (req.connection as any)?.remoteAddress || '') as string,
      userAgent: req.headers['user-agent'] || '',
      reason: 'latest_intake_retrieval',
    };

    const result = await IntakeDataManager.getLatestIntakeData(
      String(userId),
      context,
      includeFiles
    );

    if (!result) {
      res.status(404).json({
        success: false,
        error: 'No intake data found for user',
      });
      return;
    }

    res.json({
      success: true,
      intakeData: result.intakeData,
      fileReferences: result.fileReferences,
      ...(includeFiles &&
        result.fileContents && {
          fileContents: {
            photo: result.fileContents.photo?.toString('base64'),
            voice: result.fileContents.voice?.toString('base64'),
          },
        }),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[getLatestIntakeHandler ERROR]:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get latest intake data',
      details: (error as Error).message,
    });
  }
};
