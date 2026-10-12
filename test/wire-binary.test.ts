import { describe, expect, it, vi } from 'vitest';
import {
  encodeBinaryFrame,
  decodeBinaryFrame,
  makePeerTransport,
  attachPeerMessages,
  encryptMessage,
  decryptMessage,
  BINARY_FRAME_OVERHEAD,
} from '../src/net/wire.js';
import { encodeIndex } from '../src/messages.js';
import type { IndexEntry } from '../src/index.js';
import type { WebSocket } from 'ws';

const key = Buffer.from('0123456789abcdef0123456789abcdef'); // 32 字节 AES-256
const otherKey = Buffer.from('fedcba9876543210fedcba9876543210');

function entry(path: string, blocks: string[]): IndexEntry {
  return { path, version: new Map([['dev-a', 1]]), size: 10, deleted: false, blocks };
}

describe('binary frame envelope', () => {
  it('round-trips a block-response with raw body bytes', () => {
    const data = Buffer.alloc(4096, 0x5a);
    const frame = encodeBinaryFrame(
      key,
      'block-response',
      { folder: 'main', deviceId: 'DEV-A', path: 'a/b.bin', blockIndex: 3, hash: 'h3', cdc: true },
      data,
    );
    const got = decodeBinaryFrame(key, frame);
    expect(got?.kind).toBe('block-response');
    expect(got?.header).toEqual({
      folder: 'main',
      deviceId: 'DEV-A',
      path: 'a/b.bin',
      blockIndex: 3,
      hash: 'h3',
      cdc: true,
    });
    // 体是原样字节:没有 base64 往返,长度就是块长
    expect(got?.body.length).toBe(4096);
    expect(got?.body.equals(data)).toBe(true);
  });

  it('round-trips an index message (entries JSON as body)', () => {
    const entries = [entry('a.txt', ['h1']), entry('b.txt', ['h2', 'h3'])];
    const body = encodeIndex(entries);
    const got = decodeBinaryFrame(
      key,
      encodeBinaryFrame(key, 'index', { folder: 'main', full: true, relayed: false }, body),
    );
    expect(got?.kind).toBe('index');
    expect(got?.header.full).toBe(true);
    // 复用同一套条目编解码,语义与文本路径完全一致
    const decoded = JSON.parse(got!.body.toString('utf8')) as Array<{ path: string }>;
    expect(decoded.map((e) => e.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('drops malformed frames instead of throwing (same policy as the text path)', () => {
    const good = encodeBinaryFrame(key, 'block-response', { folder: 'main' }, Buffer.from('xx'));
    expect(decodeBinaryFrame(otherKey, good)).toBeUndefined(); // 密钥不符 = 认证失败
    expect(decodeBinaryFrame(key, good.subarray(0, good.length - 1))).toBeUndefined(); // 尾部被截
    expect(decodeBinaryFrame(key, Buffer.from('short'))).toBeUndefined(); // 不足 iv+tag+前缀
    expect(decodeBinaryFrame(key, Buffer.concat([good, Buffer.from('trailing')]))).toBeUndefined(); // 篡改
    const flipped = Buffer.from(good);
    flipped[0] = flipped[0]! ^ 0xff; // 改 iv
    expect(decodeBinaryFrame(key, flipped)).toBeUndefined();
  });

  it('keeps 1 MB of block payload near 1 MB on the wire (the whole point)', () => {
    const data = Buffer.alloc(1024 * 1024, 0x41);
    const binary = encodeBinaryFrame(
      key,
      'block-response',
      { folder: 'main', deviceId: 'DEV-A', path: 'a.bin', blockIndex: 0, hash: 'h' },
      data,
    );
    const text = encryptMessage(key, {
      type: 'block-response',
      folder: 'main',
      payload: {
        deviceId: 'DEV-A',
        path: 'a.bin',
        blockIndex: 0,
        hash: 'h',
        data: data.toString('base64'),
      },
    });
    // 文本信封两层 base64 ≈ 1.78 倍;二进制只剩 iv+tag+小头
    expect(Buffer.byteLength(text)).toBeGreaterThan(1_700_000);
    expect(binary.length).toBeLessThan(1024 * 1024 + 1024);
    const headerLen = JSON.stringify({ folder: 'main', deviceId: 'DEV-A', path: 'a.bin', blockIndex: 0, hash: 'h' }).length;
    expect(binary.length).toBe(BINARY_FRAME_OVERHEAD + headerLen + data.length);
  });
});

describe('estimatedWireBytes (供块前窗口的信封估算)', () => {
  function transportWith(binary: boolean) {
    const socket = { send(): void {} } as unknown as WebSocket;
    return makePeerTransport(socket, key, 'main', undefined, { canSendBinary: () => binary });
  }

  function actualTextBytes(data: Buffer): number {
    return Buffer.byteLength(
      encryptMessage(key, {
        type: 'block-response',
        folder: 'main',
        payload: { deviceId: 'DEV-A', path: 'a/b.bin', blockIndex: 7, hash: 'h'.repeat(40), data: data.toString('base64') },
      }),
    );
  }

  function actualBinaryBytes(data: Buffer): number {
    return encodeBinaryFrame(
      key,
      'block-response',
      { folder: 'main', deviceId: 'DEV-A', path: 'a/b.bin', blockIndex: 7, hash: 'h'.repeat(40), cdc: false },
      data,
    ).length;
  }

  it('never under-counts what it actually puts on the wire, in either encoding', () => {
    const bin = transportWith(true);
    const txt = transportWith(false);
    for (const size of [1, 4096, 64 * 1024, 1024 * 1024]) {
      const data = Buffer.alloc(size, 0x42);
      expect(txt.estimatedWireBytes!(data.length)).toBeGreaterThanOrEqual(actualTextBytes(data));
      expect(bin.estimatedWireBytes!(data.length)).toBeGreaterThanOrEqual(actualBinaryBytes(data));
    }
  });

  it('tracks the encoding switch instead of assuming base64 doubling', () => {
    const data = Buffer.alloc(1024 * 1024, 0x42);
    const bin = transportWith(true).estimatedWireBytes!(data.length);
    const txt = transportWith(false).estimatedWireBytes!(data.length);
    // 二进制贴近 1.0 倍(否则等于没修:窗口仍按 1.78 倍预留,吞吐被无谓掐住)
    expect(bin).toBeLessThan(data.length * 1.1);
    // 文本仍按两层 base64 预留 —— 旧口径只算一层,会把窗口撑大约 25%
    expect(txt).toBeGreaterThan(data.length * 1.7);
    expect(txt).toBeGreaterThan(bin * 1.5);
    expect(actualBinaryBytes(data)).toBeLessThan(actualTextBytes(data) / 1.5);
  });
});

describe('transport frame selection (kx caps)', () => {
  function captureSocket() {
    const sent: Array<string | Buffer> = [];
    const socket = { send: (d: string | Buffer) => sent.push(d) } as unknown as WebSocket;
    return { socket, sent };
  }

  it('sends binary frames only when the peer announced the capability', async () => {
    const bin = captureSocket();
    const t1 = makePeerTransport(bin.socket, key, 'main', undefined, {
      canSendBinary: () => true,
    });
    t1.sendBlockResponse({ deviceId: 'D', path: 'a', blockIndex: 0, hash: 'h', data: Buffer.from('xx') });
    t1.sendEntries([entry('a', ['h1'])], 'full');
    await Promise.resolve();
    expect(bin.sent.every((f) => Buffer.isBuffer(f))).toBe(true);

    const txt = captureSocket();
    const t2 = makePeerTransport(txt.socket, key, 'main', undefined, {
      canSendBinary: () => false,
    });
    t2.sendBlockResponse({ deviceId: 'D', path: 'a', blockIndex: 0, hash: 'h', data: Buffer.from('xx') });
    t2.sendEntries([entry('a', ['h1'])], 'full');
    await Promise.resolve();
    expect(txt.sent.every((f) => typeof f === 'string')).toBe(true);
    // 旧对端路径逐字节沿用原编码:能被 decryptMessage 解开
    const decoded = decryptMessage(key, txt.sent[1] as string);
    expect(decoded.type).toBe('index');

    // 未注入谓词(测试替身/旧调用)= 一律兼容编码
    const legacy = captureSocket();
    const t3 = makePeerTransport(legacy.socket, key, 'main');
    t3.sendBlockResponse({ deviceId: 'D', path: 'a', blockIndex: 0, hash: 'h', data: Buffer.from('xx') });
    await Promise.resolve();
    expect(typeof legacy.sent[0]).toBe('string');
  });

  it('re-reads the capability per send, so a session that gains caps later is honoured', async () => {
    let capable = false;
    const { socket, sent } = captureSocket();
    const t = makePeerTransport(socket, key, 'main', undefined, { canSendBinary: () => capable });
    t.sendBlockRequest({ deviceId: 'D', path: 'a', blockIndex: 0, hash: 'h' });
    capable = true;
    t.sendBlockResponse({ deviceId: 'D', path: 'a', blockIndex: 0, hash: 'h', data: Buffer.from('yy') });
    await Promise.resolve();
    // 块请求本来就恒走文本(几十字节,不改);块响应在能力到位后走二进制
    expect(typeof sent[0]).toBe('string');
    expect(Buffer.isBuffer(sent[1])).toBe(true);
  });
});

describe('dispatch routes binary frames to the same handlers', () => {
  /** 只实现 attachPeerMessages 用到的那一面:'message' 监听 + 可手喂帧。 */
  function fakeSocketReceiver() {
    let handler: ((data: Buffer, isBinary?: boolean) => void) | undefined;
    const socket = {
      on(event: string, cb: (data: Buffer, isBinary?: boolean) => void): void {
        if (event === 'message') handler = cb;
      },
      off(): void {},
      send(): void {},
    } as unknown as WebSocket;
    return {
      socket,
      feed: (frame: Buffer, isBinary = true) => handler?.(frame, isBinary),
    };
  }

  it('carries index flags and raw block bytes through to the peer handlers', () => {
    const indexes: Array<{ n: number; full?: boolean; relayed?: boolean }> = [];
    const responses: Array<{ path: string; body: number; cdc?: boolean }> = [];
    const peer = {
      onPeerIndex(entries: IndexEntry[], opts?: { full?: boolean; relayed?: boolean }): void {
        indexes.push({ n: entries.length, full: opts?.full, relayed: opts?.relayed });
      },
      onBlockResponse(r: { path: string; data: Buffer; cdc?: boolean }): void {
        responses.push({ path: r.path, body: r.data.length, cdc: r.cdc });
      },
    };
    const peers = new Map<string, unknown>([['main', peer]]);
    const { socket, feed } = fakeSocketReceiver();
    attachPeerMessages(peers as never, socket, key);

    feed(encodeBinaryFrame(key, 'index', { folder: 'main', full: true, relayed: true }, encodeIndex([entry('a', ['h1'])])));
    expect(indexes).toEqual([{ n: 1, full: true, relayed: true }]);

    feed(encodeBinaryFrame(key, 'block-response', { folder: 'main', path: 'x.bin', blockIndex: 1, hash: 'h', cdc: true }, Buffer.alloc(700)));
    expect(responses).toEqual([{ path: 'x.bin', body: 700, cdc: true }]);

    // 坏帧、以及本机没有该目录 peer 的帧:静默丢弃,不抛也不误路由
    expect(() => feed(Buffer.from('junk'))).not.toThrow();
    expect(() =>
      feed(encodeBinaryFrame(key, 'index', { folder: 'other', full: false }, encodeIndex([]))),
    ).not.toThrow();
    expect(indexes).toHaveLength(1);
    expect(responses).toHaveLength(1);
  });

  it('text frames keep working untouched on the same connection', () => {
    const indexes: number[] = [];
    const peer = {
      onPeerIndex(entries: IndexEntry[]): void {
        indexes.push(entries.length);
      },
      onBlockResponse(): void {},
    };
    const peers = new Map<string, unknown>([['main', peer]]);
    const { socket, feed } = fakeSocketReceiver();
    attachPeerMessages(peers as never, socket, key);

    // 旧对端(未协商能力)仍在发文本 JSON:isBinary=false 走原路径
    feed(Buffer.from(encryptMessage(key, { type: 'index', folder: 'main', payload: encodeIndex([entry('a', ['h1'])]).toString('base64'), full: true }), 'utf8'), false);
    expect(indexes).toEqual([1]);
  });
});
