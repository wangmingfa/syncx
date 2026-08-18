import { generateKeyPairSync, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const IDENTITY_FILE = 'device.key';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface DeviceIdentity {
  deviceId: string;
  publicKey: string;
  privateKey: string;
}

function deriveDeviceId(publicKeyPem: string): string {
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

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    deviceId: deriveDeviceId(publicKey),
    publicKey,
    privateKey,
  };
}

/**
 * Load the device identity from `configDir`, creating and persisting
 * a fresh Ed25519 keypair on first start.
 */
export function loadOrCreateIdentity(configDir: string): DeviceIdentity {
  mkdirSync(configDir, { recursive: true });
  const file = join(configDir, IDENTITY_FILE);
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, 'utf8')) as DeviceIdentity;
  }
  const identity = generateIdentity();
  writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}
