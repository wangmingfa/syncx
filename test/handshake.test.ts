import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, createHash } from 'node:crypto';
import {
  deriveDeviceIdFromPublicKey,
  signChallenge,
  verifyChallenge,
  generateX25519KeyPair,
  x25519PublicDer,
  deriveSessionKey,
  buildKxMessage,
  verifyKxMessage,
  decodeKxMessage,
} from '../src/handshake.js';
import { connectPeer } from '../src/net/client.js';
import { startPeerServer } from '../src/net/server.js';
import { mkdtempSync } from 'node:fs';
import { rmDir } from './helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateIdentity } from '../src/identity.js';
import { WebSocketServer } from 'ws';
import { learnPeerUrl } from '../src/cli.js';

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

describe('handshake verification', () => {
  it('derives the same device id as the identity module', () => {
    const { publicKey } = makeKeypair();
    const deviceId = deriveDeviceIdFromPublicKey(publicKey);

    expect(deviceId).toMatch(/^[A-Z2-7]{10}$/);

    // 与 identity.ts 的派生算法一致(sha256 → base32 短码)
    const hash = createHash('sha256').update(publicKey).digest();
    let value = 0n;
    for (let i = 0; i < 6; i++) value = (value << 8n) | BigInt(hash[i]!);
    const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let expected = '';
    for (let i = 0; i < 10; i++) {
      expected = BASE32[Number(value & 31n)]! + expected;
      value >>= 5n;
    }
    expect(deviceId).toBe(expected);
  });

  it('verifies a challenge signature with the matching public key', () => {
    const { publicKey, privateKey } = makeKeypair();
    const challenge = Buffer.from('nonce-123');

    const signature = signChallenge(privateKey, challenge);
    expect(verifyChallenge(publicKey, challenge, signature)).toBe(true);
  });

  it('rejects a signature with a different public key', () => {
    const a = makeKeypair();
    const b = makeKeypair();
    const challenge = Buffer.from('nonce-123');

    const signature = signChallenge(a.privateKey, challenge);
    expect(verifyChallenge(b.publicKey, challenge, signature)).toBe(false);
  });

  it('rejects a signature for a different challenge', () => {
    const { publicKey, privateKey } = makeKeypair();

    const signature = signChallenge(privateKey, Buffer.from('nonce-123'));
    expect(verifyChallenge(publicKey, Buffer.from('nonce-999'), signature)).toBe(false);
  });
});

describe('session key exchange', () => {
  it('derives the same session key on both sides of the ECDH', () => {
    const a = generateX25519KeyPair();
    const b = generateX25519KeyPair();

    const keyA = deriveSessionKey(a.privateKeyPem, b.publicKeyPem);
    const keyB = deriveSessionKey(b.privateKeyPem, a.publicKeyPem);

    expect(keyA).toEqual(keyB);
    expect(keyA.length).toBe(32);
  });

  it('binds the kx message to the device identity with a valid signature', () => {
    const identity = makeKeypair();
    const session = generateX25519KeyPair();

    const kx = buildKxMessage(session, identity.privateKey);
    expect(kx.type).toBe('kx');

    const peerX25519Pem = verifyKxMessage(kx, identity.publicKey);
    expect(peerX25519Pem).toBe(session.publicKeyPem);
  });

  it('rejects a kx message signed by a different device', () => {
    const identityA = makeKeypair();
    const identityB = makeKeypair();
    const session = generateX25519KeyPair();

    const kx = buildKxMessage(session, identityA.privateKey);
    expect(() => verifyKxMessage(kx, identityB.publicKey)).toThrow('invalid key exchange');
  });

  it('rejects a tampered kx message', () => {
    const identity = makeKeypair();
    const session = generateX25519KeyPair();

    const kx = buildKxMessage(session, identity.privateKey);
    // 篡改 X25519 公钥字节(翻转首字节),签名校验应失败
    const der = x25519PublicDer(session.publicKeyPem);
    der[0] ^= 0xff;
    const tampered = { ...kx, x25519: der.toString('base64') };
    expect(() => verifyKxMessage(tampered, identity.publicKey)).toThrow();
  });

  it('round-trips the listenPort field for reverse peer discovery', () => {
    const identity = makeKeypair();
    const session = generateX25519KeyPair();

    const kx = buildKxMessage(session, identity.privateKey, 22000);
    expect(kx.listenPort).toBe(22000);

    // 序列化后仍能被解码并校验,且 listenPort 保持
    const decoded = decodeKxMessage(JSON.stringify(kx));
    expect(decoded.listenPort).toBe(22000);
    expect(verifyKxMessage(decoded, identity.publicKey)).toBe(session.publicKeyPem);
  });

  it('omits listenPort when not provided (backward compatible)', () => {
    const identity = makeKeypair();
    const session = generateX25519KeyPair();

    const kx = buildKxMessage(session, identity.privateKey);
    expect(kx.listenPort).toBeUndefined();

    const decoded = decodeKxMessage(JSON.stringify(kx));
    expect(decoded.listenPort).toBeUndefined();
  });
});

describe('connectPeer handshake', () => {
  /** 完整两阶段握手的测试服务端:回发公钥 → 校验并回发 kx。 */
  function startTestPeerServer(): Promise<{ port: number; close(): Promise<void> }> {
    const serverIdentity = makeKeypair();
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    return new Promise((resolve) => {
      wss.on('listening', () =>
        resolve({
          port: (wss.address() as { port: number }).port,
          close: () => new Promise<void>((r) => wss.close(() => r())),
        }),
      );
      wss.on('connection', (socket) => {
        let sentKey = false;
        socket.on('message', (data) => {
          const text = Buffer.from(data as Buffer).toString('utf8');
          if (!sentKey) {
            sentKey = true;
            socket.send(serverIdentity.publicKey);
            return;
          }
          const sessionPair = generateX25519KeyPair();
          socket.send(JSON.stringify(buildKxMessage(sessionPair, serverIdentity.privateKey)));
        });
      });
    });
  }

  it('cleans up the handshake error listener after a successful handshake', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-client-'));
    const identity = loadOrCreateIdentity(dir);
    const server = await startTestPeerServer();

    const { socket } = await connectPeer(identity, `ws://127.0.0.1:${server.port}`);

    // 修复前:解析后仍遗留 once('error') 监听(对已 settle 的 promise 无害,
    // 但属清理项);修复后 error 监听应被移除
    expect(socket.listenerCount('error')).toBe(0);

    socket.close();
    await server.close();
    rmDir(dir);
  });

  it('cleans up the handshake message listener after a successful handshake', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-client-'));
    const identity = loadOrCreateIdentity(dir);
    const server = await startTestPeerServer();

    const { socket } = await connectPeer(identity, `ws://127.0.0.1:${server.port}`);

    // 修复前:主 message 处理器在 resolve 后仍是永久 no-op 监听(对每条
    // 对端连接挂一个永不工作的处理器);修复后应被移除
    expect(socket.listenerCount('message')).toBe(0);

    socket.close();
    await server.close();
    rmDir(dir);
  });

  it('rejects when the peer closes the socket mid-handshake', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-client-'));
    const identity = loadOrCreateIdentity(dir);
    const { publicKey } = makeKeypair();

    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
    const port = (wss.address() as { port: number }).port;

    let gotConnection = false;
    wss.on('connection', (socket) => {
      gotConnection = true;
      socket.on('message', (data) => {
        // 对端在第一阶段发公钥后,服务器直接关闭连接(模拟握手超时/异常断连)
        socket.terminate();
      });
      socket.send(publicKey);
    });

    await expect(connectPeer(identity, `ws://127.0.0.1:${port}`)).rejects.toBeDefined();
    expect(gotConnection).toBe(true);

    await new Promise<void>((resolve) => wss.close(() => resolve()));
    rmDir(dir);
  });
});

describe('peer server reverse discovery (listenPort)', () => {
  it('passes the connecting peer listenPort to onPeerConnected', async () => {
    const serverDir = mkdtempSync(join(tmpdir(), 'syncx-srv-'));
    const clientDir = mkdtempSync(join(tmpdir(), 'syncx-cli-'));
    const serverIdentity = loadOrCreateIdentity(serverDir);
    const clientIdentity = loadOrCreateIdentity(clientDir);

    let receivedPort: number | undefined;
    const server = startPeerServer(
      serverIdentity,
      {
        onPeerConnected: (_socket, _deviceId, _key, listenPort) => {
          receivedPort = listenPort;
        },
        onError: () => {},
      },
      0,
    );

    const peer = await connectPeer(clientIdentity, `ws://127.0.0.1:${server.port}`, 22000);
    // 等待 server 侧握手完成的回调触发
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedPort).toBe(22000);

    peer.socket.close();
    server.close();
    rmDir(serverDir);
    rmDir(clientDir);
  });

  it('passes undefined listenPort when the client omits it (old peer)', async () => {
    const serverDir = mkdtempSync(join(tmpdir(), 'syncx-srv-'));
    const clientDir = mkdtempSync(join(tmpdir(), 'syncx-cli-'));
    const serverIdentity = loadOrCreateIdentity(serverDir);
    const clientIdentity = loadOrCreateIdentity(clientDir);

    let receivedPort: number | undefined;
    const server = startPeerServer(
      serverIdentity,
      {
        onPeerConnected: (_socket, _deviceId, _key, listenPort) => {
          receivedPort = listenPort;
        },
        onError: () => {},
      },
      0,
    );

    // 旧版客户端不广播 listenPort
    const peer = await connectPeer(clientIdentity, `ws://127.0.0.1:${server.port}`);
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedPort).toBeUndefined();

    peer.socket.close();
    server.close();
    rmDir(serverDir);
    rmDir(clientDir);
  });
});

describe('learnPeerUrl address normalization', () => {
  it('strips the ::ffff: IPv4-mapped IPv6 prefix (dual-stack peer server)', () => {
    const sock = { remoteAddress: '::ffff:172.25.48.139' } as unknown as WebSocket;
    expect(learnPeerUrl(sock, 22000)).toBe('ws://172.25.48.139:22000');
  });

  it('normalizes a bracketed ::ffff: address to bare IPv4', () => {
    const sock = { remoteAddress: '[::ffff:172.25.48.139]' } as unknown as WebSocket;
    expect(learnPeerUrl(sock, 22000)).toBe('ws://172.25.48.139:22000');
  });

  it('keeps a bare IPv4 address unchanged', () => {
    const sock = { remoteAddress: '10.13.18.36' } as unknown as WebSocket;
    expect(learnPeerUrl(sock, 22000)).toBe('ws://10.13.18.36:22000');
  });

  it('brackets a true IPv6 address', () => {
    const sock = { remoteAddress: '2001:db8::1' } as unknown as WebSocket;
    expect(learnPeerUrl(sock, 22000)).toBe('ws://[2001:db8::1]:22000');
  });

  it('falls back to the underlying _socket.remoteAddress', () => {
    const sock = { _socket: { remoteAddress: '::ffff:192.168.1.5' } } as unknown as WebSocket;
    expect(learnPeerUrl(sock, 22000)).toBe('ws://192.168.1.5:22000');
  });

  it('returns undefined for an invalid listen port', () => {
    const sock = { remoteAddress: '::ffff:172.25.48.139' } as unknown as WebSocket;
    expect(learnPeerUrl(sock, 0)).toBeUndefined();
    expect(learnPeerUrl(sock, 70000)).toBeUndefined();
    expect(learnPeerUrl(sock, undefined)).toBeUndefined();
  });

  it('returns undefined when no remote address is available', () => {
    const sock = {} as unknown as WebSocket;
    expect(learnPeerUrl(sock, 22000)).toBeUndefined();
  });
});
