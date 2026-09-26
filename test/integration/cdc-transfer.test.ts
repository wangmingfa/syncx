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
import { allocatePort, cleanDaemonEnv } from './ports.js';

/**
 * CDC 内容定义分块的「真进程收益」证明:两个真实 daemon 之间,对 6MB 文件做
 * 一次中部 10KB 插入后,接收侧的**网络字节增量**应远小于一遍文件(2MB 预算),
 * 而不是定长块口径下的整文件重传(≈6MB)。
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
      const v2 = Buffer.concat([
        v1.subarray(0, 3_000_000),
        Buffer.alloc(10_240, 0x5c),
        v1.subarray(3_000_000),
      ]);

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
      console.log(`[cdc-transfer] bReceived=${bReceived} aSent=${aSent} (bytes)`);

      // 定长口径下这一轮是 ≈6MB(6 个整块重传,外加 B 无块可预填);
      // CDC 下只有插入点所在的那一个块(≈0.6MB)过网。留 2MB 宽松预算:
      // 版本竞态多一轮重放的余地都有,但绝不可能是一遍文件的量级。
      expect(bReceived).toBeGreaterThan(0);
      expect(bReceived).toBeLessThan(2 * 1024 * 1024);
      expect(aSent).toBeLessThan(2 * 1024 * 1024);

      await stopChildren();
      rmDir(a.dir);
      rmDir(b.dir);
    },
    150000,
  );
});
