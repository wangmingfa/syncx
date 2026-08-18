import { describe, expect, it, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { loadOrCreateIdentity } from '../../src/identity.js';
import { openIndexStore } from '../../src/indexstore.js';
import { hashBlock } from '../../src/blockstore.js';

const children: ChildProcess[] = [];

/** 停掉所有子进程并等待退出;避免进程仍持有文件导致清理竞态(ENOTEMPTY)。 */
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

afterEach(() => {
  for (const child of children) {
    child.kill('SIGTERM');
  }
  children.length = 0;
});

function waitFor(condition: () => boolean, timeoutMs = 15000): Promise<void> {
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

/** 创建 daemon 配置目录 + 预置索引条目,返回设置(不启动进程)。 */
function setupDaemon(
  name: string,
  seedFiles: Array<{ path: string; content: Buffer }>,
): DaemonSetup {
  const dir = mkdtempSync(join(tmpdir(), `syncx-daemon-${name}-`));
  const share = join(dir, 'share');
  mkdirSync(share, { recursive: true });

  const identity = loadOrCreateIdentity(dir);
  const index = openIndexStore(join(dir, 'index.db'));
  for (const file of seedFiles) {
    writeFileSync(join(share, file.path), file.content);
    index.saveEntry({
      path: file.path,
      version: new Map([[identity.deviceId, 1]]),
      size: file.content.length,
      deleted: false,
      blocks: [hashBlock(file.content)],
    });
  }
  index.close();

  return {
    dir,
    share,
    configPath: join(dir, 'config.json'),
    peerPort: 25000 + Math.floor(Math.random() * 10000),
    controlPort: 26000 + Math.floor(Math.random() * 10000),
    deviceId: identity.deviceId,
  };
}

function startDaemon(setup: DaemonSetup, peers: string[], peerDeviceIds: string[]): void {
  writeFileSync(
    setup.configPath,
    JSON.stringify({
      sharedFolders: [{ path: setup.share, devices: peerDeviceIds }],
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
    { cwd: process.cwd(), stdio: 'pipe' },
  );
  children.push(child);
}

describe('two real daemons sync over peers config', () => {
  it(
    'propagates files in both directions between two processes',
    async () => {
      const a = setupDaemon('a', [
        { path: 'a.txt', content: Buffer.from('content from A') },
      ]);
      const b = setupDaemon('b', [
        { path: 'b.txt', content: Buffer.from('content from B') },
      ]);

      // 两个 daemon 互相把对方配为手动对端,并互相加入 devices 白名单
      startDaemon(a, [`ws://127.0.0.1:${b.peerPort}`], [b.deviceId]);
      startDaemon(b, [`ws://127.0.0.1:${a.peerPort}`], [a.deviceId]);

      // 双向同步:B 应收到 a.txt,A 应收到 b.txt
      await waitFor(() => existsSync(join(b.share, 'a.txt')));
      await waitFor(() => existsSync(join(a.share, 'b.txt')));

      expect(readFileSync(join(b.share, 'a.txt'))).toEqual(Buffer.from('content from A'));
      expect(readFileSync(join(a.share, 'b.txt'))).toEqual(Buffer.from('content from B'));

      // 先停掉 daemon 再清理临时目录,避免进程写文件导致 ENOTEMPTY
      await stopChildren();
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    },
    30000,
  );
});
