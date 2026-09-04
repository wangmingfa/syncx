import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { loadOrCreateIdentity } from '../../src/identity.js';
import { allocatePort } from './ports.js';

const children: ChildProcess[] = [];

/** 停掉所有子进程,避免旧 daemon 占用文件导致清理竞态。 */
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

interface DaemonSetup {
  dir: string;
  share: string;
  configPath: string;
  peerPort: number;
  controlPort: number;
  deviceId: string;
}

async function setupDaemon(name: string): Promise<DaemonSetup> {
  const dir = mkdtempSync(join(tmpdir(), `syncx-offer-${name}-`));
  const share = join(dir, 'share');
  mkdirSync(share, { recursive: true });
  const identity = loadOrCreateIdentity(dir);
  const [peerPort, controlPort] = await Promise.all([allocatePort(), allocatePort()]);
  return { dir, share, configPath: join(dir, 'config.json'), peerPort, controlPort, deviceId: identity.deviceId };
}

function startDaemon(
  setup: DaemonSetup,
  opts: {
    peers?: string[];
    knownDevices?: string[];
    sharedFolders?: Array<{ id: string; path: string; devices: string[] }>;
  },
): void {
  writeFileSync(
    setup.configPath,
    JSON.stringify({
      sharedFolders: opts.sharedFolders ?? [],
      peers: opts.peers ?? [],
      knownDevices: opts.knownDevices ?? [],
    }),
  );
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/main.ts', 'start', '--config', setup.configPath, '--port', String(setup.peerPort), '--control-port', String(setup.controlPort)],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout?.pipe(createWriteStream(join(setup.dir, 'daemon.out.log')));
  child.stderr?.pipe(createWriteStream(join(setup.dir, 'daemon.err.log')));
  children.push(child);
}

async function waitForDaemonReady(setup: DaemonSetup): Promise<void> {
  await waitFor(() => {
    try {
      return readFileSync(join(setup.dir, 'daemon.out.log'), 'utf8').includes('syncx daemon started');
    } catch {
      return false;
    }
  });
}

async function apiCall(
  setup: DaemonSetup,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const token = readFileSync(join(setup.dir, 'control.token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${setup.controlPort}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function waitFor(condition: () => Promise<unknown>, timeoutMs = 30000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async (): Promise<void> => {
      try {
        const v = await condition();
        if (v) {
          resolve(v);
          return;
        }
      } catch (err) {
        console.log('[waitFor] condition threw:', err instanceof Error ? err.message : String(err));
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(check, 200);
    };
    void check();
  });
}

function dumpLogs(...setups: DaemonSetup[]): void {
  for (const s of setups) {
    try {
      console.log(`--- ${s.dir} share:`, readFileSync(join(s.share, '.'), 'utf8'));
    } catch {
      /* noop */
    }
    for (const f of ['daemon.out.log', 'daemon.err.log', 'control.token']) {
      try {
        console.log(`--- ${s.dir}/${f} ---`);
        console.log(readFileSync(join(s.dir, f), 'utf8'));
      } catch {
        console.log(`(no ${f})`);
      }
    }
  }
}

describe('Phase 2 remote confirmation (offer channel)', () => {
  it(
    'folder-invitation and pairing-request flow over a live daemon connection',
    async () => {
      const a = await setupDaemon('a');
      const b = await setupDaemon('b');
      try {
      // A 共享目录并把 B 指派进去(既授权连接,又会在连接建立时推送目录共享邀请);
      // B 暂无共享目录,稍后通过接受邀请来落地。
      startDaemon(a, {
        peers: [`ws://127.0.0.1:${b.peerPort}`],
        sharedFolders: [{ id: 'main', path: a.share, devices: [b.deviceId] }],
      });
      await waitForDaemonReady(a);
      startDaemon(b, { peers: [`ws://127.0.0.1:${a.peerPort}`] });
      await waitForDaemonReady(b);
      try {
        console.log('[dbg] A out:', readFileSync(join(a.dir, 'daemon.out.log'), 'utf8'));
      } catch { console.log('[dbg] A out: (missing)'); }
      try {
        console.log('[dbg] B out:', readFileSync(join(b.dir, 'daemon.out.log'), 'utf8'));
      } catch { console.log('[dbg] B out: (missing)'); }
      try {
        const st = (await apiCall(a, 'GET', '/api/status')) as { deviceId: string; devices: unknown[] };
        console.log('[dbg] A status devices:', JSON.stringify(st.devices));
      } catch (e) { console.log('[dbg] A status err:', e instanceof Error ? e.message : String(e)); }

      // 等 B 连上 A(B 出站连接被 A 接受,因为 A 的目录已把 B 列入 devices)
      await waitFor(async () => {
        const st = (await apiCall(a, 'GET', '/api/status')) as { devices: Array<{ deviceId: string; online: boolean }> };
        return st.devices.some((d) => d.deviceId === b.deviceId && d.online);
      }, 30000);

      // A 连接建立时 pushSharesTo 推送 folder-invitation → B 弹出待确认
      const folderOffer = (await waitFor(async () => {
        const st = (await apiCall(b, 'GET', '/api/status')) as { offers: Array<{ kind: string; fromDeviceId: string; folderId?: string }> };
        return st.offers.find((o) => o.kind === 'folder' && o.fromDeviceId === a.deviceId) ?? null;
      }, 20000)) as { id: string; folderId?: string };
      expect(folderOffer).toBeTruthy();
      expect(folderOffer.folderId).toBe('main');

      // B 接受目录共享邀请并选好本地路径
      await apiCall(b, 'POST', `/api/offers/${folderOffer.id}/accept`, { localPath: b.share });

      const bAfterFolder = (await waitFor(async () => {
        const st = (await apiCall(b, 'GET', '/api/status')) as {
          folders: Array<{ id: string; devices: string[] }>;
        };
        const f = st.folders.find((x) => x.id === 'main');
        return f && f.devices.includes(a.deviceId) ? st : null;
      }, 20000)) as { folders: Array<{ id: string; devices: string[] }> };
      expect(bAfterFolder.folders.find((x) => x.id === 'main')?.devices).toContain(a.deviceId);

      // A 再把 B 加为 known device → 通过已建立的会话推送 pairing-request
      await apiCall(a, 'POST', '/api/devices', { deviceId: b.deviceId });
      const pairingOffer = (await waitFor(async () => {
        const st = (await apiCall(b, 'GET', '/api/status')) as { offers: Array<{ kind: string; fromDeviceId: string }> };
        return st.offers.find((o) => o.kind === 'pairing' && o.fromDeviceId === a.deviceId) ?? null;
      }, 20000)) as { id: string };
      expect(pairingOffer).toBeTruthy();

      // B 接受配对请求 → B 把 A 记入 knownDevices
      await apiCall(b, 'POST', `/api/offers/${pairingOffer.id}/accept`);
      await waitFor(async () => {
        const st = (await apiCall(b, 'GET', '/api/status')) as {
          devices: Array<{ deviceId: string }>;
        };
        return st.devices.some((d) => d.deviceId === a.deviceId);
      }, 20000);
      } catch (err) {
        console.log('[offer-flow] FAILED, dumping daemon logs:');
        dumpLogs(a, b);
        throw err;
      }

      await stopChildren();
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    },
    150000,
  );

  it(
    'addFolder immediately pushes a folder-invitation to an assigned online peer (no second setup needed)',
    async () => {
      const a = await setupDaemon('a');
      const b = await setupDaemon('b');
      try {
        // A 预先授权 B(knownDevices),但首启动不配任何共享目录——这样连接建立时
        // 不会走 pushSharesTo 重连补推,纯粹考验 addFolder 的即时推送。
        startDaemon(a, { knownDevices: [b.deviceId], peers: [`ws://127.0.0.1:${b.peerPort}`] });
        await waitForDaemonReady(a);
        // B 主动拨 A(A 已授权 B,接受连接);A 不在 B 的 knownDevices,故仅 B 单向拨入
        startDaemon(b, { peers: [`ws://127.0.0.1:${a.peerPort}`] });
        await waitForDaemonReady(b);

        // 等双向连接建立(A 侧看到 B 在线)
        await waitFor(async () => {
          const st = (await apiCall(a, 'GET', '/api/status')) as {
            devices: Array<{ deviceId: string; online: boolean }>;
          };
          return st.devices.some((d) => d.deviceId === b.deviceId && d.online);
        }, 30000);

        // A 新建共享目录并直接指派 B——应当即时推送邀请,而非等 B 再建一次目录
        await apiCall(a, 'POST', '/api/folders', {
          path: a.share,
          devices: [b.deviceId],
          id: 'main',
        });

        // B 立即收到 folder-invitation(旧逻辑:不会触发,需 B 手动建目录)
        const folderOffer = (await waitFor(async () => {
          const st = (await apiCall(b, 'GET', '/api/status')) as {
            offers: Array<{ kind: string; fromDeviceId: string; folderId?: string }>;
          };
          return st.offers.find((o) => o.kind === 'folder' && o.fromDeviceId === a.deviceId) ?? null;
        }, 20000)) as { id: string; folderId?: string };
        expect(folderOffer).toBeTruthy();
        expect(folderOffer.folderId).toBe('main');

        // B 接受邀请并落地到本地路径,闭环成立
        await apiCall(b, 'POST', `/api/offers/${folderOffer.id}/accept`, { localPath: b.share });
        await waitFor(async () => {
          const st = (await apiCall(b, 'GET', '/api/status')) as {
            folders: Array<{ id: string; devices: string[] }>;
          };
          const f = st.folders.find((x) => x.id === 'main');
          return f && f.devices.includes(a.deviceId);
        }, 20000);
      } catch (err) {
        console.log('[offer-flow:addFolder] FAILED, dumping daemon logs:');
        dumpLogs(a, b);
        throw err;
      }

      await stopChildren();
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    },
    150000,
  );
});
