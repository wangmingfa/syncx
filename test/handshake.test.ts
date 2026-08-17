import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { deriveDeviceIdFromPublicKey, signChallenge, verifyChallenge } from '../src/handshake.js';

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
