import { WebSocketServer, WebSocket } from 'ws';
import type { DeviceIdentity } from '../identity.js';
import { deriveDeviceIdFromPublicKey } from '../handshake.js';

export interface PeerHandlers {
  onPeerConnected(socket: WebSocket, deviceId: string): void;
  onError(error: Error): void;
}

export interface PeerServer {
  port: number;
  close(): void;
}

/**
 * Thin WebSocket listener: accepts connections, expects the first message
 * to be the peer's public key PEM, derives its Device ID and hands the
 * socket over. Real mTLS + session loop is a later integration batch.
 */
export function startPeerServer(
  identity: DeviceIdentity,
  handlers: PeerHandlers,
  port = 22000,
): PeerServer {
  const wss = new WebSocketServer({ port });
  wss.on('connection', (socket) => {
    const onMessage = (data: Buffer): void => {
      const pem = data.toString('utf8');
      let deviceId: string;
      try {
        deviceId = deriveDeviceIdFromPublicKey(pem);
      } catch {
        handlers.onError(new Error('invalid public key from peer'));
        socket.close();
        return;
      }
      socket.off('message', onMessage);
      handlers.onPeerConnected(socket, deviceId);
    };
    socket.on('message', onMessage);
  });
  wss.on('error', handlers.onError);

  return {
    port,
    close(): void {
      wss.close();
    },
  };
}
