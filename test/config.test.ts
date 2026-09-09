import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rmDir } from './helpers.js';
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

    expect(config).toEqual({ sharedFolders: [], peers: [], knownDevices: [], pendingOffers: [] });

    rmDir(dir);
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
      knownDevices: [],
      pendingOffers: [],
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      sharedFolders: [{ path: '/data/docs', devices: ['DEV1234567'] }],
      peers: ['ws://192.168.1.10:22000'],
    });

    rmDir(dir);
  });

  it('defaults missing peers to an empty list', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    saveConfig(path, { sharedFolders: [] });

    expect(loadConfig(path)).toEqual({ sharedFolders: [], peers: [], knownDevices: [], pendingOffers: [] });

    rmDir(dir);
  });

  it('normalizes legacy ::ffff:-mapped peer entries on load', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        sharedFolders: [],
        peers: ['ws://[::ffff:10.13.18.36]:22000', 'ws://10.13.18.36:22000'],
      }),
    );

    // 两条等价记录合并为一条纯 IPv4 形式
    expect(loadConfig(path).peers).toEqual(['ws://10.13.18.36:22000']);

    rmDir(dir);
  });

  it('keeps genuine IPv6 peers bracketed while normalizing host case', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        sharedFolders: [],
        peers: ['ws://[FE80::1]:22000', 'ws://[::1]:54949'],
      }),
    );

    expect(loadConfig(path).peers).toEqual(['ws://[fe80::1]:22000', 'ws://[::1]:54949']);

    rmDir(dir);
  });

  it('drops non-string and empty peer entries on load', () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        sharedFolders: [],
        // 故意写非法形态(绕过 TS 类型,模拟手改配置文件)
        peers: ['ws://10.0.0.2:22000', '', null, 'not-a-url'],
      } as unknown as Record<string, unknown>),
    );

    expect(loadConfig(path).peers).toEqual(['ws://10.0.0.2:22000', 'not-a-url']);

    rmDir(dir);
  });
});
