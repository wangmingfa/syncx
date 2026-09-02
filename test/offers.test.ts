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
