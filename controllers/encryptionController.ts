// controllers/encryptionController.ts

import { generateKeyPairSync, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import fs from 'fs/promises'; // Changed to fs/promises for asynchronous operations
import path from 'path';

/**
 * Generates RSA key pair and AES key+IV for a user, and stores them in the expected file structure.
 * This function is now asynchronous to prevent blocking the event loop during file I/O.
 *
 * @param userId The ID of the user for whom keys are generated.
 * @param basePath The base path where user directories are located (e.g., '/var/www/mirror-storage/users').
 */
export async function generateUserKeys(userId: string, basePath: string): Promise<void> {
    console.log(`[EncryptionController]: Initiating key generation for user ID: ${userId}`);
    const userKeyDir = path.join(basePath, userId, 'tier1', 'keys');

    try {
        const { publicKey, privateKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem'
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem'
            }
        });

        // Write RSA keys asynchronously
        await fs.writeFile(path.join(userKeyDir, 'rsa_pub.pem'), publicKey);
        await fs.writeFile(path.join(userKeyDir, 'rsa_priv.pem'), privateKey);
        console.log(`[EncryptionController]: RSA keys saved for user ${userId}.`);

        const aesKey = randomBytes(32); // AES-256 (32 bytes = 256 bits)
        const iv = randomBytes(16);     // 16-byte IV for AES-256-GCM (NIST recommends 96 bits for GCM, but 16 bytes is common for direct use with `createCipheriv`)

        // Write AES key and IV asynchronously
        await fs.writeFile(path.join(userKeyDir, 'aes_key.bin'), aesKey);
        await fs.writeFile(path.join(userKeyDir, 'aes_iv.bin'), iv);
        console.log(`[EncryptionController]: AES key and IV saved for user ${userId}.`);

        console.log(`[EncryptionController]: All keys successfully generated and stored for user ${userId}.`);
    } catch (error) {
        console.error(`[EncryptionController ERROR]: Failed to generate or store keys for user ${userId}:`, error);
        // Re-throw the error to be handled by the calling function (e.g., createUserInDB)
        throw new Error(`Key generation/storage failed: ${(error as Error).message}`);
    }
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 */
export function encryptDataAES(
    plainText: string,
    aesKey: Buffer,
    iv: Buffer
): { encrypted: string; authTag: string } {
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
        encrypted: encrypted.toString('hex'),
        authTag: authTag.toString('hex')
    };
}

/**
 * Decrypt AES-256-GCM encrypted data.
 */
export function decryptDataAES(
    encryptedHex: string,
    aesKey: Buffer,
    iv: Buffer,
    authTagHex: string
): string {
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
}
