import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';

import { rmDir } from './helpers.js';
import { SyncSessionManager, type FolderState } from '../src/session-manager.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { folderIdFor, folderIndexPath, purgeOrphanIndexFiles, type Config, type SharedFolderConfig } from '../src/config.js';
import { ensureFolderMarker } from '../src/marker.js';
import type { IndexEntry } from '../src/index.js';

/**
 * 索引库清理回归(2026-09-15 双向误删事故的根因封堵)。
 *
 * 事故链条:移除共享目录时勾了「同时删除索引库」,但索引库文件没被真正删掉 →
 * 同一 folderId 再次添加时复用了旧索引(里面全是上一轮的活条目)→ 本机磁盘已无这些
 * 文件 → 扫描判定为「本地删除」→ 墓碑广播给完整端 → 对端成批文件被删。
 *
 * 关键点:daemon 持有 .db 句柄时即时 unlink 必然失败(Windows EBUSY),唯一可靠的
 * 删除时机是 reloadConfig 里 index.close() 之后。因此「登记待清理 + 显式 reloadConfig」
 * 必须成对出现,缺一不可。
 */
/**
 * 取指定序号的目录运行期状态。
 *
 * `noUncheckedIndexedAccess` 下 `folderStates[0]` 的类型是 `FolderState | undefined`,
 * 而用例本身断言该目录必然存在——用显式 guard 把它收敛为 `FolderState`,
 * 既满足类型检查,也让「断言失败」以清晰的错误信息暴露,而不是靠非空断言掩盖。
 */
function folderAt(mgr: SyncSessionManager, index = 0): FolderState {
  const state = mgr.folderStates[index];
  if (!state) throw new Error(`folder state #${index} not found (count=${mgr.folderStates.length})`);
  return state;
}

function setup(): {
  dir: string;
  configPath: string;
  share: string;
  writeConfig: (folders: SharedFolderConfig[]) => void;
  createManager: (folders: SharedFolderConfig[]) => SyncSessionManager;
} {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-index-purge-'));
  const configPath = join(dir, 'config.json');
  const share = join(dir, 'share');
  mkdirSync(share, { recursive: true });

  const writeConfig = (folders: SharedFolderConfig[]): void => {
    writeFileSync(
      configPath,
      JSON.stringify({ sharedFolders: folders, peers: [], knownDevices: [], pendingOffers: [] }, null, 2),
    );
  };

  const createManager = (folders: SharedFolderConfig[]): SyncSessionManager =>
    new SyncSessionManager(
      {
        identity: loadOrCreateIdentity(dir),
        configPath,
        configDir: dir,
        peerPort: 0,
        logger: pino({ level: 'silent' }),
      },
      folders,
    );

  return { dir, configPath, share, writeConfig, createManager };
}

describe('索引库清理', () => {
  it('移除目录且登记待清理后,reloadConfig 真正删掉索引库文件', () => {
    const { dir, share, writeConfig, createManager } = setup();
    const folder: SharedFolderConfig = { path: share, devices: [], id: 'aabbccddeeff' };
    writeConfig([folder]);
    // 目录初始即在内存中 → 索引库已打开(模拟 daemon 持有句柄的情形)
    const mgr = createManager([folder]);
    const dbPath = folderIndexPath(dir, folderIdFor(folder));
    expect(existsSync(dbPath)).toBe(true);

    // 模拟 cli.removeFolder:配置里移除 + 登记待清理 + 显式热重载
    writeConfig([]);
    mgr.markIndexForPurge(folderIdFor(folder));
    mgr.reloadConfig();

    expect(existsSync(dbPath)).toBe(false);
    mgr.close();
    rmDir(dir);
  });

  it('未勾选「删除索引库」时保留索引库(尊重用户显式选择)', () => {
    const { dir, share, writeConfig, createManager } = setup();
    const folder: SharedFolderConfig = { path: share, devices: [], id: 'aabbccddeeff' };
    writeConfig([folder]);
    const mgr = createManager([folder]);
    const dbPath = folderIndexPath(dir, folderIdFor(folder));

    writeConfig([]);
    // 不调用 markIndexForPurge
    mgr.reloadConfig();

    expect(existsSync(dbPath)).toBe(true);
    mgr.close();
    rmDir(dir);
  });

  it('同一路径的 folderId 被重新指派时,旧索引库被清理(否则 id 兜回来会复用旧墓碑)', () => {
    const { dir, share, writeConfig, createManager } = setup();
    const before: SharedFolderConfig = { path: share, devices: [], id: 'oldoldoldold' };
    writeConfig([before]);
    const mgr = createManager([before]);
    const oldDb = folderIndexPath(dir, folderIdFor(before));
    expect(existsSync(oldDb)).toBe(true);

    // 接受目录邀请时的 id 对齐:同路径换成对端的 folderId
    const after: SharedFolderConfig = { path: share, devices: ['PEER'], id: 'newnewnewnew' };
    writeConfig([after]);
    mgr.reloadConfig();

    expect(existsSync(oldDb)).toBe(false);
    expect(existsSync(folderIndexPath(dir, folderIdFor(after)))).toBe(true);
    mgr.close();
    rmDir(dir);
  });
});

describe('目录实例化(instanceId):索引寿命 = 目录实例寿命', () => {
  it('同 id 移除后重加会产生新实例,绝不继承旧索引里的条目', () => {
    const { dir, share, writeConfig, createManager } = setup();
    const before: SharedFolderConfig = { path: share, devices: [], id: 'sameid000001', instanceId: 'inst-old' };
    writeConfig([before]);
    const mgr = createManager([before]);

    // 旧实例索引里留一条「索引有、磁盘无」的条目 —— 若被新实例继承,扫描会判为本地删除并广播
    const stale: IndexEntry = {
      path: 'stale.txt',
      version: new Map([['DEV', 1]]),
      size: 5,
      deleted: false,
      blocks: ['h'],
    };
    folderAt(mgr).index.saveEntry(stale);
    const oldDb = folderIndexPath(dir, 'inst-old');
    expect(existsSync(oldDb)).toBe(true);

    // 移除后同 folderId 重新添加:新条目 → 新 instanceId → 新索引文件名
    const after: SharedFolderConfig = { path: share, devices: [], id: 'sameid000001', instanceId: 'inst-new' };
    writeConfig([after]);
    mgr.reloadConfig();

    const newDb = folderIndexPath(dir, 'inst-new');
    expect(existsSync(newDb)).toBe(true);
    expect(existsSync(oldDb)).toBe(false); // 旧实例的库被废弃清理
    expect(folderAt(mgr).indexKey).toBe('inst-new');
    // 关键:新实例索引为空 → 旧条目在结构上不可能被继承(也就不会变成删除广播出去)
    expect(folderAt(mgr).localIndex.size).toBe(0);

    mgr.close();
    rmDir(dir);
  });

  it('缺省 instanceId 的旧配置沿用 folderId 命名的索引(升级不触发重扫)', () => {
    const { dir, share, writeConfig, createManager } = setup();
    const legacy: SharedFolderConfig = { path: share, devices: [], id: 'legacy000001' };
    writeConfig([legacy]);
    const mgr = createManager([legacy]);

    expect(folderAt(mgr).indexKey).toBe('legacy000001');
    expect(existsSync(folderIndexPath(dir, folderIdFor(legacy)))).toBe(true);
    // 未生成 instanceId(既有条目不做实例化,避免升级后索引换名触发全量重扫)
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).sharedFolders[0].instanceId).toBeUndefined();

    mgr.close();
    rmDir(dir);
  });
});

describe('启动孤儿索引回收(purgeOrphanIndexFiles)', () => {
  it('删掉不属于当前 config 的索引库(含 sidecar),保留在册库与无关文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-orphan-'));
    const keep = folderIndexPath(dir, 'keepkey');
    const orphan = folderIndexPath(dir, 'orphankey');
    writeFileSync(keep, '');
    writeFileSync(orphan, '');
    writeFileSync(`${orphan}-wal`, '');
    const unrelated = join(dir, 'control.token');
    writeFileSync(unrelated, 'not-an-index');

    const config: Config = {
      sharedFolders: [{ path: '/x', devices: [], instanceId: 'keepkey' }],
      peers: [],
      knownDevices: [],
      pendingOffers: [],
    };
    const removed = purgeOrphanIndexFiles(dir, config);

    expect(existsSync(keep)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(`${orphan}-wal`)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(removed.sort()).toEqual([orphan, `${orphan}-wal`].sort());

    rmDir(dir);
  });
});

describe('硬忽略断根(.git 等历史条目在启动时被清出索引库)', () => {
  /**
   * 2026-09-15 事故留给旧库的「种子」:旧版本把 .git 当普通内容索引过,库里留着活条目
   * 与墓碑。过滤能挡住它们参与同步(filterIndexedEntries),但它们在库里既污染条目统计、
   * 又会在排查时误导判断,所以创建目录状态时顺手删掉。这是纯优化:即使不删也不会同步。
   */
  it('清掉 .git 等遗留条目,普通条目不受影响', () => {
    const { dir, share, writeConfig, createManager } = setup();
    const folder: SharedFolderConfig = {
      path: share,
      devices: [],
      id: 'hardign000001',
      instanceId: 'inst-hard',
    };
    writeConfig([folder]);
    const mgr = createManager([folder]);

    const index = folderAt(mgr).index;
    index.saveEntry({
      path: '.git/config',
      version: new Map([['DEV', 1]]),
      size: 7,
      deleted: false,
      blocks: ['h'],
    });
    index.saveEntry({
      path: '.git/HEAD',
      version: new Map([['DEV', 2]]),
      size: 0,
      deleted: true,
      blocks: [],
    });
    index.saveEntry({
      path: 'utils/version.mbt',
      version: new Map([['DEV', 1]]),
      size: 3,
      deleted: false,
      blocks: ['h'],
    });
    mgr.close();

    // 重启:重新打开同一个索引库(daemon 每次启动都会走 createFolderState)
    const mgr2 = createManager([folder]);
    const reopened = folderAt(mgr2).index;

    expect(reopened.getEntry('.git/config')).toBeUndefined();
    expect(reopened.getEntry('.git/HEAD')).toBeUndefined();
    expect(reopened.getEntry('utils/version.mbt')).toBeDefined();
    // 本地索引(与对端交换的那一份)同样不含它们
    expect(folderAt(mgr2).localIndex.has('.git/config')).toBe(false);
    expect(folderAt(mgr2).localIndex.has('utils/version.mbt')).toBe(true);

    mgr2.close();
    rmDir(dir);
  });
});

describe('可疑删除防御(墓碑路径含平台分隔符)', () => {
  it("路径含 '\\' 的墓碑被拒绝执行:索引错配绝不演变成数据丢失", async () => {
    const { dir, share, writeConfig, createManager } = setup();
    const folder: SharedFolderConfig = { path: share, devices: [], id: 'sepguard00001' };
    writeConfig([folder]);
    ensureFolderMarker(share);
    const mgr = createManager([folder]);
    // 模拟「本地路径构造与协议索引不一致」:索引条目用 '\' 分隔,而扫描器按 '/' 生成路径,
    // 于是这条看起来「盘上已无」→ 会被判成墓碑。这正是 2026-09-15 的事故形态。
    folderAt(mgr).index.saveEntry({
      path: 'utils\\version.mbt',
      version: new Map([['DEV', 1]]),
      size: 3,
      deleted: false,
      blocks: ['h'],
    });

    await mgr.runScan();

    // 条目保持「活的」(既未删除也未写入墓碑),并给出可见的目录错误
    expect(folderAt(mgr).index.getEntry('utils\\version.mbt')?.deleted).toBe(false);
    expect(mgr.getFolderErrors().some((e) => e.message.includes('可疑删除'))).toBe(true);

    mgr.close();
    rmDir(dir);
  });
});

describe('挂载标记门禁(.syncx-folder)', () => {
  it('标记缺失时跳过扫描:目录不可信不会被误判成「文件被删光」', async () => {
    const { dir, share, writeConfig, createManager } = setup();
    const folder: SharedFolderConfig = { path: share, devices: [], id: 'markergate001' };
    writeConfig([folder]);
    const mgr = createManager([folder]);
    // 造出「索引里有、磁盘上无」的形态(盘未挂载 / 目录被整体清空的典型样貌)
    folderAt(mgr).index.saveEntry({
      path: 'doc.txt',
      version: new Map([['DEV', 1]]),
      size: 3,
      deleted: false,
      blocks: ['h'],
    });

    await mgr.runScan();

    // 无墓碑:索引条目保持「活的」,并给出可见的目录错误与恢复指引
    expect(folderAt(mgr).index.getEntry('doc.txt')?.deleted).toBe(false);
    expect(mgr.getFolderErrors().some((e) => e.message.includes('缺少共享目录标记'))).toBe(true);

    // 建立标记后放行:此时才允许按真实差异推断删除
    ensureFolderMarker(share);
    await mgr.runScan();
    expect(folderAt(mgr).index.getEntry('doc.txt')?.deleted).toBe(true);
    expect(mgr.getFolderErrors()).toHaveLength(0);

    mgr.close();
    rmDir(dir);
  });
});
