import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSharedFolder, removeSharedFolder, isPeerAllowed } from '../src/devices.js';
import type { SharedFolderConfig } from '../src/config.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'syncx-devices-'));
}

describe('shared folder configuration', () => {
  it('adds a shared folder to an empty config', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    addSharedFolder(configPath, '/data/docs', ['DEV1234567']);

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.sharedFolders).toEqual([{ path: '/data/docs', devices: ['DEV1234567'] }]);

    rmSync(dir, { recursive: true, force: true });
  });

  it('appends a shared folder to an existing config', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    addSharedFolder(configPath, '/data/docs', ['DEV1234567']);

    addSharedFolder(configPath, '/data/photos', ['DEV1234567', 'DEVABCDEFG']);

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.sharedFolders).toHaveLength(2);
    expect(raw.sharedFolders[1]).toEqual({
      path: '/data/photos',
      devices: ['DEV1234567', 'DEVABCDEFG'],
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('removes a shared folder by path', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    addSharedFolder(configPath, '/data/docs', ['DEV1234567']);
    addSharedFolder(configPath, '/data/photos', ['DEV1234567']);

    removeSharedFolder(configPath, '/data/docs');

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.sharedFolders).toEqual([{ path: '/data/photos', devices: ['DEV1234567'] }]);

    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a relative path', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    expect(() => addSharedFolder(configPath, 'relative/path', ['DEV1234567'])).toThrow('must be absolute');
    expect(() => addSharedFolder(configPath, './relative', ['DEV1234567'])).toThrow('must be absolute');

    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects system and privacy-sensitive paths', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    expect(() => addSharedFolder(configPath, '/etc', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/etc/nginx', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/usr/local', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/root/.ssh', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.ssh', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.gnupg', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.aws', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.kube', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.docker', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.local', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.cache', ['DEV1234567'])).toThrow('not allowed');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('isPeerAllowed', () => {
  const folders: SharedFolderConfig[] = [
    { path: '/docs', devices: ['AA', 'BB'] },
    { path: '/pics', devices: ['BB', 'CC'] },
  ];

  it('allows a peer matching any shared folder devices list', () => {
    expect(isPeerAllowed('AA', folders)).toBe(true);
    expect(isPeerAllowed('BB', folders)).toBe(true);
    expect(isPeerAllowed('CC', folders)).toBe(true);
  });

  it('rejects a peer not present in any devices list', () => {
    expect(isPeerAllowed('XX', folders)).toBe(false);
  });

  it('rejects when sharedFolders is empty', () => {
    expect(isPeerAllowed('AA', [])).toBe(false);
  });

  it('rejects empty peer id', () => {
    expect(isPeerAllowed('', folders)).toBe(false);
  });
});
