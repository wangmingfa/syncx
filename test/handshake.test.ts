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
} from '../src/handshake.js';
import { connectPeer } from '../src/net/client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateIdentity } from '../src/identity.js';
import { WebSocketServer } from 'ws';

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
});

describe('connectPeer handshake', () => {
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
    rmSync(dir, { recursive: true, force: true });
  });
});
