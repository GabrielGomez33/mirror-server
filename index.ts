// mirror-server/index.ts

import https from 'https';
import fs from 'fs';
import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const APP = express();
const PORT = process.env.MIRRORPORT || 8444;

// SSL Certificate loading
const PRIV = fs.readFileSync(process.env.TUGRRPRIV!, 'utf8');
const CERT = fs.readFileSync(process.env.TUGRRCERT!, 'utf8');
const INTERCERT = fs.readFileSync(process.env.TUGRRINTERCERT!, 'utf8');

const credentials = { key: PRIV, cert: CERT, ca: INTERCERT };
const httpsServer = https.createServer(credentials, APP);

// WebSocket setup
const WSS = new WebSocketServer({ server: httpsServer });

WSS.on('connection', (ws, req) => {
    const protocol = req.headers['sec-websocket-protocol'];
    const clientType = protocol === 'Mirror' ? 'Mirror' : 'Intruder';

    if (clientType === 'Mirror') {
        console.log('🔐 Mirror client connected');
        // Here you can initialize session keys, etc.
    } else {
        console.warn('🚨 Intruder WebSocket attempt — closing');
        ws.close();
    }
});

// Start listening
httpsServer.listen(PORT, () => {
    console.log(`✅ MIRROR SERVER LISTENING on port ${PORT}`);
});
