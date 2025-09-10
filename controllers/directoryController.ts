// controllers/directoryController.ts
// Enhanced directory controller with tiered security and clean separation of concerns
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { DB } from '../db';
import dotenv from 'dotenv';
import { 
  loadUserKeys, 
  encryptBuffer, 
  decryptBuffer, 
  hashData, 
  verifyDataIntegrity 
} from './encryptionController';

// Types for enhanced functionality
interface FileMetadata {
  filename: string;
  size: number;
  mimeType?: string;
  checksum: string;
  encrypted: boolean;
  tier: string;
  createdAt: Date;
  lastAccessed?: Date;
  version: string;
}

interface DataAccessContext {
  userId: number;
  accessedBy: number;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
  reason?: string;
}

dotenv.config;

// Constants
const TIERS = ['tier1', 'tier2', 'tier3'] as const;
const SUB_DIRS = ['keys', 'uploads', 'meta', 'tmp'] as const;
const HASH_ALGORITHM = 'sha256';

type TierType = typeof TIERS[number];
type SubDirType = typeof SUB_DIRS[number];

// Enhanced Directory Controller Class
class DirectoryController {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = process.env.MIRRORUSERSTORAGE! ;
  }

  // ===== DIRECTORY MANAGEMENT =====

  /**
   * Create complete directory structure for a new user
   */
  async createUserDirectories(userId: string): Promise<void> {
    console.log(`[DirectoryController]: Creating directories for user ${userId} at base path: ${this.basePath}`);
    
    try {
      const userRootPath = path.join(this.basePath, userId);
      
      // Create user root directory with restricted permissions
      await fs.mkdir(userRootPath, { recursive: true, mode: 0o750 });
      console.log(`[DirectoryController]: Created user root directory: ${userRootPath}`);
      
      // Create tier structure
      for (const tier of TIERS) {
        const tierPath = path.join(userRootPath, tier);
        await fs.mkdir(tierPath, { recursive: true, mode: 0o750 });
        
        // Create subdirectories within each tier
        for (const subDir of SUB_DIRS) {
          const fullPath = path.join(tierPath, subDir);
          await fs.mkdir(fullPath, { recursive: true, mode: 0o750 });
          console.log(`[DirectoryController]: Created subdirectory: ${fullPath}`);
        }
        
        // Create tier-specific metadata file
        await this.createTierMetadata(userId, tier);
      }
      
      // Log directory creation in database
      await this.logDataAccess({
        userId: parseInt(userId),
        accessedBy: parseInt(userId),
        tier: 'tier1',
        filePath: userRootPath,
        accessType: 'write',
        accessReason: 'directory_creation',
        success: true
      });
      
      console.log(`[DirectoryController]: All directories created successfully for user ${userId}`);
      
    } catch (error) {
      console.error(`[DirectoryController ERROR]: Failed to create directories for user ${userId}:`, error);
      
      // Log failed directory creation
      await this.logDataAccess({
        userId: parseInt(userId),
        accessedBy: parseInt(userId),
        tier: 'tier1',
        filePath: path.join(this.basePath, userId),
        accessType: 'write',
        accessReason: 'directory_creation',
        success: false,
        errorMessage: (error as Error).message
      });
      
      throw new Error(`Failed to create user directories: ${(error as Error).message}`);
    }
  }

  /**
   * Delete all user directories and data
   */
  async deleteUserDirectories(userId: string, context?: DataAccessContext): Promise<void> {
    const userPath = path.join(this.basePath, userId);
    
    try {
      // Log deletion attempt
      if (context) {
        await this.logDataAccess({
          userId: context.userId,
          accessedBy: context.accessedBy,
          tier: 'tier1',
          filePath: userPath,
          accessType: 'delete',
          accessReason: context.reason || 'user_deletion',
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          sessionId: context.sessionId,
          success: true
        });
      }
      
      // Securely delete directory contents
      await this.secureDeleteDirectory(userPath);
      
      console.log(`[DirectoryController]: Successfully deleted user directories: ${userPath}`);
      
    } catch (error) {
      console.error(`[DirectoryController ERROR]: Failed to delete user directories ${userPath}:`, error);
      
      if (context) {
        await this.logDataAccess({
          userId: context.userId,
          accessedBy: context.accessedBy,
          tier: 'tier1',
          filePath: userPath,
          accessType: 'delete',
          accessReason: context.reason || 'user_deletion',
          success: false,
          errorMessage: (error as Error).message
        });
      }
      
      throw new Error(`Failed to delete user directories ${userPath}: ${(error as Error).message}`);
    }
  }

  // ===== TIERED DATA OPERATIONS =====

  /**
   * Write data to specified tier with appropriate security measures
   */
  async writeToTier(
    userId: string, 
    tier: TierType, 
    filename: string, 
    data: Buffer | string, 
    context?: DataAccessContext
  ): Promise<void> {
    try {
      const filePath = this.getTierFilePath(userId, tier, filename);
      
      // Ensure directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o750 });
      
      let finalData: Buffer;
      let encrypted = false;
      
      // Convert string to buffer if needed
      if (typeof data === 'string') {
        finalData = Buffer.from(data, 'utf8');
      } else {
        finalData = data;
      }
      
      // Encrypt data for tier2 and tier3 using encryptionController
      if (tier === 'tier2' || tier === 'tier3') {
        const userKeys = await loadUserKeys(userId, this.basePath);
        finalData = encryptBuffer(finalData, userKeys.aesKey);
        encrypted = true;
      }
      
      // Write file with appropriate permissions
      const fileMode = tier === 'tier1' ? 0o644 : 0o600; // More restrictive for sensitive tiers
      await fs.writeFile(filePath, finalData, { mode: fileMode });
      
      // Calculate checksum for integrity verification
      const checksum = hashData(finalData);
      
      // Create and store metadata
      const metadata: FileMetadata = {
        filename,
        size: finalData.length,
        checksum,
        encrypted,
        tier,
        createdAt: new Date(),
        version: '1.0'
      };
      
      await this.writeMetadata(userId, tier, filename, metadata);
      
      // Log data access
      if (context) {
        await this.logDataAccess({
          userId: context.userId,
          accessedBy: context.accessedBy,
          tier,
          filePath,
          accessType: 'write',
          accessReason: context.reason,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          sessionId: context.sessionId,
          success: true
        });
      }
      
      console.log(`[DirectoryController]: Successfully wrote ${encrypted ? 'encrypted' : 'plain'} file to ${tier}: ${filePath}`);
      
    } catch (error) {
      console.error(`[DirectoryController ERROR]: Failed to write to ${tier}:`, error);
      
      if (context) {
        await this.logDataAccess({
          userId: context.userId,
          accessedBy: context.accessedBy,
          tier,
          filePath: this.getTierFilePath(userId, tier, filename),
          accessType: 'write',
          accessReason: context.reason,
          success: false,
          errorMessage: (error as Error).message
        });
      }
      
      throw new Error(`Failed to write to ${tier}: ${(error as Error).message}`);
    }
  }

  /**
   * Read data from specified tier with decryption if needed
   */
  async readFromTier(
    userId: string, 
    tier: TierType, 
    filename: string, 
    context?: DataAccessContext
  ): Promise<Buffer> {
    try {
      const filePath = this.getTierFilePath(userId, tier, filename);
      
      // Verify file exists
      try {
        await fs.access(filePath);
      } catch {
        throw new Error(`File not found: ${filename}`);
      }
      
      // Read file data
      let data = await fs.readFile(filePath);
      
      // Get metadata to check if file is encrypted
      const metadata = await this.readMetadata(userId, tier, filename);
      
      // Verify file integrity
      const currentChecksum = hashData(data);
      if (!verifyDataIntegrity(data, metadata.checksum)) {
        throw new Error(`File integrity check failed for ${filename}`);
      }
      
      // Decrypt if necessary using encryptionController
      if (metadata.encrypted) {
        const userKeys = await loadUserKeys(userId, this.basePath);
        data = decryptBuffer(data, userKeys.aesKey);
      }
      
      // Update last accessed time
      metadata.lastAccessed = new Date();
      await this.writeMetadata(userId, tier, filename, metadata);
      
      // Log data access
      if (context) {
        await this.logDataAccess({
          userId: context.userId,
          accessedBy: context.accessedBy,
          tier,
          filePath,
          accessType: 'read',
          accessReason: context.reason,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          sessionId: context.sessionId,
          success: true
        });
      }
      
      console.log(`[DirectoryController]: Successfully read ${metadata.encrypted ? 'encrypted' : 'plain'} file from ${tier}: ${filename}`);
      return data;
      
    } catch (error) {
      console.error(`[DirectoryController ERROR]: Failed to read from ${tier}:`, error);
      
      if (context) {
        await this.logDataAccess({
          userId: context.userId,
          accessedBy: context.accessedBy,
          tier,
          filePath: this.getTierFilePath(userId, tier, filename),
          accessType: 'read',
          accessReason: context.reason,
          success: false,
          errorMessage: (error as Error).message
        });
      }
      
      throw new Error(`Failed to read from ${tier}: ${(error as Error).message}`);
    }
  }

  /**
   * Delete file from specified tier
   */
  async deleteFromTier(
    userId: string, 
    tier: TierType, 
    filename: string, 
    context?: DataAccessContext
  ): Promise<void> {
    try {
      const filePath = this.getTierFilePath(userId, tier, filename);
      
      // Secure deletion for sensitive tiers
      if (tier === 'tier2' || tier === 'tier3') {
        await this.secureDeleteFile(filePath);
      } else {
        await fs.unlink(filePath);
      }
      
      // Delete metadata
      await this.deleteMetadata(userId, tier, filename);
      
      // Log deletion
      if (context) {
        await this.logDataAccess({
          userId: context.userId,
          accessedBy: context.accessedBy,
          tier,
          filePath,
          accessType: 'delete',
          accessReason: context.reason,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          sessionId: context.sessionId,
          success: true
        });
      }
      
      console.log(`[DirectoryController]: Successfully deleted file from ${tier}: ${filename}`);
      
    } catch (error) {
      console.error(`[DirectoryController ERROR]: Failed to delete from ${tier}:`, error);
      
      if (context) {
        await this.logDataAccess({
          userId: context.userId,
          accessedBy: context.accessedBy,
          tier,
          filePath: this.getTierFilePath(userId, tier, filename),
          accessType: 'delete',
          accessReason: context.reason,
          success: false,
          errorMessage: (error as Error).message
        });
      }
      
      throw new Error(`Failed to delete from ${tier}: ${(error as Error).message}`);
    }
  }

  /**
   * List files in a specific tier
   */
  async listTierFiles(userId: string, tier: TierType): Promise<string[]> {
    try {
      const tierPath = path.join(this.basePath, userId, tier, 'uploads');
      const files = await fs.readdir(tierPath);
      return files.filter(file => !file.startsWith('.') && file !== 'metadata');
    } catch (error) {
      console.error(`[DirectoryController ERROR]: Failed to list ${tier} files:`, error);
      return [];
    }
  }

  // ===== METADATA OPERATIONS =====

  /**
   * Write metadata for a file
   */
  private async writeMetadata(userId: string, tier: TierType, filename: string, metadata: FileMetadata): Promise<void> {
    const metadataPath = path.join(this.basePath, userId, tier, 'meta', `${filename}.json`);
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });
  }

  /**
   * Read metadata for a file
   */
  private async readMetadata(userId: string, tier: TierType, filename: string): Promise<FileMetadata> {
    const metadataPath = path.join(this.basePath, userId, tier, 'meta', `${filename}.json`);
    const data = await fs.readFile(metadataPath, 'utf8');
    return JSON.parse(data);
  }

  /**
   * Delete metadata for a file
   */
  private async deleteMetadata(userId: string, tier: TierType, filename: string): Promise<void> {
    const metadataPath = path.join(this.basePath, userId, tier, 'meta', `${filename}.json`);
    try {
      await fs.unlink(metadataPath);
    } catch (error) {
      // Ignore if metadata file doesn't exist
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Create tier-specific metadata file
   */
  private async createTierMetadata(userId: string, tier: TierType): Promise<void> {
    const tierMetadata = {
      tier,
      userId,
      createdAt: new Date().toISOString(),
      version: '1.0',
      encryptionEnabled: tier !== 'tier1',
      maxFileSize: tier === 'tier1' ? '10MB' : tier === 'tier2' ? '50MB' : '100MB'
    };
    
    const metadataPath = path.join(this.basePath, userId, tier, 'meta', 'tier.json');
    await fs.writeFile(metadataPath, JSON.stringify(tierMetadata, null, 2), { mode: 0o600 });
  }

  // ===== UTILITY FUNCTIONS =====

  /**
   * Get full file path for tier-based storage
   */
  private getTierFilePath(userId: string, tier: TierType, filename: string): string {
    return path.join(this.basePath, userId, tier, 'uploads', filename);
  }

  /**
   * Secure file deletion (overwrite before deletion)
   */
  private async secureDeleteFile(filePath: string): Promise<void> {
    try {
      const stats = await fs.stat(filePath);
      const fileSize = stats.size;
      
      // Overwrite file with random data multiple times
      const randomData = crypto.randomBytes(fileSize);
      await fs.writeFile(filePath, randomData);
      
      // Overwrite with zeros
      const zeroData = Buffer.alloc(fileSize, 0);
      await fs.writeFile(filePath, zeroData);
      
      // Finally delete the file
      await fs.unlink(filePath);
      
    } catch (error) {
      // If secure deletion fails, still try regular deletion
      await fs.unlink(filePath);
    }
  }

  /**
   * Secure directory deletion
   */
  private async secureDeleteDirectory(dirPath: string): Promise<void> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          await this.secureDeleteDirectory(fullPath);
        } else {
          await this.secureDeleteFile(fullPath);
        }
      }
      
      await fs.rmdir(dirPath);
      
    } catch (error) {
      // Fallback to regular deletion
      await fs.rm(dirPath, { recursive: true, force: true });
    }
  }

  /**
   * Log data access to database
   */
  private async logDataAccess(logData: {
    userId: number;
    accessedBy: number;
    tier: string;
    filePath: string;
    accessType: 'read' | 'write' | 'delete';
    accessReason?: string;
    ipAddress?: string;
    userAgent?: string;
    sessionId?: string;
    success: boolean;
    errorMessage?: string;
  }): Promise<void> {
    try {
      await DB.query(`
        INSERT INTO data_access_log (
          user_id, accessed_by, data_tier, file_path, access_type, 
          access_reason, ip_address, user_agent, session_id, success, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        logData.userId,
        logData.accessedBy,
        logData.tier,
        logData.filePath,
        logData.accessType,
        logData.accessReason || null,
        logData.ipAddress || null,
        logData.userAgent || null,
        logData.sessionId || null,
        logData.success,
        logData.errorMessage || null
      ]);
    } catch (error) {
      console.error('[DirectoryController]: Failed to log data access:', error);
      // Don't throw here as we don't want logging failures to break file operations
    }
  }
}

// ===== EXPORTED FUNCTIONS FOR BACKWARD COMPATIBILITY =====

const directoryController = new DirectoryController();

export async function createUserDirectories(userId: string, basePath?: string): Promise<void> {
  if (basePath) {
    const controller = new DirectoryController(basePath);
    return controller.createUserDirectories(userId);
  }
  return directoryController.createUserDirectories(userId);
}

export async function writeToTier(
  userId: string, 
  tier: TierType, 
  filename: string, 
  data: Buffer | string, 
  context?: DataAccessContext
): Promise<void> {
  return directoryController.writeToTier(userId, tier, filename, data, context);
}

export async function readFromTier(
  userId: string, 
  tier: TierType, 
  filename: string, 
  context?: DataAccessContext
): Promise<Buffer> {
  return directoryController.readFromTier(userId, tier, filename, context);
}

export async function deleteFromTier(
  userId: string, 
  tier: TierType, 
  filename: string, 
  context?: DataAccessContext
): Promise<void> {
  return directoryController.deleteFromTier(userId, tier, filename, context);
}

export async function deleteUserDirectories(userId: string, context?: DataAccessContext): Promise<void> {
  return directoryController.deleteUserDirectories(userId, context);
}

export async function listTierFiles(userId: string, tier: TierType): Promise<string[]> {
  return directoryController.listTierFiles(userId, tier);
}

// Legacy function exports for backward compatibility
export async function writeFile(filePath: string, data: string | Buffer, overwrite = true): Promise<void> {
  const flags = overwrite ? 'w' : 'wx';
  try {
    await fs.writeFile(filePath, data, { flag: flags });
    console.log(`[DirectoryController]: Successfully written file: ${filePath}`);
  } catch (error) {
    console.error(`[DirectoryController ERROR]: Failed to write file ${filePath}:`, error);
    throw new Error(`Failed to write file ${filePath}: ${(error as Error).message}`);
  }
}

export async function appendToFile(filePath: string, data: string | Buffer): Promise<void> {
  try {
    await fs.appendFile(filePath, data);
    console.log(`[DirectoryController]: Successfully appended to file: ${filePath}`);
  } catch (error) {
    console.error(`[DirectoryController ERROR]: Failed to append to file ${filePath}:`, error);
    throw new Error(`Failed to append to file ${filePath}: ${(error as Error).message}`);
  }
}

export async function deleteFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
    console.log(`[DirectoryController]: Successfully deleted file: ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(`[DirectoryController WARNING]: Attempted to delete non-existent file: ${filePath}.`);
    } else {
      console.error(`[DirectoryController ERROR]: Failed to delete file ${filePath}:`, error);
      throw new Error(`Failed to delete file ${filePath}: ${(error as Error).message}`);
    }
  }
}

export default DirectoryController;
export { DirectoryController, TierType, SubDirType, FileMetadata, DataAccessContext };
