// mirror-server/index.ts

import dotenv from "dotenv";
dotenv.config();
console.log("ENV LOADED: ", process.env.NODE_ENV);

import https from 'https';
import fs from 'fs';
import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
//import dotenv from 'dotenv';

import authRoutes from './routes/auth';
import {SetupWebSocket} from './wss/setupWSS'

// Load environment variables
dotenv.config();

const APP = express();
APP.use(express.json());
APP.use('/mirror/api/auth', authRoutes);

const PORT = process.env.MIRRORPORT || 8444;

const __DIRNAME = path.resolve()

const requiredEnvs = ['TUGRRPRIV', 'TUGRRCERT', 'TUGRRINTERCERT'];
for(const key of requiredEnvs){
	if(!process.env[key]){
		throw new Error(`Missing environment variable: ${key}`);
	}
}

// SSL Certificate loading
const PRIV = fs.readFileSync(process.env.TUGRRPRIV!, 'utf8');
const CERT = fs.readFileSync(process.env.TUGRRCERT!, 'utf8');
const INTERCERT = fs.readFileSync(process.env.TUGRRINTERCERT!, 'utf8');


const credentials = { key: PRIV, cert: CERT, ca: INTERCERT };
const httpsServer = https.createServer(credentials, APP);

// WebSocket setup
SetupWebSocket(httpsServer);

// Start listening
httpsServer.listen(PORT, () => {
    console.log(`✅ MIRROR SERVER LISTENING on port ${PORT}`);
});
