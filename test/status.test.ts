import { describe, expect, it } from 'vitest';
import { buildStatus } from '../src/status.js';

describe('status aggregation', () => {
  it('aggregates identity, config and index stats', () => {
    const status = buildStatus(
      { deviceId: 'DEV1234567', publicKey: 'pk', privateKey: 'sk' },
      {
        sharedFolders: [
          { path: '/data/docs', devices: ['DEV1234567'] },
          { path: '/data/photos', devices: ['DEV1234567', 'DEVABCDEFG'] },
        ],
      },
      { entries: 42, tombstones: 3 },
    );

    expect(status.deviceId).toBe('DEV1234567');
    expect(status.folders).toEqual([
      { path: '/data/docs', devices: ['DEV1234567'] },
      { path: '/data/photos', devices: ['DEV1234567', 'DEVABCDEFG'] },
    ]);
    expect(status.entries).toBe(42);
    expect(status.tombstones).toBe(3);
  });
});
