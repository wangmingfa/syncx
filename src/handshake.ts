import { createHash, sign, verify } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Derive the 10-character Device ID from an Ed25519 public key (PEM):
 * sha256 of the key, first 6 bytes, base32-encoded.
 */
export function deriveDeviceIdFromPublicKey(publicKeyPem: string): string {
  const hash = createHash('sha256').update(publicKeyPem).digest();
  let value = 0n;
  for (let i = 0; i < 6; i++) {
    value = (value << 8n) | BigInt(hash[i]!);
  }
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = BASE32[Number(value & 31n)]! + out;
    value >>= 5n;
  }
  return out;
}

export function signChallenge(privateKeyPem: string, challenge: Buffer): Buffer {
  return sign(null, challenge, privateKeyPem);
}

export function verifyChallenge(
  publicKeyPem: string,
  challenge: Buffer,
  signature: Buffer,
): boolean {
  return verify(null, challenge, publicKeyPem, signature);
}
