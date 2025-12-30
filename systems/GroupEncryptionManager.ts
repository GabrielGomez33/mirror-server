// managers/GroupEncryptionManager.ts
// MirrorGroups Phase 1: Encryption Manager - CORRECTED for actual database schema
// Matches schema: id (not key_id), single encrypted_group_key field, status enum, key_version

import crypto from 'crypto';
import { DB } from '../db';
import { EventEmitter } from 'events';

// ============================================================================
// TYPES
// ============================================================================

interface EncryptedDataPackage {
  encrypted: string;          // Base64 encoded: iv + authTag + encryptedData
  algorithm: string;
}

interface DecryptedData {
  data: Buffer;
  verified: boolean;
}

// ============================================================================
// GROUP ENCRYPTION MANAGER
// ============================================================================

export class GroupEncryptionManager extends EventEmitter {
  private initialized: boolean = false;
  private systemMasterKey: Buffer;
  private keyCache: Map<string, Buffer> = new Map();  // Cache decrypted group keys
  private readonly ALGORITHM = 'aes-256-gcm';
  private readonly KEY_LENGTH = 32;  // 256 bits
  private readonly IV_LENGTH = 16;   // 128 bits
  private readonly AUTH_TAG_LENGTH = 16;

  constructor() {
    super();
    
    // Load system master key from environment
    const masterKeyHex = process.env.SYSTEM_MASTER_KEY;
    if (!masterKeyHex || masterKeyHex.length !== 64) {
      throw new Error('SYSTEM_MASTER_KEY must be 64 hex characters (256 bits)');
    }
    
    this.systemMasterKey = Buffer.from(masterKeyHex, 'hex');
    console.log('🔐 GroupEncryptionManager: System master key loaded');
  }

  /**
   * Initialize the encryption manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('⚠️  GroupEncryptionManager already initialized');
      return;
    }

    try {
      // Verify database tables exist
      await this.verifyTables();
      
      this.initialized = true;
      this.emit('initialized');
      console.log('✅ GroupEncryptionManager initialized successfully');
    } catch (error) {
      console.error('❌ GroupEncryptionManager initialization failed:', error);
      throw error;
    }
  }

  /**
   * Verify required database tables exist
   */
  private async verifyTables(): Promise<void> {
    const tables = ['mirror_group_encryption_keys', 'mirror_group_member_keys'];
    
    for (const table of tables) {
      const [rows] = await DB.query(
        `SELECT COUNT(*) as count FROM information_schema.tables 
         WHERE table_schema = DATABASE() AND table_name = ?`,
        [table]
      );
      
      if ((rows as any[])[0].count === 0) {
        throw new Error(`Required table ${table} does not exist`);
      }
    }
  }

  // ============================================================================
  // KEY GENERATION & MANAGEMENT
  // ============================================================================

  /**
   * Generate a new shared encryption key for a group
   * Stores encrypted key in database using system master key
   */
  async generateGroupKey(groupId: string): Promise<string> {
    try {
      console.log(`🔑 Generating group key for group: ${groupId}`);

      // Generate random 256-bit key
      const groupKey = crypto.randomBytes(this.KEY_LENGTH);
      const keyId = crypto.randomUUID();

      // Encrypt group key with system master key
      const encryptedPackage = this.encryptWithSystemKey(groupKey);

      // Get next key version
      const [versionRows] = await DB.query(
        `SELECT COALESCE(MAX(key_version), 0) + 1 as next_version 
         FROM mirror_group_encryption_keys WHERE group_id = ?`,
        [groupId]
      );
      const keyVersion = (versionRows as any[])[0].next_version;

      // Store in database - using actual schema
      await DB.query(
        `INSERT INTO mirror_group_encryption_keys (
          id, group_id, key_version, encrypted_group_key, 
          key_algorithm, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'active', NOW())`,
        [keyId, groupId, keyVersion, encryptedPackage, this.ALGORITHM]
      );

      // Cache the decrypted key
      this.keyCache.set(keyId, groupKey);

      console.log(`✅ Group key generated: ${keyId} (version ${keyVersion})`);
      this.emit('key-generated', { groupId, keyId, keyVersion });

      return keyId;
    } catch (error) {
      console.error('❌ Failed to generate group key:', error);
      throw new Error(`Group key generation failed: ${(error as Error).message}`);
    }
  }

  /**
   * Distribute group key to a member
   * @param keyVersion - The version of the key being distributed
   */
  async distributeKeyToMember(
    groupId: string,
    userId: string,
    keyId: string,
    keyVersion?: number
  ): Promise<string> {
    try {
      console.log(`📤 Distributing key ${keyId} to user ${userId} in group ${groupId}`);

      // Get the group key (decrypt if needed)
      const groupKey = await this.getGroupKey(keyId);

      // Get key version if not provided
      if (keyVersion === undefined) {
        const [keyRows] = await DB.query(
          `SELECT key_version FROM mirror_group_encryption_keys WHERE id = ?`,
          [keyId]
        );
        keyVersion = (keyRows as any[])[0].key_version;
      }

      // Derive a user-specific encryption key
      const userEncryptionKey = this.deriveUserEncryptionKey(userId);

      // Encrypt group key with user's encryption key
      const encryptedForUser = this.encryptWithUserKey(groupKey, userEncryptionKey);

      // Create key derivation metadata
      const metadata = {
        derivation_method: 'PBKDF2',
        iterations: 100000,
        hash: 'SHA256',
        distributed_by: 'system',
        key_id: keyId
      };

      const parsedUserId = parseInt(userId);

      // Check if user already has a key for this group/version
      const [existingKey] = await DB.query(
        `SELECT id FROM mirror_group_member_keys
         WHERE group_id = ? AND user_id = ? AND key_version = ?`,
        [groupId, parsedUserId, keyVersion]
      );

      let memberKeyId: string;

      if ((existingKey as any[]).length > 0) {
        // Update existing key record
        memberKeyId = (existingKey as any[])[0].id;
        await DB.query(
          `UPDATE mirror_group_member_keys
           SET encrypted_member_key = ?,
               key_derivation_metadata = ?,
               status = 'active',
               distributed_at = NOW()
           WHERE id = ?`,
          [encryptedForUser, JSON.stringify(metadata), memberKeyId]
        );
        console.log(`✅ Updated existing key for user ${userId}: ${memberKeyId}`);
      } else {
        // Insert new key record
        memberKeyId = crypto.randomUUID();
        await DB.query(
          `INSERT INTO mirror_group_member_keys (
            id, group_id, user_id, key_version, encrypted_member_key,
            key_derivation_metadata, status, distributed_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', NOW())`,
          [memberKeyId, groupId, parsedUserId, keyVersion, encryptedForUser, JSON.stringify(metadata)]
        );
        console.log(`✅ Created new key for user ${userId}: ${memberKeyId}`);
      }

      // Verify the key was stored correctly
      const [verifyKey] = await DB.query(
        `SELECT id, status FROM mirror_group_member_keys
         WHERE group_id = ? AND user_id = ? AND status = 'active'
         ORDER BY key_version DESC LIMIT 1`,
        [groupId, parsedUserId]
      );

      if ((verifyKey as any[]).length === 0) {
        throw new Error(`Key verification failed - no active key found after distribution`);
      }

      console.log(`✅ Key distribution verified for user ${userId}, keyId: ${(verifyKey as any[])[0].id}`);
      this.emit('key-distributed', { groupId, userId, memberKeyId });

      return memberKeyId;
    } catch (error) {
      console.error('❌ Failed to distribute key:', error);
      throw new Error(`Key distribution failed: ${(error as Error).message}`);
    }
  }

  /**
   * Revoke a user's access to the group key
   */
  async revokeUserAccess(groupId: string, userId: string): Promise<void> {
    try {
      console.log(`🚫 Revoking access for user ${userId} in group ${groupId}`);

      await DB.query(
        `UPDATE mirror_group_member_keys 
         SET status = 'revoked' 
         WHERE group_id = ? AND user_id = ?`,
        [groupId, parseInt(userId)]
      );

      // Remove from cache
      const cacheKeys = Array.from(this.keyCache.keys());
      for (const key of cacheKeys) {
        // Clear any cached keys for this user
        this.keyCache.delete(key);
      }

      console.log(`✅ Access revoked for user ${userId}`);
      this.emit('access-revoked', { groupId, userId });
    } catch (error) {
      console.error('❌ Failed to revoke access:', error);
      throw new Error(`Access revocation failed: ${(error as Error).message}`);
    }
  }

  /**
   * Rotate group key (security measure after member leaves or suspected compromise)
   */
  async rotateGroupKey(groupId: string): Promise<string> {
    try {
      console.log(`🔄 Rotating group key for group: ${groupId}`);

      // Mark old keys as expired
      await DB.query(
        `UPDATE mirror_group_encryption_keys 
         SET status = 'expired' 
         WHERE group_id = ? AND status = 'active'`,
        [groupId]
      );

      // Generate new key
      const newKeyId = await this.generateGroupKey(groupId);

      // Get all active members
      const [members] = await DB.query(
        `SELECT user_id FROM mirror_group_members 
         WHERE group_id = ? AND status = 'active'`,
        [groupId]
      );

      // Get new key version
      const [keyRows] = await DB.query(
        `SELECT key_version FROM mirror_group_encryption_keys WHERE id = ?`,
        [newKeyId]
      );
      const newKeyVersion = (keyRows as any[])[0].key_version;

      // Distribute new key to all members
      for (const member of members as any[]) {
        await this.distributeKeyToMember(groupId, String(member.user_id), newKeyId, newKeyVersion);
      }

      console.log(`✅ Group key rotated successfully: ${newKeyId}`);
      this.emit('key-rotated', { groupId, newKeyId, memberCount: (members as any[]).length });

      return newKeyId;
    } catch (error) {
      console.error('❌ Failed to rotate group key:', error);
      throw new Error(`Key rotation failed: ${(error as Error).message}`);
    }
  }

  // ============================================================================
  // ENCRYPTION & DECRYPTION
  // ============================================================================

  /**
   * Encrypt data for group storage
   * Returns base64 string with iv + authTag + encrypted data
   */
  async encryptForGroup(data: Buffer, keyId: string): Promise<EncryptedDataPackage> {
    try {
      const groupKey = await this.getGroupKey(keyId);
      const iv = crypto.randomBytes(this.IV_LENGTH);

      const cipher = crypto.createCipheriv(this.ALGORITHM, groupKey, iv);
      const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
      const authTag = cipher.getAuthTag();

      // Combine: iv + authTag + encrypted data
      const combined = Buffer.concat([iv, authTag, encrypted]);

      return {
        encrypted: combined.toString('base64'),
        algorithm: this.ALGORITHM
      };
    } catch (error) {
      console.error('❌ Encryption failed:', error);
      throw new Error(`Encryption failed: ${(error as Error).message}`);
    }
  }

  /**
   * Decrypt data for a specific user
   * Verifies user has access to the group key
   */
  async decryptForUser(
    encryptedPackage: string,
    userId: string,
    groupId: string
  ): Promise<DecryptedData> {
    try {
      // Get user's member key
      const [memberKeyRows] = await DB.query(
        `SELECT encrypted_member_key, key_version 
         FROM mirror_group_member_keys 
         WHERE user_id = ? AND group_id = ? AND status = 'active' 
         ORDER BY key_version DESC LIMIT 1`,
        [parseInt(userId), groupId]
      );

      if ((memberKeyRows as any[]).length === 0) {
        throw new Error('User does not have access to this group key');
      }

      const memberKey = (memberKeyRows as any[])[0];

      // Decrypt the group key using user's encryption key
      const userEncryptionKey = this.deriveUserEncryptionKey(userId);
      const groupKey = this.decryptWithUserKey(memberKey.encrypted_member_key, userEncryptionKey);

      // Parse the encrypted package: iv + authTag + encrypted data
      const combined = Buffer.from(encryptedPackage, 'base64');
      const iv = combined.subarray(0, this.IV_LENGTH);
      const authTag = combined.subarray(this.IV_LENGTH, this.IV_LENGTH + this.AUTH_TAG_LENGTH);
      const encrypted = combined.subarray(this.IV_LENGTH + this.AUTH_TAG_LENGTH);

      // Decrypt the actual data with group key
      const decipher = crypto.createDecipheriv(this.ALGORITHM, groupKey, iv);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

      return {
        data: decrypted,
        verified: true
      };
    } catch (error) {
      console.error('❌ Decryption failed:', error);
      throw new Error(`Decryption failed: ${(error as Error).message}`);
    }
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  /**
   * Get and decrypt a group key
   */
  private async getGroupKey(keyId: string): Promise<Buffer> {
    // Check cache first
    if (this.keyCache.has(keyId)) {
      return this.keyCache.get(keyId)!;
    }

    // Fetch from database
    const [rows] = await DB.query(
      `SELECT encrypted_group_key FROM mirror_group_encryption_keys 
       WHERE id = ? AND status = 'active'`,
      [keyId]
    );

    if ((rows as any[]).length === 0) {
      throw new Error(`Group key not found or inactive: ${keyId}`);
    }

    const encryptedPackage = (rows as any[])[0].encrypted_group_key;

    // Decrypt with system master key
    const groupKey = this.decryptWithSystemKey(encryptedPackage);

    // Cache for future use
    this.keyCache.set(keyId, groupKey);

    return groupKey;
  }

  /**
   * Encrypt data with system master key
   * Returns base64 string: iv + authTag + encrypted
   */
  private encryptWithSystemKey(data: Buffer): string {
    const iv = crypto.randomBytes(this.IV_LENGTH);
    const cipher = crypto.createCipheriv(this.ALGORITHM, this.systemMasterKey, iv);
    
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Combine: iv + authTag + encrypted
    const combined = Buffer.concat([iv, authTag, encrypted]);
    return combined.toString('base64');
  }

  /**
   * Decrypt data with system master key
   * Expects base64 string: iv + authTag + encrypted
   */
  private decryptWithSystemKey(encryptedPackage: string): Buffer {
    const combined = Buffer.from(encryptedPackage, 'base64');
    
    const iv = combined.subarray(0, this.IV_LENGTH);
    const authTag = combined.subarray(this.IV_LENGTH, this.IV_LENGTH + this.AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(this.IV_LENGTH + this.AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(this.ALGORITHM, this.systemMasterKey, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  /**
   * Derive a user-specific encryption key
   */
  private deriveUserEncryptionKey(userId: string): Buffer {
    return crypto.pbkdf2Sync(
      userId,
      this.systemMasterKey,
      100000,  // iterations
      this.KEY_LENGTH,
      'sha256'
    );
  }

  /**
   * Encrypt with user's derived key
   * Returns base64 string: iv + authTag + encrypted
   */
  private encryptWithUserKey(data: Buffer, userKey: Buffer): string {
    const iv = crypto.randomBytes(this.IV_LENGTH);
    const cipher = crypto.createCipheriv(this.ALGORITHM, userKey, iv);
    
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const combined = Buffer.concat([iv, authTag, encrypted]);
    return combined.toString('base64');
  }

  /**
   * Decrypt with user's derived key
   * Expects base64 string: iv + authTag + encrypted
   */
  private decryptWithUserKey(encryptedPackage: string, userKey: Buffer): Buffer {
    const combined = Buffer.from(encryptedPackage, 'base64');
    
    const iv = combined.subarray(0, this.IV_LENGTH);
    const authTag = combined.subarray(this.IV_LENGTH, this.IV_LENGTH + this.AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(this.IV_LENGTH + this.AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(this.ALGORITHM, userKey, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down GroupEncryptionManager...');
    
    // Clear key cache (sensitive data)
    this.keyCache.clear();
    
    this.initialized = false;
    this.emit('shutdown');
    console.log('✅ GroupEncryptionManager shutdown complete');
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const groupEncryptionManager = new GroupEncryptionManager();
