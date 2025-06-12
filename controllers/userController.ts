// controllers/userControllers.ts

import bcrypt from 'bcrypt';
import path from 'path';
import jwt from 'jsonwebtoken';
import { RequestHandler } from 'express';
import { DB } from '../db';
import { generateUserKeys } from './encryptionController';
import { createUserDirectories, deleteUserDirectories } from './directoryController';

const basePath = path.join(process.env.MIRRORSTORAGE!);
const storagePath = path.join(basePath,'users');
const SALT_ROUNDS = 10;

// === CORE LOGIC FUNCTIONS ===

export async function createUserInDB(username: string, email: string, password: string): Promise<void> {
  console.log(`[CreateUserInDb()]: Attempting to create account for ${username}`);

  const [existing] = await DB.query('SELECT id FROM users WHERE email=?', [email]);
  if ((existing as any[]).length > 0) {
    throw new Error('EMAIL ALREADY REGISTERED');
  }

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
  const result: any = await DB.query(
    'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
    [username, email, hashedPassword]
  );

  const userInfo = await fetchUserInfo(email);
  console.log(`[User Info] -> ${userInfo.id}`);
  
  const userId = userInfo.id.toString();
  await createUserDirectories(userId,storagePath);
  await generateUserKeys(userId,storagePath);
}

export async function deleteUserData(userId: string): Promise<void> {
  await DB.query('DELETE FROM users WHERE id = ?', [userId]);
  await deleteUserDirectories(userId, basePath);
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

export async function fetchUserInfo(email: string): Promise<{ id: number; email: string }> {
  const [rows] = await DB.query('SELECT * FROM users WHERE email = ?', [email]);
  const user = (rows as any[])[0];

  if (!user) throw new Error('INVALID CREDENTIALS');

  return { id: user.id, email: user.email };
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
  const { userId } = req.body;

  if (!userId) {
    res.status(400).json({ error: 'Missing userId' });
    return;
  }

  try {
    await deleteUserData(userId);
    res.status(200).json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error('[User Deletion Error]', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};
