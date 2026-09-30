/**
 * 发送侧在途窗口(peer.ts 的 SEND_WINDOW_BYTES)。
 *
 * 要钉住的性质:对端**一次性**为一整个大文件发出全部块请求时,本机内存峰值只与
 * 「窗口」有关,而与文件大小无关。改前的形态是每条请求都立刻读盘 + 加密 + 压进发送
 * 队列,峰值 = 文件大小 × 1.34(base64 信封),2.2GB 文件实测把 daemon 顶到 8GB 堆
 * 上限 OOM。
 *
 * 观测量是 **readLocalBlock 的调用序列**:挡在读取之前才是这机制的本意(读出来再挂起
 * 等于什么都没省),而「何时读」同时给出了放行时机、服务顺序与是否重复读盘 —— 不必
 * 解密信封去数响应。
 *
 * 传输层用**真实的** makePeerTransport,下面接一个会记账的假 socket:它的
 * bufferedAmount 由测试手工放行,等价于「链路的消费速度由我说了算」。窗口常量在模块
 * 加载时读取,所以用「设环境变量 + 顶层 await 动态 import」拿到按小窗口编译的 peer
 * 模块(与 test/integration/ports.ts 调短租约同一套路)。
 */
process.env.SYNCX_SEND_WINDOW_BYTES = String(8 * 1024 * 1024);

import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { BLOCK_SIZE } from '../src/blockstore.js';
import type { IndexEntry } from '../src/index.js';
import type { BlockRequest } from '../src/messages.js';
import { makePeerTransport } from '../src/net/wire.js';
import type { PeerTransport } from '../src/peer.js';

const { createSyncPeer } = await import('../src/peer.js');

const WINDOW = 8 * 1024 * 1024;
const FILE_BLOCKS = 40; // 40MB:够让「不设限」与「设限」在数值上无可混淆
const oneBlock = Buffer.alloc(BLOCK_SIZE, 0x61); // 每次读盘都返同一个缓冲(不复制)
const sessionKey = Buffer.alloc(32, 7); // 信封要加密,内容与本用例无关

/** 一块响应的上线体量:与 expectedWireBytes 同一口径(明文 + tag → base64 → 信封)。 */
const wireBytes = (plain: number): number => Math.ceil((plain + 16) / 3) * 4 + 256;

function localIndex(): Map<string, IndexEntry> {
  const entry = {
    path: 'big.bin',
    version: new Map([['dev-a', 1]]),
    size: FILE_BLOCKS * BLOCK_SIZE,
    deleted: false,
    blocks: Array.from({ length: FILE_BLOCKS }, (_, i) => `h${i}`),
  } as unknown as IndexEntry;
  return new Map([['big.bin', entry]]);
}

const requestOf = (blockIndex: number, extra: Partial<BlockRequest> = {}): BlockRequest => ({
  deviceId: 'DEV-B',
  path: 'big.bin',
  blockIndex,
  hash: `h${blockIndex}`,
  ...extra,
});

/**
 * 会记账的假 socket:send 只把字节挪进 bufferedAmount —— 正是真实 socket 在链路
 * 排不下时所做的事(数据交给它之后并不等于已经离开本机)。
 */
function simSocket() {
  const sock = {
    bufferedAmount: 0,
    sends: 0,
    peak: 0,
    send(payload: string): void {
      sock.sends += 1;
      sock.bufferedAmount += Buffer.byteLength(payload);
      if (sock.bufferedAmount > sock.peak) sock.peak = sock.bufferedAmount;
    },
  };
  return {
    /** 交给 makePeerTransport 的那一面(它只认 WebSocket 的接口) */
    socket: sock as unknown as WebSocket,
    /** 同一对象的本来面目:用例要读的是记账字段,不是 WebSocket 的 */
    sock,
    /** 链路吐掉 n 字节(测试来当这条链路的消费速度)。 */
    release(n: number): void {
      sock.bufferedAmount = Math.max(0, sock.bufferedAmount - n);
    },
  };
}

/** 组一套「真实 transport + 记录读盘序列的 peer」。 */
function harness() {
  const sim = simSocket();
  const transport = makePeerTransport(sim.socket, sessionKey, 'share');
  const reads: number[] = [];
  const peer = createSyncPeer({
    transport,
    localIndex: localIndex(),
    deviceId: 'DEV-A',
    readLocalBlock: (_path, blockIndex) => {
      reads.push(blockIndex);
      return oneBlock;
    },
  });
  return { sim, transport, peer, reads };
}

/**
 * 把链路恢复成「一直有空位」,并等延迟队列排空到 target 块。
 *
 * 每轮之间要让出一格真实时间:这段时间里**没有任何新的块请求进来**,唤起只能来自
 * transport 自己的腾挪信号(排空后的那一次叫醒 / 100ms 轮询)—— 这正是「挡下来的
 * 请求一定会被补上」这条性质的强条件版本。窗口失效会让 peak 冲到整文件;排空失灵
 * 会让这里的等待超时。
 */
async function drainTo(sim: ReturnType<typeof simSocket>, reads: number[], target: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (reads.length < target && Date.now() < deadline) {
    sim.release(sim.socket.bufferedAmount);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  expect(reads.length).toBe(target);
}

describe('发送侧在途窗口', () => {
  it('窗口满即停止读盘:峰值由窗口决定,不是由文件大小决定', async () => {
    const { sim, peer, reads } = harness();

    for (let i = 0; i < FILE_BLOCKS; i++) peer.onBlockRequest(requestOf(i));

    // 一块约 1.37MB,窗口 8MB 只容得下 5~6 块;窗口失效就是 40。
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThan(FILE_BLOCKS / 2);
    // 读一次盘就上一次线:没有「读了却没发」的白工
    expect(sim.sock.sends).toBe(reads.length);

    await drainTo(sim, reads, FILE_BLOCKS);
    expect(new Set(reads).size).toBe(FILE_BLOCKS); // 一块不漏,也没重复审
    expect(sim.sock.sends).toBe(FILE_BLOCKS);
    // 整轮下来的峰值仍是「窗口 + 一块」:判定在放行之前,单块之内无从 preempt。
    // 这一条就是当初那个 OOM 的反面 —— 它正比于窗口,而不是 40MB。
    expect(sim.sock.peak).toBeLessThanOrEqual(WINDOW + wireBytes(BLOCK_SIZE));
  });

  it('transport 不报在途量时不设限(退回旧行为,不引入新卡点)', () => {
    const responses: unknown[] = [];
    const transport: PeerTransport = {
      sendEntries: () => {},
      sendBlockRequest: () => {},
      sendBlockResponse: (r) => responses.push(r),
    };
    const reads: number[] = [];
    const peer = createSyncPeer({
      transport,
      localIndex: localIndex(),
      deviceId: 'DEV-A',
      readLocalBlock: (_path, blockIndex) => {
        reads.push(blockIndex);
        return oneBlock;
      },
    });

    for (let i = 0; i < FILE_BLOCKS; i++) peer.onBlockRequest(requestOf(i));

    expect(reads.length).toBe(FILE_BLOCKS);
    expect(responses.length).toBe(FILE_BLOCKS);
  });

  it('对端超时重试同一块,延迟队列里只留一份', async () => {
    const { sim, peer, reads } = harness();
    // 先拿 0..n 把窗口占满,再盯住最后一块
    for (let i = 0; i < FILE_BLOCKS - 1; i++) peer.onBlockRequest(requestOf(i));
    const blockedBefore = reads.length;

    for (let retry = 0; retry < 5; retry++) peer.onBlockRequest(requestOf(FILE_BLOCKS - 1));
    expect(reads.length).toBe(blockedBefore); // 窗口满:五次重试一块也没提前供

    await drainTo(sim, reads, FILE_BLOCKS);
    expect(reads.filter((i) => i === FILE_BLOCKS - 1).length).toBe(1); // 五次重试只兑现一次读盘
    expect(sim.sock.sends).toBe(FILE_BLOCKS);
  });

  it('带优先标记的块越过已排队的常规块', async () => {
    const { sim, peer, reads } = harness();
    for (let i = 0; i < FILE_BLOCKS - 2; i++) peer.onBlockRequest(requestOf(i));
    const head = FILE_BLOCKS - 2; // 常规队尾:它比下一块先入队
    const urgent = FILE_BLOCKS - 1;

    peer.onBlockRequest(requestOf(head));
    peer.onBlockRequest(requestOf(urgent, { priority: true })); // 用户点名插队

    await drainTo(sim, reads, FILE_BLOCKS);
    expect(reads.indexOf(urgent)).toBeLessThan(reads.indexOf(head));
  });

  it('请求量远小于窗口时行为与不设限一致(小文件零影响)', () => {
    const { sim, peer, reads } = harness();
    for (let i = 0; i < 3; i++) peer.onBlockRequest(requestOf(i)); // 3 × 1.37MB ≪ 8MB
    expect(reads.length).toBe(3);
    expect(sim.sock.peak).toBeLessThan(WINDOW);
  });
});
