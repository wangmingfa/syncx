import { describe, expect, it, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  createWriteStream,
} from 'node:fs';
import { rmDir } from '../helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { loadOrCreateIdentity } from '../../src/identity.js';
import { chunkContent, hashBlock, splitIntoBlocks } from '../../src/blockstore.js';
import { allocatePort, cleanDaemonEnv } from './ports.js';

/**
 * CDC 内容定义分块的「真进程收益」证明:两个真实 daemon 之间,对 6MB 文件做
 * 一次中部 10KB 插入后,接收侧的**网络字节增量**应只有插入点所在那一块的量级,
 * 而不是定长块口径下的整尾重传。
 *
 * 预算不从文件尺寸拍脑袋,而是用同一套 chunkContent 在测试里算出差集:期望过网量 =
 * v2 中内容不在 v1 块集合里的那些块。定长口径的对照量一并算出来,断言它比 CDC 口径大过
 * 四倍 —— 这样"省了"这件事本身也是被验证的,不是从日志里读出来的印象。
 *
 * 单元层(test/peer.test.ts)已钉死协议语义;这里守的是装配层 —— 索引构造、
 * 线格式、存储、供块偏移换算在真实进程里整条链是否真的接通(任何一环没接上,
 * 表现都是「悄悄退回定长全量重传」,单测全绿但收益为零)。
 */

const children: ChildProcess[] = [];

async function stopChildren(): Promise<void> {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
        }),
    ),
  );
  children.length = 0;
}

afterEach(async () => {
  await stopChildren();
});

function waitFor(condition: () => boolean, timeoutMs = 45000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

interface DaemonSetup {
  dir: string;
  share: string;
  configPath: string;
  peerPort: number;
  controlPort: number;
  deviceId: string;
}

async function setupDaemon(name: string): Promise<DaemonSetup> {
  const dir = mkdtempSync(join(tmpdir(), `syncx-cdc-${name}-`));
  const share = join(dir, 'share');
  mkdirSync(share, { recursive: true });
  const identity = loadOrCreateIdentity(dir);
  const [peerPort, controlPort] = await Promise.all([allocatePort(), allocatePort()]);
  return {
    dir,
    share,
    configPath: join(dir, 'config.json'),
    peerPort,
    controlPort,
    deviceId: identity.deviceId,
  };
}

function startDaemon(setup: DaemonSetup, peers: string[], peerDeviceIds: string[]): ChildProcess {
  writeFileSync(
    setup.configPath,
    JSON.stringify({
      sharedFolders: [{ id: 'main', path: setup.share, devices: peerDeviceIds }],
      peers,
    }),
  );
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/main.ts',
      'start',
      '--config',
      setup.configPath,
      '--port',
      String(setup.peerPort),
      '--control-port',
      String(setup.controlPort),
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: cleanDaemonEnv() },
  );
  child.stdout?.pipe(createWriteStream(join(setup.dir, 'daemon.out.log')));
  child.stderr?.pipe(createWriteStream(join(setup.dir, 'daemon.err.log')));
  children.push(child);
  return child;
}

async function waitForDaemonReady(setup: DaemonSetup): Promise<void> {
  await waitFor(() => {
    try {
      return readFileSync(join(setup.dir, 'daemon.out.log'), 'utf8').includes(
        'syncx daemon started',
      );
    } catch {
      return false;
    }
  });
}

/** /api/status 里我们关心的两块:traffic 字节账本(块载荷的网络量,重启清零)。 */
async function getTraffic(setup: DaemonSetup): Promise<{ sent: number; received: number }> {
  const token = readFileSync(join(setup.dir, 'control.token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${setup.controlPort}/api/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /api/status returned ${res.status}`);
  const json = (await res.json()) as {
    traffic?: { sent: number; received: number };
  };
  return json.traffic ?? { sent: 0, received: 0 };
}

/** 确定性伪随机内容(mulberry32):与单测同一族,块边界可复现。 */
function pseudoRandom(size: number, seed: number): Buffer {
  const buf = Buffer.allocUnsafe(size);
  let a = seed >>> 0;
  for (let i = 0; i < size; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    buf[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return buf;
}

describe('two daemons over CDC', () => {
  it(
    '中部 10KB 插入后,接收侧网络字节增量远小于一遍文件',
    async () => {
      const v1 = pseudoRandom(6_000_000, 0x2468ace);
      // 插入点不写死:取 v1 **最短**那个 CDC 块的中部。这样「本轮应过网的字节数」是由内容
      // 算出来的期望值,而不是一个碰运气调出来的魔数预算 —— 换指纹、换种子都不用重调这条用例。
      const v1Chunks = chunkContent(v1);
      const starts: number[] = [];
      let cum = 0;
      for (const c of v1Chunks) {
        starts.push(cum);
        cum += c.length;
      }
      const si = v1Chunks.reduce((best, c, i) => (c.length < v1Chunks[best]!.length ? i : best), 0);
      const at = starts[si]! + Math.floor(v1Chunks[si]!.length / 2);
      const v2 = Buffer.concat([
        v1.subarray(0, at),
        Buffer.alloc(10_240, 0x5c),
        v1.subarray(at),
      ]);
      // CDC 差集 = 这轮真正必须过网的字节:v2 里内容不在 v1 块集合中的那些块
      const v1Hashes = new Set(v1Chunks.map(hashBlock));
      const cdcBytes = chunkContent(v2)
        .filter((c) => !v1Hashes.has(hashBlock(c)))
        .reduce((s, c) => s + c.length, 0);
      // 前提自查:这轮改动在 CDC 口径下确实只值一小块(否则下面的预算只是在描述巧合,
      // 用例退化成"传了多少算多少")
      expect(cdcBytes).toBeGreaterThan(0);
      expect(cdcBytes * 4).toBeLessThan(v1.length);
      // 对照组:同样的插入在定长口径下按块下标匹配几乎全废 —— 收益确实来自 CDC
      const v1Blocks = splitIntoBlocks(v1).map(hashBlock);
      const fixedBytes = splitIntoBlocks(v2).reduce(
        (s, c, i) => (hashBlock(c) !== v1Blocks[i] ? s + c.length : s),
        0,
      );
      expect(fixedBytes).toBeGreaterThan(cdcBytes * 4);

      const a = await setupDaemon('a');
      const b = await setupDaemon('b');

      startDaemon(a, [`ws://127.0.0.1:${b.peerPort}`], [b.deviceId]);
      await waitForDaemonReady(a);
      startDaemon(b, [`ws://127.0.0.1:${a.peerPort}`], [a.deviceId]);

      // 首传:文件在 B 落地(此轮无本地可比对版本,按定长全量走,正是 CDC 的对照基线)
      writeFileSync(join(a.share, 'big.bin'), v1);
      await waitFor(
        () => {
          try {
            return (
              existsSync(join(b.share, 'big.bin')) &&
              readFileSync(join(b.share, 'big.bin')).equals(v1)
            );
          } catch {
            return false;
          }
        },
        60000,
      );

      // 基线读数:等首传的块流量走完再取(取差值时把索引/控制帧排除在外 ——
      // traffic 只记块载荷字节,索引帧本来就不计)
      await new Promise((r) => setTimeout(r, 800));
      const base = { a: await getTraffic(a), b: await getTraffic(b) };

      // A 侧「编辑器式」中部插入 → 扫描重索引(带 cdh)→ 增量广播 → B 按 CDC 差集拉块
      writeFileSync(join(a.share, 'big.bin'), v2);
      await waitFor(
        () => {
          try {
            return readFileSync(join(b.share, 'big.bin')).equals(v2);
          } catch {
            return false;
          }
        },
        60000,
      );

      const after = { a: await getTraffic(a), b: await getTraffic(b) };
      const bReceived = after.b.received - base.b.received;
      const aSent = after.a.sent - base.a.sent;
      // 失败时能直接看到差值,判断是「退回全量」还是「账本没接上」
      console.log(
        `[cdc-transfer] cdcBytes=${cdcBytes} fixedBytes=${fixedBytes} bReceived=${bReceived} aSent=${aSent}`,
      );

      // 期望值由内容算出(见上):下限是「该传的确实传了」,上限给一轮版本竞态重放留出
      // 余地(整轮重放的量仍是 cdcBytes 级别,和一遍文件差着一个数量级)。
      expect(bReceived).toBeGreaterThanOrEqual(cdcBytes);
      expect(bReceived).toBeLessThanOrEqual(2 * cdcBytes);
      expect(aSent).toBeLessThanOrEqual(2 * cdcBytes);

      await stopChildren();
      rmDir(a.dir);
      rmDir(b.dir);
    },
    150000,
  );
});
