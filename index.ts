// index.ts

import https from 'https';
import fs from 'fs';
import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import dotenv from 'dotenv';

// ROUTES
import authRoutes from './routes/auth';
import userRoutes from './routes/user';
import storageRoutes from './routes/storage';
import debugRoutes from './routes/debug';
import intakeRoutes from './routes/intake';
import dashboardRoutes from './routes/dashboard';

// WEBSOCKET
import { SetupWebSocket } from './wss/setupWSS';

// ✅ 1. Load environment variables
dotenv.config();

// ✅ 2. Validate required environment variables
const requiredEnvs = ['TUGRRPRIV', 'TUGRRCERT', 'TUGRRINTERCERT', 'MIRRORPORT', 'MIRRORSTORAGE', 'JWT_KEY'];
for (const key of requiredEnvs) {
  if (!process.env[key]) {
    throw new Error(`❌ Missing environment variable: ${key}`);
  }
}

// ✅ 3. Create and configure Express
const APP = express();

// ✅ IMPORTANT: express.json() MUST come before any middleware that reads req.body
// This middleware parses incoming JSON requests and populates req.body
APP.use(express.json());

// ✅ Custom logging middleware: Now it will run after express.json()
// So req.body will be populated if the request has a JSON body.
APP.use((req, res, next) => {
  console.log(`[DEBUG] Incoming ${req.method} request to ${req.url}`);
  console.log(`[DEBUG] Headers:`, req.headers);

  // If you still need the raw body for some reason, you'd need to buffer it differently
  // or use a library that provides it after parsing.
  // For debugging parsed body
  console.log('[DEBUG] Parsed Body:', req.body);

  next();
});

// ✅ 4. Setup routes
APP.use('/mirror/api/auth', authRoutes);
APP.use('/mirror/api/user', userRoutes);
APP.use('/mirror/api/storage', storageRoutes);
APP.use('/mirror/api/debug', debugRoutes);
APP.use('/mirror/api/intake', intakeRoutes);
APP.use('/mirror/api/dashboard', dashboardRoutes);

// ✅ 5. SSL certificate loading
const PRIV = fs.readFileSync(process.env.TUGRRPRIV!, 'utf8');
const CERT = fs.readFileSync(process.env.TUGRRCERT!, 'utf8');
const INTERCERT = fs.readFileSync(process.env.TUGRRINTERCERT!, 'utf8');

const credentials = {
  key: PRIV,
  cert: CERT,
  ca: INTERCERT,
};

// ✅ 6. Create HTTPS server
const httpsServer = https.createServer(credentials, APP);

// ✅ 7. Setup WebSocket layer
SetupWebSocket(httpsServer);

// ✅ 8. Start listening
const PORT = parseInt(process.env.MIRRORPORT || '8444');
httpsServer.listen(PORT, () => {
  console.log(`✅ MIRROR SERVER LISTENING on port ${PORT}`);
});
