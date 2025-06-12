// controllers/directoryController.ts
// This module provides a robust and asynchronous interface for file system operations.

import fs from 'fs/promises'; // Use the promises API for asynchronous operations
import path from 'path';


const TIERS = ['tier1', 'tier2', 'tier3']; 
const SUB_DIRS = ['keys', 'uploads', 'meta', 'tmp']; 

export async function createUserDirectories(userId:string, basePath: string): Promise<void> {
    console.log(`[fileService]: Attempting to create directories for user ${userId} at base path: ${basePath}`);
    try {
        // userRootPath will be like '/var/www/mirror-storage/users/18'
        const userRootPath = path.join(basePath, userId);

        // Ensure the user's root directory exists first
        await fs.mkdir(userRootPath, { recursive: true });
        console.log(`[fileService]: Created user root directory: ${userRootPath}`);

        // Iterate through tiers and subdirectories to create the full structure
        for (const tier of TIERS) {
            for (const sub of SUB_DIRS) {
                const dirPath = path.join(userRootPath, tier, sub);
                await fs.mkdir(dirPath, { recursive: true });
                console.log(`[fileService]: Created subdirectory: ${dirPath}`);
            }
        }
        console.log(`[fileService]: All directories created successfully for user ${userId}.`);
    } catch (error) {
        console.error(`[fileService ERROR]: Failed to create user directories for user ${userId}:`, error);
        throw new Error(`Failed to create user directories: ${(error as Error).message}`);
    }
}


export async function writeFile(filePath: string, data: string | Buffer, overwrite = true): Promise<void> {
    const flags = overwrite ? 'w' : 'wx';
    try {
        await fs.writeFile(filePath, data, { flag: flags });
        console.log(`[fileService]: Successfully written file: ${filePath}`);
    } catch (error) {
        console.error(`[fileService ERROR]: Failed to write file ${filePath}:`, error);
        throw new Error(`Failed to write file ${filePath}: ${(error as Error).message}`);
    }
}

export async function appendToFile(filePath: string, data: string | Buffer): Promise<void> {
    try {
        await fs.appendFile(filePath, data);
        console.log(`[fileService]: Successfully appended to file: ${filePath}`);
    } catch (error) {
        console.error(`[fileService ERROR]: Failed to append to file ${filePath}:`, error);
        throw new Error(`Failed to append to file ${filePath}: ${(error as Error).message}`);
    }
}


export async function deleteFile(filePath: string): Promise<void> {
    try {
        await fs.unlink(filePath);
        console.log(`[fileService]: Successfully deleted file: ${filePath}`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            console.warn(`[fileService WARNING]: Attempted to delete non-existent file: ${filePath}.`);
        } else {
            console.error(`[fileService ERROR]: Failed to delete file ${filePath}:`, error);
            throw new Error(`Failed to delete file ${filePath}: ${(error as Error).message}`);
        }
    }
}


export async function deleteUserDirectories(basePath: string, userId: string): Promise<void> {
    const userPath = path.join(basePath, userId);
    try {
        await fs.rm(userPath, { recursive: true, force: true });
        console.log(`[fileService]: Successfully deleted user directories: ${userPath}`);
    } catch (error) {
        console.error(`[fileService ERROR]: Failed to delete user directories ${userPath}:`, error);
        throw new Error(`Failed to delete user directories ${userPath}: ${(error as Error).message}`);
    }
}
