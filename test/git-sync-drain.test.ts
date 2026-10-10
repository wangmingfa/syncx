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
 *
 * 两份台账(中继 `gitRelayPending`、本机出站广播 `gitBroadcastPending`)都按**投递回执**
 * 销账:接收方处理到通知即回 git-commit-ack(回给这一跳,不是最初提交者),发送端收到
 * 回执才算这一笔完成。写成功却没回执的设备重发到上限自动放弃(旧版本对端不认识该 kind),
 * 离线的设备不计数、账一直记着 —— 它回来时补投,这正是「内容同步了、提交却少一笔」的解药。
 * 台账同时落盘:中间设备在投出去之前重启,这一跳照样补得回。
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
  onControl(msg: ControlMessage, hopDeviceId: string): void;
  flushPendingGitNotify(): void;
  checkGitCommits(): Promise<void>;
  sendControlTo(deviceId: string, msg: ControlMessage): boolean;
}

const cleanupDirs: string[] = [];

function boot(
  mode: 'off' | 'send' | 'receive' | 'full',
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

/**
 * 关一个 manager 的正确顺序:先把在途扫描排空,再 close()。
 *
 * close() 是同步的,也不会等 runScan —— 扫描进行中关掉,索引库(sqlite)句柄就还攥着
 * 临时目录,Windows 上 afterEach 的 rmDir 直接 EPERM(macOS/Linux 不锁,所以这条只在
 * 那边红)。而 `await runScan()` 单独用也不够:它在已有扫描在跑时只置一个 scanQueued
 * 就立刻返回(见其重入注释),所以要先让出一格真实时间、再 await 一轮。同款处理见
 * test/folder-identity.test.ts 的收尾。
 */
async function shutdown(manager: SyncSessionManager): Promise<void> {
  await new Promise((r) => setTimeout(r, 250));
  await manager.runScan();
  manager.close();
}

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

/** 从磁盘配置里读某目录的待投递台账(验证「内存与配置同值」这条不变量)。 */
function pendingOnDisk(dir: string, field: 'gitRelayPending' | 'gitBroadcastPending'): Record<string, unknown> | undefined {
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
    sharedFolders?: Array<{ id?: string } & Partial<Record<typeof field, Record<string, unknown>>>>;
  };
  return config.sharedFolders?.find((f) => f.id === 'main')?.[field];
}

const relayOnDisk = (dir: string) => pendingOnDisk(dir, 'gitRelayPending');
const broadcastOnDisk = (dir: string) => pendingOnDisk(dir, 'gitBroadcastPending');

/** 接收方处理到通知后回给发送方的投递回执(它署自己的 id,发送方按它匹配台账目标)。 */
function ackOf(hash: string, device: string): ControlMessage {
  return { kind: 'git-commit-ack', fromDeviceId: device, folderId: 'main', commitHash: hash };
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
 * config.json 还原。调用前必须先经 shutdown() 关掉前一个(索引库同一文件,别双开;
 * 直接 close() 不算关 —— 在途扫描会让句柄还攥着目录,见 shutdown 的注释)。
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

  it.skipIf(!HAS_GIT)('appends the batch subjects to the mirror commit message, oldest first', () => {
    const { share, manager, folder } = boot('full');
    const internals = manager as unknown as Internals;

    // 离线积压多笔的通知:镜像提交正文用最后一笔,body 附上其余提交的 subject(旧→新)
    writeFileSync(join(share, 'a.txt'), 'from peer');
    const batch = notify('9'.repeat(40), 'feat: 最后一笔\n\n最后一笔的正文');
    batch.commitSubjects = ['feat: 第一笔', 'feat: 第二笔', 'feat: 最后一笔'];
    internals.onGitCommitNotify(batch);
    internals.flushPendingGitNotify();
    expect(commitCount(share)).toBe(2);
    expect(git(share, ['log', '-1', '--format=%B']).trim())
      .toBe('feat: 最后一笔\n\n最后一笔的正文\n\nfeat: 第一笔\nfeat: 第二笔');

    // 缺 commitSubjects(旧版本对端):消息原样落库,不多一段
    writeFileSync(join(share, 'b.txt'), 'again');
    internals.onGitCommitNotify(notify('8'.repeat(40), 'feat: 单独一笔'));
    internals.flushPendingGitNotify();
    expect(commitCount(share)).toBe(3);
    expect(git(share, ['log', '-1', '--format=%B']).trim()).toBe('feat: 单独一笔');

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
    const { dir, share, manager, folder } = boot('full', ['PEER000001', 'PEER000002']);
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
    // 写成功不等于送达:回执没到之前这一跳仍挂在台账上(内存与磁盘同值)
    expect(folder.gitRelay?.targets).toEqual(['PEER000002']);
    expect(relayOnDisk(dir)).toMatchObject({ commitHash: remoteHash, targets: ['PEER000002'] });
    // 对端回执到达 → 销账(内存与磁盘一起清)
    internals.onControl(ackOf(remoteHash, 'PEER000002'), 'PEER000002');
    expect(folder.gitRelay).toBeNull();
    expect(relayOnDisk(dir)).toBeUndefined();

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
    const { dir, share, manager, folder } = boot('full', ['PEER000001', 'PEER000002']);
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
    expect(sent).toHaveLength(2);
    // 先钉住 kind 再按收窄取哈希:补投出去的那一笔必须原样是 git 提交通知
    expect(sent[1]?.msg.kind).toBe('git-commit-notify');
    const resent = sent[1]?.msg;
    if (resent?.kind !== 'git-commit-notify') throw new Error('resent message is not a git commit notify');
    expect(resent.commitHash).toBe('a'.repeat(40));
    // 补投只是「再送一次」,销账要等回执
    expect(folder.gitRelay?.targets).toEqual(['PEER000002']);
    // 再补投一轮:台账未清,会原样重发(接收侧按哈希去重,重复通知无害)
    internals.flushPendingGitNotify();
    expect(sent).toHaveLength(3);
    // 回执到达 → 两处一起清空,不再多发一个字
    internals.onControl(ackOf('a'.repeat(40), 'PEER000002'), 'PEER000002');
    expect(folder.gitRelay).toBeNull();
    expect(relayOnDisk(dir)).toBeUndefined();
    internals.flushPendingGitNotify();
    expect(sent).toHaveLength(3);

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
    // 补投成功后仍等回执;回执到达才两处一起清空:配置里不留陈旧的待中继记录
    expect(restarted.folder.gitRelay?.targets).toEqual(['PEER000002']);
    (restarted.manager as unknown as Internals).onControl(ackOf('b'.repeat(40), 'PEER000002'), 'PEER000002');
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

describe('git commit broadcast reaches every device of the folder', () => {
  /**
   * 真实事故:本机 mo 目录配了两台设备,15:58:13 探活失败拆掉了其中一台的连接,
   * 15:58:14 本机提交广播只送达另一台 —— `broadcastGitCommit` 只看「至少送达一个」,
   * 于是基线照样推进,掉线那台永远收不到这一笔通知(文件照常同步,工作树留一堆未提交
   * 改动)。这条测试钉住这个缺口:没送达的设备必须被记住并在下一轮补投。
   */
  it.skipIf(!HAS_GIT)('carries the subjects of every commit in the batch on the broadcast', async () => {
    const { share, manager } = boot('full', ['PEER000001']);
    const internals = manager as unknown as Internals;
    const sent = spyControls(manager);

    await internals.checkGitCommits(); // 首轮建基线

    // 两轮扫描之间攒下两笔:通知必须带全整批 subject,正文取最后一笔
    writeFileSync(join(share, 'a.txt'), 'one');
    git(share, ['add', '-A']);
    git(share, ['commit', '-qm', 'feat: 第一笔']);
    writeFileSync(join(share, 'b.txt'), 'two');
    git(share, ['add', '-A']);
    git(share, ['commit', '-qm', 'feat: 第二笔']);
    await internals.checkGitCommits();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.msg).toMatchObject({
      kind: 'git-commit-notify',
      commitMessage: 'feat: 第二笔',
      commitSubjects: ['feat: 第一笔', 'feat: 第二笔'],
    });

    (manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('resends the commit notification to a device that was out of reach', async () => {
    const { share, manager } = boot('full', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    let online = new Set(['PEER000001', 'PEER000002']);
    const accepted: string[] = [];
    const sent = spyControls(manager, (deviceId) => {
      const ok = online.has(deviceId);
      if (ok) accepted.push(deviceId);
      return ok;
    });

    // 首轮只建基线,不广播
    await internals.checkGitCommits();
    expect(sent).toEqual([]);

    // 本机提交一笔,此刻 PEER000001 够不着
    writeFileSync(join(share, 'a.txt'), 'local change');
    git(share, ['add', '-A']);
    git(share, ['commit', '-qm', 'feat: 本机提交']);
    const head = git(share, ['rev-parse', 'HEAD']);
    online = new Set(['PEER000002']);
    await internals.checkGitCommits();
    expect(accepted).toEqual(['PEER000002']);

    // 它重连之后:这一笔要补投给它(接收侧按原始哈希去重,重复通知无害)
    online = new Set(['PEER000001', 'PEER000002']);
    accepted.length = 0;
    sent.length = 0;
    await internals.checkGitCommits();
    expect(accepted).toContain('PEER000001');
    const resent = sent.find((s) => s.deviceId === 'PEER000001')?.msg;
    if (resent?.kind !== 'git-commit-notify') throw new Error('PEER000001 没有收到 git 提交通知');
    expect(resent.commitHash).toBe(head);

    (manager as unknown as { close(): void }).close();
  });

  /**
   * 发送端的「完成」判据是**回执**,不是本地写成功:两台都写成功时台账仍挂着两台,
   * 各自回执各自销账,回执齐了才清空(内存与磁盘一起)。
   */
  it.skipIf(!HAS_GIT)('keeps one entry per device until every device has acked', async () => {
    const { dir, share, manager, folder } = boot('full', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    const sent = spyControls(manager, () => true);

    await internals.checkGitCommits(); // 首轮建基线
    writeFileSync(join(share, 'a.txt'), 'local change');
    git(share, ['add', '-A']);
    git(share, ['commit', '-qm', 'feat: 本机提交']);
    const head = git(share, ['rev-parse', 'HEAD']);
    await internals.checkGitCommits();

    expect(sent.map((s) => s.deviceId).sort()).toEqual(['PEER000001', 'PEER000002']);
    expect(folder.gitBroadcast?.targets.sort()).toEqual(['PEER000001', 'PEER000002']);
    expect(broadcastOnDisk(dir)).toMatchObject({ commitHash: head, targets: ['PEER000001', 'PEER000002'] });

    internals.onControl(ackOf(head, 'PEER000001'), 'PEER000001');
    expect(folder.gitBroadcast?.targets).toEqual(['PEER000002']);
    expect(broadcastOnDisk(dir)).toMatchObject({ targets: ['PEER000002'] });

    // 回执齐 → 台账两处一起清空,后续扫描不再多发一个字
    internals.onControl(ackOf(head, 'PEER000002'), 'PEER000002');
    expect(folder.gitBroadcast).toBeNull();
    expect(broadcastOnDisk(dir)).toBeUndefined();
    sent.length = 0;
    await internals.checkGitCommits();
    expect(sent).toEqual([]);

    (manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('ignores an ack for a hash the ledger no longer holds', async () => {
    const { dir, share, manager, folder } = boot('full', ['PEER000001']);
    const internals = manager as unknown as Internals;
    spyControls(manager, () => true);

    await internals.checkGitCommits();
    writeFileSync(join(share, 'a.txt'), 'first');
    git(share, ['add', '-A']);
    git(share, ['commit', '-qm', 'feat: 第一笔']);
    await internals.checkGitCommits();
    expect(folder.gitBroadcast?.targets).toEqual(['PEER000001']);
    const pendingHash = folder.gitBroadcast?.msg.commitHash;

    // 陈旧回执(前一笔的)不清账:它证明不了这一笔送达
    internals.onControl(ackOf('9'.repeat(40), 'PEER000001'), 'PEER000001');
    expect(folder.gitBroadcast?.msg.commitHash).toBe(pendingHash);

    (manager as unknown as { close(): void }).close();
  });

  /**
   * 补投有上限:本地一直写成功却始终等不到回执 = 对端是不回 git-commit-ack 的旧版本,
   * 重发到上限自动放弃(每目标各记各的账,一台耗尽不连累另一台),绝不无限重发刷屏。
   */
  it.skipIf(!HAS_GIT)('abandons a peer that never acks after the resend cap, but keeps the other one', async () => {
    const { dir, share, manager, folder } = boot('full', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    // PEER000001 是旧版本:写得进去却永不定回执;PEER000002 正常回执
    const accepted: string[] = [];
    const sent = spyControls(manager, (deviceId) => {
      accepted.push(deviceId);
      return true;
    });

    await internals.checkGitCommits();
    writeFileSync(join(share, 'a.txt'), 'local change');
    git(share, ['add', '-A']);
    git(share, ['commit', '-qm', 'feat: 本机提交']);
    const head = git(share, ['rev-parse', 'HEAD']);
    await internals.checkGitCommits(); // 首发:两台各 1 次

    for (let i = 0; i < 10; i++) {
      internals.onControl(ackOf(head, 'PEER000002'), 'PEER000002');
      await internals.checkGitCommits();
    }

    // 首 1 次 + 补投 4 次 = 5 次写成功后放弃(GIT_NOTIFY_MAX_RESENDS)
    expect(sent.filter((s) => s.deviceId === 'PEER000001')).toHaveLength(5);
    expect(folder.gitBroadcast).toBeNull();
    expect(broadcastOnDisk(dir)).toBeUndefined();

    (manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('resumes an unacked broadcast after the daemon restarts', async () => {
    const { dir, share, manager, folder } = boot('full', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    spyControls(manager, () => false); // 两台都够不着

    await internals.checkGitCommits();
    writeFileSync(join(share, 'a.txt'), 'local change');
    git(share, ['add', '-A']);
    git(share, ['commit', '-qm', 'feat: 停机期间的提交']);
    const head = git(share, ['rev-parse', 'HEAD']);
    await internals.checkGitCommits();

    // 全部离线也要记账:旧实现里这一笔会因为「一个对端都没送达」而冻住基线等重试,
    // 而基线一旦因别的缘故推进就永久漏掉。现在基线照常推进,账落在台账里。
    expect(folder.gitBroadcast?.targets.sort()).toEqual(['PEER000001', 'PEER000002']);
    expect(folder.lastCommitHash).toBe(head);
    expect(broadcastOnDisk(dir)).toMatchObject({ commitHash: head });

    // 「重启」意味着旧进程先死:不关掉它,索引的 sqlite 句柄会一直攥着临时目录,
    // Windows 上 afterEach 的 rmDir 直接 EPERM(其余用例都关了自己的 manager,
    // 这条有两个 manager 却只关了后者 —— 漏的那个就是旧进程)。
    await shutdown(manager);
    const restarted = reboot(dir);
    expect(restarted.folder.gitBroadcast?.targets.sort()).toEqual(['PEER000001', 'PEER000002']);
    const sent = spyControls(restarted.manager, () => true);
    (restarted.manager as unknown as Internals).flushPendingGitNotify();
    expect(sent.map((s) => s.deviceId).sort()).toEqual(['PEER000001', 'PEER000002']);
    expect(sent[0]?.msg).toMatchObject({ kind: 'git-commit-notify', commitHash: head });
    // 重启后补投出去的这一笔照样要等回执才销账
    expect(restarted.folder.gitBroadcast?.targets.sort()).toEqual(['PEER000001', 'PEER000002']);
    (restarted.manager as unknown as Internals).onControl(ackOf(head, 'PEER000001'), 'PEER000001');
    (restarted.manager as unknown as Internals).onControl(ackOf(head, 'PEER000002'), 'PEER000002');
    expect(restarted.folder.gitBroadcast).toBeNull();
    expect(broadcastOnDisk(dir)).toBeUndefined();

    await shutdown(restarted.manager);
  });

  it.skipIf(!HAS_GIT)('drops the pending broadcast when the folder stops sending or loses its targets', async () => {
    const { dir, share, manager, folder } = boot('full', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    spyControls(manager, () => false);

    await internals.checkGitCommits();
    writeFileSync(join(share, 'a.txt'), 'local change');
    git(share, ['add', '-A']);
    git(share, ['commit', '-qm', 'feat: 本机提交']);
    await internals.checkGitCommits();
    expect(folder.gitBroadcast?.targets.sort()).toEqual(['PEER000001', 'PEER000002']);

    // 改成 receive:用户已明确不再往外发,积压的那一笔必须作废(内存与磁盘)
    manager.setFolderGitSync('main', 'receive');
    expect(folder.gitBroadcast).toBeNull();
    expect(broadcastOnDisk(dir)).toBeUndefined();
    const sent = spyControls(manager, () => true);
    internals.flushPendingGitNotify();
    expect(sent).toEqual([]);

    (manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('drops a target that has been unshared from the folder', async () => {
    const { dir, share, manager, folder } = boot('full', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    spyControls(manager, () => false);

    await internals.checkGitCommits();
    writeFileSync(join(share, 'a.txt'), 'local change');
    git(share, ['add', '-A']);
    git(share, ['commit', '-qm', 'feat: 本机提交']);
    await internals.checkGitCommits();

    // 目录不再共享给任何人:无权外发,台账作废并清盘
    patchDiskFolder(dir, { devices: [] });
    manager.reloadConfig();
    const sent = spyControls(manager, () => true);
    internals.flushPendingGitNotify();
    expect(sent).toEqual([]);
    expect(folder.gitBroadcast).toBeNull();
    expect(broadcastOnDisk(dir)).toBeUndefined();

    (manager as unknown as { close(): void }).close();
  });
});

describe('incoming git commit notify is receipted to the hop it arrived on', () => {
  /**
   * 中继出去的通知里 fromDeviceId 仍是最初那台提交设备(两跳之外,本机对它未必有会话),
   * 所以回执必须按**这一跳**寻址 —— 否则中间设备永远等不到回执,会一遍遍重发。
   */
  it.skipIf(!HAS_GIT)('answers a relayed notify back to the relaying device', () => {
    const { share, manager } = boot('receive', ['PEER000001', 'PEER000002']);
    const internals = manager as unknown as Internals;
    const sent = spyControls(manager, () => true);
    writeFileSync(join(share, 'a.txt'), 'from peer');

    // 通知由 PEER000002 转发过来,署名仍是最初提交者 PEER000001
    internals.onControl(notify('7'.repeat(40)), 'PEER000002');

    const receipt = sent.find((s) => s.msg.kind === 'git-commit-ack');
    expect(receipt?.deviceId).toBe('PEER000002');
    expect(receipt?.msg).toMatchObject({ kind: 'git-commit-ack', folderId: 'main', commitHash: '7'.repeat(40) });
    // 通知照常入队(回执只是投递层的事,不影响接收流程)
    expect(manager.folderStates[0]?.pendingGitNotify).not.toBeNull();

    (manager as unknown as { close(): void }).close();
  });

  it.skipIf(!HAS_GIT)('receipts even a notify it will not act on (no such folder / send-only mode)', () => {
    const { manager } = boot('send', ['PEER000001']);
    const internals = manager as unknown as Internals;
    const sent = spyControls(manager, () => true);

    // 本目录是 send 模式:不提交,但回执照回 —— 发送方据此停止重发
    internals.onControl(notify('8'.repeat(40)), 'PEER000001');
    expect(sent.filter((s) => s.msg.kind === 'git-commit-ack')).toHaveLength(1);
    expect(manager.folderStates[0]?.pendingGitNotify).toBeNull();

    (manager as unknown as { close(): void }).close();
  });
});
