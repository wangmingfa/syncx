import { closeSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, writeSync, rmSync, existsSync, statSync, realpathSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, basename, join, relative, isAbsolute, extname, sep } from 'node:path';
import type { IndexEntry } from './index.js';
import type { IndexStore } from './indexstore.js';
import { verifyBlock, hashBlock, hashFileViews, blocksMatchOnDisk, BLOCK_SIZE } from './blockstore.js';
import { isHardIgnored } from './ignore.js';
import { isUnchanged } from './scanner.js';
import { mergeVersions, incrementVersion, createVersionVector } from './version.js';
import { entryFingerprint, partialPaths, readManifest, removePartial, writeManifest, SlotBitmap, type PartialManifest } from './partial-store.js';
import type { SlotSample, SlotVerdict } from './drift.js';

/**
 * 一个在途接收的落盘句柄:块到达即按最终偏移写进 `<target>.syncx-tmp`,
 * 位图与条目指纹落在 `<target>.syncx-partial`(见 partial-store.ts)。
 *
 * 这是断点续传的载体:daemon 重启后,同一内容的接收会经 beginReceive 读到旧位图,
 * 只补缺的槽位。内存占用从 O(文件大小) 降到 O(单块)。
 *
 * 它是接收侧**唯一**的落地通道:旧的入口要求调用方先把全部块攒成一个数组再交出来
 * (那正是 O(文件) 的来源,CDC 口径还要再把它们整份拼接一次),已随阶段 2 一并删除 ——
 * 留着它就会给「先攒内存再落地」留一条回头路。
 */
export interface ReceiveHandle {
  /** 该槽位是否已正确写入。 */
  has(index: number): boolean;
  /** 已收槽位数。 */
  count(): number;
  /** 已收字节数(供传输进度统计)。 */
  bytes(): number;
  /** 写入一个槽位(乱序安全:按预计算偏移随机写)。块校验由调用方在到达时完成。 */
  append(index: number, data: Buffer): void;
  /**
   * 只读检查「这份内容现在就能落地」:位图已满,且 tmp 的定长块视图与条目一致。
   * 不碰磁盘,也只可能抛这两种错(没收齐 / 收齐了但内容不符)。冲突路径用它做前置判断
   * (见 applyConflict):校验不过时本地文件还不能动。
   */
  preflight(): void;
  /** 校验 + 版本快照 + rename 落地 + 清中间态,返回落盘 mtime。位图不满会抛错。 */
  finalize(): Promise<number>;
  /** 放弃:keepPartial=true 保留 tmp+manifest 供续传,false 整份作废。 */
  abort(keepPartial: boolean): void;
}

export interface LocalExecutor {
  /**
   * 把一个**已经收齐**的句柄落地(校验/快照/rename)并登记索引。块是逐块 append 进
   * 句柄的,这里只收尾 —— 不再有任何一次「整份内容」的搬运。
   */
  finalizeReceive(entry: IndexEntry, handle: ReceiveHandle): Promise<void>;
  /** 开启(或续上)一个在途接收。同内容重入会复用磁盘上的中间态。 */
  beginReceive(entry: IndexEntry, opts: { cdc: boolean }): ReceiveHandle;
  /**
   * 这份内容**已经**有多少字节躺在磁盘中间态里(见 partial-store.ts)。
   * 磁盘空间守卫用它把「本轮还要腾多少地方」估准:阶段 2 之后 tmp 活到整场传输结束,
   * 不扣这一段就会把已经写好的字节当成新需求,连续传几个大文件的目录会被误判空间不足。
   *
   * 只信 manifest 的位图,不做回读验哈希:验块是 beginReceive 的职责(它关系到内容对不对),
   * 这里问的只是空间 —— 位图声称的槽位即便随后被验失败、退回重传,写的也是同一段区间,
   * 那块盘本来就已经被占了。预估因此偏保守方向:少扣只是这一轮多拦一点,不会写坏数据。
   *
   * **绝不抛错**:一条预估失败掀翻整轮同步是不成比例的代价,任何异常(路径被拒 / 残骸读不出)
   * 都只返回 0,即退回「不扣在途」的旧口径。
   */
  partialBytes(entry: IndexEntry, opts: { cdc: boolean }): number;
  /**
   * 抽样验盘(drift 哨兵的 B 检查):对给定抽样的**那一个槽位**做定位读 + sha256,
   * 与索引宣告的块哈希比。返回每个抽样的结论;顺序与入参一致。
   *
   * 问的是「本机有没有在宣告一份盘上并不存在的内容」—— 这份谎会被本机外推给整个舰队,
   * 而索引一旦与盘不符,接收侧的哈希闸门反倒会把对端送来的**正确**内容当坏块丢掉。
   *
   * 只读被抽到的那一段(偏移由 slotLayout 现算,与落地用的同一套算术,所以「验的位置」
   * 与「写的位置」不可能各说各话),整轮成本 = 抽样数 × 一块,与文件大小无关。
   *
   * 盘上字节与宣告不符有两类原因,只有第二类是事故:①本机刚改过这份文件而索引还没跟上
   * (判据 = scanner 的免哈希快速路径,同一条口径)→ `unreadable`;②索引在撒谎 → `drift`。
   *
   * **绝不抛错**:一条抽样读不出来只记 `unreadable`,不允许掀翻审计或同步轮次
   * (`partialBytes` 同一条规矩)。文件消失 / 无权限 / 越界路径都归这一类 ——
   * 它们说明「这条没法验」,不是「内容不对」。
   */
  verifySampledSlots(samples: readonly SlotSample[]): SlotVerdict[];
  applyDelete(path: string, tombstone: IndexEntry): Promise<void>;
  /**
   * 双方都改过同一份文件:本地内容保留成 `.sync-conflict-` 副本,远端内容落地。
   * `handle` 是远端内容**已经收齐**的接收句柄(同一管线 beginReceive 拿到的那个);
   * 先 preflight 再动本地文件,校验不过时本地保持原样。
   */
  applyConflict(
    path: string,
    local: IndexEntry,
    remote: IndexEntry,
    handle: ReceiveHandle,
    remoteDeviceId: string,
  ): Promise<IndexEntry>;
  /**
   * 冲突自动策略 local-wins / newest-wins(本机 mtime 更新)的落地:内容不动、
   * 不生成冲突副本,只把版本向量合并进本地条目并持久化。
   *
   * 合并结果支配对端版本(mergeVersions 取逐设备最大值),对端下一轮规划会判
   * 「本地较新」并主动来拉本机内容 —— 收敛由协议自然完成,这里无需额外推送。
   */
  applyConflictKeepLocal(local: IndexEntry, remote: IndexEntry): Promise<IndexEntry>;
  /**
   * 按需同步(见 config.SharedFolderConfig.onDemand):把远端条目以**占位**形态
   * 记进索引(含块哈希)但绝不落盘 —— 文件系统一字不动,只写索引库。
   */
  applyPlaceholder(entry: IndexEntry): Promise<void>;
  applySend(path: string, deviceId: string): Promise<IndexEntry>;
}

/**
 * 接收句柄的**进程内**替身:调用方没有本地执行器时用(测试管线、执行器缺失的降级路径)。
 * 块攒在内存里、finalize 不碰磁盘 —— 它只承担块管线必需的那件事:记住哪些槽位收到了、
 * 收了多少字节,让请求/校验/收齐判定/进度统计都按同一套接口跑。
 *
 * 生产路径永远走 executor.beginReceive 的磁盘句柄;这里之所以还留一份内存实现,是为了
 * 不让 peer.ts 到处写 `handle?.` 分支 —— 那种分支会让「有没有落盘能力」变成调用方要
 * 关心的事,而它本来只该关心「收没收到」。
 */
export function createMemoryReceiveHandle(slots: number): ReceiveHandle {
  const got = new Array<Buffer | undefined>(slots);
  let done = 0;
  let bytes = 0;
  return {
    has: (index) => got[index] !== undefined,
    count: () => done,
    bytes: () => bytes,
    preflight(): void {
      if (done !== slots) throw new Error(`incomplete receive: ${done}/${slots} block(s)`);
    },
    append(index, data) {
      if (index < 0 || index >= slots || got[index] !== undefined) return;
      got[index] = data;
      done += 1;
      bytes += data.length;
    },
    async finalize() {
      if (done !== slots) throw new Error(`incomplete receive: ${done}/${slots} block(s)`);
      return Date.now();
    },
    abort() {
      /* 内存替身没有中间态可保留,也没有可清理的磁盘残骸 */
    },
  };
}

/**
 * 解析共享目录内的相对路径为绝对路径,并做符号链接越界校验:
 * 沿路径各段自顶向下,对**已存在**的段做 realpath 检查,任何段解析后指向
 * 共享目录之外则抛错。读写两侧共用(finalizeReceive/applyDelete/applyConflict
 * 与 readLocalBlock),防止对端利用目录内符号链接读写共享目录之外的文件。
 * 尚不存在的路径段(将由 mkdirSync recursive 安全创建)跳过。
 *
 * 同时拒绝硬忽略路径(HARD_IGNORE_NAMES:`.git`/`.hg`/`.svn`/`.syncx-trash`/
 * `.syncx-folder`,加上冲突副本命名与 `.syncx-tmp`/`.syncx-partial` 中间态后缀)。
 * 这是硬忽略的**最后一道、也是唯一一道文件系统级闸门**:
 * 即使上游某个调用方漏了过滤,同步也无法把对端内容写进本机 `.git`,更无法把本机的 `.git`
 * 移进回收站。放在这里而不是只放在 peer/scanner 里,是因为「不碰这些路径」最终要由
 * 真正动文件的那一层保证,而这一层是全部读写操作的必经之路。
 *
 * `allowHardIgnored`:仅供冲突处理链路(生成副本 / 收件箱合并 / 丢弃)使用 —— 冲突副本
 * 本身就是硬忽略对象,这些操作天然要碰它;符号链接越界守卫**不受该选项影响**,永远生效。
 */
export function resolveSharePath(
  root: string,
  relPath: string,
  opts?: { allowHardIgnored?: boolean },
): string {
  if (!opts?.allowHardIgnored && isHardIgnored(relPath)) {
    throw new Error(`hard-ignored path: ${relPath}`);
  }
  // 根目录可能不存在(刚配置尚未创建 / 运行中被删除):realpathSync 会抛 ENOENT。
  // 此时任何候选段也不可能存在(其祖先链断了),越界检查自然跳过;根目录恢复后恢复完整校验。
  const rootReal = existsSync(root) ? realpathSync(root) : undefined;
  const abs = join(root, relPath);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`unsafe path: ${relPath}`);
  }

  // 协议路径一律以 '/' 分隔,但 Windows 本地调用方可能传来 '\'(见 scanner 的历史问题)。
  // 两种分隔符都要切分:否则在 Windows 上 '\' 路径整条被当成一个 part,中间目录段的
  // 符号链接越界校验会被静默绕过(安全弱化)。
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  let ancestor = root;
  for (const part of parts) {
    const candidate = join(ancestor, part);
    if (existsSync(candidate) && rootReal !== undefined) {
      const resolved = realpathSync(candidate);
      if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
        throw new Error(`unsafe path: ${relPath}`);
      }
    }
    ancestor = candidate;
  }

  return abs;
}

/**
 * 接收对端文件前的冷启动保护:本机磁盘已存在同名文件、但本机索引尚未记录该路径
 * (目录刚加入 / daemon 刚启动、首扫未跑即遭“热”对端推送)时,把本机原文件保留为
 * `.sync-conflict-<ts>-<remoteDeviceId>` 副本,让出原路径给对端版本落地,避免被静默覆盖。
 * 返回 true 表示已保留副本(原路径已让出),false 表示无需保留(磁盘无该文件)。
 * 经 resolveSharePath 做符号链接越界校验;路径不安全时抛错,由调用方兜底。
 */
export function preserveLocalAsConflict(root: string, path: string, remoteDeviceId: string): boolean {
  const target = resolveSharePath(root, path);
  if (!existsSync(target) || !statSync(target).isFile()) return false;

  const ext = extname(path);
  const base = path.slice(0, path.length - ext.length);
  const ts = Date.now().toString(36);
  let n = 0;
  let copyName: string;
  // 副本命名本身就是硬忽略对象 → allowHardIgnored(越界守卫不受影响)
  do {
    const seq = n > 0 ? `-${n.toString(36)}` : '';
    copyName = `${base}.sync-conflict-${ts}${seq}-${remoteDeviceId}${ext}`;
    n++;
  } while (existsSync(resolveSharePath(root, copyName, { allowHardIgnored: true })) && n < 1000);
  renameSync(target, resolveSharePath(root, copyName, { allowHardIgnored: true }));
  return true;
}

/**
 * 槽位布局:每槽的偏移与前缀和长宽,以及总字节数、最长槽(读缓冲按其分配)。
 *
 * 口径只有两种:CDC 取 `clens` 前缀和,定长取 `BLOCK_SIZE`、末块按 size 收口。
 * beginReceive(随机写的落点)与 partialBytes(磁盘守卫的体积预估)**必须共用这一份** ——
 * 各写一遍的话,预估就会按另一套布局说话:块长差一个字节,「盘上已经有多少」就是假的,
 * 而假的预估只会让守卫在真正该拦的时候放行。
 */
function slotLayout(entry: IndexEntry, cdc: boolean): {
  offsets: number[];
  lengths: number[];
  total: number;
  maxLen: number;
} {
  const hashes = cdc ? entry.cdh! : entry.blocks;
  const offsets = new Array<number>(hashes.length);
  const lengths = new Array<number>(hashes.length);
  let total = 0;
  let maxLen = 0;
  for (let i = 0; i < hashes.length; i++) {
    offsets[i] = total;
    lengths[i] = cdc ? entry.clens![i]! : Math.min(BLOCK_SIZE, entry.size - total);
    total += lengths[i]!;
    if (lengths[i]! > maxLen) maxLen = lengths[i]!;
  }
  return { offsets, lengths, total, maxLen };
}

/**
 * 创建一个共享目录的本地执行器。
 *
 * @param trashDir 删除回收站目录的绝对路径。**刻意由调用方传入而不是在共享根下现算**:
 *   回收站放在共享目录里会在用户目录中留下常驻痕迹(并被 `git status` 报成未跟踪文件),
 *   故生产路径一律传 `<configDir>/trash/<index key>`(见 config.folderTrashPath)。
 * @param versionsDir 文件版本目录的绝对路径,生产路径传 `<configDir>/versions/<index key>`
 *   (见 config.folderVersionsPath)。本机文件被对端版本**覆盖**前,旧内容快照一份到这里:
 *   回收站保护「删除」,版本目录保护「修改」。缺省(旧调用方/测试)不做版本快照。
 * @param opts.versionsPerPath 每路径保留的版本份数上限(超出删最旧)。缺省 10;
 *   生产路径由 config.versionsPerPath 注入(设置页可调),改值后由 daemon 重建执行器生效。
 */
export function createLocalExecutor(
  root: string,
  index: IndexStore,
  trashDir: string,
  versionsDir?: string,
  opts?: { versionsPerPath?: number },
): LocalExecutor {
  /** 每个路径保留的版本份数上限:超出删最旧。版本目录是安全网而非归档,无界增长不合适。 */
  const MAX_VERSIONS_PER_PATH = Math.max(1, Math.floor(opts?.versionsPerPath ?? 10));

  /** 共享目录内相对路径解析:复用模块级守卫(含符号链接越界校验)。 */
  function resolvePath(relPath: string): string {
    return resolveSharePath(root, relPath);
  }

  /**
   * 冲突副本专用解析:副本命名属硬忽略对象,生成副本这一步必须绕过硬忽略闸门,
   * 但仍走完整的符号链接越界守卫(见 resolveSharePath 的 allowHardIgnored 说明)。
   */
  function resolveConflictCopyPath(relPath: string): string {
    return resolveSharePath(root, relPath, { allowHardIgnored: true });
  }

  /**
   * 把待删除文件移入回收站(共享目录之外),而非硬删:误删可经回收站找回,避免
   * 2026-09-15 那样的不可逆数据丢失。保留原相对路径结构(便于原样还原);
   * 同路径短时间内多次删除用自增序号避免覆盖。
   * 同文件系统走 rename(瞬时、原子);跨文件系统(共享盘与配置目录不同盘)或文件被
   * 占用(如 Windows)时退化为拷贝后删,仍保留可恢复副本。
   */
  function moveToTrash(relPath: string): void {
    const target = resolvePath(relPath);
    if (!existsSync(target) || !statSync(target).isFile()) return;
    mkdirSync(trashDir, { recursive: true });
    const stamp = Date.now().toString(36);
    let dest = join(trashDir, `${relPath}.${stamp}`);
    let n = 0;
    while (existsSync(dest)) {
      n += 1;
      dest = join(trashDir, `${relPath}.${stamp}.${n}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    try {
      renameSync(target, dest);
    } catch {
      // 跨文件系统 / 文件被占用:拷贝保留副本后再删原文件,绝不静默丢弃
      copyFileSync(target, dest);
      rmSync(target);
    }
  }

  /**
   * 把待覆盖文件的当前内容快照进版本目录(共享目录之外),再由 landRemote 覆盖:
   * 回收站保护「删除」,这里保护「修改」——对端推送覆盖本机现存文件时,旧内容
   * 不再直接丢失。命名 `<relPath>.syncx-v-<stamp>`(碰撞加序号):`.syncx-v-`
   * 后缀是显式标记,恢复时据此无歧义地反推原始相对路径。
   * 快照动作绝不能让原文件消失:rename 失败(跨文件系统/文件被占用)退化为
   * 拷贝,原文件保持原样,随后照常被覆盖。
   */
  function snapshotVersion(relPath: string): void {
    if (versionsDir === undefined) return;
    const target = resolvePath(relPath);
    if (!existsSync(target) || !statSync(target).isFile()) return;
    mkdirSync(versionsDir, { recursive: true });
    const stamp = Date.now().toString(36);
    let dest = join(versionsDir, `${relPath}.syncx-v-${stamp}`);
    let n = 0;
    while (existsSync(dest)) {
      n += 1;
      dest = join(versionsDir, `${relPath}.syncx-v-${stamp}.${n}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    try {
      renameSync(target, dest);
    } catch {
      copyFileSync(target, dest);
    }
  }

  /**
   * 快照后修剪:同一路径的版本超过上限时删最旧。
   * 按文件名排序近似按时间排序 —— stamp 是单调递增的 base36 时间戳,同一路径下
   * 字典序即时间序;碰撞序号(.n)也在同一文件名内,不影响比较。
   * 版本文件保留了原相对路径的目录结构(docs/plan.md 的留档在 <versionsDir>/docs/),
   * 所以必须在「relPath 的父目录」里按 basename 前缀筛——只扫顶层会漏掉所有嵌套
   * 路径,每路径上限对它们失效(无界增长)。
   */
  function pruneVersions(relPath: string): void {
    if (versionsDir === undefined) return;
    const dir = dirname(join(versionsDir, relPath));
    const prefix = `${basename(relPath)}.syncx-v-`;
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.startsWith(prefix));
    } catch {
      return; // 版本目录还没建等异常:修剪是 best-effort,不阻塞落地
    }
    if (names.length <= MAX_VERSIONS_PER_PATH) return;
    names.sort();
    for (const name of names.slice(0, names.length - MAX_VERSIONS_PER_PATH)) {
      try {
        rmSync(join(dir, name));
      } catch {
        // 单个删除失败(占用等):留给下一次快照再试
      }
    }
  }

  /**
   * 组提交节奏:每攒够这么多槽位,先 fsync tmp 再写 manifest。
   *
   * 顺序是铁律,不可颠倒 —— manifest 说「这块已在盘上」而字节还没刷盘,崩溃后续传就会
   * 把一个空洞当成好块跳过(所以续传自检也只兜住一部分,顺序才是根保证)。
   * 取 8:再密就退化成「每块一次 fsync」,大文件会被刷盘拖慢;再稀则崩溃时多丢几个块的重传量。
   */
  const PARTIAL_COMMIT_SLOTS = 8;

  /**
   * 开启(或续上)一个在途接收,返回逐块落盘句柄。
   *
   * 槽位偏移在规划时就按条目算死(CDC 口径取 `clens` 前缀和,定长口径取 `i * BLOCK_SIZE`),
   * 块因此可以按任意到达顺序随机写进 `<target>.syncx-tmp` —— 每个块落在它最终该在的位置,
   * 收齐后 rename 即落地,全程没有任何一次「整份内容」的搬运,内存峰值 = 单个块。
   */
  function beginReceive(entry: IndexEntry, opts: { cdc: boolean }): ReceiveHandle {
    const target = resolvePath(entry.path);
    const paths = partialPaths(target);
    const hashes = opts.cdc ? entry.cdh! : entry.blocks;
    const slots = hashes.length;
    const { offsets, lengths, maxLen } = slotLayout(entry, opts.cdc);
    const fingerprint = entryFingerprint(entry);

    let bitmap = new SlotBitmap(slots);
    let bytes = 0;
    let startedAt = Date.now();
    const prev = readManifest(paths.manifest, { fingerprint, cdc: opts.cdc, slots });
    // 只认「manifest 说得清这份内容」:tmp 的长度不用等式校验 —— 条目的声明尺寸与块实长
    // 可能本就不等(旧对端的 size 是它自己看到的),而长度不符的槽位在下面的自检里
    // 一律读不满、自动清位退回重传,末尾还有 blocksMatchOnDisk 这道全量闸门兜着。
    const resumed = prev !== null && existsSync(paths.tmp);
    if (resumed) {
      bitmap = new SlotBitmap(slots, prev!.bitmap);
      startedAt = prev!.startedAt;
      // 续传自检:位图声称已写的槽位逐个回读验哈希。半截块(崩在写中间)、被别的进程
      // 改过的区间都在这里清掉位、退回缺失态重传。宁可多读一遍盘,不可把坏块当成已收 ——
      // 代价只在重启后的第一次接收上付,而它省下的是整份重传。
      const vf = openSync(paths.tmp, 'r');
      try {
        const buf = Buffer.allocUnsafe(maxLen);
        for (let i = 0; i < slots; i++) {
          if (!bitmap.has(i)) continue;
          // 循环读满(口径同 readBlockAt/hashFileViews):单次定位读的短读是 POSIX
          // 允许的正常返回,拿短读去验哈希会把**写对了的槽位**误判成坏块清位重传。
          let got = 0;
          while (got < lengths[i]!) {
            const n = readSync(vf, buf, got, lengths[i]! - got, offsets[i]! + got);
            if (n <= 0) break;
            got += n;
          }
          if (got !== lengths[i]! || !verifyBlock(buf.subarray(0, got), hashes[i]!)) {
            bitmap.clear(i);
            continue;
          }
          bytes += got;
        }
      } finally {
        closeSync(vf);
      }
    }

    // 磁盘中间态是**按需**创建的:第一个块到达(或确实要落地)才建目录、开句柄。
    // beginReceive 一进来就 fopen 的话,一条「规划完却一个块都没收」的接收(占位、
    // 双方同删、路径被判不安全)会在用户目录里留下一个没人认领的空 tmp。
    let fd: number | undefined;
    let dirty = 0;

    function ensureFd(): number {
      if (fd !== undefined) return fd;
      mkdirSync(dirname(target), { recursive: true });
      // 自认为已有内容 → 'r+':'w' 会把写好的 tmp 截成空文件,那等于把断点续传删了。
      // 全新接收(或空文件)→ 'w',顺带把上一轮的残骸截干净。
      fd = openSync(paths.tmp, bitmap.count() > 0 ? 'r+' : 'w');
      return fd;
    }

    /** 关掉写句柄(幂等)。Windows 上句柄不关就 rename / 删不掉,每条终态路径都必须先过这里。 */
    function closeFd(): void {
      if (fd === undefined) return;
      closeSync(fd);
      fd = undefined;
    }

    /** 把「哪些槽位已在盘上」交代给磁盘:先 fsync 字节,再写位图(见 PARTIAL_COMMIT_SLOTS)。 */
    function commit(): void {
      if (dirty === 0 || fd === undefined) return;
      fsyncSync(fd);
      const m: PartialManifest = {
        v: 1,
        fingerprint,
        cdc: opts.cdc,
        slots,
        bitmap: bitmap.toBase64(),
        startedAt,
        updatedAt: Date.now(),
      };
      writeManifest(paths.manifest, m);
      dirty = 0;
    }

    /**
     * 定长视图是两种口径共用的正确性依据:CDC 块拼起来就是同一份字节,重切一次必然
     * 得到 entry.blocks,所以这里不需要知道本次按哪种口径收的。流式逐块读、首处不符
     * 立刻返回,内存峰值仍然只有块级。空文件没有字节可验,直接判定通过。
     */
    function contentMatches(): boolean {
      return slots === 0 || blocksMatchOnDisk(paths.tmp, entry.blocks);
    }

    /** 只读闸门:位图已满,且 tmp 的定长块视图与条目逐块吻合。不抛这两种情况以外的错。 */
    function preflight(): void {
      if (!bitmap.full()) {
        throw new Error(`incomplete receive for ${entry.path}: ${bitmap.count()}/${slots} block(s)`);
      }
      if (!contentMatches()) throw new Error(`content mismatch for ${entry.path}`);
    }

    return {
      has: (index) => bitmap.has(index),
      count: () => bitmap.count(),
      bytes: () => bytes,
      preflight,

      append(index: number, data: Buffer): void {
        if (bitmap.has(index)) return; // 重复响应:幂等,不重写也不重复计数
        // 落盘前逐块验哈希(越界一并挡住)。peer 在块到达时已经验过一次,这道是执行器
        // 自己的:位图一旦说「这块已在盘上」就必须是真的对,续传与终验才敢信它。
        const expected = hashes[index];
        if (expected === undefined || !verifyBlock(data, expected)) {
          throw new Error(`block ${index} hash mismatch for ${entry.path}`);
        }
        const handle = ensureFd();
        // 5 参形式 —— 第 3 参是 buffer 内偏移、不是文件位置,3 参形式会把每块都写到文件开头
        let written = 0;
        while (written < data.length) {
          written += writeSync(handle, data, written, data.length - written, offsets[index]! + written);
        }
        bitmap.set(index);
        bytes += data.length;
        dirty += 1;
        if (dirty >= PARTIAL_COMMIT_SLOTS || bitmap.full()) commit();
      },

      async finalize(): Promise<number> {
        if (!bitmap.full()) {
          // 还没收齐就落地 = 把空洞当成内容。中间态**保留**:这条接收本来就还能续。
          throw new Error(`incomplete receive for ${entry.path}: ${bitmap.count()}/${slots} block(s)`);
        }
        if (!contentMatches()) {
          // 位图说齐了、盘上内容不对(块被篡改 / tmp 被动过):留着也没用,整对作废重传
          closeFd();
          removePartial(target);
          throw new Error(`content mismatch for ${entry.path}`);
        }
        // 空文件的接收一个块都没有(不会创建 tmp),落地就是一份空文件:补上创建这一步。
        if (fd === undefined) ensureFd();
        closeFd();
        // 覆盖本机现存文件前留存旧内容(全新文件不产生版本)。冲突路径的本地文件已经
        // rename 成 .sync-conflict- 副本让出原路径,这里天然不会重复快照。
        snapshotVersion(entry.path);
        pruneVersions(entry.path);
        renameSync(paths.tmp, target);
        removePartial(target); // tmp 已改名,这里真正清掉的是 manifest
        return statSync(target).mtimeMs;
      },

      abort(keepPartial: boolean): void {
        // 保留中间态时先把最后一批字节交代干净,否则这段进度在重启后就是白写的。
        // 落地成功后再调(终态收口会统一走这里)必须是无操作:句柄已关、位图已清零。
        if (fd !== undefined) {
          if (keepPartial) commit();
          closeFd();
        }
        if (!keepPartial) removePartial(target);
      },
    };
  }

  /**
   * 磁盘中间态已占的字节(见 LocalExecutor.partialBytes 的语义)。
   * 一次 existsSync + 一次 JSON 读,只在守卫拦本轮前对每个入向项各跑一遍。
   */
  function partialBytes(entry: IndexEntry, opts: { cdc: boolean }): number {
    try {
      const paths = partialPaths(resolvePath(entry.path));
      // 位图在、tmp 不在 = 没有字节可扣(beginReceive 也会整对作废重来)
      if (!existsSync(paths.tmp)) return 0;
      const { lengths } = slotLayout(entry, opts.cdc);
      const prev = readManifest(paths.manifest, {
        fingerprint: entryFingerprint(entry),
        cdc: opts.cdc,
        slots: lengths.length,
      });
      // 指纹不符(内容哪怕只变了一块)→ 续传会整对作废,这一段一分都算不上已占
      if (prev === null) return 0;
      const bitmap = new SlotBitmap(prev.slots, prev.bitmap);
      let bytes = 0;
      for (let i = 0; i < lengths.length; i++) {
        if (bitmap.has(i)) bytes += lengths[i]!;
      }
      // size 是条目自己声明的期望字节数:残骸比它「多」时不认(宁可多估需求)
      return Math.min(bytes, entry.size);
    } catch {
      return 0;
    }
  }

  function verifySampledSlots(samples: readonly SlotSample[]): SlotVerdict[] {
    const out: SlotVerdict[] = [];
    for (const { entry, cdc, slot } of samples) {
      try {
        const hashes = cdc ? entry.cdh : entry.blocks;
        if (hashes === undefined || slot < 0 || slot >= hashes.length) {
          out.push({ kind: 'unreadable', path: entry.path, slot, error: 'no such slot' });
          continue;
        }
        // CDC 口径要 clens 与 cdh 一一对应才定得出偏移(同 peer.ts 的 cdcUsable 口径)
        if (cdc && (!entry.clens || entry.clens.length !== hashes.length)) {
          out.push({ kind: 'unreadable', path: entry.path, slot, error: 'incomplete cdc view' });
          continue;
        }
        const target = resolvePath(entry.path); // 不安全路径在这里抛,由下面的 catch 归 unreadable
        const st = statSync(target, { throwIfNoEntry: false });
        if (st === undefined || !st.isFile()) {
          out.push({ kind: 'unreadable', path: entry.path, slot, error: 'file absent' });
          continue;
        }
        // 本机正在改这份文件:索引还没跟上,盘上字节与旧宣告不符是**预期**,不是漂移。
        // 判据与扫描器的免哈希快速路径同源(见 scanner.isUnchanged)—— 它自己都不信这种
        // 条目的块哈希,哨兵再拿它当基准去验盘就是拿一张已知过期的收据对账。
        if (!isUnchanged(entry, st)) {
          out.push({ kind: 'unreadable', path: entry.path, slot, error: 'index stale (edited locally since scan)' });
          continue;
        }
        // 偏移与长度用 slotLayout:与 beginReceive 落地时同一套算术,验的位置=写的位置
        const { offsets, lengths } = slotLayout(entry, cdc);
        const len = lengths[slot]!;
        const buf = Buffer.allocUnsafe(len);
        const fd = openSync(target, 'r');
        let got = 0;
        try {
          // 必须循环读到 EOF:定位读的短读是 POSIX 允许的正常返回(尤其大 offset 与大长度),
          // 只读一次会拿半截字节去哈希 —— 那是一条**每次都对不上**的假 drift。
          while (got < len) {
            const n = readSync(fd, buf, got, len - got, offsets[slot]! + got);
            if (n <= 0) break;
            got += n;
          }
        } finally {
          closeSync(fd);
        }
        // 读不满也照哈希:短内容的哈希必然不等于宣告值,落进 drift,不必再分一类 ——
        // 「盘上比索引说的少」正是索引在撒谎的一种。走到这里的只剩两种情况:定位读的
        // 短读(POSIX 允许,上面的循环已读完为止),以及 stat 与 read 之间文件被截短。
        const actual = hashBlock(buf.subarray(0, got));
        const declared = hashes[slot]!;
        out.push(
          actual === declared
            ? { kind: 'ok', path: entry.path, slot }
            : { kind: 'drift', path: entry.path, slot, declared, actual },
        );
      } catch (e) {
        out.push({ kind: 'unreadable', path: entry.path, slot, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  }

  return {
    async finalizeReceive(entry: IndexEntry, handle: ReceiveHandle): Promise<void> {
      const mtime = await handle.finalize();
      // 记录落盘后的 mtime,供扫描免哈希快速跳过未变更文件
      index.saveEntry({ ...entry, mtime });
    },
    beginReceive,
    partialBytes,
    verifySampledSlots,
    async applyDelete(path: string, tombstone: IndexEntry): Promise<void> {
      const target = resolvePath(path);
      if (existsSync(target) && statSync(target).isFile()) {
        // 移入回收站而非硬删:误删可经回收站找回(2026-09-15 事故前删除不可恢复)
        moveToTrash(path);
      }
      index.saveEntry(tombstone);
    },
    async applyConflict(
      path: string,
      local: IndexEntry,
      remote: IndexEntry,
      handle: ReceiveHandle,
      remoteDeviceId: string,
    ): Promise<IndexEntry> {
      // 双方同时删除:只合并版本向量写墓碑,绝不落盘空文件复活删除
      if (local.deleted && remote.deleted) {
        const merged: IndexEntry = {
          path,
          version: mergeVersions(local.version, remote.version),
          size: 0,
          deleted: true,
          blocks: [],
        };
        index.saveEntry(merged);
        return merged;
      }

      const target = resolvePath(path);
      const ext = extname(path);
      const base = path.slice(0, path.length - ext.length);

      // 先确认远端内容齐了而且对(位图满 + 逐块哈希吻合):校验不过时本地文件保持不动,
      // 避免本地被 rename 成冲突副本后原路径变空,下一轮扫描产生墓碑并传播删除。
      handle.preflight();

      // 校验通过后才动本地文件:本地内容保留为冲突副本,绝不静默丢弃。
      // 时间戳精度到毫秒 + 逐次递增序号,防止同一毫秒多次冲突时副本文件名碰撞被覆盖
      if (existsSync(target)) {
        const ts = Date.now().toString(36);
        let n = 0;
        let copyName: string;
        do {
          const seq = n > 0 ? `-${n.toString(36)}` : '';
          copyName = `${base}.sync-conflict-${ts}${seq}-${remoteDeviceId}${ext}`;
          n++;
        } while (existsSync(resolveConflictCopyPath(copyName)) && n < 1000);
        renameSync(target, resolveConflictCopyPath(copyName));
      }

      const mtime = await handle.finalize();

      // 索引记录合并版本(双方修改都保留),并写入落地后的 mtime
      const landed: IndexEntry = {
        ...remote,
        version: mergeVersions(local.version, remote.version),
        mtime,
      };
      index.saveEntry(landed);
      return landed;
    },
    async applyConflictKeepLocal(local: IndexEntry, remote: IndexEntry): Promise<IndexEntry> {
      // 本地内容胜出:磁盘一字不动,只在索引里采纳合并后的版本向量。
      // 保留本地 mtime(文件没变);merged 支配双方,对端自然转判「我方较新」来拉取。
      const keep: IndexEntry = {
        ...local,
        version: mergeVersions(local.version, remote.version),
      };
      index.saveEntry(keep);
      return keep;
    },
    async applyPlaceholder(entry: IndexEntry): Promise<void> {
      // 按需同步占位:只写索引库,绝不碰文件系统(块哈希已在 entry 里)。
      index.saveEntry({ ...entry, placeholder: true });
    },
    async applySend(path: string, deviceId: string): Promise<IndexEntry> {
      const target = resolvePath(path);
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new Error(`file not found: ${path}`);
      }

      // 流式算视图:定长块与 CDC 块一次读盘一起扫出来(CDC 是纯附加视图,见 IndexEntry.cdh)。
      // 不再 readFileSync 整读 —— 整读把整个文件搬进内存(1.5GB 实测顶爆 V8 堆),
      // 还有 ~2GiB 硬上限。与内存实现的逐字节等价性由 test/blockstore.test.ts 钉住。
      const { size, blocks, cdh, clens } = hashFileViews(target);
      const previous = index.getEntry(path);
      const version = incrementVersion(previous?.version ?? createVersionVector(), deviceId);

      const updated: IndexEntry = {
        path,
        version,
        size,
        deleted: false,
        blocks,
        mtime: statSync(target).mtimeMs,
        // 空文件没有块可言:cdh/clens 留空,与「无 CDC 视图」同口径(见 IndexEntry.clens)
        ...(cdh.length > 0 ? { cdh, clens } : {}),
      };
      index.saveEntry(updated);
      return updated;
    },
  };
}
