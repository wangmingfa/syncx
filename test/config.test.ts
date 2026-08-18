import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig } from '../src/config.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'syncx-config-'));
}

describe('config store', () => {
  it('returns a default config when the file does not exist', () => {
    const dir = tempDir();

    const config = loadConfig(join(dir, 'config.json'));

    expect(config).toEqual({ sharedFolders: [], peers: [] });

    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a saved config', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');

    saveConfig(path, {
      sharedFolders: [
        {
          path: '/data/docs',
          devices: ['DEV1234567'],
        },
      ],
      peers: ['ws://192.168.1.10:22000'],
    });

    expect(loadConfig(path)).toEqual({
      sharedFolders: [{ path: '/data/docs', devices: ['DEV1234567'] }],
      peers: ['ws://192.168.1.10:22000'],
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      sharedFolders: [{ path: '/data/docs', devices: ['DEV1234567'] }],
      peers: ['ws://192.168.1.10:22000'],
    });

    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults missing peers to an empty list', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    saveConfig(path, { sharedFolders: [] });

    expect(loadConfig(path)).toEqual({ sharedFolders: [], peers: [] });

    rmSync(dir, { recursive: true, force: true });
  });
});
