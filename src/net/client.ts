import { WebSocket } from 'ws';
import type { DeviceIdentity } from '../identity.js';

/**
 * Thin WebSocket client: opens a connection and immediately presents the
 * local public key PEM as the first message. Returns the open socket.
 */
export function connectPeer(identity: DeviceIdentity, url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => {
      socket.send(identity.publicKey);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}
