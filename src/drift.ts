import { createHash } from 'node:crypto';
import type { IndexEntry } from './index.js';
import { compareFileState } from './index.js';

/**
 * drift 哨兵(抽样审计)的判定侧:定期抽几条路径,验「索引说的」与「盘上/对端说的」是否一致。
 *
 * 要堵的盲区是精确的一行代码:`compareFileState` 判 `equal` **只看版本向量,不看内容**
 * (src/index.ts 的 compareVersions 只逐设备比计数器),`planPath` 对 `equal` 直接返回
 * `undefined`。于是两条声明只要版本向量相等,尺寸与块哈希差得再远也不会产生动作 ——
 * 不落盘、不记历史、不打日志。「双落地覆盖」这类静默分叉正是靠这条缝活下来的:
 * 索引收敛了,内容没收敛,而协议里没有第二种东西会注意到。
 *
 * 因此有两道检查,成本不同一个量级:
 *  - **A 声明 vs 声明**(本文件,零 IO、零流量):对判定 equal 的条目比 `size` 与块哈希。
 *    用的哈希是对端**这轮索引里已经送来的**那几条宣告,不新发任何帧、不要对端配合,
 *    所以旧版对端也照样被审计(它只是不知道自己在被审计)。
 *  - **B 声明 vs 磁盘**(executor.verifySampledSlots,每槽一次定位读 + 一次 sha256):
 *    本机索引在宣告某个块哈希,而盘上那段字节不是它。这份谎会被本机外推给整个舰队。
 *
 * 两道都只报不回修:回修要选一个赢家,而「谁的内容是对的」恰恰是这类故障里唯一
 * 还没有证据的事实。理由与代价见 docs/adr/0022。
 */

/** 一条抽样:该路径按给定口径的第 slot 个槽位要验盘。 */
export interface SlotSample {
  entry: IndexEntry;
  /** CDC 口径(clens 前缀和定偏移)还是定长口径(slot × BLOCK_SIZE)。 */
  cdc: boolean;
  slot: number;
}

/** 一个抽样槽位的验盘结论。`unreadable` **不是**漂移。 */
export type SlotVerdict =
  | { kind: 'ok'; path: string; slot: number }
  | { kind: 'drift'; path: string; slot: number; declared: string; actual: string }
  | { kind: 'unreadable'; path: string; slot: number; error: string };

/** 一轮审计的计数:日志必须能把「没检出」与「没跑」区分开。 */
export interface AuditSummary {
  /** 本轮参与比对的「版本相等」条目数(抽样前的候选总量)。 */
  candidates: number;
  /** 实际抽样并做完两道检查的路径数。 */
  sampled: number;
  /** A 检出数:版本相等而声明内容不同。 */
  declared: number;
  /** B 检出数:声明与盘上字节不符。 */
  disk: number;
  /** 盘读不出(文件被移走 / 无权限 / 越界路径):不计入漂移。 */
  unreadable: number;
}

/** 一条检出:哨兵只负责把它报出来,不裁决谁的内容是对的。 */
export interface DriftFinding {
  kind: 'declared' | 'disk' | 'unreadable';
  path: string;
  /** 定长口径的块下标;CDC 口径时指「第几个内容块」(偏移可由 clens 前缀和还原)。 */
  slot: number;
  /** 已排好版的原因片段,直接进日志行。 */
  detail: string;
}

/**
 * 两条声明的内容是否不符(检查 A)。一致时返回 undefined。
 *
 * 比的是**内容事实**:`size` 先比(它最便宜,且「同版本不同尺寸」几乎必然是坏的那一类),
 * 再比块哈希。块哈希按两边都有的口径比 —— 双方都有可用的 CDC 视图时比 `cdh`/`clens`
 * (它对中部改动的分辨力更强),否则比定长 `blocks`(旧对端只有这一套)。
 *
 * 不看 `mtime`:它不进 wire(见 IndexEntry.mtime 注释),线上永远比不出意义。
 * 不看 `version`:调用方已经确认它相等,这正是本检查的前提 —— 版本相等而内容不等才是漂移。
 */
export function declaredDrift(
  local: IndexEntry,
  remote: IndexEntry,
): { detail: string; slot: number } | undefined {
  if (local.size !== remote.size) return { detail: `size ${local.size} != ${remote.size}`, slot: -1 };

  const lCdc = cdcView(local);
  const rCdc = cdcView(remote);
  if (lCdc && rCdc) {
    if (lCdc.lengths !== rCdc.lengths) {
      return { detail: `chunk lengths differ (${lCdc.hashes.length} vs ${rCdc.hashes.length} chunk(s))`, slot: -1 };
    }
    const i = indexOfDiff(lCdc.hashes, rCdc.hashes);
    if (i >= 0) return { detail: `cdh[${i}] ${lCdc.hashes[i]!.slice(0, 12)}… != ${rCdc.hashes[i]!.slice(0, 12)}…`, slot: i };
    return undefined;
  }

  if (local.blocks.length !== remote.blocks.length) {
    return { detail: `blocks length ${local.blocks.length} != ${remote.blocks.length}`, slot: -1 };
  }
  const i = indexOfDiff(local.blocks, remote.blocks);
  if (i >= 0) return { detail: `blocks[${i}] ${local.blocks[i]!.slice(0, 12)}… != ${remote.blocks[i]!.slice(0, 12)}…`, slot: i };
  return undefined;
}

/** CDC 视图是否可用(与 peer.ts 的 cdcUsable 同一口径):cdh 与 clens 等长且非空。 */
function cdcView(e: IndexEntry): { hashes: string[]; lengths: string } | undefined {
  if (!e.cdh || !e.clens || e.cdh.length === 0 || e.cdh.length !== e.clens.length) return undefined;
  return { hashes: e.cdh, lengths: e.clens.join(',') };
}

/** 首个不同的下标(只为把日志写得可定位;列表等长才有意义)。 */
function indexOfDiff(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/**
 * 从「本轮对端宣告 ∩ 本机索引」里挑出**版本相等**的条目对(检查 A/B 的候选集)。
 *
 * 只审 equal 是有意的:local-newer / remote-newer / conflict 都还有动作要做,内容
 * 不一致是它们本职工作的一部分(下一轮自然收敛,或走冲突副本);把「尚未收敛」当成
 * 漂移报出来,等于给每条在途变更都发一张假警报。
 *
 * 墓碑(deleted)跳过:它的 blocks 是空的,与对端的活条目「不等」是正常语义。
 * 占位条目(on-demand,盘上无实体)**留在候选里**:A 比的是宣告与宣告,占位条目
 * 块哈希齐备、审得动;是 B(验盘)要避开它,由调用方按 placeholder 分流。
 */
export function equalPairs(
  remote: Iterable<IndexEntry>,
  localIndex: Map<string, IndexEntry>,
): DriftPair[] {
  const out: DriftPair[] = [];
  for (const r of remote) {
    if (r.deleted) continue;
    const l = localIndex.get(r.path);
    if (!l || l.deleted) continue;
    if (compareFileState(l, r) !== 'equal') continue;
    out.push({ path: r.path, local: l, remote: r });
  }
  return out;
}

/**
 * 等距抽样:每轮审 `n` 条,起始位置随轮次滚动,所以相邻轮次审的是不同文件。
 *
 * 不用随机:轮转覆盖是可验证的性质(测试要能断言「第 k 轮抽到了这一条」),
 * 而随机抽样在小集合上会反复抽中同几条、大集合上又无法证明覆盖过。
 * 单趟遍历、不排序、不复制整表(全量轮次的候选集可能是几万条)。
 */
export function strideSample<T>(items: readonly T[], n: number, round: number): T[] {
  if (n <= 0 || items.length === 0) return [];
  const step = Math.max(1, Math.ceil(items.length / n));
  const out: T[] = [];
  for (let i = round % step; i < items.length; i += step) out.push(items[i]!);
  return out;
}

/**
 * 为一个抽样条目定下**这一轮**要验盘的那个槽位。
 *
 * 按 (路径, 轮次) 散列而不是固定读第 0 块:固定槽位永远只覆盖文件的开头,而
 * 真实坏掉的是偏移算术(ADR-0021 记过一次「3 参 writeSync 把每块都写到文件开头」
 * 那种错法 —— 它偏偏让第 0 块看着是对的)。轮次进散列,同一文件在不同轮被审到时
 * 换槽位;路径进散列,同一轮里抽到的不同文件不都落在同一个下标上。
 *
 * 确定性(不加 Math.random)是为了测试能断言具体槽位。
 */
export function pickSlot(key: string, slots: number): number {
  if (slots <= 1) return 0;
  const h = createHash('sha256').update(key).digest();
  return h.readUInt32BE(0) % slots;
}

/** 一对「版本相等」的条目:检查 A 的两边,也是检查 B 的抽样单位。 */
export interface DriftPair {
  path: string;
  local: IndexEntry;
  remote: IndexEntry;
}

/** 一轮审计的产出。`findings` 为空且 `sampled > 0` 才是「这一片舰队没问题」的证据。 */
export interface AuditResult {
  summary: AuditSummary;
  findings: DriftFinding[];
}

/** 交给上层的完整报告(一轮审计 + 它是谁的、第几轮)。 */
export interface DriftReport extends AuditResult {
  /** 对端设备 id,只用于把日志行归到那条连接;未知时为空串。 */
  peer: string;
  /** 本条连接上**真正跑了**审计的第几轮(与抽样的轮转同源;被门控跳过的轮不计数)。 */
  round: number;
}

export interface AuditOptions {
  /** 轮次序号:等距抽样的滚动起点 + 槽位散列的盐。 */
  round: number;
  /** 本轮抽样条数;0 关掉整道审计。 */
  n: number;
  /**
   * 该条目按哪个口径验盘。由调用方给:同一个文件在 CDC / 定长两套视图下偏移算法不同,
   * 而**选哪套是传输侧的知识**(peer.ts 的 planCdc)。哨兵自己再判一次就会漂移到
   * 「按盘上读不到的那套口径报 drift」。缺省按定长。
   */
  cdcOf?: (pair: DriftPair) => boolean;
  /** 验盘接缝(executor.verifySampledSlots)。缺则只跑 A —— 测试里就跑 A。 */
  verify?: (samples: readonly SlotSample[]) => readonly SlotVerdict[];
}

/**
 * 跑一轮抽样审计:等距抽 `n` 条 → 逐条做 A(声明 vs 声明) → 剩下的按槽位交给 `verify` 做 B。
 *
 * A 检出的条目**仍然进 B**:两道问的是不同问题(A「两端的宣告互相不符」,B「本机在宣告一份
 * 盘上并不存在的内容」)。一条路径两边都红是重要的信号 —— 本机盘上就是那份内容,而它已经把
 * 谎外推给了对端。
 *
 * 纯函数(唯一的副作用在注入的 `verify` 里),所以两道检查的判定逻辑能在不起 daemon、
 * 不建传输的情况下被测到。
 */
export function runAudit(
  candidates: readonly DriftPair[],
  opts: AuditOptions,
): AuditResult {
  const findings: DriftFinding[] = [];
  const sampled = strideSample(candidates, opts.n, opts.round);
  const summary: AuditSummary = {
    candidates: candidates.length,
    sampled: sampled.length,
    declared: 0,
    disk: 0,
    unreadable: 0,
  };

  for (const pair of sampled) {
    const d = declaredDrift(pair.local, pair.remote);
    if (!d) continue;
    summary.declared++;
    findings.push({ kind: 'declared', path: pair.path, slot: d.slot, detail: d.detail });
  }

  const samples: SlotSample[] = [];
  for (const pair of sampled) {
    // 占位条目盘上没有实体(它的内容全在别端),对它验盘只会得到一条假的 unreadable。
    if (pair.local.placeholder) continue;
    const view = viewFor(pair.local, opts.cdcOf?.(pair) ?? false);
    if (!view) continue;
    samples.push({ entry: pair.local, cdc: view.cdc, slot: pickSlot(`${pair.path}:${opts.round}`, view.hashes.length) });
  }

  if (samples.length > 0 && opts.verify) {
    for (const v of opts.verify(samples)) {
      if (v.kind === 'ok') continue;
      if (v.kind === 'unreadable') {
        summary.unreadable++;
        findings.push({ kind: 'unreadable', path: v.path, slot: v.slot, detail: v.error });
        continue;
      }
      summary.disk++;
      findings.push({
        kind: 'disk',
        path: v.path,
        slot: v.slot,
        detail: `slot[${v.slot}] declared ${v.declared.slice(0, 12)}… != on disk ${v.actual.slice(0, 12)}…`,
      });
    }
  }

  return { summary, findings };
}

/**
 * 选一套**本机条目上真的可用**的哈希视图来验盘:优先调用方点名的口径,它不可用
 * (只有旧版写入的 blocks、或 cdh/clens 长度不符)则退回定长。
 *
 * 返回 undefined 表示这条没得验:两套视图都空 —— 0 字节文件就是这种(size 与内容都无冲突可言)。
 */
function viewFor(local: IndexEntry, wantCdc: boolean): { cdc: boolean; hashes: readonly string[] } | undefined {
  if (wantCdc && cdcView(local)) return { cdc: true, hashes: local.cdh! };
  if (local.blocks.length > 0) return { cdc: false, hashes: local.blocks };
  const fallback = cdcView(local);
  return fallback ? { cdc: true, hashes: local.cdh! } : undefined;
}
