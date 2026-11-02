/**
 * 分片索引交换(ADR-0027)。
 *
 * 要钉住的性质,按故障链条的顺序:
 *  1. 大索引被切成多片,每片**编码后**不超上限(按条数切挡不住单条巨条目);
 *  2. 对端宣告 `index-chunk1` 时才分片 —— 未宣告时逐字节仍是原来的单帧;
 *  3. 接收侧按 seq 拼回一份,且只在集齐时调用一次 onPeerIndex;
 *  4. 同一目录新的「第 0 片」丢弃旧的一半(重连/重发不会拼出重复条目);
 *  5. 畸形声明整体丢弃,不掀翻连接。
 */
process.env.SYNCX_INDEX_CHUNK_BYTES = String(16 * 1024);

import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { encodeIndexChunks, encodeIndex, decodeIndex } from '../src/messages.js';
// 分片上限是模块加载期常量:必须先设环境变量,再用顶层 await 动态 import
// (与 test/send-window.test.ts 同一套路)。
const { attachPeerMessages, makePeerTransport, encryptMessage, decryptMessage } = await import(
  '../src/net/wire.js'
);
import type { IndexEntry } from '../src/index.js';

const key = Buffer.from('0123456789abcdef0123456789abcdef');

function entry(path: string, blocks: string[] = ['h1'], size = 100): IndexEntry {
  return { path, version: new Map([['dev-a', 1]]), size, deleted: false, blocks };
}

describe('encodeIndexChunks', () => {
  it('keeps every chunk under the byte budget and loses nothing', () => {
    // 混排大小条目:一条 200KB 的条目不按条数切就会独占一片
    const entries = [
      ...Array.from({ length: 40 }, (_, i) => entry(`small-${i}.txt`)),
      entry('huge.bin', Array.from({ length: 8000 }, (_, i) => `h${i}`), 8_000_000),
      ...Array.from({ length: 40 }, (_, i) => entry(`after-${i}.txt`)),
    ];
    const chunks = encodeIndexChunks(entries, 64 * 1024);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(64 * 1024);

    const roundTripped = chunks.flatMap((c) => decodeIndex(c));
    expect(roundTripped.map((e) => e.path).sort()).toEqual(entries.map((e) => e.path).sort());
    // 与整份编码的内容语义完全一致(不是「差不多」)
    expect(roundTripped).toEqual(decodeIndex(encodeIndex(entries)));
  });

  it('never emits a placeholder entry (same filter as encodeIndex)', () => {
    const chunks = encodeIndexChunks(
      [entry('a.txt'), { ...entry('p.txt'), placeholder: true }],
      64 * 1024,
    );
    expect(chunks.flatMap((c) => decodeIndex(c)).map((e) => e.path)).toEqual(['a.txt']);
  });

  it('yields a single empty chunk for an empty index (full 语义依赖它)', () => {
    expect(encodeIndexChunks([], 64 * 1024)).toEqual([Buffer.from('[]')]);
  });
});

/* ==================== 发送侧:能力开关 ==================== */

describe('chunked sends (transport capability)', () => {
  function capture(opts: { canSendBinary?: boolean; canChunkIndex?: boolean }) {
    const sent: Array<string | Buffer> = [];
    const socket = { send: (d: string | Buffer) => sent.push(d) } as unknown as WebSocket;
    const transport = makePeerTransport(socket, key, 'main', undefined, {
      canSendBinary: () => opts.canSendBinary === true,
      canChunkIndex: () => opts.canChunkIndex === true,
    });
    return { transport, sent, socket };
  }

  const many = Array.from({ length: 400 }, (_, i) =>
    entry(`f${i}.bin`, Array.from({ length: 100 }, (_, j) => `${i}-${j}`), 1_000_000),
  );

  it('splits a large index into ordered seq/total frames when the peer can chunk', async () => {
    const { transport, sent } = capture({ canChunkIndex: true });
    transport.sendEntries(many, 'full');
    // sendChunkedIndex 每帧之间让出事件循环:等它排空
    for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 50));

    expect(sent.length).toBeGreaterThan(1);
    // 未宣告 binary:每帧都是文本信封,解密后核对 index 元数据
    const decoded = sent.map(
      (raw) =>
        decryptMessage(key, raw as string) as {
          type: string;
          seq?: number;
          total?: number;
          full?: boolean;
          payload: string;
        },
    );
    expect(decoded.every((m) => m.type === 'index')).toBe(true);
    expect(decoded.every((m) => m.full === true)).toBe(true);
    expect(decoded.map((m) => m.seq)).toEqual(decoded.map((_, i) => i));
    expect(new Set(decoded.map((m) => m.total)).size).toBe(1);
    expect(decoded[0]!.total).toBe(decoded.length);
  });

  it('keeps the single-frame path byte-for-byte when the peer cannot chunk', () => {
    const { transport, sent } = capture({ canChunkIndex: false });
    transport.sendEntries(many, 'full');
    // 同步发送(旧路径):立刻就是 1 帧
    expect(sent.length).toBe(1);
    const msg = decryptMessage(key, sent[0] as string) as { seq?: number; total?: number };
    expect(msg.seq).toBeUndefined();
    expect(msg.total).toBeUndefined();
  });

  it('stops delivering the remaining chunks once the socket is closed', async () => {
    // 拆连后继续一帧帧走完全程没有任何意义:既没人收,还会白等水位轮询
    const { transport, sent, socket } = capture({ canChunkIndex: true });
    Object.assign(socket as object, { readyState: 3 /* CLOSED */ });
    transport.sendEntries(many, 'full');
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([]);
  });

  it('does not chunk a small index even when the capability is present', () => {
    const { transport, sent } = capture({ canChunkIndex: true });
    transport.sendEntries([entry('a.txt')], 'full');
    expect(sent.length).toBe(1);
  });
});

/* ==================== 接收侧:拼装 ==================== */

describe('chunk assembly (attachPeerMessages)', () => {
  function receiver() {
    let handler: ((data: Buffer, isBinary?: boolean) => void) | undefined;
    const socket = {
      on(event: string, cb: (data: Buffer, isBinary?: boolean) => void): void {
        if (event === 'message') handler = cb;
      },
      off(): void {},
      send(): void {},
    } as unknown as WebSocket;
    const calls: Array<{ n: number; full?: boolean; relayed?: boolean; paths: string[] }> = [];
    const peer = {
      onPeerIndex(entries: IndexEntry[], opts?: { full?: boolean; relayed?: boolean }): void {
        calls.push({
          n: entries.length,
          full: opts?.full,
          relayed: opts?.relayed,
          paths: entries.map((e) => e.path),
        });
      },
      onBlockResponse(): void {},
    };
    const peers = new Map<string, unknown>([['main', peer]]);
    attachPeerMessages(peers as never, socket, key);
    return {
      calls,
      feed: (message: Record<string, unknown>) =>
        handler?.(Buffer.from(encryptMessage(key, message as never), 'utf8'), false),
    };
  }

  const frame = (seq: number, total: number, entries: IndexEntry[], folder = 'main') => ({
    type: 'index',
    folder,
    payload: encodeIndex(entries).toString('base64'),
    full: true,
    seq,
    total,
  });

  it('delivers exactly one merged index when the last chunk arrives', () => {
    const { calls, feed } = receiver();
    feed(frame(0, 3, [entry('a.txt'), entry('b.txt')]));
    expect(calls).toEqual([]); // 未集齐:一个字都不交给规划器
    feed(frame(2, 3, [entry('e.txt')]));
    expect(calls).toEqual([]);
    feed(frame(1, 3, [entry('c.txt'), entry('d.txt')]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.n).toBe(5);
    expect(calls[0]!.full).toBe(true);
    expect(calls[0]!.paths.sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
  });

  it('drops the old half when a new chunk 0 starts (reconnect / resend)', () => {
    const { calls, feed } = receiver();
    feed(frame(0, 2, [entry('stale-a.txt')]));
    feed(frame(0, 2, [entry('fresh-a.txt')])); // 重来
    feed(frame(1, 2, [entry('fresh-b.txt')]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.paths).toEqual(['fresh-a.txt', 'fresh-b.txt']);
  });

  it('ignores duplicate chunks instead of double-counting them', () => {
    const { calls, feed } = receiver();
    feed(frame(0, 2, [entry('a.txt')]));
    feed(frame(0, 2, [entry('a.txt')]));
    feed(frame(1, 2, [entry('b.txt')]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.n).toBe(2);
  });

  it('discards malformed declarations without throwing or emitting a partial index', () => {
    const { calls, feed } = receiver();
    expect(() => feed(frame(3, 2, [entry('x.txt')]))).not.toThrow(); // seq >= total
    expect(() => feed(frame(-1, 2, [entry('x.txt')]))).not.toThrow();
    expect(() => feed(frame(0, 9999, [entry('x.txt')]))).not.toThrow(); // 超量
    expect(calls).toEqual([]);
  });

  it('treats a chunk-less frame as a complete index (old peers)', () => {
    const { calls, feed } = receiver();
    feed({
      type: 'index',
      folder: 'main',
      payload: encodeIndex([entry('a.txt')]).toString('base64'),
      full: true,
    });
    expect(calls).toEqual([{ n: 1, full: true, relayed: false, paths: ['a.txt'] }]);
  });

  it('takes full/relayed from chunk 0, not from whichever arrives last', () => {
    // 发送侧受背压与插队影响不保证字节序;一份分片索引的语义由开头那片定义
    const { calls, feed } = receiver();
    feed({ ...frame(0, 2, [entry('a.txt')]), full: true, relayed: true });
    feed({ ...frame(1, 2, [entry('b.txt')]), full: false, relayed: false });
    expect(calls).toEqual([{ n: 2, full: true, relayed: true, paths: ['a.txt', 'b.txt'] }]);
  });

  it('assembles per folder independently', () => {
    const { calls, feed } = receiver();
    feed(frame(0, 2, [entry('a.txt')], 'main'));
    feed(frame(0, 2, [entry('x.txt')], 'other')); // 另一目录的进度不受影响
    feed(frame(1, 2, [entry('b.txt')], 'main'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.paths.sort()).toEqual(['a.txt', 'b.txt']);
  });
});

/* ==================== 端到端:真实 transport ↔ 真实 dispatcher ==================== */

describe('transport → dispatcher round trip', () => {
  it('a chunked full index survives the wire as one planning round', async () => {
    const senderSocket = { send(): void {} } as unknown as WebSocket;
    const transport = makePeerTransport(senderSocket, key, 'main', undefined, {
      canChunkIndex: () => true,
    });
    // 接收侧独立一套:直接从发送侧拿帧喂进去
    const delivered: Array<{ n: number; full?: boolean }> = [];
    const peer = {
      onPeerIndex(entries: IndexEntry[], opts?: { full?: boolean }): void {
        delivered.push({ n: entries.length, full: opts?.full });
      },
      onBlockResponse(): void {},
    };
    const peers = new Map<string, unknown>([['main', peer]]);
    let handler: ((data: Buffer, isBinary?: boolean) => void) | undefined;
    const recvSocket = {
      on(event: string, cb: (data: Buffer, isBinary?: boolean) => void): void {
        if (event === 'message') handler = cb;
      },
      off(): void {},
      send(): void {},
    } as unknown as WebSocket;
    attachPeerMessages(peers as never, recvSocket, key);

    // 把发送侧的 socket.send 直接接到接收侧的 handler
    const sentFrames: Array<string | Buffer> = [];
    (senderSocket as unknown as { send: (d: string | Buffer) => void }).send = (d) => {
      sentFrames.push(d);
      handler?.(Buffer.from(d as string), false);
    };

    const many = Array.from({ length: 400 }, (_, i) =>
      entry(`f${i}.bin`, Array.from({ length: 100 }, (_, j) => `${i}-${j}`), 1_000_000),
    );
    transport.sendEntries(many, 'full');
    await new Promise((r) => setTimeout(r, 100));

    expect(sentFrames.length).toBeGreaterThan(1);
    expect(delivered).toEqual([{ n: many.length, full: true }]);
  });
});
