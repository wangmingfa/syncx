import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rmDir } from './helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSharedFolder, removeSharedFolder, isPeerAllowed, addPeer, removePeer } from '../src/devices.js';
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
    expect(raw.sharedFolders).toHaveLength(1);
    expect(raw.sharedFolders[0]).toMatchObject({ path: '/data/docs', devices: ['DEV1234567'] });
    expect(raw.sharedFolders[0].id).toMatch(/^[0-9a-f]{12}$/);

    rmDir(dir);
  });

  it('appends a shared folder to an existing config', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    addSharedFolder(configPath, '/data/docs', ['DEV1234567']);

    addSharedFolder(configPath, '/data/photos', ['DEV1234567', 'DEVABCDEFG']);

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.sharedFolders).toHaveLength(2);
    expect(raw.sharedFolders[1]).toMatchObject({
      path: '/data/photos',
      devices: ['DEV1234567', 'DEVABCDEFG'],
    });
    expect(raw.sharedFolders[1].id).toMatch(/^[0-9a-f]{12}$/);

    rmDir(dir);
  });

  it('removes a shared folder by path', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');
    addSharedFolder(configPath, '/data/docs', ['DEV1234567']);
    addSharedFolder(configPath, '/data/photos', ['DEV1234567']);

    removeSharedFolder(configPath, '/data/docs');

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.sharedFolders).toHaveLength(1);
    expect(raw.sharedFolders[0]).toMatchObject({ path: '/data/photos', devices: ['DEV1234567'] });
    expect(raw.sharedFolders[0].id).toMatch(/^[0-9a-f]{12}$/);

    rmDir(dir);
  });

  it('rejects a relative path', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    expect(() => addSharedFolder(configPath, 'relative/path', ['DEV1234567'])).toThrow('must be absolute');
    expect(() => addSharedFolder(configPath, './relative', ['DEV1234567'])).toThrow('must be absolute');

    rmDir(dir);
  });

  it.skipIf(process.platform === 'win32')('rejects system and privacy-sensitive paths', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    expect(() => addSharedFolder(configPath, '/etc', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/etc/nginx', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/usr/local', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/root/.ssh', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.ssh', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.gnupg', ['DEV1234567'])).toThrow('not allowed');
    // 变体目录名(如 .ssh2)不得绕过黑名单
    expect(() => addSharedFolder(configPath, '/home/user/.ssh2', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.ssh2/keys', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.aws', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.kube', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.docker', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.local', ['DEV1234567'])).toThrow('not allowed');
    expect(() => addSharedFolder(configPath, '/home/user/.cache', ['DEV1234567'])).toThrow('not allowed');

    rmDir(dir);
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

  it('allows a pasted known device even with no shared folders (Syncthing-style device introduction)', () => {
    expect(isPeerAllowed('KK', [], [{ id: 'KK' }])).toBe(true);
    // 未知设备仍拒绝
    expect(isPeerAllowed('ZZ', [], [{ id: 'KK' }])).toBe(false);
    // 未传 knownDevices 时退回仅目录授权(空 knownDevices 默认拒绝)
    expect(isPeerAllowed('KK', [])).toBe(false);
  });

  it('rejects empty peer id', () => {
    expect(isPeerAllowed('', folders)).toBe(false);
  });
});

describe('manual peer address (addPeer)', () => {
  it('appends a ws:// peer address to config.peers', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    addPeer(configPath, 'ws://10.13.18.36:22000');

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.peers).toEqual(['ws://10.13.18.36:22000']);

    rmDir(dir);
  });

  it('is idempotent for the same address', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    addPeer(configPath, 'ws://172.25.48.139:22000');
    addPeer(configPath, 'ws://172.25.48.139:22000');

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.peers).toEqual(['ws://172.25.48.139:22000']);

    rmDir(dir);
  });

  it('rejects a non-ws:// address', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    expect(() => addPeer(configPath, 'http://10.13.18.36:22000')).toThrow('ws://');
    expect(() => addPeer(configPath, '10.13.18.36:22000')).toThrow('ws://');

    rmDir(dir);
  });

  it('removePeer deletes the exact address and is idempotent', () => {
    const dir = tempDir();
    const configPath = join(dir, 'config.json');

    addPeer(configPath, 'ws://10.13.18.36:22000');
    addPeer(configPath, 'ws://172.25.48.139:22000');

    removePeer(configPath, 'ws://10.13.18.36:22000');
    let raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.peers).toEqual(['ws://172.25.48.139:22000']);

    // 幂等:删除不存在的地址不应报错,也不改变配置
    removePeer(configPath, 'ws://10.13.18.36:22000');
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.peers).toEqual(['ws://172.25.48.139:22000']);

    rmDir(dir);
  });
});
