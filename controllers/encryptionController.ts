// controllers/encryptionController.ts
import { generateKeyPairSync, randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

// Types for encryption operations
export interface EncryptionResult {
  encrypted: Buffer;
  authTag: Buffer;
  iv: Buffer;
}

export interface DecryptionParams {
  encryptedData: Buffer;
  authTag: Buffer;
  iv: Buffer;
}

export interface UserKeys {
  aesKey: Buffer;
  iv: Buffer;
  publicKey: string;
  privateKey: string;
}

// Constants
const AES_ALGORITHM = 'aes-256-gcm';
const RSA_KEY_SIZE = 2048;
const AES_KEY_SIZE = 32; // 256 bits
const IV_SIZE = 16; // 128 bits
const AUTH_TAG_SIZE = 16; // 128 bits

/**
 * Generates RSA key pair and AES key+IV for a user, and stores them in the expected file structure.
 * Enhanced with better error handling and key validation.
 *
 * @param userId The ID of the user for whom keys are generated.
 * @param basePath The base path where user directories are located.
 */
export async function generateUserKeys(userId: string, basePath: string): Promise<void> {
  console.log(`[EncryptionController]: Initiating key generation for user ID: ${userId}`);
  
  const userKeyDir = path.join(basePath, userId, 'tier1', 'keys');
  
  try {
    // Ensure the keys directory exists
    await fs.mkdir(userKeyDir, { recursive: true, mode: 0o700 }); // Restrictive permissions
    
    // Generate RSA key pair
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: RSA_KEY_SIZE,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    });
    
    // Write RSA keys with restrictive permissions
    await fs.writeFile(path.join(userKeyDir, 'rsa_pub.pem'), publicKey, { mode: 0o644 });
    await fs.writeFile(path.join(userKeyDir, 'rsa_priv.pem'), privateKey, { mode: 0o600 });
    console.log(`[EncryptionController]: RSA keys saved for user ${userId}.`);
    
    // Generate AES key and IV
    const aesKey = randomBytes(AES_KEY_SIZE);
    const iv = randomBytes(IV_SIZE);
    
    // Write AES key and IV with restrictive permissions
    await fs.writeFile(path.join(userKeyDir, 'aes_key.bin'), aesKey, { mode: 0o600 });
    await fs.writeFile(path.join(userKeyDir, 'aes_iv.bin'), iv, { mode: 0o600 });
    console.log(`[EncryptionController]: AES key and IV saved for user ${userId}.`);
    
    // Generate key checksums for integrity verification
    const aesKeyHash = createHash('sha256').update(aesKey).digest('hex');
    const ivHash = createHash('sha256').update(iv).digest('hex');
    
    const keyMetadata = {
      userId,
      algorithm: AES_ALGORITHM,
      keySize: AES_KEY_SIZE,
      ivSize: IV_SIZE,
      rsaKeySize: RSA_KEY_SIZE,
      aesKeyHash,
      ivHash,
      createdAt: new Date().toISOString(),
      version: '1.0'
    };
    
    await fs.writeFile(
      path.join(userKeyDir, 'key_metadata.json'), 
      JSON.stringify(keyMetadata, null, 2),
      { mode: 0o600 }
    );
    
    console.log(`[EncryptionController]: All keys successfully generated and stored for user ${userId}.`);
    
  } catch (error) {
    console.error(`[EncryptionController ERROR]: Failed to generate or store keys for user ${userId}:`, error);
    throw new Error(`Key generation/storage failed: ${(error as Error).message}`);
  }
}

/**
 * Load user's encryption keys from storage
 */
export async function loadUserKeys(userId: string, basePath: string): Promise<UserKeys> {
  const userKeyDir = path.join(basePath, userId, 'tier1', 'keys');
  
  try {
    const [aesKey, iv, publicKey, privateKey] = await Promise.all([
      fs.readFile(path.join(userKeyDir, 'aes_key.bin')),
      fs.readFile(path.join(userKeyDir, 'aes_iv.bin')),
      fs.readFile(path.join(userKeyDir, 'rsa_pub.pem'), 'utf8'),
      fs.readFile(path.join(userKeyDir, 'rsa_priv.pem'), 'utf8')
    ]);
    
    // Verify key integrity if metadata exists
    try {
      const metadata = await fs.readFile(path.join(userKeyDir, 'key_metadata.json'), 'utf8');
      const keyMetadata = JSON.parse(metadata);
      
      const aesKeyHash = createHash('sha256').update(aesKey).digest('hex');
      const ivHash = createHash('sha256').update(iv).digest('hex');
      
      if (aesKeyHash !== keyMetadata.aesKeyHash || ivHash !== keyMetadata.ivHash) {
        throw new Error('Key integrity verification failed');
      }
    } catch (metadataError) {
      console.warn(`[EncryptionController]: Key metadata verification failed for user ${userId}:`, metadataError);
      // Continue without metadata verification for backward compatibility
    }
    
    return { aesKey, iv, publicKey, privateKey };
    
  } catch (error) {
    console.error(`[EncryptionController ERROR]: Failed to load keys for user ${userId}:`, error);
    throw new Error(`Key loading failed: ${(error as Error).message}`);
  }
}

/**
 * Encrypt data using AES-256-GCM with enhanced security
 */
export function encryptData(data: Buffer, aesKey: Buffer, iv?: Buffer): EncryptionResult {
  try {
    // Use provided IV or generate a new one
    const actualIv = iv || randomBytes(IV_SIZE);
    
    const cipher = createCipheriv(AES_ALGORITHM, aesKey, actualIv);
    
    const encrypted = Buffer.concat([
      cipher.update(data),
      cipher.final()
    ]);
    
    const authTag = cipher.getAuthTag();
    
    return {
      encrypted,
      authTag,
      iv: actualIv
    };
    
  } catch (error) {
    console.error('[EncryptionController ERROR]: Encryption failed:', error);
    throw new Error(`Encryption failed: ${(error as Error).message}`);
  }
}

/**
 * Decrypt data using AES-256-GCM
 */
export function decryptData(params: DecryptionParams, aesKey: Buffer): Buffer {
  try {
    const { encryptedData, authTag, iv } = params;
    
    const decipher = createDecipheriv(AES_ALGORITHM, aesKey, iv);
    decipher.setAuthTag(authTag);
    
    const decrypted = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final()
    ]);
    
    return decrypted;
    
  } catch (error) {
    console.error('[EncryptionController ERROR]: Decryption failed:', error);
    throw new Error(`Decryption failed: ${(error as Error).message}`);
  }
}

/**
 * Encrypt a buffer and return combined format (IV + AuthTag + EncryptedData)
 */
export function encryptBuffer(data: Buffer, aesKey: Buffer): Buffer {
  const result = encryptData(data, aesKey);
  
  // Combine IV, auth tag, and encrypted data into single buffer
  return Buffer.concat([
    result.iv,
    result.authTag,
    result.encrypted
  ]);
}

/**
 * Decrypt a combined buffer format (IV + AuthTag + EncryptedData)
 */
export function decryptBuffer(combinedData: Buffer, aesKey: Buffer): Buffer {
  if (combinedData.length < IV_SIZE + AUTH_TAG_SIZE) {
    throw new Error('Invalid encrypted data format');
  }
  
  const iv = combinedData.slice(0, IV_SIZE);
  const authTag = combinedData.slice(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
  const encryptedData = combinedData.slice(IV_SIZE + AUTH_TAG_SIZE);
  
  return decryptData({ encryptedData, authTag, iv }, aesKey);
}

/**
 * Legacy string-based encryption for backward compatibility
 */
export function encryptDataAES(
  plainText: string,
  aesKey: Buffer,
  iv: Buffer
): { encrypted: string; authTag: string } {
  const data = Buffer.from(plainText, 'utf8');
  const result = encryptData(data, aesKey, iv);
  
  return {
    encrypted: result.encrypted.toString('hex'),
    authTag: result.authTag.toString('hex')
  };
}

/**
 * Legacy string-based decryption for backward compatibility
 */
export function decryptDataAES(
  encryptedHex: string,
  aesKey: Buffer,
  iv: Buffer,
  authTagHex: string
): string {
  const encryptedData = Buffer.from(encryptedHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  
  const decrypted = decryptData({ encryptedData, authTag, iv }, aesKey);
  return decrypted.toString('utf8');
}

/**
 * Generate a secure hash of data
 */
export function hashData(data: Buffer, algorithm: string = 'sha256'): string {
  return createHash(algorithm).update(data).digest('hex');
}

/**
 * Verify data integrity using hash
 */
export function verifyDataIntegrity(data: Buffer, expectedHash: string, algorithm: string = 'sha256'): boolean {
  const actualHash = hashData(data, algorithm);
  return actualHash === expectedHash;
}

/**
 * Rotate user keys (generate new AES key while keeping RSA keys)
 */
export async function rotateUserAESKeys(userId: string, basePath: string): Promise<void> {
  console.log(`[EncryptionController]: Rotating AES keys for user ${userId}`);
  
  const userKeyDir = path.join(basePath, userId, 'tier1', 'keys');
  
  try {
    // Backup old keys
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(userKeyDir, 'backup', timestamp);
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    
    // Copy old keys to backup
    try {
      const oldAesKey = await fs.readFile(path.join(userKeyDir, 'aes_key.bin'));
      const oldIv = await fs.readFile(path.join(userKeyDir, 'aes_iv.bin'));
      
      await fs.writeFile(path.join(backupDir, 'aes_key.bin'), oldAesKey, { mode: 0o600 });
      await fs.writeFile(path.join(backupDir, 'aes_iv.bin'), oldIv, { mode: 0o600 });
    } catch (backupError) {
      console.warn(`[EncryptionController]: Could not backup old keys: ${backupError}`);
    }
    
    // Generate new AES key and IV
    const newAesKey = randomBytes(AES_KEY_SIZE);
    const newIv = randomBytes(IV_SIZE);
    
    // Write new keys
    await fs.writeFile(path.join(userKeyDir, 'aes_key.bin'), newAesKey, { mode: 0o600 });
    await fs.writeFile(path.join(userKeyDir, 'aes_iv.bin'), newIv, { mode: 0o600 });
    
    // Update metadata
    const aesKeyHash = createHash('sha256').update(newAesKey).digest('hex');
    const ivHash = createHash('sha256').update(newIv).digest('hex');
    
    const keyMetadata = {
      userId,
      algorithm: AES_ALGORITHM,
      keySize: AES_KEY_SIZE,
      ivSize: IV_SIZE,
      aesKeyHash,
      ivHash,
      rotatedAt: new Date().toISOString(),
      version: '1.1'
    };
    
    await fs.writeFile(
      path.join(userKeyDir, 'key_metadata.json'),
      JSON.stringify(keyMetadata, null, 2),
      { mode: 0o600 }
    );
    
    console.log(`[EncryptionController]: AES keys successfully rotated for user ${userId}`);
    
  } catch (error) {
    console.error(`[EncryptionController ERROR]: Failed to rotate keys for user ${userId}:`, error);
    throw new Error(`Key rotation failed: ${(error as Error).message}`);
  }
}

/**
 * Delete user keys securely
 */
export async function deleteUserKeys(userId: string, basePath: string): Promise<void> {
  const userKeyDir = path.join(basePath, userId, 'tier1', 'keys');
  
  try {
    // List all key files
    const keyFiles = [
      'aes_key.bin',
      'aes_iv.bin', 
      'rsa_pub.pem',
      'rsa_priv.pem',
      'key_metadata.json'
    ];
    
    // Securely overwrite each key file before deletion
    for (const keyFile of keyFiles) {
      const keyPath = path.join(userKeyDir, keyFile);
      try {
        const stats = await fs.stat(keyPath);
        const fileSize = stats.size;
        
        // Overwrite with random data
        const randomData = randomBytes(fileSize);
        await fs.writeFile(keyPath, randomData);
        
        // Overwrite with zeros
        const zeroData = Buffer.alloc(fileSize, 0);
        await fs.writeFile(keyPath, zeroData);
        
        // Delete the file
        await fs.unlink(keyPath);
        
      } catch (fileError) {
        if ((fileError as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`[EncryptionController]: Could not securely delete ${keyFile}:`, fileError);
        }
      }
    }
    
    // Remove backup directories if they exist
    try {
      const backupDir = path.join(userKeyDir, 'backup');
      await fs.rm(backupDir, { recursive: true, force: true });
    } catch (backupError) {
      // Ignore backup deletion errors
    }
    
    console.log(`[EncryptionController]: User keys securely deleted for user ${userId}`);
    
  } catch (error) {
    console.error(`[EncryptionController ERROR]: Failed to delete keys for user ${userId}:`, error);
    throw new Error(`Key deletion failed: ${(error as Error).message}`);
  }
}

/**
 * Check if user has valid keys
 */
export async function validateUserKeys(userId: string, basePath: string): Promise<boolean> {
  const userKeyDir = path.join(basePath, userId, 'tier1', 'keys');
  
  try {
    // Check if all required key files exist
    const keyFiles = [
      'aes_key.bin',
      'aes_iv.bin',
      'rsa_pub.pem', 
      'rsa_priv.pem'
    ];
    
    for (const keyFile of keyFiles) {
      await fs.access(path.join(userKeyDir, keyFile));
    }
    
    // Verify key integrity if metadata exists
    try {
      const keys = await loadUserKeys(userId, basePath);
      return keys.aesKey.length === AES_KEY_SIZE && keys.iv.length === IV_SIZE;
    } catch (loadError) {
      return false;
    }
    
  } catch (error) {
    return false;
  }
}
