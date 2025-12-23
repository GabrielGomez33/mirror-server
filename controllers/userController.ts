// controllers/userController.ts

import bcrypt from 'bcrypt';
import path from 'path';
import jwt from 'jsonwebtoken';
import { RequestHandler } from 'express';
import { ResultSetHeader, FieldPacket } from 'mysql2/promise';

import { DB } from '../db';
import { generateUserKeys } from './encryptionController';
import { createUserDirectories, deleteUserDirectories, DataAccessContext } from './directoryController';
const basePath = path.join(process.env.MIRRORSTORAGE!);
const storagePath = path.join(basePath, 'users');
const SALT_ROUNDS = 10;

// === CORE LOGIC FUNCTIONS ===

export async function createUserInDB(username: string, email: string, password: string): Promise<number> {
  console.log(`[CreateUserInDb()]: Attempting to create account for ${username}`);

  const [existing] = await DB.query('SELECT id FROM users WHERE email=?', [email]);
  if ((existing as any[]).length > 0) {
    throw new Error('EMAIL_ALREADY_REGISTERED');
  }

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

  const [result] = await DB.query<ResultSetHeader>(
    'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
    [username, email, hashedPassword]
  )
	
  // Get the inserted user ID
  const userId = result.insertId;
  console.log(`[New user created with] -> ID:${userId}`);

  // Create user directories and keys
  await createUserDirectories(userId.toString(), storagePath);
  await generateUserKeys(userId.toString(), storagePath);

  // Return the user ID
  return userId;
}

export async function deleteUserFromDB(userId: string, adminUserId: number): Promise<void> {
  console.log(`[DeleteUserFromDB]: Attempting to delete user ${userId}`);

  try {
    // Create context for the deletion operation
    const context: DataAccessContext = {
      userId: parseInt(userId),
      accessedBy: adminUserId,
      reason: 'user_account_deletion'
    };

    // Delete user directories with proper context
    await deleteUserDirectories(userId, context);

    // Delete user from database
    await DB.query('DELETE FROM users WHERE id = ?', [userId]);

    console.log(`[DeleteUserFromDB]: Successfully deleted user ${userId}`);
  } catch (error) {
    console.error(`[DeleteUserFromDB ERROR]: Failed to delete user ${userId}:`, error);
    throw new Error(`Failed to delete user: ${(error as Error).message}`);
  }
}

export async function userLogin(email: string, password: string): Promise<string> {
  const [rows] = await DB.query('SELECT * FROM users WHERE email=?', [email]);
  const user = (rows as any[])[0];

  if (!user) throw new Error('INVALID CREDENTIALS');

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) throw new Error('INVALID CREDENTIALS');

  const token = createJWT(user.id, user.email);
  await updateLastLogin(email);

  return token;
}

export function createJWT(id: number, email: string): string {
  return jwt.sign({ id, email }, process.env.JWT_KEY!, { expiresIn: '1h' });
}

async function updateLastLogin(email: string): Promise<void> {
  const now = new Date();
  await DB.query('UPDATE users SET last_login = ? WHERE email = ?', [now, email]);
}

export async function updateUserPassword(userId: string, newPassword: string): Promise<void> {
  const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await DB.query('UPDATE users SET password_hash = ? WHERE id = ?', [hashed, userId]);
}

export async function updateUserEmail(userId: string, newEmail: string): Promise<void> {
  const [existing] = await DB.query('SELECT id FROM users WHERE email = ?', [newEmail]);
  if ((existing as any[]).length > 0) {
    throw new Error('EMAIL ALREADY REGISTERED');
  }
  await DB.query('UPDATE users SET email = ? WHERE id = ?', [newEmail, userId]);
}

export async function fetchUserInfo(email: string): Promise<{ id: number; email: string; username: string }> {
  const [rows] = await DB.query('SELECT id, email, username FROM users WHERE email = ?', [email]);
  const users = rows as any[];

  if (users.length === 0) {
    throw new Error('User not found');
  }

  return {
    id: users[0].id,
    email: users[0].email,
    username: users[0].username
  };
}

// === EXPRESS HANDLERS ===

export const updateUserPasswordHandler: RequestHandler = async (req, res) => {
  const { userId, newPassword } = req.body;

  if (!userId || !newPassword) {
    res.status(400).json({ error: 'Missing parameters' });
    return;
  }

  try {
    await updateUserPassword(userId, newPassword);
    res.status(200).json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('[Password Update Error]', err);
    res.status(500).json({ error: 'Failed to update password' });
  }
};

export const updateUserEmailHandler: RequestHandler = async (req, res) => {
  const { userId, newEmail } = req.body;

  if (!userId || !newEmail) {
    res.status(400).json({ error: 'Missing parameters' });
    return;
  }

  try {
    await updateUserEmail(userId, newEmail);
    res.status(200).json({ message: 'Email updated successfully' });
  } catch (err) {
    console.error('[Email Update Error]', err);
    res.status(500).json({ error: 'Failed to update email' });
  }
};

export const deleteUserHandler: RequestHandler = async (req, res) => {
  const { userId, adminUserId } = req.body;

  if (!userId) {
    res.status(400).json({ error: 'Missing userId' });
    return;
  }

  // If adminUserId is not provided, assume the user is deleting their own account
  const effectiveAdminUserId = adminUserId || parseInt(userId);

  try {
    await deleteUserFromDB(userId, effectiveAdminUserId);
    res.status(200).json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error('[User Deletion Error]', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};

// === USER SEARCH ===

export async function searchUsers(query: string, limit: number = 10): Promise<{ id: number; username: string }[]> {
  if (!query || query.length < 2) {
    return [];
  }

  const searchPattern = `%${query}%`;
  const [rows] = await DB.query(
    `SELECT id, username FROM users
     WHERE username LIKE ?
     ORDER BY username ASC
     LIMIT ?`,
    [searchPattern, limit]
  );

  return (rows as any[]).map(row => ({
    id: row.id,
    username: row.username
  }));
}

export const searchUsersHandler: RequestHandler = async (req, res) => {
  const user = (req as any).user;
  if (!user?.id) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { q, limit } = req.query;
  const query = String(q || '');
  const limitNum = Math.min(Math.max(parseInt(String(limit)) || 10, 1), 50);

  if (query.length < 2) {
    res.status(400).json({
      success: false,
      error: 'Query must be at least 2 characters'
    });
    return;
  }

  try {
    const users = await searchUsers(query, limitNum);
    res.json({
      success: true,
      data: {
        users,
        count: users.length,
        query
      }
    });
  } catch (err) {
    console.error('[User Search Error]', err);
    res.status(500).json({ success: false, error: 'Failed to search users' });
  }
};
