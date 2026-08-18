import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateIdentity } from '../src/identity.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'syncx-identity-'));
}

describe('device identity', () => {
  it('creates an identity on first start and persists it', () => {
    const dir = tempDir();

    const identity = loadOrCreateIdentity(dir);

    expect(identity.deviceId).toMatch(/^[A-Z2-7]{10}$/);
    expect(identity.publicKey).toBeTruthy();
    expect(identity.privateKey).toBeTruthy();
    expect(existsSync(join(dir, 'device.key'))).toBe(true);
    expect(readFileSync(join(dir, 'device.key'), 'utf8')).toContain('privateKey');

    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the same identity across restarts', () => {
    const dir = tempDir();

    const first = loadOrCreateIdentity(dir);
    const second = loadOrCreateIdentity(dir);

    expect(second.deviceId).toBe(first.deviceId);
    expect(second.privateKey).toBe(first.privateKey);
    expect(second.publicKey).toBe(first.publicKey);

    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the config directory when it does not exist', () => {
    const base = tempDir();
    const configDir = join(base, 'nested', 'config');

    const identity = loadOrCreateIdentity(configDir);

    expect(existsSync(join(configDir, 'device.key'))).toBe(true);
    expect(identity.deviceId).toMatch(/^[A-Z2-7]{10}$/);

    rmSync(base, { recursive: true, force: true });
  });
});
