import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync as rm, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scanFolder, scanFolderAsync, type ScanDiff } from '../src/scanner.js';
import { openIndexStore, type IndexStore } from '../src/indexstore.js';
import { parseIgnoreRules } from '../src/ignore.js';
import { hashBlock } from '../src/blockstore.js';
import { rmDir } from './helpers.js';

/**
 * scanFolderAsync(让出主线程的异步形态)与同步版 scanFolder 的语义等价性测试。
 *
 * 背景:Termux(Android)上 scanOnce 的同步遍历会把事件循环饿死(生产日志实证:
 * 每 ~6s 一次 ~5s 卡顿)。异步版必须在「语义完全一致」的前提下让出主线程 ——
 * 这里用同一棵临时目录树、两份相同种子的索引,逐字段比对两版的产出与落库结果。
 */

function setup(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), `syncx-scanner-async-${tag}-`));
  const root = join(dir, 'share');
  mkdirSync(root, { recursive: true });
  const index = openIndexStore(join(dir, 'index.db'));
  return { dir, root, index };
}

/** 向单个索引写入「与盘上内容一致」的条目;mtime 取真实 stat 时走免哈希快速路径。 */
function seedPresent(root: string, index: IndexStore, rel: string, content: string, deviceId = 'DEV-A') {
  const abs = join(root, rel);
  const s = statSync(abs);
  index.saveEntry({
    path: rel,
    version: new Map([[deviceId, 1]]),
    size: content.length,
    deleted: false,
    blocks: [hashBlock(Buffer.from(content))],
    ...(s ? { mtime: s.mtimeMs } : {}),
  });
}

/** 只写索引不写盘(用于构造「盘上已删除」「内容已变化」的种子)。 */
function seedIndexOnly(
  index: IndexStore,
  rel: string,
  content: string,
  opts: { mtime?: number } = {},
  deviceId = 'DEV-A',
) {
  index.saveEntry({
    path: rel,
    version: new Map([[deviceId, 1]]),
    size: content.length,
    deleted: false,
    blocks: [hashBlock(Buffer.from(content))],
    ...(opts.mtime !== undefined ? { mtime: opts.mtime } : {}),
  });
}

describe('scanFolderAsync 与同步版 scanFolder 的语义等价性', () => {
  it('对同一棵目录树产出深度相等的 diff 与索引写回', async () => {
    // 同一棵树,两份相同种子的索引:同步版一份、异步版一份
    const { dir, root, index: indexSync } = setup('eq');
    const indexAsync = openIndexStore(join(dir, 'index-async.db'));

    // 1) 未改动(免哈希快速路径)
    writeFileSync(join(root, 'keep.txt'), 'same');
    seedPresent(root, indexSync, 'keep.txt', 'same');
    seedPresent(root, indexAsync, 'keep.txt', 'same');
    // 2) 内容变化 → changed
    writeFileSync(join(root, 'mod.txt'), 'old');
    seedIndexOnly(indexSync, 'mod.txt', 'old');
    seedIndexOnly(indexAsync, 'mod.txt', 'old');
    writeFileSync(join(root, 'mod.txt'), 'new content');
    // 3) 内容未变仅 mtime 过期(超出 2s 容忍窗口)→ mtime 写回,不进 changed
    const stable = 'stable content';
    writeFileSync(join(root, 'stale-mtime.txt'), stable);
    seedIndexOnly(indexSync, 'stale-mtime.txt', stable, { mtime: Date.now() - 10_000 });
    seedIndexOnly(indexAsync, 'stale-mtime.txt', stable, { mtime: Date.now() - 10_000 });
    // 4) 盘上已删除 → 墓碑(版本递增、块清空)
    writeFileSync(join(root, 'gone.txt'), 'data');
    seedIndexOnly(indexSync, 'gone.txt', 'data');
    seedIndexOnly(indexAsync, 'gone.txt', 'data');
    rm(join(root, 'gone.txt'));
    // 5) 被忽略规则的文件:盘上删除不产生墓碑,盘上存在不进 changed
    writeFileSync(join(root, 'skip.log'), 'logs');
    seedIndexOnly(indexSync, 'skip.log', 'logs');
    seedIndexOnly(indexAsync, 'skip.log', 'logs');
    rm(join(root, 'skip.log'));
    writeFileSync(join(root, 'noise.log'), 'still logs');
    // 6) 忽略目录(规则命中目录本身)
    mkdirSync(join(root, 'logs'));
    writeFileSync(join(root, 'logs', 'x.log'), 'ignored dir');
    // 7) 冲突副本:硬忽略、不进索引,仅计数供徽标
    writeFileSync(join(root, 'a.txt'), 'real');
    writeFileSync(join(root, 'a.sync-conflict-lxq8-ABCDEFGH23.txt'), 'mine');
    // 8) 在途中间态(tmp + 位图 sidecar,新鲜):不参与索引也不回收
    writeFileSync(join(root, 'part.bin.syncx-tmp'), 'transient');
    writeFileSync(join(root, 'part.bin.syncx-partial'), '{"v":1}');
    // 9) 子目录递归
    mkdirSync(join(root, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(root, 'sub', 'deep', 'nested.txt'), 'nested');
    // 10) 嵌套共享根:不重复索引其中文件,也不为其既有条目产生墓碑
    const child = join(root, 'child');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, 'inner.txt'), 'child content');
    seedIndexOnly(indexSync, 'child/inner.txt', 'child content');
    seedIndexOnly(indexAsync, 'child/inner.txt', 'child content');

    const rules = parseIgnoreRules(['*.log', 'logs/']);
    const nestedRoots = [resolve(child)];

    // 异步版先跑(两版都不会改动盘面 —— 只用新鲜中间态,无回收副作用),同步版后跑
    const asyncDiff = await scanFolderAsync(root, indexAsync, rules, 'DEV-A', nestedRoots);
    const syncDiff = scanFolder(root, indexSync, rules, 'DEV-A', nestedRoots);

    const norm = (d: ScanDiff) => ({ ...d, changed: [...d.changed].sort() });
    expect(norm(asyncDiff)).toEqual(norm(syncDiff));

    // 落库结果(mtime 写回、墓碑版本)也必须一致
    const dump = (ix: IndexStore) => ix.listEntries().sort((a, b) => a.path.localeCompare(b.path));
    expect(dump(indexAsync)).toEqual(dump(indexSync));

    // 顺带钉住几个关键值,防止两版「一起错」时等价性测试空转
    expect(asyncDiff.changed.sort()).toEqual(['a.txt', 'mod.txt', 'sub/deep/nested.txt']);
    expect(asyncDiff.tombstones).toHaveLength(1);
    expect(asyncDiff.tombstones[0]!.path).toBe('gone.txt');
    expect(asyncDiff.conflictCount).toBe(1);
    // keep.txt + mod.txt + stale-mtime.txt + a.txt + sub/deep/nested.txt + gone.txt 之外的
    // 存量文件(skip.log/noise.log/logs 目录/冲突副本/中间态/嵌套共享根内的文件)都不计;
    // gone.txt 已删除不在盘上,不计入「本轮看到」
    expect(asyncDiff.filesSeen).toBe(5);

    indexSync.close();
    indexAsync.close();
    rmDir(dir);
  });

  it('根不存在 / 根不是目录时与同步版同样返回空 diff', async () => {
    const { dir, root, index } = setup('missing');
    writeFileSync(join(root, 'a.txt'), 'x');
    seedIndexOnly(index, 'a.txt', 'x');

    const gone = join(dir, 'does-not-exist');
    expect(await scanFolderAsync(gone, index, [], 'DEV-A')).toEqual(scanFolder(gone, index, [], 'DEV-A'));

    // 根是一个普通文件(不是目录):同样空 diff
    const fileAsRoot = join(dir, 'a-file');
    writeFileSync(fileAsRoot, 'not a dir');
    expect(await scanFolderAsync(fileAsRoot, index, [], 'DEV-A')).toEqual(scanFolder(fileAsRoot, index, [], 'DEV-A'));

    index.close();
    rmDir(dir);
  });
});

describe('scanFolderAsync 的让出节奏', () => {
  it('大目录确认有让出(缺省节奏:每 64 个条目)', async () => {
    const { dir, root, index } = setup('yield');
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(root, `f${String(i).padStart(3, '0')}.txt`), 'x');
    }
    let yields = 0;
    const diff = await scanFolderAsync(root, index, [], 'DEV-A', [], { onYield: () => (yields += 1) });
    expect(diff.filesSeen).toBe(300);
    expect(diff.changed).toHaveLength(300);
    // 300 个条目、每 64 个让出一次 → 至少 4 次(时间线兜底只会更多)
    expect(yields).toBeGreaterThanOrEqual(4);
    index.close();
    rmDir(dir);
  });

  it('显式节奏参数生效(yieldEveryEntries: 1 时每个条目让出一次)', async () => {
    const { dir, root, index } = setup('yield1');
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      writeFileSync(join(root, name), 'x');
    }
    let yields = 0;
    const diff = await scanFolderAsync(root, index, [], 'DEV-A', [], {
      yieldEveryEntries: 1,
      onYield: () => (yields += 1),
    });
    expect(diff.changed).toHaveLength(3);
    expect(yields).toBe(3);
    index.close();
    rmDir(dir);
  });

  /**
   * 让出期间外部改动目录的竞态防护:已索引文件在扫描途中(某个让出点)被删。
   * 无论该文件在删除前还是删除后被遍历到,结果都必须一致 —— seen.add 先于 stat,
   * 「本轮已经看到它」就不产生墓碑、也不进 changed(与同步版的 catch-continue 防护
   * 语义等价),下一轮扫描再如实墓碑化。
   */
  it('文件在扫描途中(让出窗口内)被删:无幻影墓碑、无 changed', async () => {
    const { dir, root, index } = setup('race');
    for (let i = 0; i < 100; i++) {
      const name = `f${String(i).padStart(3, '0')}.txt`;
      writeFileSync(join(root, name), `content-${i}`);
      seedPresent(root, index, name, `content-${i}`);
    }
    // 会消失的文件:已索引、盘上存在,首次让出时删掉
    writeFileSync(join(root, 'vanishing.txt'), 'bye');
    seedPresent(root, index, 'vanishing.txt', 'bye');
    const vanishing = join(root, 'vanishing.txt');
    let yields = 0;
    const diff = await scanFolderAsync(root, index, [], 'DEV-A', [], {
      onYield: () => {
        yields += 1;
        if (existsSync(vanishing)) rm(vanishing);
      },
    });

    // 100 个文件全部走免哈希快速路径;vanishing.txt 无论在删除前后被遍历都:
    // 删除前 → 快速路径命中;删除后 → stat 失败 continue。两种分支都是「已看到」,
    // 因此既不 changed 也不墓碑。
    expect(diff.changed).toEqual([]);
    expect(diff.tombstones).toEqual([]);
    expect(diff.filesSeen).toBe(101);
    // 让出确实发生过,文件确实在扫描期间被删
    expect(yields).toBeGreaterThanOrEqual(1);
    expect(existsSync(vanishing)).toBe(false);

    index.close();
    rmDir(dir);
  });
});
