import { RequestHandler } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { DB } from '../db';

const SALT_ROUNDS = 12;

export const registerUser: RequestHandler = async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
      res.status(400).json({ error: 'ALL FIELDS ARE REQUIRED.' });
  }

  try {
    const [existing] = await DB.query('SELECT id FROM users WHERE email=?', [email]);
    if ((existing as any[]).length > 0) {
      res.status(409).json({ error: 'EMAIL ALREADY REGISTERED' });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    await DB.query(
      'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
      [username, email, hashedPassword]
    );

      res.status(201).json({ message: 'USER REGISTERED SUCCESSFULLY' });
  } catch (err) {
    console.error(err);
     res.status(500).json({ error: 'SERVER ERROR' });
  }
};

export const loginUser: RequestHandler = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'EMAIL AND PASSWORD ARE REQUIRED' });
  }

  try {
    const [rows] = await DB.query('SELECT * FROM users WHERE email=?', [email]);
    const user = (rows as any[])[0];

    if (!user) {
     res.status(401).json({ error: 'INVALID CREDENTIALS' });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
     res.status(401).json({ error: 'INVALID CREDENTIALS' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_KEY!,
      { expiresIn: '1h' }
    );

    res.status(200).json({ message: 'LOGIN SUCCESSFUL', token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'SERVER ERROR' });
  }
};
