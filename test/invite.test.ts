import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createInviteCode, parseInviteCode, INVITE_TTL_MS } from '../src/invite.js';
import type { DeviceIdentity } from '../src/identity.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const identity: DeviceIdentity = {
  deviceId: 'ABCDEFGHIJ',
  publicKey,
  privateKey,
};

describe('invite codes', () => {
  it('creates a code that parses back to the invite payload', () => {
    const code = createInviteCode(identity, '/data/docs', 1_000_000);
    const invite = parseInviteCode(code, 1_000_000);

    expect(invite.deviceId).toBe('ABCDEFGHIJ');
    expect(invite.folder).toBe('/data/docs');
    expect(invite.ts).toBe(1_000_000);
  });

  it('rejects a tampered payload', () => {
    const code = createInviteCode(identity, '/data/docs', 1_000_000);
    // 篡改邀请码中的目录路径
    const decoded = Buffer.from(code, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    const payload = JSON.parse(parsed.payload);
    payload.folder = '/evil';
    parsed.payload = JSON.stringify(payload);
    const tampered = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url');

    expect(() => parseInviteCode(tampered, 1_000_000)).toThrow('signature');
  });

  it('rejects expired codes', () => {
    const code = createInviteCode(identity, '/data/docs', 1_000_000);
    expect(() => parseInviteCode(code, 1_000_000 + INVITE_TTL_MS + 1)).toThrow('expired');
  });

  it('rejects garbage input', () => {
    expect(() => parseInviteCode('not-a-code')).toThrow();
  });
});
