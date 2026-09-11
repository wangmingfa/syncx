import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { receiveOffer, listPendingOffers, findPendingOffer, markOfferAccepted, markOfferDeclined } from '../src/offers.js';
import type { Config } from '../src/config.js';

function tempConfig(initial: Partial<Config> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-offers-'));
  const path = join(dir, 'config.json');
  const config: Config = {
    sharedFolders: [],
    peers: [],
    knownDevices: [],
    pendingOffers: [],
    ...initial,
  };
  writeFileSync(path, JSON.stringify(config));
  return path;
}

describe('offers', () => {
  it('creates a pending folder offer', () => {
    const configPath = tempConfig();
    const offer = receiveOffer(configPath, {
      id: 'o1',
      kind: 'folder',
      fromDeviceId: 'REMOTE',
      folderId: 'docs',
      folderName: 'docs',
    });
    expect(offer).not.toBeNull();
    expect(offer!.status).toBe('pending');
    expect(listPendingOffers(configPath)).toHaveLength(1);
  });

  it('dedupes the same (from, kind, folderId) offer', () => {
    const configPath = tempConfig();
    receiveOffer(configPath, { id: 'o1', kind: 'folder', fromDeviceId: 'REMOTE', folderId: 'docs' });
    const again = receiveOffer(configPath, { id: 'o2', kind: 'folder', fromDeviceId: 'REMOTE', folderId: 'docs' });
    expect(again).toBeNull();
    expect(listPendingOffers(configPath)).toHaveLength(1);
  });

  it('backfills missing source ip / hostname when a duplicate offer arrives', () => {
    const configPath = tempConfig();
    // 模拟「字段引入之前」落库的老记录(没有 fromIp / fromHostname)
    receiveOffer(configPath, { id: 'o1', kind: 'folder', fromDeviceId: 'REMOTE', folderId: 'docs' });
    expect(findPendingOffer(configPath, 'o1')?.fromIp).toBeUndefined();

    const again = receiveOffer(configPath, {
      id: 'o2',
      kind: 'folder',
      fromDeviceId: 'REMOTE',
      folderId: 'docs',
      fromIp: '192.168.1.5',
      fromHostname: 'peer-pc',
    });
    expect(again).toBeNull();
    const backfilled = findPendingOffer(configPath, 'o1');
    expect(backfilled?.fromIp).toBe('192.168.1.5');
    expect(backfilled?.fromHostname).toBe('peer-pc');
    // 去重语义不变:仍然只有一条
    expect(listPendingOffers(configPath)).toHaveLength(1);
    // 回填已落盘
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.pendingOffers[0].fromHostname).toBe('peer-pc');
  });

  it('does not overwrite existing source info on a duplicate offer', () => {
    const configPath = tempConfig();
    receiveOffer(configPath, {
      id: 'o1',
      kind: 'pairing',
      fromDeviceId: 'REMOTE',
      fromIp: '10.0.0.1',
      fromHostname: 'old-name',
    });
    receiveOffer(configPath, {
      id: 'o2',
      kind: 'pairing',
      fromDeviceId: 'REMOTE',
      fromIp: '10.0.0.9',
      fromHostname: 'new-name',
    });
    const kept = findPendingOffer(configPath, 'o1');
    expect(kept?.fromIp).toBe('10.0.0.1');
    expect(kept?.fromHostname).toBe('old-name');
  });

  it('skips a folder invitation when already mutually shared', () => {
    const configPath = tempConfig({
      sharedFolders: [{ id: 'docs', path: '/x', devices: ['REMOTE'] }],
    });
    const offer = receiveOffer(configPath, { id: 'o1', kind: 'folder', fromDeviceId: 'REMOTE', folderId: 'docs' });
    expect(offer).toBeNull();
  });

  it('skips a pairing request when the device is already known', () => {
    const configPath = tempConfig({ knownDevices: [{ id: 'REMOTE' }] });
    const offer = receiveOffer(configPath, { id: 'o1', kind: 'pairing', fromDeviceId: 'REMOTE' });
    expect(offer).toBeNull();
  });

  it('keeps a declined offer out of the pending list but findable by id', () => {
    const configPath = tempConfig();
    receiveOffer(configPath, { id: 'o1', kind: 'folder', fromDeviceId: 'REMOTE', folderId: 'docs' });
    const declined = markOfferDeclined(configPath, 'o1');
    expect(declined?.status).toBe('declined');
    expect(listPendingOffers(configPath)).toHaveLength(0);
    expect(findPendingOffer(configPath, 'o1')?.status).toBe('declined');
  });

  it('marks an offer accepted and persists the transition', () => {
    const configPath = tempConfig();
    receiveOffer(configPath, { id: 'o1', kind: 'pairing', fromDeviceId: 'REMOTE' });
    const accepted = markOfferAccepted(configPath, 'o1');
    expect(accepted?.status).toBe('accepted');
    // 文件落地正确
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.pendingOffers[0].status).toBe('accepted');
  });

  it('returns undefined for a missing offer', () => {
    const configPath = tempConfig();
    expect(markOfferAccepted(configPath, 'nope')).toBeUndefined();
    expect(markOfferDeclined(configPath, 'nope')).toBeUndefined();
  });
});
