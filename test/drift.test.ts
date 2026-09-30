import { describe, expect, it } from 'vitest';
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { rmDir } from './helpers.js';
import { openIndexStore, type IndexStore } from '../src/indexstore.js';
import { createLocalExecutor, type LocalExecutor } from '../src/executor.js';
import { hashBlock, splitIntoBlocks, BLOCK_SIZE } from '../src/blockstore.js';
import { createSyncPeer, type DriftState, type PeerTransport } from '../src/peer.js';
import { loadConfig } from '../src/config.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { SyncSessionManager } from '../src/session-manager.js';
import type { BlockRequest } from '../src/messages.js';
import type { IndexEntry } from '../src/index.js';
import {
  declaredDrift,
  equalPairs,
  pickSlot,
  runAudit,
  runLocalAudit,
  strideSample,
  type DriftPair,
  type DriftReport,
  type SlotSample,
  type SlotVerdict,
} from '../src/drift.js';

// ---------------------------------------------------------------------------
// 造条目的小搭子
//
// 索引条目的「内容事实」就是 size + blocks(+ 可选的 cdh/clens),测试里几乎每次都要
// 现算,所以统一从这里出。version 一律同一份向量:A 检查的前提就是「版本相等而内容
// 不符」,向量不同就落到 local-newer / conflict 那些还有动作的关系上,不进候选集。
// ---------------------------------------------------------------------------

function mkEntry(path: string, data: Buffer, over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path,
    version: new Map([['dev-a', 1]]),
    size: data.length,
    deleted: false,
    blocks: splitIntoBlocks(data).map(hashBlock),
    ...over,
  };
}

/** 按声明的 CDC 切法(块长列表)补出 cdh/clens 两份视图。 */
function withCdc(e: IndexEntry, data: Buffer, clens: number[]): IndexEntry {
  let off = 0;
  const cdh: string[] = [];
  for (const len of clens) {
    cdh.push(hashBlock(data.subarray(off, off + len)));
    off += len;
  }
  if (off !== data.length) throw new Error('clens 之和与内容长度不符');
  return { ...e, cdh, clens };
}

/** 对端那份宣告:默认与本机完全一致(= 诚实),要造漂移就覆盖个别字段。 */
function declare(local: IndexEntry, over: Partial<IndexEntry> = {}): IndexEntry {
  return { ...local, ...over };
}

function ok(entry: IndexEntry, slot: number): SlotVerdict {
  return { kind: 'ok', path: entry.path, slot };
}

// ---------------------------------------------------------------------------
// 真盘小搭子(检查 B 与本地巡检共用)
//
// 从「检查 B」那组提上来:本地轮(runLocalAudit)的端到端用例要的是同一套
// 「写盘 + 建条目 + 改一字节」,一份就够。
// ---------------------------------------------------------------------------

function fixture(): { dir: string; root: string; index: IndexStore; executor: LocalExecutor } {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-drift-'));
  const root = join(dir, 'share');
  mkdirSync(root, { recursive: true });
  const index = openIndexStore(join(dir, 'index.db'));
  const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
  return { dir, root, index, executor };
}

/** 写盘 + 建条目,mtime 取落盘后的真值(与扫描器落库的形态一致)。 */
function seed(root: string, rel: string, data: Buffer, over: Partial<IndexEntry> = {}): IndexEntry {
  const target = join(root, rel);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, data);
  return { ...mkEntry(rel, data, over), mtime: statSync(target).mtimeMs };
}

/**
 * 改一个字节并把 mtime 复位。
 *
 * 复位不是取巧:要仿真的是「落地路径自己把字节写坏了」那一类故障(ADR-0021 记过的
 * 「3 参 writeSync 把每块都写到文件开头」就是它),那种坏法写完照样 stat 得出正常的
 * mtime 与 size —— 扫描器因此**永远不会**重算这份文件,只有哨兵看得见。
 */
function corruptByte(target: string, offset: number): void {
  const before = statSync(target);
  const buf = readFileSync(target);
  buf[offset] = buf[offset]! ^ 0xff;
  writeFileSync(target, buf);
  utimesSync(target, before.atime, before.mtime);
}

describe('检查 A:本机宣告 vs 对端宣告', () => {
  const data = Buffer.from('a'.repeat(40));

  it('同一份内容的两条宣告不报', () => {
    const a = mkEntry('f.bin', data);
    expect(declaredDrift(a, declare(a))).toBeUndefined();
  });

  it('尺寸先比:同版本不同尺寸直接把两个值报出来', () => {
    const a = mkEntry('f.bin', data);
    const d = declaredDrift(a, declare(a, { size: data.length + 1 }));
    expect(d?.detail).toBe(`size ${data.length} != ${data.length + 1}`);
  });

  it('块哈希不符时报出首个不符的下标', () => {
    const a = mkEntry('f.bin', Buffer.concat([Buffer.alloc(BLOCK_SIZE, 1), Buffer.alloc(BLOCK_SIZE, 2)]));
    const b = declare(a, { blocks: [a.blocks[0]!, 'deadbeef'] });
    const d = declaredDrift(a, b);
    expect(d?.slot).toBe(1);
    expect(d?.detail).toContain('blocks[1]');
  });

  it('块数不同也是漂移:末块消失 = 有一截内容不见了', () => {
    const a = mkEntry('f.bin', Buffer.alloc(BLOCK_SIZE + 5, 2));
    const b = declare(a, { blocks: [a.blocks[0]!] });
    expect(declaredDrift(a, b)?.detail).toBe('blocks length 2 != 1');
  });

  it('双方都有可用的 CDC 视图时按 cdh 比:定长列表相同也照样查出中部改动', () => {
    // 两条宣告的定长 blocks 完全相同(那套口径看不见这次改动),只有 cdh 不同。
    const a = mkEntry('f.bin', Buffer.alloc(10, 3));
    const b = declare(a, { cdh: ['c0', 'diff'], clens: [6, 4] });
    const withViews = (x: IndexEntry, i: number): IndexEntry => ({ ...x, cdh: ['c0', `h${i}`], clens: [6, 4] });
    const d = declaredDrift(withViews(a, 0), withViews(b, 1));
    expect(d?.slot).toBe(1);
    expect(d?.detail).toContain('cdh[1]');
  });

  it('CDC 块长序列不符时报 chunk lengths differ(同一套哈希、切法不同也算不符)', () => {
    const a = withCdc(mkEntry('f.bin', Buffer.alloc(10, 4)), Buffer.alloc(10, 4), [6, 4]);
    const b = declare(a, { clens: [5, 5] });
    expect(declaredDrift(a, b)?.detail).toContain('chunk lengths differ');
  });

  it('只有一侧有 CDC 视图时退回定长口径(旧对端只有这一套)', () => {
    const data2 = Buffer.alloc(10, 5);
    const a = withCdc(mkEntry('f.bin', data2), data2, [10]);
    const b = declare(a, { cdh: undefined, clens: undefined, blocks: ['bad'] });
    expect(declaredDrift(a, b)?.detail).toContain('blocks[0]');
  });

  it('cdh 与 clens 长度不符的那侧视为没有 CDC 视图(严进口径同 peer.cdcUsable)', () => {
    const data2 = Buffer.alloc(10, 6);
    const a = withCdc(mkEntry('f.bin', data2), data2, [10]);
    const b = declare(a, { clens: undefined });
    expect(declaredDrift(a, b)).toBeUndefined(); // 退回定长,而定长两份一致
  });
});

describe('候选集:只审「版本相等」', () => {
  it('local-newer / remote-newer / conflict 都不进候选:尚未收敛不等于漂移', () => {
    const local = new Map<string, IndexEntry>([
      ['equal.txt', mkEntry('equal.txt', Buffer.from('1'))],
      ['local-newer.txt', mkEntry('local-newer.txt', Buffer.from('1'), { version: new Map([['dev-a', 2]]) })],
      ['remote-newer.txt', mkEntry('remote-newer.txt', Buffer.from('1'))],
      ['conflict.txt', mkEntry('conflict.txt', Buffer.from('1'))],
    ]);
    const remote = [
      declare(local.get('equal.txt')!),
      declare(local.get('local-newer.txt')!, { version: new Map([['dev-a', 1]]) }),
      declare(local.get('remote-newer.txt')!, { version: new Map([['dev-a', 2]]) }),
      declare(local.get('conflict.txt')!, { version: new Map([['dev-b', 9]]) }),
    ];
    expect(equalPairs(remote, local).map((p) => p.path)).toEqual(['equal.txt']);
  });

  it('墓碑两端都跳过,本机没有的路径也不入选', () => {
    const live = mkEntry('x.txt', Buffer.from('1'));
    const local = new Map<string, IndexEntry>([
      ['x.txt', live],
      ['gone.txt', declare(live, { path: 'gone.txt', deleted: true, blocks: [], size: 0 })],
    ]);
    const remote = [
      declare(live, { path: 'gone.txt', deleted: true, blocks: [], size: 0 }),
      declare(live, { path: 'unknown.txt' }),
    ];
    expect(equalPairs(remote, local)).toEqual([]);
  });

  it('占位条目留在候选里:它块哈希齐备,A 审得动(避开它是 B 的事)', () => {
    const ph = mkEntry('ph.txt', Buffer.from('content'), { placeholder: true });
    const local = new Map([['ph.txt', ph]]);
    expect(equalPairs([declare(ph)], local).map((p) => p.path)).toEqual(['ph.txt']);
  });
});

describe('抽样:确定性地轮转,而不是随机', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];

  it('n≥总数时取全部,n=0 时一条不取', () => {
    expect(strideSample(items, 8, 0)).toEqual(items);
    expect(strideSample(items, 0, 0)).toEqual([]);
  });

  it('起点随轮次滚动:转满一轮的并集覆盖全部,相邻两轮审的不是同一批', () => {
    const seen = new Set<string>();
    for (let round = 0; round < 3; round++) for (const x of strideSample(items, 2, round)) seen.add(x);
    expect([...seen].sort()).toEqual(items);
    expect(strideSample(items, 2, 0)).not.toEqual(strideSample(items, 2, 1));
  });

  it('同输入同结果:测试要能断言「第 k 轮抽到了哪一条」', () => {
    expect(strideSample(items, 2, 5)).toEqual(strideSample(items, 2, 5));
    expect(strideSample(items, 2, 0)).toEqual(['a', 'd']);
  });

  it('槽位在单槽文件上恒为 0,多槽时落在范围内且随 (路径, 轮次) 变化', () => {
    expect(pickSlot('any:0', 1)).toBe(0);
    expect(pickSlot('any:0', 0)).toBe(0);
    const slots = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const s = pickSlot(`file-${i}.bin:${i}`, 8);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(8);
      slots.add(s);
    }
    // 同一轮抽到的不同路径若都落同一个下标,哨兵就永远只验文件的同一小段
    expect(slots.size).toBeGreaterThan(1);
    expect(pickSlot('f.bin:1', 8)).toBe(pickSlot('f.bin:1', 8));
  });
});

describe('对端轮(runAudit):只做 A', () => {
  const e = mkEntry('clean.bin', Buffer.from('hello drift'));
  const pair = (over: Partial<IndexEntry> = {}): DriftPair[] => [
    { path: e.path, local: e, remote: declare(e, over) },
  ];

  it('干净舰队报 sampled>0 且两个检出计数都是 0 —— 让「没检出」与「没跑」可区分', () => {
    const { summary, findings } = runAudit(pair(), { round: 0, n: 8 });
    expect(summary).toMatchObject({ candidates: 1, sampled: 1, declared: 0, disk: 0, unreadable: 0 });
    expect(findings).toEqual([]);
  });

  it('A 的检出记进 declared 并带上路径与槽位', () => {
    const { summary, findings } = runAudit(pair({ blocks: ['bad'] }), { round: 0, n: 8 });
    expect(summary).toMatchObject({ declared: 1, disk: 0 });
    expect(findings[0]).toMatchObject({ kind: 'declared', path: 'clean.bin' });
  });

  it('盘上字节坏掉也不影响它:对端轮没有验盘这道(接口里连 verify 都没有)', () => {
    const f = fixture();
    const entry = seed(f.root, 'quiet.bin', Buffer.alloc(64, 3));
    corruptByte(join(f.root, 'quiet.bin'), 0);
    const { summary, findings } = runAudit(
      [{ path: entry.path, local: entry, remote: declare(entry) }],
      { round: 0, n: 8 },
    );
    expect(summary).toMatchObject({ declared: 0, disk: 0, unreadable: 0 });
    expect(findings).toEqual([]);
    rmDir(f.dir);
  });
});

describe('本地轮(runLocalAudit):只做 B', () => {
  const e = mkEntry('clean.bin', Buffer.from('hello drift'));
  const allOk = (samples: readonly SlotSample[]): SlotVerdict[] => samples.map((s) => ok(s.entry, s.slot));

  it('干净条目报 sampled>0 且两个检出计数都是 0;declared 恒为 0(没有第二台设备)', () => {
    const seen: SlotSample[] = [];
    const { summary, findings } = runLocalAudit([e], {
      round: 0,
      n: 8,
      verify: (samples) => {
        seen.push(...samples);
        return allOk(samples);
      },
    });
    expect(seen.map((s) => [s.entry.path, s.cdc])).toEqual([['clean.bin', false]]);
    expect(summary).toMatchObject({ candidates: 1, sampled: 1, declared: 0, disk: 0, unreadable: 0 });
    expect(findings).toEqual([]);
  });

  it('候选过滤:墓碑 / 占位条目 / 无宣告可验(0 字节)一条都不进', () => {
    const dead = { ...e, path: 'gone.bin', deleted: true, blocks: [], size: 0 };
    const ph = { ...e, path: 'ph.bin', placeholder: true };
    const empty = mkEntry('empty.bin', Buffer.alloc(0));
    const seen: SlotSample[] = [];
    const { summary } = runLocalAudit([dead, ph, empty], {
      round: 0,
      n: 8,
      verify: (samples) => {
        seen.push(...samples);
        return allOk(samples);
      },
    });
    expect(seen).toEqual([]);
    expect(summary).toMatchObject({ candidates: 0, sampled: 0 });
  });

  it('n=0 连 verify 都不调:整道关掉时一次盘读都不发生', () => {
    let called = 0;
    const { summary } = runLocalAudit([e], {
      round: 0,
      n: 0,
      verify: (samples) => {
        called++;
        return allOk(samples);
      },
    });
    expect(called).toBe(0);
    expect(summary).toMatchObject({ candidates: 1, sampled: 0, disk: 0 });
  });

  it('验盘结论按 kind 分流:drift 记 disk 并带出两个哈希,unreadable 单列', () => {
    const verdictsFor = (kind: 'drift' | 'unreadable') => (samples: readonly SlotSample[]): SlotVerdict[] =>
      samples.map((s) =>
        kind === 'drift'
          ? { kind: 'drift', path: s.entry.path, slot: s.slot, declared: 'aaaa1111aaaa', actual: 'bbbb2222bbbb' }
          : { kind: 'unreadable', path: s.entry.path, slot: s.slot, error: 'file absent' },
      );
    const d = runLocalAudit([e], { round: 0, n: 8, verify: verdictsFor('drift') });
    expect(d.summary).toMatchObject({ disk: 1, unreadable: 0 });
    expect(d.findings[0]).toMatchObject({ kind: 'disk', path: 'clean.bin' });
    expect(d.findings[0]!.detail).toContain('declared aaaa1111aaaa… != on disk bbbb2222bbbb…');

    const u = runLocalAudit([e], { round: 0, n: 8, verify: verdictsFor('unreadable') });
    expect(u.summary).toMatchObject({ disk: 0, unreadable: 1 });
    expect(u.findings[0]).toMatchObject({ kind: 'unreadable', detail: 'file absent' });
  });

  it('验盘口径自己定:有可用 CDC 视图就用它(偏移是 prefix-sum,ADR-0021 的算错路径)', () => {
    const data = Buffer.alloc(10, 7);
    const c = withCdc(mkEntry('cdc.bin', data), data, [6, 4]);
    const seen: SlotSample[] = [];
    runLocalAudit([c], {
      round: 0,
      n: 8,
      verify: (samples) => {
        seen.push(...samples);
        return allOk(samples);
      },
    });
    expect(seen[0]!.cdc).toBe(true);
    expect(seen[0]!.slot).toBeLessThan(2);
  });

  it('换轮真换槽:同一份索引在后续轮次抽到不同的块(不是永远读第 0 块)', () => {
    const data = Buffer.from('0123456789abcdef');
    const c = withCdc(mkEntry('rot.bin', data), data, Array.from({ length: 16 }, () => 1));
    const slots = new Set<number>();
    for (let round = 1; round <= 8; round++) {
      runLocalAudit([c], {
        round,
        n: 8,
        verify: (samples) => {
          slots.add(samples[0]!.slot);
          return allOk(samples);
        },
      });
    }
    expect(slots.size).toBeGreaterThan(1);
  });

  it('篡改一字节必须报红(真盘 + 真 executor):报 disk 且只报不改', () => {
    const f = fixture();
    const intact = seed(f.root, 'intact.bin', Buffer.from('good content'));
    const broken = seed(f.root, 'broken.bin', Buffer.alloc(64, 3));
    const before = readFileSync(join(f.root, 'broken.bin'));
    corruptByte(join(f.root, 'broken.bin'), 5);
    const after = readFileSync(join(f.root, 'broken.bin'));
    expect(after).not.toEqual(before);

    const { summary, findings } = runLocalAudit([intact, broken], {
      round: 0,
      n: 8,
      verify: (samples) => f.executor.verifySampledSlots(samples),
    });
    expect(summary).toMatchObject({ candidates: 2, sampled: 2, declared: 0, disk: 1, unreadable: 0 });
    expect(findings).toEqual([expect.objectContaining({ kind: 'disk', path: 'broken.bin', slot: 0 })]);
    // 只报不回修:坏字节还在原处,哨兵不裁决「谁的内容是对的」
    expect(readFileSync(join(f.root, 'broken.bin'))).toEqual(after);
    rmDir(f.dir);
  });
});

describe('检查 B:本机宣告 vs 盘上字节(executor.verifySampledSlots)', () => {
  it('完好文件的每个槽位都判 ok:非零偏移也对得上,才证明偏移算术而不只是「开头一段」', () => {
    const { dir, root, index } = fixture();
    const data = Buffer.concat([Buffer.alloc(BLOCK_SIZE, 1), Buffer.alloc(BLOCK_SIZE, 2), Buffer.from('tail')]);
    const e = seed(root, 'big.bin', data);
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const verdicts = executor.verifySampledSlots(e.blocks.map((_, slot) => ({ entry: e, cdc: false, slot })));
    expect(verdicts.map((v) => v.kind)).toEqual(['ok', 'ok', 'ok']);
    rmDir(dir);
  });

  it('篡改一个字节必须报红:声明与盘上字节都带出来,日志才能定位', () => {
    const { dir, root, index } = fixture();
    const data = Buffer.concat([Buffer.alloc(BLOCK_SIZE, 7), Buffer.alloc(BLOCK_SIZE, 9)]);
    const e = seed(root, 'tampered.bin', data);
    corruptByte(join(root, 'tampered.bin'), BLOCK_SIZE + 5); // 坏在第 1 块内部
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const verdicts = executor.verifySampledSlots([
      { entry: e, cdc: false, slot: 0 },
      { entry: e, cdc: false, slot: 1 },
    ]);
    expect(verdicts[0]!.kind).toBe('ok');
    const drift = verdicts[1] as Extract<SlotVerdict, { kind: 'drift' }>;
    expect(drift.kind).toBe('drift');
    expect(drift.slot).toBe(1);
    expect(drift.declared).toBe(e.blocks[1]);
    expect(drift.actual).not.toBe(e.blocks[1]);
    rmDir(dir);
  });

  it('本机改动已超出扫描容忍窗口(mtime 晚于索引值 2s 以上)判 unreadable,不判漂移', () => {
    const { dir, root, index } = fixture();
    const e = seed(root, 'editing.bin', Buffer.alloc(10, 1));
    const target = join(root, 'editing.bin');
    writeFileSync(target, Buffer.alloc(10, 2)); // 用户又存了一盘(同尺寸,内容不同)
    // 把 mtime 推到「索引记录值 + 5s」:这是扫描器自己也会认定「这条目该重算」的位置。
    // 落在容忍窗口(MTIME_TOLERANCE_MS=2s)之内则相反 —— 那种情况下连扫描器都认索引是新鲜的,
    // 哨兵读到不符就报红;代价是「存盘正好卡在索引后 2s 内」这一窄窗会被误报一次,
    // 而它在下一轮扫描重算后自愈(取舍的理由与量级见 docs/adr/0022)。
    const base = statSync(target);
    utimesSync(target, base.atime, new Date((e.mtime ?? 0) + 5000));
    const verdicts = createLocalExecutor(root, index, join(root, '.syncx-trash')).verifySampledSlots([
      { entry: e, cdc: false, slot: 0 },
    ]);
    expect((verdicts[0] as Extract<SlotVerdict, { kind: 'unreadable' }>).error).toContain('index stale');
    rmDir(dir);
  });

  it('条目没有 mtime(旧库数据)按「索引可能过期」处理,不报漂移', () => {
    const { dir, root, index } = fixture();
    const e = { ...seed(root, 'legacy.bin', Buffer.alloc(10, 3)), mtime: undefined };
    const verdicts = createLocalExecutor(root, index, join(root, '.syncx-trash')).verifySampledSlots([
      { entry: e, cdc: false, slot: 0 },
    ]);
    expect((verdicts[0] as Extract<SlotVerdict, { kind: 'unreadable' }>).error).toContain('index stale');
    rmDir(dir);
  });

  it('CDC 口径的偏移取 clens 前缀和:与定长布局不同的一套位置也逐个对得上', () => {
    const { dir, root, index } = fixture();
    const data = Buffer.from('0123456789abcdefghij'); // 20 字节
    // 声明的切法是 [0,3) [3,8) [8,20):除第 0 块外,与 i*BLOCK_SIZE 没有一处重合
    const e = withCdc(seed(root, 'cdc.bin', data), data, [3, 5, 12]);
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    expect(
      executor.verifySampledSlots(e.cdh!.map((_, slot) => ({ entry: e, cdc: true, slot }))).map((v) => v.kind),
    ).toEqual(['ok', 'ok', 'ok']);
    corruptByte(join(root, 'cdc.bin'), 5); // 坏在 CDC 第 1 块([3,8) 之内)
    const after = executor.verifySampledSlots(e.cdh!.map((_, slot) => ({ entry: e, cdc: true, slot })));
    expect(after.map((v) => v.kind)).toEqual(['ok', 'drift', 'ok']);
    rmDir(dir);
  });

  it('cdh 与 clens 对不上长度 → unreadable「incomplete cdc view」而不是抛错', () => {
    const { dir, root, index } = fixture();
    const data = Buffer.alloc(10, 4);
    const e = { ...withCdc(seed(root, 'broken-cdc.bin', data), data, [6, 4]), clens: undefined };
    const verdicts = createLocalExecutor(root, index, join(root, '.syncx-trash')).verifySampledSlots([
      { entry: e, cdc: true, slot: 0 },
    ]);
    expect(verdicts[0]).toMatchObject({ kind: 'unreadable', error: 'incomplete cdc view' });
    rmDir(dir);
  });

  it('文件被移走 → unreadable(file absent),不计漂移', () => {
    const { dir, root, index } = fixture();
    const e = seed(root, 'gone-later.bin', Buffer.alloc(10, 5));
    rmSync(join(root, 'gone-later.bin'));
    const verdicts = createLocalExecutor(root, index, join(root, '.syncx-trash')).verifySampledSlots([
      { entry: e, cdc: false, slot: 0 },
    ]);
    expect(verdicts[0]).toMatchObject({ kind: 'unreadable', error: 'file absent' });
    rmDir(dir);
  });

  it('目录不是文件 → unreadable,不误读成空内容报漂移', () => {
    const { dir, root, index } = fixture();
    const e = seed(root, 'dir-like.bin', Buffer.alloc(10, 6));
    rmSync(join(root, 'dir-like.bin'));
    mkdirSync(join(root, 'dir-like.bin'));
    const verdicts = createLocalExecutor(root, index, join(root, '.syncx-trash')).verifySampledSlots([
      { entry: e, cdc: false, slot: 0 },
    ]);
    expect(verdicts[0]).toMatchObject({ kind: 'unreadable', error: 'file absent' });
    rmDir(dir);
  });

  it('越界槽位与越界路径都归 unreadable:一条抽样读不出来不许掀翻整场审计', () => {
    const { dir, root, index } = fixture();
    const e = seed(root, 'edge.bin', Buffer.alloc(10, 8));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const verdicts = executor.verifySampledSlots([
      { entry: e, cdc: false, slot: 99 },
      { entry: { ...e, path: '../../etc/passwd' }, cdc: false, slot: 0 },
      { entry: { ...e, path: '/etc/passwd' }, cdc: false, slot: 0 },
    ]);
    expect(verdicts.map((v) => v.kind)).toEqual(['unreadable', 'unreadable', 'unreadable']);
    expect((verdicts[0] as Extract<SlotVerdict, { kind: 'unreadable' }>).error).toBe('no such slot');
    rmDir(dir);
  });

  it('盘比索引短(尺寸已经变了)判 unreadable:那是扫描器马上要重算的形态,不是哨兵要报的案', () => {
    const { dir, root, index } = fixture();
    const data = Buffer.concat([Buffer.alloc(BLOCK_SIZE, 8), Buffer.alloc(BLOCK_SIZE, 9)]);
    const e = seed(root, 'short.bin', data);
    const target = join(root, 'short.bin');
    const fd = openSync(target, 'r+');
    try {
      ftruncateSync(fd, 10);
    } finally {
      closeSync(fd);
    }
    const verdicts = createLocalExecutor(root, index, join(root, '.syncx-trash')).verifySampledSlots([
      { entry: e, cdc: false, slot: 1 },
    ]);
    expect((verdicts[0] as Extract<SlotVerdict, { kind: 'unreadable' }>).error).toContain('index stale');
    rmDir(dir);
  });

  it('空输入给空结论:一轮没抽到东西不该有任何输出', () => {
    const { dir, root, index } = fixture();
    expect(createLocalExecutor(root, index, join(root, '.syncx-trash')).verifySampledSlots([])).toEqual([]);
    rmDir(dir);
  });

  it('结论顺序与入参一致(上层按位置把 finding 归回抽样)', () => {
    const { dir, root, index } = fixture();
    const a = seed(root, 'p1.bin', Buffer.from('one'));
    const b = seed(root, 'p2.bin', Buffer.from('two'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const verdicts = executor.verifySampledSlots([
      { entry: a, cdc: false, slot: 0 },
      { entry: b, cdc: false, slot: 3 },
      { entry: b, cdc: false, slot: 0 },
    ]);
    expect(verdicts.map((v) => [v.path, v.slot])).toEqual([['p1.bin', 0], ['p2.bin', 3], ['p2.bin', 0]]);
    rmDir(dir);
  });
});

describe('哨兵接线:peer 侧的门控与上报', () => {
  function fakeTransport() {
    const requests: BlockRequest[] = [];
    const transport: PeerTransport = {
      sendEntries(): void {},
      sendBlockRequest(request): void {
        requests.push(request);
      },
      sendBlockResponse(): void {},
    };
    return { transport, requests };
  }

  /**
   * 建一条真带执行器的管线,并把两个旋钮按用例需要设好。
   *
   * 旋钮必须在 createSyncPeer **之前**设:peer 在建管线时读它们(见 peer.ts),
   * 这样每个用例能自己决定抽样数与间隔,而不必依赖进程启动时的环境。
   */
  function harness(env: { n: string; intervalMs: string; state?: DriftState }) {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-drift-peer-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));
    const localIndex = new Map<string, IndexEntry>();
    const reports: DriftReport[] = [];
    const saved = {
      n: process.env.SYNCX_DRIFT_SAMPLE_N,
      interval: process.env.SYNCX_DRIFT_INTERVAL_MS,
    };
    process.env.SYNCX_DRIFT_SAMPLE_N = env.n;
    process.env.SYNCX_DRIFT_INTERVAL_MS = env.intervalMs;
    const { transport, requests } = fakeTransport();
    /** 再建一条 SyncPeer:同一份本机索引、同一个执行器、同一个上报出口 —— 生产里这就是
     *  同一目录上的第二条连接(设备对之间至多两条,每方向一条)。 */
    function makePeer(remoteDeviceId = 'DEV-B') {
      return createSyncPeer({
        transport,
        localIndex,
        executor,
        readLocalBlock: () => Buffer.alloc(0),
        deviceId: 'DEV-A',
        remoteDeviceId,
        root,
        onDriftAudit: (report) => reports.push(report),
        driftState: env.state,
      });
    }
    const peer = makePeer();
    return {
      dir,
      root,
      executor,
      localIndex,
      requests,
      reports,
      peer,
      makePeer,
      /** 在盘上写一份文件并登记进本机索引(mtime 取落盘真值,否则哨兵会判 unreadable)。 */
      seed(rel: string, data: Buffer): IndexEntry {
        const e = seed2(root, rel, data);
        localIndex.set(rel, e);
        return e;
      },
      dispose(): void {
        if (saved.n === undefined) delete process.env.SYNCX_DRIFT_SAMPLE_N;
        else process.env.SYNCX_DRIFT_SAMPLE_N = saved.n;
        if (saved.interval === undefined) delete process.env.SYNCX_DRIFT_INTERVAL_MS;
        else process.env.SYNCX_DRIFT_INTERVAL_MS = saved.interval;
        index.close();
        rmDir(dir);
      },
    };
  }

  function seed2(root: string, rel: string, data: Buffer): IndexEntry {
    const target = join(root, rel);
    writeFileSync(target, data);
    return { ...mkEntry(rel, data), mtime: statSync(target).mtimeMs };
  }

  it('闲时跑一轮:计数行必须出现,哪怕什么都没检出', async () => {
    const h = harness({ n: '8', intervalMs: '0' });
    const e = h.seed('a.txt', Buffer.from('content a'));
    await h.peer.onPeerIndex([declare(e)], { full: true });
    expect(h.reports.length).toBe(1);
    expect(h.reports[0]!.summary).toMatchObject({ candidates: 1, sampled: 1, declared: 0, disk: 0, unreadable: 0 });
    expect(h.reports[0]!.peer).toBe('DEV-B');
    h.dispose();
  });

  it('版本相等而内容不符 → 报 declared,并且一个字都不改(只报不回修)', async () => {
    const h = harness({ n: '8', intervalMs: '0' });
    const e = h.seed('b.txt', Buffer.from('on disk'));
    const before = readFileSync(join(h.root, 'b.txt'));
    await h.peer.onPeerIndex([declare(e, { blocks: ['deadbeef'] })], { full: true });
    expect(h.reports[0]!.summary).toMatchObject({ declared: 1 });
    expect(h.reports[0]!.findings[0]!.kind).toBe('declared');
    expect(readFileSync(join(h.root, 'b.txt'))).toEqual(before);
    h.dispose();
  });

  it('盘上字节被改坏:对端轮不报(A 只看宣告),同一份坏象由本地轮报 disk —— 拆分后的分工', async () => {
    const h = harness({ n: '8', intervalMs: '0' });
    const data = Buffer.alloc(64, 3); // 单块文件:抽到哪一格都是它
    const e = h.seed('c.bin', data);
    const target = join(h.root, 'c.bin');
    const st = statSync(target);
    const buf = readFileSync(target);
    buf[0] = 9;
    writeFileSync(target, buf);
    utimesSync(target, st.atime, st.mtime); // 坏的是字节,stat 一切如常 —— 扫描器看不见这种坏法

    await h.peer.onPeerIndex([declare(e)], { full: true });
    expect(h.reports[0]!.summary).toMatchObject({ declared: 0, disk: 0 });
    expect(h.reports[0]!.findings).toEqual([]);

    const local = runLocalAudit(h.localIndex.values(), {
      round: 1,
      n: 8,
      verify: (samples) => h.executor.verifySampledSlots(samples),
    });
    expect(local.summary).toMatchObject({ declared: 0, disk: 1, unreadable: 0 });
    expect(local.findings[0]!.kind).toBe('disk');
    h.dispose();
  });

  it('间隔没到就不再审:哨兵不能每轮索引都读一遍盘', async () => {
    const h = harness({ n: '8', intervalMs: '600000' });
    const e = h.seed('d.txt', Buffer.from('content d'));
    await h.peer.onPeerIndex([declare(e)], { full: true });
    await h.peer.onPeerIndex([declare(e)], { full: true });
    expect(h.reports.length).toBe(1);
    h.dispose();
  });

  it('两条连接共享一份 driftState → 间隔内第二条整轮跳过(一次检出只报一遍)', async () => {
    const state: DriftState = { lastAt: 0, round: 0 };
    const h = harness({ n: '8', intervalMs: '600000', state });
    const e = h.seed('h1.txt', Buffer.from('content h1'));
    await h.peer.onPeerIndex([declare(e)], { full: true });
    await h.makePeer('DEV-B-dup').onPeerIndex([declare(e)], { full: true });
    // 各记各的话这里是 2 条,而且两条 round 都是 1 —— 2026-09-30 双真 daemon 冒烟实测到的形态
    expect(h.reports.length).toBe(1);
    expect(h.reports[0]!.round).toBe(1);
    h.dispose();
  });

  it('共享 driftState:间隔过了才来的下一轮由另一条连接跑,轮号继续前移(槽位真轮换的前提)', async () => {
    const state: DriftState = { lastAt: 0, round: 0 };
    const h = harness({ n: '8', intervalMs: '600000', state });
    const e = h.seed('h2.txt', Buffer.from('content h2'));
    await h.peer.onPeerIndex([declare(e)], { full: true });
    state.lastAt = 0; // 等价于「间隔已过」:这份状态由上层持有,本来就是个普通对象
    await h.makePeer('DEV-B-dup').onPeerIndex([declare(e)], { full: true });
    // 每连接各记各的话是 [1, 1]:轮号一归零,(path, round) 哈希出的槽位就永远是同一个
    expect(h.reports.map((r) => r.round)).toEqual([1, 2]);
    h.dispose();
  });

  it('不传 driftState → 退化成每连接一份(旧调用方与单测行为不变)', async () => {
    const h = harness({ n: '8', intervalMs: '600000' });
    const e = h.seed('h3.txt', Buffer.from('content h3'));
    await h.peer.onPeerIndex([declare(e)], { full: true });
    await h.makePeer('DEV-B-dup').onPeerIndex([declare(e)], { full: true });
    expect(h.reports.map((r) => r.round)).toEqual([1, 1]);
    h.dispose();
  });

  it('抽样数设 0 → 整道关闭,连报告都不发', async () => {
    const h = harness({ n: '0', intervalMs: '0' });
    const e = h.seed('e.txt', Buffer.from('content e'));
    await h.peer.onPeerIndex([declare(e)], { full: true });
    expect(h.reports.length).toBe(0);
    h.dispose();
  });

  it('正在收文件时不审:盘上同一批路径正被逐块写,此时读到的字节没有意义', async () => {
    const h = harness({ n: '8', intervalMs: '0' });
    const e = h.seed('f.txt', Buffer.from('content f'));
    // 对端另外宣告一条本机没有的文件 → 本轮建立待接收(pending 非空)并索要块
    const incoming = mkEntry('g.bin', Buffer.alloc(40, 1), { version: new Map([['dev-b', 1]]) });
    await h.peer.onPeerIndex([declare(e), incoming], { full: true });
    expect(h.requests.length).toBeGreaterThan(0); // 前置事实:确实在收
    expect(h.reports.length).toBe(0);
    h.dispose();
  });

  it('没有候选路径也上报一次:sampled=0 是「跑了但没得审」的证据', async () => {
    const h = harness({ n: '8', intervalMs: '0' });
    // 对端这轮只推了一条硬忽略路径(.git/*,入向闸门直接丢弃):既不建候选,也不建
    // 待接收 —— 这正是「跑过审计却什么都没抽到」的形态。
    const ignored = mkEntry('.git/config', Buffer.from('x'), { version: new Map([['dev-b', 1]]) });
    await h.peer.onPeerIndex([ignored], { full: true });
    expect(h.reports.length).toBe(1);
    expect(h.reports[0]!.summary).toMatchObject({ candidates: 0, sampled: 0 });
    h.dispose();
  });

  it('上层没接 onDriftAudit 时一切照旧(既有管线不因哨兵多读盘)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-drift-off-'));
    const root = join(dir, 'share');
    mkdirSync(root, { recursive: true });
    const index = openIndexStore(join(dir, 'index.db'));
    const { transport, requests } = fakeTransport();
    const peer = createSyncPeer({
      transport,
      localIndex: new Map(),
      executor: createLocalExecutor(root, index, join(root, '.syncx-trash')),
      readLocalBlock: () => Buffer.alloc(0),
      deviceId: 'DEV-A',
    });
    await peer.onPeerIndex([mkEntry('z.txt', Buffer.from('z'), { version: new Map([['dev-b', 1]]) })], { full: true });
    expect(requests.length).toBeGreaterThan(0);
    index.close();
    rmDir(dir);
  });
});

describe('接线:session-manager 的本地巡检按时钟跑(peer=local)', () => {
  /**
   * 起一台只有本地目录、**一个对端都没有**的 manager —— 这正是这道巡检存在的理由:
   * 对端长期离线或目录安静到没有索引交换时,盘上坏掉的东西也得有人看得见。日志走
   * 自建的 pino 目的地流(而不是 createLogger 的 stdout / 文件),断言可以直接读行。
   */
  function bootLocal(prefix: string): {
    dir: string;
    share: string;
    manager: SyncSessionManager;
    lines: string[];
    auditLines: () => string[];
  } {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const share = join(dir, 'share');
    mkdirSync(share, { recursive: true });
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ sharedFolders: [{ id: 'main', path: share, devices: [] }], knownDevices: [], peers: [] }),
    );
    const lines: string[] = [];
    const logger = pino(
      { level: 'debug' },
      {
        write: (s: string) => {
          lines.push(s);
        },
      },
    );
    const manager = new SyncSessionManager(
      { identity: loadOrCreateIdentity(dir), configPath, configDir: dir, peerPort: 0, logger },
      loadConfig(configPath).sharedFolders,
    );
    return { dir, share, manager, lines, auditLines: () => lines.filter((l) => l.includes('audit folder=main')) };
  }

  /** 两个旋钮在 manager 构造时读;无论用例怎么结束都要还原,否则污染同文件后面的构建。 */
  function withKnobs<T>(n: string, intervalMs: string, fn: () => Promise<T>): Promise<T> {
    const saved = { n: process.env.SYNCX_DRIFT_SAMPLE_N, interval: process.env.SYNCX_DRIFT_INTERVAL_MS };
    process.env.SYNCX_DRIFT_SAMPLE_N = n;
    process.env.SYNCX_DRIFT_INTERVAL_MS = intervalMs;
    return fn().finally(() => {
      if (saved.n === undefined) delete process.env.SYNCX_DRIFT_SAMPLE_N;
      else process.env.SYNCX_DRIFT_SAMPLE_N = saved.n;
      if (saved.interval === undefined) delete process.env.SYNCX_DRIFT_INTERVAL_MS;
      else process.env.SYNCX_DRIFT_INTERVAL_MS = saved.interval;
    });
  }

  it('对端一台都不在:盘上改坏一个字节,下一轮扫描就报 peer=local + disk=1', async () => {
    await withKnobs('8', '0', async () => {
      const h = bootLocal('syncx-drift-local-');
      try {
        writeFileSync(join(h.share, 'victim.bin'), Buffer.alloc(64, 3));
        await h.manager.runScan(); // 第一轮:扫描器把条目建进索引,巡检干净收场
        const first = h.auditLines();
        expect(first.length).toBe(1);
        expect(first[0]).toContain('peer=local');
        expect(first[0]).toContain('disk=0');

        corruptByte(join(h.share, 'victim.bin'), 0); // 坏字节 + mtime 复位:扫描器看不见
        await h.manager.runScan();

        const audits = h.auditLines();
        expect(audits.length).toBe(2);
        expect(audits[1]).toContain('peer=local');
        expect(audits[1]).toContain('disk=1');
        const drift = h.lines.find((l) => l.includes('drift folder=main peer=local disk victim.bin'));
        expect(drift).toBeDefined();
        expect(drift).toContain('slot=0');
      } finally {
        h.manager.close();
        rmDir(h.dir);
      }
    });
  });

  it('间隔未到就不跑:两轮扫描之间只该有一条计数行(巡检的状态是目录级的)', async () => {
    await withKnobs('8', '600000', async () => {
      const h = bootLocal('syncx-drift-local-gap-');
      try {
        writeFileSync(join(h.share, 'a.txt'), Buffer.from('content a'));
        await h.manager.runScan();
        await h.manager.runScan();
        expect(h.auditLines().length).toBe(1);
      } finally {
        h.manager.close();
        rmDir(h.dir);
      }
    });
  });

  it('抽样数设 0 整道关掉:一行都不发(与对端轮同一个旋钮)', async () => {
    await withKnobs('0', '0', async () => {
      const h = bootLocal('syncx-drift-local-off-');
      try {
        writeFileSync(join(h.share, 'a.txt'), Buffer.from('content a'));
        await h.manager.runScan();
        expect(h.auditLines()).toEqual([]);
      } finally {
        h.manager.close();
        rmDir(h.dir);
      }
    });
  });
});
