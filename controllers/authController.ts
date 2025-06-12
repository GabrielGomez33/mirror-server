// controllers/authController.ts
import { RequestHandler } from 'express';
import { createUserInDB, userLogin } from './userController';

export const registerUser: RequestHandler = async (req, res) => {
  console.log('[DEBUG] req.body', req.body);
	
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    res.status(400).json({ error: 'All fields are required.' });
    return;
  }

  try {
    await createUserInDB(username, email, password);
    res.status(201).json({ message: 'User registered successfully.' });
  } catch (err) {
    console.error('[REGISTRATION ERROR]', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
};

export const loginUser: RequestHandler = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }

  try {
    const token = await userLogin(email, password);
    res.status(200).json({ message: 'Login successful.', token });
  } catch (err) {
    console.error('[LOGIN ERROR]', err);
    res.status(401).json({ error: 'Invalid credentials.' });
  }
};
