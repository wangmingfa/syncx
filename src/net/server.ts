import { WebSocketServer, WebSocket } from 'ws';
import type { DeviceIdentity } from '../identity.js';
import { deriveDeviceIdFromPublicKey } from '../handshake.js';
import {
  buildKxMessage,
  decodeKxMessage,
  deriveSessionKey,
  generateX25519KeyPair,
  verifyKxMessage,
} from '../handshake.js';

export interface PeerHandlers {
  onPeerConnected(socket: WebSocket, deviceId: string, key: Buffer): void;
  onError(error: Error): void;
}

export interface PeerServer {
  port: number;
  close(): void;
}

/**
 * WebSocket listener with a two-phase handshake: the peer first presents
 * its Ed25519 public key (PEM), then a signed X25519 key-exchange message.
 * Both sides end up with a shared AES-256-GCM session key; the socket is
 * handed over only after the key exchange completes.
 */
export function startPeerServer(
  identity: DeviceIdentity,
  handlers: PeerHandlers,
  port = 22000,
): PeerServer {
  const wss = new WebSocketServer({ port });
  wss.on('connection', (socket) => {
    let remotePublicKeyPem: string | undefined;
    let peerDeviceId: string | undefined;

    const onMessage = (data: Buffer): void => {
      const raw = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data as Buffer);
      const text = raw.toString('utf8');

      if (remotePublicKeyPem === undefined) {
        // 第一阶段:对端公钥 → 设备 ID
        let deviceId: string;
        try {
          deviceId = deriveDeviceIdFromPublicKey(text);
        } catch {
          handlers.onError(new Error('invalid public key from peer'));
          socket.close();
          return;
        }
        peerDeviceId = deviceId;
        remotePublicKeyPem = text;
        // 回发自己的公钥,让对端也能推导本机 Device ID
        socket.send(identity.publicKey);
        return;
      }

      // 第二阶段:签名后的 X25519 密钥交换
      let kx;
      let peerX25519Pem: string;
      try {
        kx = decodeKxMessage(text);
        peerX25519Pem = verifyKxMessage(kx, remotePublicKeyPem);
      } catch (error) {
        handlers.onError(error instanceof Error ? error : new Error('invalid key exchange'));
        socket.close();
        return;
      }

      const sessionPair = generateX25519KeyPair();
      socket.send(encodeKx(buildKxMessage(sessionPair, identity.privateKey)));
      const key = deriveSessionKey(sessionPair.privateKeyPem, peerX25519Pem);

      socket.off('message', onMessage);
      handlers.onPeerConnected(socket, peerDeviceId!, key);
    };
    socket.on('message', onMessage);
  });
  wss.on('error', handlers.onError);

  return {
    port,
    close(): void {
      // 先关闭所有客户端连接,否则 http server 的 close 会等待连接结束,
      // 导致 daemon 收到 SIGTERM 后进程挂起不退出
      for (const client of wss.clients) {
        client.close();
      }
      wss.close();
    },
  };
}

function encodeKx(kx: { type: 'kx'; x25519: string; sig: string }): string {
  return JSON.stringify(kx);
}
