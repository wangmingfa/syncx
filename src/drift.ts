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
 * 两道检查**不在同一轮里跑**。A 只能在收到对端索引的那一刻做(本机不持久化每个对端的索引,
 * 离开那轮消息就没有「对端宣告」可比);B 的全部输入都在本机索引里 —— 块哈希是 `blocks`(必填)
 * 或 `cdh`/`clens`,读的是本机文件、比的是本机宣告,没有一段来自对端,所以它跟着扫描器的心跳跑。
 * 分开的收益是 B 覆盖到两类原本永远验不到的盘(对端长期离线的目录、端到端加密的盲区设备),
 * 并且每目录每间隔的读盘次数回到 8:同一轮里做两道时,对端轮与本地轮会各读一遍同样的 8 个槽。
 *
 * 两道都只报不回修:回修要选一个赢家,而「谁的内容是对的」恰恰是这类故障里唯一
 * 还没有证据的事实。理由与代价见 docs/adr/0022。
 */

/**
 * 每轮抽样的路径条数默认值。取 8 的理由是**读盘**那一侧的成本:本地巡检(B)= 8 次
 * 「读一块 + 一次 sha256」,与目录里有多少文件无关。一块的字节数按被验的那套视图定:
 * 定长块 ≤ BLOCK_SIZE,内容定义块 ≤ CDC_MAX_CHUNK —— 所以两侧都有 CDC 视图时,一轮的最坏情况是
 * 32MB 而不是 8MB(平均块长 ≈1MB,8MB 是典型值不是上限)。对端轮(A)比同样多条宣告,但它零 IO,
 * 不占这份预算。
 */
export const DRIFT_SAMPLE_N_DEFAULT = 8;
/**
 * 两次同类审计的最小间隔默认值:半小时。哨兵要抓的是「静默分叉」,它以周为单位积累,
 * 半小时一轮已经把覆盖转完一圈绰绰有余,再把间隔收紧就只是在给一个几乎不响的东西分配盘读预算。
 */
export const DRIFT_INTERVAL_MS_DEFAULT = 30 * 60 * 1000;

/**
 * 读两个旋钮(抽样条数 / 最小间隔),对端轮与本地巡检共用同一对环境变量。
 *
 * 由调用方在**建管线 / 构造 manager 时**读,不做成模块常量:那会把值冻在 import 那一刻,
 * 而「把抽样数压到 2、间隔压到 0」正是集成用例走到这条路径的办法。
 */
export function readDriftKnobs(): { sampleN: number; intervalMs: number } {
  return {
    sampleN: envInt('SYNCX_DRIFT_SAMPLE_N', DRIFT_SAMPLE_N_DEFAULT),
    intervalMs: envInt('SYNCX_DRIFT_INTERVAL_MS', DRIFT_INTERVAL_MS_DEFAULT),
  };
}

/** 读整型环境旋钮:未设/空串/非有限/负数都退回默认值。0 是**要能生效**的取值(整道关掉)。 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

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
  /** 抽样前的候选总量。对端轮=版本相等的条目对;本地轮=盘上该有实体且有宣告可验的本机条目。 */
  candidates: number;
  /** 本轮实际抽到、并把该道检查跑完的路径数。 */
  sampled: number;
  /** A 检出数:版本相等而声明内容不同。本地轮没有第二台设备,恒为 0。 */
  declared: number;
  /** B 检出数:声明与盘上字节不符。对端轮自 0.3.5 之后不再做 B,恒为 0。 */
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
 * 块哈希齐备、审得动。是 B 要避开它 —— 那一道不看这里,看的是本机索引,过滤在
 * `runLocalAudit` 里。
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
  /** 轮次序号:等距抽样的滚动起点。 */
  round: number;
  /** 本轮抽样条数;0 关掉整道审计。 */
  n: number;
}

/**
 * 跑一轮对端审计(只做 A):等距抽 `n` 条「版本相等」的条目对,逐条比两份宣告。
 *
 * 这里**不做 B**,不是漏了:验盘需要的东西本机全都有(见 LocalAuditOptions),把它挂在这一刻
 * 只是让它依赖一件本来无关的事 —— 对端得在线、得送来索引。拆出去之后这条路径零 IO、零流量,
 * 也因此可以在每次索引交换时跑。
 *
 * 纯函数,所以判定逻辑能在不起 daemon、不建传输的情况下被测到。
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

  return { summary, findings };
}

/** 本地巡检(只做 B)的参数。与 AuditOptions 分开:这一道没有第二台设备可比。 */
export interface LocalAuditOptions {
  /** 轮次序号:抽样的滚动起点 + 槽位散列的盐。 */
  round: number;
  /** 本轮抽样条数;0 关掉整道巡检。 */
  n: number;
  /** 验盘接缝(executor.verifySampledSlots)。 */
  verify: (samples: readonly SlotSample[]) => readonly SlotVerdict[];
}

/**
 * 跑一轮本地巡检(只做 B):从本机索引里等距抽 `n` 条,逐条验「索引宣告的这一块」与
 * 「盘上那段字节」是否一致。
 *
 * 它存在的理由是**覆盖**:对端轮那套触发下,两类盘永远验不到 —— 对端长期离线或
 * 目录安静到没有索引交换(笔记本合盖几天之后盘上坏了什么,没人会看),以及端到端加密的盲区
 * 设备(那边只能比密文视图,拿它比明文盘等于把每条路径都报成漂移)。B 不需要对端任何东西,
 * 所以它可以跟着扫描器的心跳走。
 *
 * 口径在这里自己定,不像对端轮那样由调用方给:`AuditOptions` 那边要问「传输会按哪套切块发」,
 * 而这一道没有传输 —— 两套视图都是同一份内容的事实,验哪套都算验过。优先 CDC 是因为它的偏移
 * 是 `clens` 前缀和算出来的,ADR-0021 记过的那类算术错正在这条路上,定长视图验不到它。
 *
 * `declared` 恒为 0:这里没有第二台设备的宣告可比。保留这个字段是为了让日志行与对端轮次同形,
 * 同一套 grep 与同一套判据能读两种轮次。
 */
export function runLocalAudit(
  entries: Iterable<IndexEntry>,
  opts: LocalAuditOptions,
): AuditResult {
  // 候选过滤口径留在这里,不让调用方各写一遍:墓碑没有块列表、占位条目盘上没有实体
  // (内容全在别端)、0 字节文件两套视图都空 —— 三者都只能得到一个 unreadable 或一条假警报。
  const candidates: { entry: IndexEntry; cdc: boolean; hashes: readonly string[] }[] = [];
  for (const entry of entries) {
    if (entry.deleted || entry.placeholder) continue;
    const view = viewFor(entry);
    if (!view) continue;
    candidates.push({ entry, cdc: view.cdc, hashes: view.hashes });
  }

  const sampled = strideSample(candidates, opts.n, opts.round);
  const summary: AuditSummary = {
    candidates: candidates.length,
    sampled: sampled.length,
    declared: 0,
    disk: 0,
    unreadable: 0,
  };
  const findings: DriftFinding[] = [];
  if (sampled.length === 0) return { summary, findings };

  const samples: SlotSample[] = sampled.map((c) => ({
    entry: c.entry,
    cdc: c.cdc,
    slot: pickSlot(`${c.entry.path}:${opts.round}`, c.hashes.length),
  }));

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

  return { summary, findings };
}

/**
 * 选一套**本机条目上真的可用**的哈希视图来验盘:有可用的 CDC 视图就用它(它的偏移走 `clens`
 * 前缀和,正是 ADR-0021 记过的那条算断路径,值得专门验),否则退回定长 `blocks`。
 *
 * 返回 undefined 表示这条没得验:两套视图都空 —— 0 字节文件就是这种(size 与内容都无冲突可言)。
 */
function viewFor(local: IndexEntry): { cdc: boolean; hashes: readonly string[] } | undefined {
  if (cdcView(local)) return { cdc: true, hashes: local.cdh! };
  return local.blocks.length > 0 ? { cdc: false, hashes: local.blocks } : undefined;
}
