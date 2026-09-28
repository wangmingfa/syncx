import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadOrCreateIdentity } from '../src/identity.js';
import type { SharedFolderConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import type { ControlMessage } from '../src/net/wire.js';
import { SyncSessionManager } from '../src/session-manager.js';
import { rmDir } from './helpers.js';

/**
 * Git 提交同步的「台账排空后结算」与「向其余对端中继」。
 *
 * 提交通知从控制面来,文件内容却要经数据面拉块才落盘 —— 收到通知就立刻
 * git add -A 定格的是半套文件,而且基线已推进、永远不会再有通知来纠正。
 * 所以通知只入队,由 flushPendingGitNotify 在每轮扫描末尾等 receiveLedger
 * 排空后再提交;超时兜底照旧提交(保留活性)。工作树干净则跳过提交,但
 * 基线必须推进到当前 HEAD,否则下一轮「新提交检测」会把它当成待广播的提交。
 *
 * 真正落了提交之后,这条通知会原样中继给本机该目录的其余对端(排除来源),
 * 链式拓扑 A—B—C 的末端才不至于一直接不到提交;skip 分支与 receive 模式都不转发。
 * 待中继的台账同时落盘到 gitRelayPending:中间设备在投出去之前重启,这一跳照样补得回。
 */

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitAvailable();

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initRepo(repoPath: string): string {
  git(repoPath, ['init', '-q']);
  git(repoPath, ['config', 'user.name', 'syncx-test']);
  git(repoPath, ['config', 'user.email', 'syncx-test@example.com']);
  git(repoPath, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repoPath, 'README.md'), '# git-sync drain fixture\n');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-qm', 'chore: 初始提交']);
  return git(repoPath, ['rev-parse', 'HEAD']);
}

function commitCount(repoPath: string): number {
  return Number(git(repoPath, ['rev-list', '--count', 'HEAD']));
}

type NotifyMsg = Extract<ControlMessage, { kind: 'git-commit-notify' }>;

/** 测试视角的内部接口:TS 的 private 只在编译期生效,测试按结构类型触达。 */
interface Internals {
  onGitCommitNotify(msg: NotifyMsg): void;
  flushPendingGitNotify(): void;
  sendControlTo(deviceId: string, msg: ControlMessage): boolean;
}

const cleanupDirs: string[] = [];

function boot(
  mode: 'full' | 'receive',
  devices = ['PEER000001'],
): { dir: string; share: string; manager: SyncSessionManager; folder: NonNullable<SyncSessionManager['folderStates'][number]>; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-gitsync-drain-'));
  const share = join(dir, 'share');
  mkdirSync(share, { recursive: true });
  const base = initRepo(share);
  const identity = loadOrCreateIdentity(dir);
  const configPath = join(dir, 'config.json');
  const sharedFolders = [{ id: 'main', path: share, devices, gitSync: mode }];
  writeFileSync(configPath, JSON.stringify({ sharedFolders, knownDevices: [], peers: [] }));
  const manager = new SyncSessionManager(
    { identity, configPath, configDir: dir, peerPort: 0, logger: createLogger(undefined) },
    sharedFolders,
  );
  const folder = manager.folderStates[0];
  if (!folder) throw new Error('folder state missing');
  cleanupDirs.push(dir);
  return { dir, share, manager, folder, base };
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmDir(dir);
  }
});

function notify(hash: string, message = 'feat: 远端提交'): NotifyMsg {
  return {
    kind: 'git-commit-notify',
    fromDeviceId: 'PEER000001',
    folderId: 'main',
    commitHash: hash,
    commitMessage: message,
    changedFiles: ['a.txt'],
    parentHash: '0'.repeat(40),
  };
}

/** 从磁盘配置里读某目录的待中继台账(验证「内存与配置同值」这条不变量)。 */
function relayOnDisk(dir: string): Record<string, unknown> | undefined {
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
    sharedFolders?: Array<{ id?: string; gitRelayPending?: Record<string, unknown> }>;
  };
  return config.sharedFolders?.find((f) => f.id === 'main')?.gitRelayPending;
}

/** 改写磁盘上该目录的配置字段(模拟手改配置 / 热重载读回的新状态)。 */
function patchDiskFolder(dir: string, patch: Record<string, unknown>): void {
  const configPath = join(dir, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    sharedFolders: Array<Record<string, unknown>>;
  };
  const folder = config.sharedFolders.find((f) => f.id === 'main');
  if (!folder) throw new Error('folder missing on disk');
  Object.assign(folder, patch);
  writeFileSync(configPath, JSON.stringify(config));
}

/**
 * 用同一份配置再启一个 manager —— 模拟 daemon 重启:内存台账全丢,一切都得从
 * config.json 还原。调用前必须先 close() 掉前一个(索引库同一文件,别双开)。
 */
function reboot(dir: string): { manager: SyncSessionManager; folder: SyncSessionManager['folderStates'][number] } {
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
    sharedFolders: SharedFolderConfig[];
  };
  const manager = new SyncSessionManager(
    {
      identity: loadOrCreateIdentity(dir),
      configPath: join(dir, 'config.json'),
      configDir: dir,
      peerPort: 0,
      logger: createLogger(undefined),
    },
    config.sharedFolders,
  );
  const folder = manager.folderStates[0];
  if (!folder) throw new Error('folder state missing');
  return { manager, folder };
}

/**
 * 拦住出站控制消息:中继是本机唯一会在结算路径上主动外发的动作,记录下来的
 * 每条都必然是中继。`deliver` 决定某个设备此刻算不算够得着(离线/握手中 = 够不着)。
 */
function spyControls(
  manager: SyncSessionManager,
  deliver: (deviceId: string) => boolean = () => true,
): Array<{ deviceId: string; msg: ControlMessage }> {
  const sent: Array<{ deviceId: string; msg: ControlMessage }> = [];
  const internals = manager as unknown as Internals;
  internals.sendControlTo = (deviceId, msg) => {
    sent.push({ deviceId, msg });
    return deliver(deviceId);
  };
  return sent;
}

describe('git auto-commit deferred until receive ledger drains', () => {
  beforeAll(() => {
    // 结算/广播的重试节奏与扫描循环同频;调快让测试不真等 5 秒
    process.env.SYNCX_SCAN_INTERVAL_MS = '250';
  });

  it.skipIf(!HAS_GIT)('queues the notify while receives are fresh and commits once they go stale', () => {
    const { share, manager, folder } = boot('full');
    const internals = manager as unknown as Internals;
    const remoteHash = 'b'.repeat(40);

    writeFileSync(join(share, 'a.txt'), 'from peer');
    folder.receiveLedger.set('a.txt', { claimId: 999, key: 'fake', ts: Date.now() });
    internals.onGitCommitNotify(notify(remoteHash));

    // 在途接收还活着(认领新鲜):什么都不发生 —— 无提交、通知仍挂着
    internals.flushPendingGitNotify();
    expect(commitCount(share)).toBe(1);
    expect(folder.pendingGitNotify).not.toBeNull();

    // 认领过期(60s 没来一块 = 死认领滞留):不再挡住结算 → 提交执行、基线推进
    folder.receiveLedger.set('a.txt', { claimId: 999, key: 'fake', ts: Date.now() - 61_000 });
    internals.flushPendingGitNotify();
    expect(commitCount(share)).toBe(2);
    expect(git(share, ['log', '-1', '--format=%s'])).toBe('feat: 远端提交');
    expect(git(share, ['status', '--porcelain'])).toBe('');
    expect(folder.pendingGitNotify).toBeNull();
    const mirror = git(share, ['rev-parse', 'HEAD']);
    expect(folder.lastCommitHash).toBe(mirror);

    // 死循环防护:基线已对齐 HEAD,再结算/再检测都不产生第三笔提交
    folder.receiveLedger.clear();
    internals.flushPendingGitNotify();
    expect(commitCount(share)).toBe(2);

    (manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('commits once the ledger drains, without waiting for the stale cap', () => {
    const { share, manager, folder } = boot('full');
    const internals = manager as unknown as Internals;

    writeFileSync(join(share, 'a.txt'), 'from peer');
    folder.receiveLedger.set('a.txt', { claimId: 999, key: 'fake', ts: Date.now() });
    internals.onGitCommitNotify(notify('c'.repeat(40)));

    // 内容落地 = 认领随文件终局被释放:结算立刻执行,不需要等满 60s
    folder.receiveLedger.clear();
    internals.flushPendingGitNotify();
    expect(commitCount(share)).toBe(2);
    expect(git(share, ['status', '--porcelain'])).toBe('');
    expect(folder.pendingGitNotify).toBeNull();

    (manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('skips the commit on a clean worktree but still advances the baseline', () => {
    const { share, manager, folder } = boot('full');
    const internals = manager as unknown as Internals;
    const head = git(share, ['rev-parse', 'HEAD']);

    // 对端提交的内容早已落地并随上一笔结算提交过:工作树干净
    internals.onGitCommitNotify(notify(head, 'docs: 已落地的提交'));
    internals.flushPendingGitNotify();
    expect(commitCount(share)).toBe(1);
    expect(folder.pendingGitNotify).toBeNull();
    // 基线推进到当前 HEAD:不推的话下一轮会把它误判成待广播的新提交
    expect(folder.lastCommitHash).toBe(head);
    // 基线已落盘(与内存同值)
    const config = JSON.parse(readFileSync(join(share, '..', 'config.json'), 'utf8')) as {
      sharedFolders?: Array<{ id?: string; gitLastCommitHash?: string }>;
    };
    expect(config.sharedFolders?.find((f) => f.id === 'main')?.gitLastCommitHash).toBe(head);

    (manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('dedupes a redelivered notify before it is ever queued', () => {
    const { share, manager, folder } = boot('receive');
    const internals = manager as unknown as Internals;
    const hash = 'd'.repeat(40);

    internals.onGitCommitNotify(notify(hash));
    expect(folder.pendingGitNotify).not.toBeNull();
    // 重连补发同一通知:入队阶段就被去重挡掉,不排两次
    folder.pendingGitNotify = null;
    internals.onGitCommitNotify(notify(hash));
    expect(folder.pendingGitNotify).toBeNull();

    (manager as unknown as { close(): void }).close();
  });
});

describe('git commit notify relayed to the folder\'s other devices', () => {
  it.skipIf(!HAS_GIT)('sends nothing when the source device is the only peer (plain pair)', () => {
    const { share, manager, folder } = boot('full'); // devices 只有通知来源
    const internals = manager as unknown as Internals;
    const sent = spyControls(manager);

    writeFileSync(join(share, 'a.txt'), 'from peer');
    internals.onGitCommitNotify(notify('1'.repeat(40)));
    internals.flushPendingGitNotify();

    expect(commitCount(share)).toBe(2);
    // 两台设备的常规拓扑:一个字都不多发,也不留中继台账
    expect(sent).toEqual([]);
    expect(folder.gitRelay).toBeNull();

    (manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('relays the original notify once the mirror commit lands, never back to the source', () => {
    const { share, manager, folder } = boot('full', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    const remoteHash = 'e'.repeat(40);
    const sent = spyControls(manager);

    writeFileSync(join(share, 'a.txt'), 'from peer');
    internals.onGitCommitNotify(notify(remoteHash));
    internals.flushPendingGitNotify();

    expect(commitCount(share)).toBe(2);
    // 转发的是**原始**通知:提交者仍是 PEER000001,哈希仍是它那一笔
    // (本机镜像哈希绝不出门),来源设备被排除
    expect(sent.map((s) => s.deviceId)).toEqual(['PEER000002']);
    expect(sent[0]?.msg).toMatchObject({
      kind: 'git-commit-notify',
      fromDeviceId: 'PEER000001',
      commitHash: remoteHash,
      commitMessage: 'feat: 远端提交',
    });
    expect(folder.gitRelay).toBeNull();

    (manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('does not relay when the mirror commit is skipped (clean worktree)', () => {
    const { share, manager, folder } = boot('full', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    const head = git(share, ['rev-parse', 'HEAD']);
    const sent = spyControls(manager);

    internals.onGitCommitNotify(notify(head, 'docs: 已落地的提交'));
    internals.flushPendingGitNotify();

    // skip 分支不提交也不转发:链路因此不会成环(每台真正落提交的设备才多走一跳)
    expect(commitCount(share)).toBe(1);
    expect(sent).toEqual([]);
    expect(folder.gitRelay).toBeNull();

    (manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('does not relay in receive-only mode', () => {
    const { share, manager, folder } = boot('receive', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    const sent = spyControls(manager);

    writeFileSync(join(share, 'a.txt'), 'from peer');
    internals.onGitCommitNotify(notify('f'.repeat(40)));
    internals.flushPendingGitNotify();

    // 自己照样提交(收),但一个字都不外发
    expect(commitCount(share)).toBe(2);
    expect(sent).toEqual([]);

    (manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('holds the relay while the target is out of reach and resends next flush', () => {
    const { share, manager, folder } = boot('full', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    let online = false;
    const sent = spyControls(manager, () => online);

    writeFileSync(join(share, 'a.txt'), 'from peer');
    internals.onGitCommitNotify(notify('a'.repeat(40)));
    internals.flushPendingGitNotify();
    expect(commitCount(share)).toBe(2);
    // 目标够不着:这一跳挂进台账等补投,而不是丢掉
    expect(folder.gitRelay?.targets).toEqual(['PEER000002']);

    online = true;
    internals.flushPendingGitNotify(); // 通知槽已空,纯补投
    expect(folder.gitRelay).toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.msg.commitHash).toBe('a'.repeat(40));

    (manager as unknown as { close(): void }).close();
  });
});

describe('git commit relay ledger persisted to config', () => {
  it.skipIf(!HAS_GIT)('resumes an undelivered relay after the daemon restarts', () => {
    const { dir, share, manager, folder } = boot('full', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    let online = false;
    spyControls(manager, () => online);

    writeFileSync(join(share, 'a.txt'), 'from peer');
    internals.onGitCommitNotify(notify('b'.repeat(40)));
    internals.flushPendingGitNotify();

    // 够不着 → 台账既在内存也落盘,两处同值
    expect(folder.gitRelay?.targets).toEqual(['PEER000002']);
    expect(relayOnDisk(dir)).toMatchObject({
      fromDeviceId: 'PEER000001',
      commitHash: 'b'.repeat(40),
      commitMessage: 'feat: 远端提交',
      changedFiles: ['a.txt'],
      targets: ['PEER000002'],
    });

    // 重启:内存全清,状态只能来自 config.json
    (manager as unknown as { close(): void }).close();
    const restarted = reboot(dir);
    expect(restarted.folder.gitRelay?.targets).toEqual(['PEER000002']);
    expect(restarted.folder.gitRelay?.msg.commitHash).toBe('b'.repeat(40));

    const sent = spyControls(restarted.manager, () => true);
    (restarted.manager as unknown as Internals).flushPendingGitNotify();
    expect(sent.map((s) => s.deviceId)).toEqual(['PEER000002']);
    expect(sent[0]?.msg).toMatchObject({ kind: 'git-commit-notify', commitHash: 'b'.repeat(40) });
    // 投完即两处一起清空:配置里不留陈旧的待中继记录
    expect(restarted.folder.gitRelay).toBeNull();
    expect(relayOnDisk(dir)).toBeUndefined();

    (restarted.manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('changing the gitSync mode drops the pending relay (memory and disk)', () => {
    const { dir, share, manager, folder } = boot('full', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    spyControls(manager, () => false);

    writeFileSync(join(share, 'a.txt'), 'from peer');
    internals.onGitCommitNotify(notify('c'.repeat(40)));
    internals.flushPendingGitNotify();
    expect(folder.gitRelay).not.toBeNull();

    // 改成 receive:用户已明确不再往外发,积压的那一笔也必须作废
    manager.setFolderGitSync('main', 'receive');
    expect(folder.gitRelay).toBeNull();
    expect(relayOnDisk(dir)).toBeUndefined();

    const sent = spyControls(manager, () => true);
    internals.flushPendingGitNotify();
    expect(sent).toEqual([]);

    (manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('hot reload treats the disk record as authoritative', () => {
    const { dir, share, manager, folder } = boot('full', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    spyControls(manager, () => false);

    writeFileSync(join(share, 'a.txt'), 'from peer');
    internals.onGitCommitNotify(notify('d'.repeat(40)));
    internals.flushPendingGitNotify();
    expect(folder.gitRelay).not.toBeNull();

    // 手改配置把待中继记录删了:内存跟随磁盘,而不是把旧台账再写回去
    patchDiskFolder(dir, { gitRelayPending: undefined });
    manager.reloadConfig();
    expect(folder.gitRelay).toBeNull();

    const sent = spyControls(manager, () => true);
    internals.flushPendingGitNotify();
    expect(sent).toEqual([]);
    expect(relayOnDisk(dir)).toBeUndefined();

    (manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('drops the relay when the target no longer shares the folder', () => {
    const { dir, share, manager, folder } = boot('full', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    spyControls(manager, () => false);

    writeFileSync(join(share, 'a.txt'), 'from peer');
    internals.onGitCommitNotify(notify('e'.repeat(40)));
    internals.flushPendingGitNotify();
    expect(folder.gitRelay?.targets).toEqual(['PEER000002']);

    // PEER000002 被移出该目录:无权再收,台账作废并清盘,绝不越权外发
    patchDiskFolder(dir, { devices: ['PEER000001'] });
    manager.reloadConfig();
    const sent = spyControls(manager, () => true);
    internals.flushPendingGitNotify();
    expect(sent).toEqual([]);
    expect(folder.gitRelay).toBeNull();
    expect(relayOnDisk(dir)).toBeUndefined();

    (manager as unknown as { close(): void }).close();
  });
});
