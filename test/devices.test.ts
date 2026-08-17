import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSharedFolder, removeSharedFolder } from '../src/devices.js';

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
});
