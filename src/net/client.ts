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
  /**
   * 取走握手完成后、消息分发器挂上之前「抢先到达」的帧,并停止缓冲。
   *
   * 背景(偶发丢邀请的根因):服务端在 kx 应答的**同一 tick** 里还会连发
   * hello / folder-invitation / folder-sync-list,这些帧常与 kx 应答同批到达。
   * 客户端若在此窗口无任何 'message' 监听,帧会被静默丢弃(EventEmitter 无监听即丢),
   * 而恢复分发要等 connectPeer 的 .then 微任务 → startSyncSession → attachPeerMessages。
   * 修复:握手完成的瞬间转入缓冲模式暂存抢先帧;分发器挂载时经本回调一次性取走回放。
   * 必须调用,否则缓冲会随对端持续推送而无界增长。
   */
  takePendingFrames: () => Buffer[];
}

/**
 * WebSocket client handshake: presents the local Ed25519 public key, waits
 * for the server's key, then performs a signed X25519 key exchange so both
 * sides share an AES-256-GCM session key.
 *
 * @param listenPort 本机 peer 监听端口(可选)。写在 kx 消息里让接收方结合源 IP
 *   拼出反向连接地址,实现「只填一方地址,另一方也能主动重连」。
 */
export function connectPeer(
  identity: DeviceIdentity,
  url: string,
  listenPort?: number,
): Promise<ConnectedPeer> {
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
      const text = toBuffer(data).toString('utf8');

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
        socket.send(encodeKx(buildKxMessage(sessionPair, identity.privateKey, listenPort)));

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
          // 分发器挂上前服务端同 tick 连发的帧不能丢:立即转入缓冲模式。
          // kx 帧的 emit 只快照了当时的监听者,本监听会接管同一批里的后续帧。
          const pending: Buffer[] = [];
          const bufferMessage = (data: Buffer | ArrayBuffer): void => {
            pending.push(toBuffer(data));
          };
          socket.on('message', bufferMessage);
          resolve({
            socket,
            remoteDeviceId,
            key: deriveSessionKey(sessionPair.privateKeyPem, peerX25519Pem),
            takePendingFrames: () => {
              socket.off('message', bufferMessage);
              return pending.splice(0, pending.length);
            },
          });
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

/** ws 'message' 事件的负载在不同二进制片段下可能是 Buffer/ArrayBuffer/TypedArray,统一成 Buffer。 */
function toBuffer(data: Buffer | ArrayBuffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
