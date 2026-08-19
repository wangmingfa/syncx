import { WebSocket } from 'ws';
import type { DeviceIdentity } from '../identity.js';
import { deriveDeviceIdFromPublicKey } from '../handshake.js';
import {
  buildKxMessage,
  decodeKxMessage,
  deriveSessionKey,
  generateX25519KeyPair,
  verifyKxMessage,
} from '../handshake.js';

export interface ConnectedPeer {
  socket: WebSocket;
  remoteDeviceId: string;
  /** AES-256-GCM 会话密钥(协商完成后可用)。 */
  key: Buffer;
}

/**
 * WebSocket client handshake: presents the local Ed25519 public key, waits
 * for the server's key, then performs a signed X25519 key exchange so both
 * sides share an AES-256-GCM session key.
 */
export function connectPeer(identity: DeviceIdentity, url: string): Promise<ConnectedPeer> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const settle = (): void => {
      settled = true;
      socket.off('close', onSocketClose);
      socket.off('error', onSocketError);
      socket.off('message', onMainMessage);
    };

    const onSocketError = (err: Error): void => {
      settle();
      reject(err);
    };

    const onSocketClose = (): void => {
      if (!settled) {
        reject(new Error('peer closed connection during handshake'));
      }
    };

    socket.once('error', onSocketError);
    socket.on('close', onSocketClose);
    socket.once('open', () => {
      socket.send(identity.publicKey);
    });

    let remotePublicKeyPem: string | undefined;

    const onMainMessage = (data: Buffer): void => {
      const raw = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data as Buffer);
      const text = raw.toString('utf8');

      if (remotePublicKeyPem === undefined) {
        // 第一阶段:服务端公钥 → 设备 ID,然后发起密钥交换
        let remoteDeviceId: string;
        try {
          remoteDeviceId = deriveDeviceIdFromPublicKey(text);
        } catch (error) {
          settle();
          reject(error);
          socket.close();
          return;
        }
        remotePublicKeyPem = text;

        const sessionPair = generateX25519KeyPair();
        socket.send(encodeKx(buildKxMessage(sessionPair, identity.privateKey)));

        // 等待服务端的 kx 消息
        const onKx = (kxData: Buffer): void => {
          let peerX25519Pem: string;
          try {
            peerX25519Pem = verifyKxMessage(
              decodeKxMessage(kxData.toString('utf8')),
              remotePublicKeyPem!,
            );
          } catch (error) {
            settle();
            reject(error);
            socket.close();
            return;
          }
          settle();
          resolve({ socket, remoteDeviceId, key: deriveSessionKey(sessionPair.privateKeyPem, peerX25519Pem) });
        };
        socket.once('message', (kxData: Buffer) => onKx(kxData));
        return;
      }
    };
    socket.on('message', onMainMessage);
  });
}

function encodeKx(kx: { type: 'kx'; x25519: string; sig: string }): string {
  return JSON.stringify(kx);
}
