import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { DeviceIdentity } from '../identity.js';
import { deriveDeviceIdFromPublicKey } from '../handshake.js';
import {
  buildKxMessage,
  decodeKxMessage,
  deriveSessionKey,
  generateX25519KeyPair,
  verifyKxMessage,
} from '../handshake.js';
import type { KxMessage } from '../handshake.js';

/** 单条 WebSocket 消息的最大字节数:索引/块传输的上限,防单条巨消息耗尽内存。 */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** 握手持久上限:连接后未在规定时间内完成密钥交换则断开,防半开连接堆积。 */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** 并发入站对端连接上限,防单点打开大量连接耗尽资源。 */
const MAX_PEER_CONNECTIONS = 64;

export interface PeerHandlers {
  /** 入站对端连上并完成握手。listenPort 为对端在 kx 中广播的监听端口(旧版可能为 undefined)。 */
  onPeerConnected(socket: WebSocket, deviceId: string, key: Buffer, listenPort?: number): void;
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
export interface PeerServerOptions {
  /** 并发入站连接上限,默认 64。 */
  maxConnections?: number;
  /** 握手超时(毫秒),默认 10000。 */
  handshakeTimeoutMs?: number;
  /** 单条消息最大字节数,默认 MAX_MESSAGE_BYTES(64MB)。 */
  maxPayloadBytes?: number;
}

export function startPeerServer(
  identity: DeviceIdentity,
  handlers: PeerHandlers,
  port = 22000,
  options: PeerServerOptions = {},
): PeerServer {
  const maxConnections = options.maxConnections ?? MAX_PEER_CONNECTIONS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const maxPayload = options.maxPayloadBytes ?? MAX_MESSAGE_BYTES;
  const wss = new WebSocketServer({ port, maxPayload });
  let activeConnections = 0;

  wss.on('connection', (socket) => {
    // 超出并发上限:直接断开,防止单点打开大量连接耗尽资源
    if (activeConnections >= maxConnections) {
      socket.terminate();
      return;
    }
    activeConnections++;

    // 单连接级错误(如超出 maxPayload、对端异常断连)若无人监听会触发
    // unhandled 'error' 并可能让进程崩溃;此处吞掉,连接清理交给 'close'。
    socket.on('error', () => {});

    let remotePublicKeyPem: string | undefined;
    let peerDeviceId: string | undefined;
    // 半开连接保护:握手未完成则超时断开
    const handshakeTimeout = setTimeout(() => socket.terminate(), handshakeTimeoutMs);
    socket.on('close', () => {
      activeConnections--;
      clearTimeout(handshakeTimeout);
    });

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
      // 回发 kx 时带上本机监听端口,让连接方(成为接收方时)也能反向发现并主动重连本机
      socket.send(encodeKx(buildKxMessage(sessionPair, identity.privateKey, port)));
      const key = deriveSessionKey(sessionPair.privateKeyPem, peerX25519Pem);

      socket.off('message', onMessage);
      clearTimeout(handshakeTimeout);
      handlers.onPeerConnected(socket, peerDeviceId!, key, kx.listenPort);
    };
    socket.on('message', onMessage);
  });
  wss.on('error', handlers.onError);

  // 端口被占用等导致监听失败时,address() 同步返回 null;直接读取会抛
  // "Cannot read properties of null" 的误导性 TypeError,无法定位根因。
  // 改为抛出清晰的端口不可用错误,并保留异步 EADDRINUSE 事件到 onError。
  const address = wss.address();
  if (address === null) {
    throw new Error(
      `peer server port ${port} is not available (EADDRINUSE: address already in use)`,
    );
  }

  return {
    port: (address as AddressInfo).port,
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

function encodeKx(kx: KxMessage): string {
  return JSON.stringify(kx);
}
