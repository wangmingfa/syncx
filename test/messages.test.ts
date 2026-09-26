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

describe('CDC 视图的线格式(纯附加,双向兼容)', () => {
  it('索引 round-trip 保留 cdh/clens;旧版线格式(无这两个字段)解出 undefined', () => {
    const withCdc = {
      path: 'big.bin',
      version: new Map([['dev-a', 3]]),
      size: 1234,
      deleted: false,
      blocks: ['fixed-hash'],
      cdh: ['chunk-a', 'chunk-b'],
      clens: [1000, 234],
    };
    expect(decodeIndex(encodeIndex([withCdc]))[0]).toEqual(withCdc);

    // 模拟旧版对端发来的帧:JSON 里根本没有 cdh/clens 键
    const legacyWire = Buffer.from(
      JSON.stringify([
        { path: 'x.bin', version: [['dev-a', 1]], size: 5, deleted: false, blocks: ['h'] },
      ]),
      'utf8',
    );
    const decoded = decodeIndex(legacyWire);
    expect(decoded[0]!.cdh).toBeUndefined();
    expect(decoded[0]!.clens).toBeUndefined();
  });

  it('cdh 与 clens 长度不齐 / 空列表:视为无 CDC 视图(对端数据严进)', () => {
    const mismatched = {
      path: 'x.bin',
      version: new Map([['dev-a', 1]]),
      size: 5,
      deleted: false,
      blocks: ['h'],
      cdh: ['a', 'b'],
      clens: [5],
    };
    const decoded = decodeIndex(encodeIndex([mismatched]))[0]!;
    expect(decoded.cdh).toBeUndefined();
    expect(decoded.clens).toBeUndefined();

    const empty = { ...mismatched, cdh: [], clens: [] };
    const decoded2 = decodeIndex(encodeIndex([empty]))[0]!;
    expect(decoded2.cdh).toBeUndefined();
  });

  it('块请求/响应往返携带 cdc 口径标记;不带时保持旧形状', () => {
    const req = { deviceId: 'dev-a', path: 'f.bin', blockIndex: 2, hash: 'chunkhash', cdc: true };
    expect(decodeBlockRequest(encodeBlockRequest(req))).toEqual(req);

    const legacyReq = { deviceId: 'dev-a', path: 'f.bin', blockIndex: 2, hash: 'h' };
    const decodedReq = decodeBlockRequest(encodeBlockRequest(legacyReq));
    expect('cdc' in decodedReq).toBe(false);

    const res = { deviceId: 'dev-a', path: 'f.bin', blockIndex: 2, hash: 'chunkhash', data: Buffer.from('chunk bytes'), cdc: true };
    const decodedRes = decodeBlockResponse(encodeBlockResponse(res));
    expect(decodedRes.cdc).toBe(true);
    expect(decodedRes.data).toEqual(res.data);

    const legacyRes = { deviceId: 'dev-a', path: 'f.bin', blockIndex: 2, hash: 'h', data: Buffer.from('x') };
    expect('cdc' in decodeBlockResponse(encodeBlockResponse(legacyRes))).toBe(false);
  });
});
