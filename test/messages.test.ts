import { describe, expect, it } from 'vitest';
import {
  encodeIndex,
  decodeIndex,
  encodeBlockRequest,
  decodeBlockRequest,
  encodeBlockResponse,
  decodeBlockResponse,
} from '../src/messages.js';

function entry(
  path: string,
  version: Array<[string, number]>,
  blocks: string[],
  size = 100,
  deleted = false,
) {
  return {
    path,
    version: new Map(version),
    size,
    deleted,
    blocks,
  };
}

describe('index message codec', () => {
  it('round-trips an entry list including tombstones and blocks', () => {
    const entries = [
      entry('docs/plan.md', [['dev-a', 2], ['dev-b', 1]], ['abc', 'def'], 200),
      entry('gone.txt', [['dev-b', 5]], [], 0, true),
    ];

    expect(decodeIndex(encodeIndex(entries))).toEqual(entries);
  });

  it('handles an empty index', () => {
    expect(decodeIndex(encodeIndex([]))).toEqual([]);
  });

  it('round-trips version vectors as maps, not arrays', () => {
    const entries = [entry('a.txt', [['dev-a', 3]], ['123'])];
    const decoded = decodeIndex(encodeIndex(entries));

    expect(decoded[0]!.version).toBeInstanceOf(Map);
    expect(decoded[0]!.version.get('dev-a')).toBe(3);
  });

  it('round-trips mtime so newest-wins conflict policy can compare across devices', () => {
    const entries = [{ ...entry('a.txt', [['dev-a', 1]], ['h1']), mtime: 1700000000123 }];
    const decoded = decodeIndex(encodeIndex(entries));

    expect(decoded[0]!.mtime).toBe(1700000000123);
  });

  it('decodes a legacy payload without mtime as undefined (backward compatible)', () => {
    // 旧版对端的 WireEntry 没有 mtime 字段:解码必须宽容,收侧据此退回 keep-both
    const legacy = [
      { path: 'a.txt', version: [['dev-a', 1]], size: 10, deleted: false, blocks: ['h1'] },
    ];
    const decoded = decodeIndex(Buffer.from(JSON.stringify(legacy), 'utf8'));

    expect(decoded[0]!.mtime).toBeUndefined();
    expect(decoded[0]!.path).toBe('a.txt');
  });
});

describe('block message codec', () => {
  it('round-trips a block request', () => {
    const request = {
      deviceId: 'DEV1234567',
      path: 'docs/plan.md',
      blockIndex: 2,
      hash: 'abc123',
    };

    expect(decodeBlockRequest(encodeBlockRequest(request))).toEqual(request);
  });

  it('round-trips the priority flag on a block request, and stays byte-identical without it', () => {
    const request = {
      deviceId: 'DEV1234567',
      path: 'docs/plan.md',
      blockIndex: 1,
      hash: 'abc123',
      priority: true,
    };

    expect(decodeBlockRequest(encodeBlockRequest(request))).toEqual(request);
    // 未提队的请求不带该字段(旧对端看到的字节不变)
    expect(
      encodeBlockRequest({ deviceId: 'D', path: 'a', blockIndex: 0, hash: 'h' }).toString('utf8'),
    ).not.toContain('priority');
  });

  it('round-trips a block response with binary data', () => {
    const response = {
      deviceId: 'DEV1234567',
      path: 'docs/plan.md',
      blockIndex: 0,
      hash: 'abc123',
      data: Buffer.from('hello block content'),
    };

    const decoded = decodeBlockResponse(encodeBlockResponse(response));
    expect(decoded.deviceId).toBe(response.deviceId);
    expect(decoded.path).toBe(response.path);
    expect(decoded.blockIndex).toBe(response.blockIndex);
    expect(decoded.hash).toBe(response.hash);
    expect(decoded.data).toEqual(response.data);
  });
});
