import { WebSocket } from 'ws';
import type { DeviceIdentity } from '../identity.js';
import { deriveDeviceIdFromPublicKey } from '../handshake.js';

export interface ConnectedPeer {
  socket: WebSocket;
  remoteDeviceId: string;
}

/**
 * Thin WebSocket client: opens a connection, presents the local public key
 * PEM as the first message, then waits for the server's public key so both
 * sides know each other's Device ID.
 */
export function connectPeer(identity: DeviceIdentity, url: string): Promise<ConnectedPeer> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('error', reject);
    socket.once('open', () => {
      socket.send(identity.publicKey);
    });
    socket.once('message', (data) => {
      const pem = data.toString('utf8');
      let remoteDeviceId: string;
      try {
        remoteDeviceId = deriveDeviceIdFromPublicKey(pem);
      } catch (error) {
        reject(error);
        socket.close();
        return;
      }
      resolve({ socket, remoteDeviceId });
    });
  });
}
