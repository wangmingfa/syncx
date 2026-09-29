import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
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
  /**
   * 复用调用方**已经监听**的 http server(测试用 `startLoopbackPeerServer` 传,生产不传)。
   *
   * 传了 `server` 就不再自己 bind:升级事件挂到这台 server 上,`address()` 同步可得,
   * `close()` 连同它一起关掉(所有权交给 PeerServer,否则测试会漏监听)。
   *
   * 为什么测试必须这么绕:不传时 ws 把端口绑在 `::`(双栈)。双栈绑定的环回流量**不算被独占**
   * ——macOS 允许另一个进程随后补绑同端口号的 `127.0.0.1`,而且补上来的那个更具体的 v4 绑定
   * 会接走环回连接。于是测试客户端 `ws://127.0.0.1:P` 连到的是别人的服务,拿到一句
   * `Unexpected server response: 404`(内核只会为 `listen(0)` 避让**当时已被占**的 v4 端口,
   * 不保证这个端口号之后也不被别人占)。绑在 `127.0.0.1` 上就是真独占:同端口再绑直接 EADDRINUSE。
   */
  server?: HttpServer;
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
  // 注入 server 时不 bind:所有权在调用方那边,它已经监听好了(见 PeerServerOptions.server)
  const wss = options.server
    ? new WebSocketServer({ server: options.server, maxPayload })
    : new WebSocketServer({ port, maxPayload });
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

  // 极少数绑定失败(如端口参数非法)会让 wss.address() 同步返回 null;直接读取会抛
  // "Cannot read properties of null" 的误导性 TypeError,无法定位根因。这里兜底抛清晰错误。
  // 注意:EADDRINUSE 是 listen 之后异步以 'error' 事件抵达,address() 此时仍返回请求端口的
  // AddressInfo,故不会走到这里——该错误经 wss.on('error', handlers.onError) 上报,见下。
  const address = wss.address();
  if (address === null) {
    throw new Error(`peer server port ${port} is not available`);
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
      // 注入进来的 server 由 ws 之外持有:wss.close() 不会关它,不关就漏一个监听
      // (测试收尾后 vitest 会因为还有活动 handle 而不退出)。
      options.server?.close();
    },
  };
}

function encodeKx(kx: KxMessage): string {
  return JSON.stringify(kx);
}
