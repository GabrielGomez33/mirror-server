// wss/setupWSS.ts

import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import * as https from 'https' // ✅ CORRECT

export function SetupWebSocket(server: https.Server): void {
  const WSS = new WebSocketServer({ server })

  WSS.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const protocol = req.headers['sec-websocket-protocol']
    const clientType = protocol === 'Mirror' ? 'Mirror' : 'Intruder'

    if (clientType === 'Mirror') {
      console.log('Mirror client connected')
    } else {
      console.warn('Intruder WebSocket attempt. Closing connection')
      ws.close()
    }
  })
}
