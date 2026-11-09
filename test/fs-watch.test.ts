import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch, type FSWatcher } from 'node:fs';

// 记录每轮真实扫描的根路径(mock 转发原实现,行为不变只加观测):
// 「watch 事件只重扫脏目录、其他目录未被扫」直接以扫描调用清单断言。
const mockScanCalls = vi.hoisted(() => [] as string[]);
vi.mock('../src/scanner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scanner.js')>();
  return {
    ...actual,
    scanFolderAsync: async (root: string, ...rest: unknown[]) => {
      mockScanCalls.push(root);
      type ScanFn = (root: string, ...args: unknown[]) => ReturnType<typeof actual.scanFolderAsync>;
      return await (actual.scanFolderAsync as unknown as ScanFn)(root, ...rest);
    },
  };
});

import { FolderWatchHub, normalizeWatchFilename } from '../src/fs-watcher.js';
import { isIgnoredPath, parseIgnoreRules } from '../src/ignore.js';
import { SyncSessionManager, type SessionManagerDeps } from '../src/session-manager.js';
import { loadConfig, type SharedFolderConfig } from '../src/config.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { createLogger } from '../src/logger.js';
import { rmDir } from './helpers.js';

/**
 * 文件系统监听驱动的扫描 + 定时兜底全扫(fs-watcher.ts + runScan 脏目录口径)。
 *
 * 架构契约:每个「未暂停且身份校验通过」的共享目录一个递归 fs.watch;事件只当
 * 触发器,聚合到「该目录脏了」后防抖触发单目录重扫;定时全扫退化为兜底。
 * 防抖/退避节奏经构造参数注入短值,避免慢测试。
 */

const cleanupDirs: string[] = [];

function tmp(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `syncx-fs-watch-${tag}-`));
  cleanupDirs.push(dir);
  return dir;
}

function errWithCode(code: string): Error {
  const e = new Error(`injected failure (${code})`);
  (e as NodeJS.ErrnoException).code = code;
  return e;
}

/**
 * 注入式假 watcher:hub 的 watchFn 换成它,测试直接投喂 (event, filename) 事件,
 * 不经过真实 fs.watch(过滤判定单测不掺 OS 噪声)。emitters[i] 对应第 i 个建出的
 * watcher;created 保留实例引用,供「谓词热替换不重建 watcher」断言。
 */
function fakeWatchFactory(): {
  watchFn: (path: string, opts: { recursive: true }) => FSWatcher;
  emitters: Array<(filename: string | null) => void>;
  created: FSWatcher[];
} {
  const emitters: Array<(filename: string | null) => void> = [];
  const created: FSWatcher[] = [];
  const watchFn = (): FSWatcher => {
    const handlers = new Map<string, (eventType: string, filename: string | null) => void>();
    const fake = {
      on: (event: string, cb: (eventType: string, filename: string | null) => void) => {
        handlers.set(event, cb);
        return fake;
      },
      close: () => {},
    };
    created.push(fake as unknown as FSWatcher);
    emitters.push((filename) => handlers.get('change')?.('change', filename));
    return fake as unknown as FSWatcher;
  };
  return { watchFn, emitters, created };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 8000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * 等一段「静默期」:触发记录停止增长达 quietMs 即返回。
 *
 * macOS 的 FSEvents 在建流时会重放注册前片刻的历史事件(实测:watch 刚建好就会
 * 收到目录自身创建的迟到事件),所以「启动 watcher → 立刻断言」必然混入噪声;
 * 先等噪声平息、清空记录,再做断言。
 */
async function waitQuiet(record: { length: number }, quietMs = 350, maxMs = 8000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let last = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (record.length !== last) {
      last = record.length;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return;
    }
  }
  throw new Error('waitQuiet 超时:触发记录始终未平息');
}

function makeManager(
  tag: string,
  config: Record<string, unknown>,
  deps: Partial<SessionManagerDeps> = {},
): { manager: SyncSessionManager; dir: string; configPath: string } {
  const dir = tmp(tag);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ sharedFolders: [], knownDevices: [], peers: [], ...config }));
  const sharedFolders = (config.sharedFolders ?? []) as SharedFolderConfig[];
  const manager = new SyncSessionManager(
    { identity: loadOrCreateIdentity(dir), configPath, configDir: dir, peerPort: 0, logger: createLogger(undefined), ...deps },
    sharedFolders,
  );
  return { manager, dir, configPath };
}

/** 优雅收尾:先让在途扫描排空再 close(与 git-sync-drain.test 同款处理)。 */
async function shutdown(manager: SyncSessionManager): Promise<void> {
  await new Promise((r) => setTimeout(r, 250));
  await manager.runScan();
  manager.close();
}

afterEach(() => {
  delete process.env.SYNCX_FS_WATCH_DEBOUNCE_MS;
  for (const dir of cleanupDirs.splice(0)) {
    rmDir(dir);
  }
});

describe('FolderWatchHub:事件聚合与防抖', () => {
  it('真实 fs.watch:写文件触发该目录脏标记,其他目录不受牵连', async () => {
    const dirA = tmp('real-a');
    const dirB = tmp('real-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const calls: string[][] = [];
    const hub = new FolderWatchHub({ debounceMs: 100, onScanDirty: (ids) => calls.push(ids) });
    try {
      hub.syncFolders([
        { id: 'a', path: dirA },
        { id: 'b', path: dirB },
      ]);
      await waitFor(() => hub.watchedIds().length === 2);
      // 先等启动期噪声(macOS FSEvents 建流重放)平息并清空记录
      await waitQuiet(calls);
      calls.length = 0;

      writeFileSync(join(dirA, 'x.txt'), 'hello');
      await waitFor(() => calls.length > 0);
      // 只塌缩出 A 一个脏目录
      expect(calls[0]).toEqual(['a']);
    } finally {
      hub.close();
    }
  });

  it('事件风暴塌缩:窗口内 N 个事件只触发一次重扫,窗口结束后恢复响应', async () => {
    const calls: string[][] = [];
    const hub = new FolderWatchHub({ debounceMs: 120, onScanDirty: (ids) => calls.push(ids) });
    try {
      // 风暴:50 个事件同步打到同一目录 → 一个防抖窗口内塌缩成一次
      for (let i = 0; i < 50; i++) hub.markDirty('a');
      await waitFor(() => calls.length > 0);
      expect(calls[0]).toEqual(['a']);
      expect(calls.length).toBe(1);

      // 新窗口:多目录事件聚合进同一次触发
      hub.markDirty('a');
      hub.markDirty('b');
      await waitFor(() => calls.length > 1);
      expect(calls[1]).toEqual(['a', 'b']);
    } finally {
      hub.close();
    }
  });
});

describe('FolderWatchHub:失效重建与降级', () => {
  it('目录被删后重建:syncFolders 对账发现 inode 变化,close 重建并立即触发该目录扫描', async () => {
    const dirA = tmp('recreate');
    mkdirSync(dirA, { recursive: true });
    const calls: string[][] = [];
    const hub = new FolderWatchHub({ debounceMs: 50, onScanDirty: (ids) => calls.push(ids) });
    try {
      hub.syncFolders([{ id: 'a', path: dirA }]);
      await waitFor(() => hub.hasWatcher('a'));

      // 删除后原地重建(inode 变化):Linux 上旧 inotify watch 已静默死亡且无 error 事件,
      // 对账以「建 watch 时的目录身份」发现失效。不能只 rm+mkdir:ext4 会把刚释放的
      // inode 立刻复用给紧邻的 mkdir,身份没变就对账不出失效 —— 先在旁边建个新目录
      // 再 rename 换入,inode 必然不同(rename 不改 inode)。
      calls.length = 0;
      rmSync(dirA, { recursive: true, force: true });
      const replacement = `${dirA}-rebuild`;
      mkdirSync(replacement, { recursive: true });
      renameSync(replacement, dirA);
      hub.syncFolders([{ id: 'a', path: dirA }]);
      expect(hub.hasWatcher('a')).toBe(true);
      // 重建后立即触发该目录扫描(补上失效空窗期的变化),不等防抖
      expect(calls.some((ids) => ids.includes('a'))).toBe(true);
    } finally {
      hub.close();
    }
  });

  it('目录不存在期间退避重建,不崩也不风暴;目录回来后 watcher 恢复', async () => {
    const dirA = tmp('backoff');
    // 故意不创建目录:创建失败走「目录不存在 → 退避重建」分支
    let fail = true;
    const hub = new FolderWatchHub({
      debounceMs: 50,
      rebuildBaseMs: 25,
      rebuildMaxMs: 200,
      onScanDirty: () => {},
      watchFn: (path, opts) => {
        if (fail) throw errWithCode('ENOENT');
        return watch(path, opts);
      },
    });
    try {
      hub.syncFolders([{ id: 'a', path: dirA }]);
      // 瞬时失败不算平台不可用:纯定时兜底继续有效
      expect(hub.healthy).toBe(true);
      expect(hub.hasWatcher('a')).toBe(false);

      // 目录出现 + 注入解除:退避定时器到期后自动补建
      mkdirSync(dirA, { recursive: true });
      fail = false;
      await waitFor(() => hub.hasWatcher('a'));
      expect(hub.healthy).toBe(true);
    } finally {
      hub.close();
    }
  });

  it('平台不支持递归 watch(创建即抛 ENOSYS)→ 全局降级,warn 一次', async () => {
    const dirA = tmp('enosys');
    mkdirSync(dirA, { recursive: true });
    let degraded = 0;
    const hub = new FolderWatchHub({
      debounceMs: 50,
      onScanDirty: () => {},
      onDegraded: () => {
        degraded += 1;
      },
      watchFn: () => {
        throw errWithCode('ENOSYS');
      },
    });
    hub.syncFolders([{ id: 'a', path: dirA }]);
    expect(hub.healthy).toBe(false);
    expect(degraded).toBe(1);
    expect(hub.watchedIds()).toEqual([]);

    // 降级后再对账完全空转:不再尝试创建、不再触发回调
    hub.syncFolders([{ id: 'a', path: dirA }]);
    expect(hub.healthy).toBe(false);
    expect(degraded).toBe(1);
    hub.close();
  });

  it('目录存在却连续创建失败(错误走异步形态的平台)→ 达到上限后降级', async () => {
    const dirA = tmp('flaky');
    mkdirSync(dirA, { recursive: true });
    let degraded = 0;
    const hub = new FolderWatchHub({
      debounceMs: 50,
      rebuildBaseMs: 20,
      rebuildMaxMs: 100,
      onScanDirty: () => {},
      onDegraded: () => {
        degraded += 1;
      },
      watchFn: () => {
        // 未知错误码且目录存在:既非「目录不存在」也非「明确不支持」,
        // 按连续失败计数,达上限判定平台不可用
        throw errWithCode('EFOO');
      },
    });
    try {
      hub.syncFolders([{ id: 'a', path: dirA }]);
      expect(hub.healthy).toBe(true); // 首次失败先退避重试
      await waitFor(() => !hub.healthy);
      expect(degraded).toBe(1);
    } finally {
      hub.close();
    }
  });
});

describe('FolderWatchHub:忽略规则过滤(事件在聚合前丢弃)', () => {
  /** 与 manager 注入同构的 .git 谓词(硬忽略路径段命中即丢)。 */
  const GIT_FILTER = (rel: string) => rel === '.git' || rel.startsWith('.git/');

  it('命中谓词的事件被丢弃(不打脏位),普通文件照常触发;聚合摘要带丢弃计数', async () => {
    const dirA = tmp('filter-hub');
    mkdirSync(dirA, { recursive: true });
    const { watchFn, emitters } = fakeWatchFactory();
    const calls: string[][] = [];
    const logs: string[] = [];
    const hub = new FolderWatchHub({
      debounceMs: 60,
      onScanDirty: (ids) => calls.push(ids),
      watchFn,
      log: (_level, line) => logs.push(line),
    });
    try {
      hub.syncFolders([{ id: 'a', path: dirA, filterEvent: GIT_FILTER }]);
      await waitFor(() => hub.hasWatcher('a'));
      const emit = emitters[0]!;

      // 实测事故复现:WebStorm 后台 git 集成持续刷 .git/index —— 这些事件必须
      // 全部丢弃,不打脏位、不触发重扫
      for (let i = 0; i < 5; i++) emit('.git/index');
      emit('.git/config');
      await sleep(150); // 超过一个防抖窗口
      expect(calls).toEqual([]);

      // 普通文件照常触发(语义红线:过滤仅限忽略范围)
      emit('src/a.txt');
      await waitFor(() => calls.length > 0);
      expect(calls[0]).toEqual(['a']);

      // 聚合 debug 一行带上丢弃计数(6 = 5×.git/index + 1×.git/config),绝不逐事件打日志
      expect(logs.filter((l) => l.includes('dropped 6 ignored fs event'))).toHaveLength(1);
    } finally {
      hub.close();
    }
  });

  it('null filename 与归一失败的路径保留原语义照常触发(宁可多扫不可漏扫)', async () => {
    const dirA = tmp('filter-null');
    mkdirSync(dirA, { recursive: true });
    const { watchFn, emitters } = fakeWatchFactory();
    const calls: string[][] = [];
    const hub = new FolderWatchHub({ debounceMs: 60, onScanDirty: (ids) => calls.push(ids), watchFn });
    try {
      hub.syncFolders([{ id: 'a', path: dirA, filterEvent: GIT_FILTER }]);
      await waitFor(() => hub.hasWatcher('a'));
      const emit = emitters[0]!;

      // null filename(部分平台的 rename 形态)→ 照常触发
      emit(null);
      await waitFor(() => calls.length > 0);
      expect(calls[0]).toEqual(['a']);
      calls.length = 0;

      // 绝对路径剥不上监听根 / 含 '..' 段 → 归一失败 → 当 null 处理,保留触发
      emit('/somewhere/else/x');
      emit('..\\escape');
      await waitFor(() => calls.length > 0);
      expect(calls[0]).toEqual(['a']);
    } finally {
      hub.close();
    }
  });

  it('被忽略目录下的文件丢弃(node_modules/x);被忽略目录自身的孤立事件放行', async () => {
    const dirA = tmp('filter-nm');
    mkdirSync(dirA, { recursive: true });
    const { watchFn, emitters } = fakeWatchFactory();
    const calls: string[][] = [];
    const hub = new FolderWatchHub({ debounceMs: 60, onScanDirty: (ids) => calls.push(ids), watchFn });
    try {
      // 与 session-manager 注入完全同构的谓词:isIgnoredPath = 硬忽略 + gitignore 语义
      const rules = parseIgnoreRules(['node_modules/']);
      hub.syncFolders([{ id: 'a', path: dirA, filterEvent: (rel) => isIgnoredPath(rules, rel, false) }]);
      await waitFor(() => hub.hasWatcher('a'));
      const emit = emitters[0]!;

      emit('node_modules/x');
      emit('node_modules/deep/pkg/file.js'); // 目录规则经前缀回溯命中任意深度
      await sleep(150);
      expect(calls).toEqual([]);

      // 目录规则按 isDir=false 判定是刻意保守:node_modules 自身的孤立 rename 事件放行,
      // 宁可多扫一轮也不冒「吞掉整棵子树变化」的风险(文件级事件才可靠地被前缀命中)
      emit('node_modules');
      await waitFor(() => calls.length > 0);
      expect(calls[0]).toEqual(['a']);
    } finally {
      hub.close();
    }
  });

  it('无谓词时一切照旧(向后兼容):.git 事件也照常触发', async () => {
    const dirA = tmp('filter-none');
    mkdirSync(dirA, { recursive: true });
    const { watchFn, emitters } = fakeWatchFactory();
    const calls: string[][] = [];
    const hub = new FolderWatchHub({ debounceMs: 60, onScanDirty: (ids) => calls.push(ids), watchFn });
    try {
      hub.syncFolders([{ id: 'a', path: dirA }]); // 没有 filterEvent
      await waitFor(() => hub.hasWatcher('a'));
      emitters[0]!('.git/index');
      await waitFor(() => calls.length > 0);
      expect(calls[0]).toEqual(['a']);
    } finally {
      hub.close();
    }
  });

  it('谓词热替换:syncFolders 换入新谓词即刻生效,且不重建 watcher', async () => {
    const dirA = tmp('filter-hot');
    mkdirSync(dirA, { recursive: true });
    const { watchFn, emitters, created } = fakeWatchFactory();
    const calls: string[][] = [];
    const hub = new FolderWatchHub({ debounceMs: 60, onScanDirty: (ids) => calls.push(ids), watchFn });
    try {
      hub.syncFolders([{ id: 'a', path: dirA, filterEvent: () => true }]); // 全部丢弃
      await waitFor(() => hub.hasWatcher('a'));
      const emit = emitters[0]!;
      emit('a.txt');
      await sleep(120);
      expect(calls).toEqual([]);

      // 规则重载:换入新谓词(不过滤)—— 即刻生效,watcher 未重建(回调按 id 查表)
      hub.syncFolders([{ id: 'a', path: dirA, filterEvent: () => false }]);
      emit('a.txt');
      await waitFor(() => calls.length > 0);
      expect(created).toHaveLength(1);

      // 谓词整体撤下:回到不过滤的旧行为
      hub.syncFolders([{ id: 'a', path: dirA }]);
      emit('.git/index');
      await waitFor(() => calls.length > 1);
      expect(created).toHaveLength(1);
    } finally {
      hub.close();
    }
  });
});

describe('normalizeWatchFilename:filename 归一化防御', () => {
  it('相对 POSIX 原样、反斜杠转正、绝对路径剥监听根、剥不出来当 null', () => {
    expect(normalizeWatchFilename('.git/index')).toBe('.git/index');
    expect(normalizeWatchFilename('src/a.txt')).toBe('src/a.txt');
    expect(normalizeWatchFilename('.git\\index')).toBe('.git/index');
    expect(normalizeWatchFilename('/root/sub/.git/index', '/root/sub')).toBe('.git/index');
    expect(normalizeWatchFilename('C:\\repo\\.git\\index', 'C:\\repo')).toBe('.git/index');
    // 绝对路径剥不上监听根 → 归一失败 → null(调用方按 null 处理:保留触发)
    expect(normalizeWatchFilename('/elsewhere/x', '/root/sub')).toBeNull();
    expect(normalizeWatchFilename('C:/other/x', '/root/sub')).toBeNull();
    expect(normalizeWatchFilename('/abs/path', undefined)).toBeNull();
    // '..' 段不可信;'./' 前缀剥掉;空串
    expect(normalizeWatchFilename('../escape/x')).toBeNull();
    expect(normalizeWatchFilename('./tmp/x')).toBe('tmp/x');
    expect(normalizeWatchFilename('')).toBeNull();
  });
});

describe('manager 集成:watch 驱动的单目录重扫与兜底间隔', () => {
  it('watch 事件只重扫脏目录,其他目录不被扫;全扫兜底照旧走全部', async () => {
    const dirA = tmp('scan-a');
    const dirB = tmp('scan-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirB, 'b.txt'), 'v1');
    const { manager } = makeManager('scan', {
      sharedFolders: [
        { id: 'fa', path: dirA, devices: [] },
        { id: 'fb', path: dirB, devices: [] },
      ],
    });
    try {
      // 基线:两目录各扫一轮,B 的 b.txt 进索引
      await manager.runScan();
      mockScanCalls.length = 0;

      process.env.SYNCX_FS_WATCH_DEBOUNCE_MS = '60';
      manager.startFolderWatchers();
      await waitFor(() => manager.isFolderWatched('fa') && manager.isFolderWatched('fb'));
      // 等启动期噪声(macOS FSEvents 建流时会重放注册前片刻的事件)平息,
      // 之后的扫描调用清单才是干净的观测样本
      await waitQuiet(mockScanCalls, 500);
      const scansOfB = mockScanCalls.filter((p) => p === dirB).length;

      // 写文件进 A:A 的 watcher 事件 → 防抖后单目录重扫(以 a.txt 进索引为正号)
      writeFileSync(join(dirA, 'a.txt'), 'from A');
      await waitFor(() => manager.folderStates[0]!.localIndex.has('a.txt'));
      // 让可能迟到的噪声排干,再做「B 未被扫」的断言
      await waitQuiet(mockScanCalls);

      // A 被重扫;B 一次都没被扫(扫描调用清单里没有 dirB 的新记录)
      expect(mockScanCalls.filter((p) => p === dirB).length).toBe(scansOfB);

      // 全扫兜底:不带脏目录的 runScan 照旧走全部目录
      await manager.runScan();
      expect(mockScanCalls).toContain(dirB);
    } finally {
      await shutdown(manager);
    }
  });

  it('runScan 脏目录口径与重入合并闸兼容:排队请求取并集,各脏目录都被补扫', async () => {
    const dirA = tmp('merge-a');
    const dirB = tmp('merge-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirA, 'a.txt'), 'v1');
    writeFileSync(join(dirB, 'b.txt'), 'v1');
    const { manager } = makeManager('merge', {
      sharedFolders: [
        { id: 'fa', path: dirA, devices: [] },
        { id: 'fb', path: dirB, devices: [] },
      ],
    });
    try {
      await manager.runScan(); // 基线
      const folderA = manager.folderStates[0]!;
      const folderB = manager.folderStates[1]!;
      writeFileSync(join(dirA, 'a.txt'), 'v2-changed');
      writeFileSync(join(dirB, 'b.txt'), 'v2-changed');

      // 第一轮只扫 A;扫描进行中(重入闸关闭)到达的 B 触发排队合并,补跑一轮扫 B
      const p1 = manager.runScan(['fa']);
      const p2 = manager.runScan(['fb']);
      await Promise.all([p1, p2]);

      expect(folderA.localIndex.get('a.txt')?.size).toBe('v2-changed'.length);
      expect(folderB.localIndex.get('b.txt')?.size).toBe('v2-changed'.length);
    } finally {
      await shutdown(manager);
    }
  });

  it('暂停目录不建 watcher,恢复时重建', async () => {
    const dirA = tmp('pause');
    mkdirSync(dirA, { recursive: true });
    const { manager } = makeManager('pause', {
      sharedFolders: [{ id: 'fa', path: dirA, devices: [] }],
    });
    try {
      manager.startFolderWatchers();
      await waitFor(() => manager.isFolderWatched('fa'));

      manager.setFolderPaused('fa', true);
      expect(manager.isFolderWatched('fa')).toBe(false);

      manager.setFolderPaused('fa', false);
      expect(manager.isFolderWatched('fa')).toBe(true);
    } finally {
      await shutdown(manager);
    }
  });

  it('fsWatchEnabled=false:不建任何 watcher,兜底间隔退回原扫描节奏(纯定时)', async () => {
    const dirA = tmp('disabled');
    mkdirSync(dirA, { recursive: true });
    const { manager } = makeManager('disabled', {
      sharedFolders: [{ id: 'fa', path: dirA, devices: [] }],
      fsWatchEnabled: false,
    });
    try {
      manager.startFolderWatchers();
      expect(manager.isFolderWatched('fa')).toBe(false);
      expect(manager.fallbackScanIntervalMs()).toBe(5000); // SYNCX_SCAN_INTERVAL_MS 未注入 → 原 5s
    } finally {
      await shutdown(manager);
    }
  });

  it('兜底间隔取 fsWatchFallbackScanSecs;watcher 未启动时仍为原节奏', () => {
    const { manager } = makeManager('interval', {
      sharedFolders: [],
      fsWatchFallbackScanSecs: 90,
    });
    try {
      // hub 未启动(未调用 startFolderWatchers)= watcher 不可用 → 原节奏
      expect(manager.fallbackScanIntervalMs()).toBe(5000);
      // hub 已启动且健康(无目录 = 无 watcher,但平台未降级)→ 配置的兜底间隔
      manager.startFolderWatchers();
      expect(manager.fallbackScanIntervalMs()).toBe(90_000);
    } finally {
      manager.close();
    }
  });

  it('设置弹窗改 fs-watch 字段:镜像同步、watcher 集合对账、兜底间隔变化回调', async () => {
    const dirA = tmp('settings');
    mkdirSync(dirA, { recursive: true });
    const intervalChanges: number[] = [];
    const { manager } = makeManager('settings', {
      sharedFolders: [{ id: 'fa', path: dirA, devices: [] }],
    }, { onFallbackScanIntervalChanged: (ms) => intervalChanges.push(ms) });
    try {
      manager.startFolderWatchers();
      await waitFor(() => manager.isFolderWatched('fa'));

      manager.setGlobalSettings({ fsWatchFallbackScanSecs: 30 });
      expect(manager.fallbackScanIntervalMs()).toBe(30_000);
      expect(intervalChanges).toContain(30_000);

      manager.setGlobalSettings({ fsWatchEnabled: false });
      expect(manager.isFolderWatched('fa')).toBe(false);
      expect(manager.fallbackScanIntervalMs()).toBe(5000);
      expect(intervalChanges).toContain(5000);
    } finally {
      await shutdown(manager);
    }
  });
});

describe('manager 集成:syncWatchers 注入的谓词对真实目录规则生效', () => {
  it('实测风暴复现:.git 子树事件不再触发重扫,普通文件照常触发', async () => {
    const dirA = tmp('storm-a');
    mkdirSync(join(dirA, '.git'), { recursive: true });
    writeFileSync(join(dirA, '.git/index'), 'seed');
    const { manager } = makeManager('storm', {
      sharedFolders: [{ id: 'fa', path: dirA, devices: [] }],
    });
    try {
      await manager.runScan(); // 基线:.git 硬忽略,不进索引
      mockScanCalls.length = 0;
      process.env.SYNCX_FS_WATCH_DEBOUNCE_MS = '60';
      manager.startFolderWatchers();
      await waitFor(() => manager.isFolderWatched('fa'));
      // 等启动期噪声(macOS FSEvents 建流重放)平息,之后的记录才是干净样本
      await waitQuiet(mockScanCalls, 500);
      const baseline = mockScanCalls.length;

      // WebStorm 每 ~2s 刷 .git/index 的形态:连续写入,全部应被谓词丢弃
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(dirA, '.git/index'), `tick ${i}`);
        await sleep(80); // 超过防抖窗口
      }
      await sleep(200);
      expect(mockScanCalls.length).toBe(baseline);

      // 对照组:普通文件照常触发单目录重扫(过滤仅限忽略范围)
      writeFileSync(join(dirA, 'a.txt'), 'v');
      await waitFor(() => mockScanCalls.length > baseline);
    } finally {
      await shutdown(manager);
    }
  });

  it('规则保存后谓词热更新:新忽略目录下的事件不再触发扫描', async () => {
    const dirA = tmp('rules-a');
    mkdirSync(join(dirA, 'logs'), { recursive: true }); // 目录先建好,避免创建事件噪声
    const { manager } = makeManager('rules', {
      sharedFolders: [{ id: 'fa', path: dirA, devices: [] }],
    });
    try {
      await manager.runScan();
      mockScanCalls.length = 0;
      process.env.SYNCX_FS_WATCH_DEBOUNCE_MS = '60';
      manager.startFolderWatchers();
      await waitFor(() => manager.isFolderWatched('fa'));
      await waitQuiet(mockScanCalls, 500);

      // 规则未生效前:logs 下的写入照常触发
      writeFileSync(join(dirA, 'logs/a.log'), 'v');
      await waitFor(() => mockScanCalls.length > 0);
      await waitQuiet(mockScanCalls);

      // 保存规则:setFolderIgnoreLines 刷新 ignoreLines 并对账 watcher(谓词热替换)
      manager.setFolderIgnoreLines('fa', ['logs/']);
      await waitQuiet(mockScanCalls);
      const armed = mockScanCalls.length;

      // 新忽略目录下的写入:被谓词丢弃,不触发扫描
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(dirA, 'logs/b.log'), `tick ${i}`);
        await sleep(80);
      }
      await sleep(200);
      expect(mockScanCalls.length).toBe(armed);

      // 对照组:非忽略文件照常触发
      writeFileSync(join(dirA, 'c.txt'), 'v');
      await waitFor(() => mockScanCalls.length > armed);
    } finally {
      await shutdown(manager);
    }
  });
});

describe('fs-watch 配置字段清洗往返', () => {
  it('loadConfig:非法值丢弃回默认,合法值保留,未知字段不受影响', () => {
    const dir = tmp('sanitize');
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        sharedFolders: [],
        fsWatchEnabled: 'yes', // 非布尔:丢弃(回默认 true)
        fsWatchFallbackScanSecs: -5, // 非法间隔:丢弃(回默认 600)
        someFutureField: { kept: true }, // 未知字段:原样保留(跨后端共写约定)
      }),
    );
    const config = loadConfig(configPath);
    expect(config.fsWatchEnabled).toBeUndefined();
    expect(config.fsWatchFallbackScanSecs).toBeUndefined();
    expect((config as unknown as Record<string, unknown>).someFutureField).toEqual({ kept: true });

    writeFileSync(
      configPath,
      JSON.stringify({ sharedFolders: [], fsWatchEnabled: false, fsWatchFallbackScanSecs: 120 }),
    );
    const loaded = loadConfig(configPath);
    expect(loaded.fsWatchEnabled).toBe(false);
    expect(loaded.fsWatchFallbackScanSecs).toBe(120);
  });

  it('devices.setGlobalSettings:仅 false 落盘,null 回默认,间隔下限校验', async () => {
    const { setGlobalSettings } = await import('../src/devices.js');
    const dir = tmp('patch');
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ sharedFolders: [] }));

    setGlobalSettings(configPath, { fsWatchEnabled: true, fsWatchFallbackScanSecs: 45 });
    let config = loadConfig(configPath);
    expect(config.fsWatchEnabled).toBeUndefined(); // 缺省即开,config 不留 true
    expect(config.fsWatchFallbackScanSecs).toBe(45);

    setGlobalSettings(configPath, { fsWatchEnabled: false, fsWatchFallbackScanSecs: null });
    config = loadConfig(configPath);
    expect(config.fsWatchEnabled).toBe(false);
    expect(config.fsWatchFallbackScanSecs).toBeUndefined(); // null = 回默认 600

    expect(() => setGlobalSettings(configPath, { fsWatchFallbackScanSecs: 0 })).toThrow(/兜底扫描间隔/);
  });
});
