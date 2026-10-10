import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';

export const BLOCK_SIZE = 1 * 1024 * 1024;

export function splitIntoBlocks(data: Buffer): Buffer[] {
  const blocks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += BLOCK_SIZE) {
    blocks.push(data.subarray(offset, Math.min(offset + BLOCK_SIZE, data.length)));
  }
  return blocks;
}

/**
 * 按块下标直接从磁盘读取单个块:**只读所需的那 1MB**,不整读文件。
 *
 * 为什么必须这样:块请求是数据面最热的路径 —— 对端会为一个文件的几十个缺失块
 * 密集发来请求(还叠加 5s 超时重试)。此前这里是「readFileSync 整读 + 分块再切片」,
 * 每供一个 1MB 块就把**整个文件**读一遍:同步一个 100MB 文件时 ≈ 100 次整读
 * (10GB 的同步 IO 与内存拷贝)串行压在事件循环上,控制面 HTTP 被彻底饿死 ——
 * 表现为「同步大文件时网页刷新后一直白屏,像后端卡死」。按偏移读单块后,
 * 100 个块的总 IO 就是文件本身的大小。
 *
 * 越界(下标超出文件实际块数,含文件被截短)抛错,与旧实现语义一致:调用方
 * (peer.onBlockRequest)捕获后忽略该请求,对端走超时重试/下一轮索引自愈。
 * 末块不足 1MB 时按实际字芔回(与 splitIntoBlocks 的末块行为一致)。
 *
 * 必须循环读满:单次 readSync 的短读是 POSIX 允许的正常返回,定位读尤其如此
 * (大 offset / 大长度,FUSE 与网络文件系统上高发)。只读一次就把半截字节当成
 * 整块送出去,对端逐块验哈希必然失败,整块传输作废;而读到的字节永远只暴露
 * subarray(0, filled),allocUnsafe 的未初始化尾部绝不会混进内容 —— 发送端把
 * 「没读到的内存」哈希进索引进而广播,正是 AALQHUYOGA 事故的形态
 * (2026-10-10:同一个文件两次扫描广播出两种哈希,垃圾字节来自堆残留)。
 */
export function readBlockAt(absPath: string, blockIndex: number): Buffer {
  const fd = openSync(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(BLOCK_SIZE);
    let filled = 0;
    while (filled < BLOCK_SIZE) {
      const n = readSync(fd, buf, filled, BLOCK_SIZE - filled, blockIndex * BLOCK_SIZE + filled);
      if (n <= 0) break; // EOF:末块按实际字节收,撕裂视图与 hashFileViews 同口径
      filled += n;
    }
    if (filled === 0) {
      throw new Error(`block ${blockIndex} out of range for ${absPath}`);
    }
    return buf.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

export function hashBlock(block: Buffer): string {
  return createHash('sha256').update(block).digest('hex');
}

export function verifyBlock(block: Buffer, hash: string): boolean {
  return hashBlock(block) === hash;
}

// ---------------------------------------------------------------------------
// CDC(Content-Defined Chunking)内容定义分块
//
// 定长 1MB 块的问题:文件中部插入/删除一点内容会让其后**所有**块错位,哈希全不
// 匹配,接收端被迫重传整个文件(块下标 diff 只救得了尾部追加与就地改写)。
// CDC 用「内容滚动哈希命中掩码」决定块边界:同样的字节序列在两端必然切出同样的
// 块 —— 中部插入只影响插入点附近一两块,其余块按哈希集合天然对齐,预填与网络
// 请求都只围绕改动区域。
//
// 关键性质(全部实现都必须守住):
//  - **纯函数**:边界只由内容决定,不依赖文件路径/大小/既有索引。两端各自算出
//    相同结果,才谈得上「按哈希预填本地已有块」。
//  - **种子与折叠式永久冻结**: Gear 表、窗口宽度、移出项的算法一旦换,所有历史 cdh
//    作废(表现为全量重传,不损坏数据),必须当成协议变更对待 —— 见 ADR-0017 与
//    ADR-0019(后者就是一次这样的变更:补上缺失的窗口移出项)。
//  - 与定长块**共存而非替换**:索引里 blocks 仍是定长哈希(旧对端只认它),
//    cdh/clens 是附加视图(见 IndexEntry),新对端两边都拿到、各取所需。
// ---------------------------------------------------------------------------

/** CDC 块长下限:太短的碎片会让哈希列表本身成为索引/线路负担。 */
export const CDC_MIN_CHUNK = 256 * 1024;
/**
 * CDC 块长上限:同时也是「单个块响应」的体积上限(接收闸门按此拒绝超大块,
 * 见 peer.onBlockResponse),必须与 wire 语义一致,勿随意调大。
 */
export const CDC_MAX_CHUNK = 4 * 1024 * 1024;
/** 目标平均块长 ≈ 1MB(2^20 分之一命中,与定长块口径接近)。 */
const CDC_MASK = (1 << 20) - 1;

/**
 * 内容指纹滚动表:256 个 uint32,mulberry32 固定种子确定性生成。
 * 种子 0x9e3779b9(黄金比例常数)一经写入源码即永久冻结 —— 见上「种子永久冻结」。
 */
const GEAR_TABLE: Uint32Array = (() => {
  let a = 0x9e3779b9 >>> 0;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    table[i] = (t ^ (t >>> 14)) >>> 0;
  }
  return table;
})();

/** 指纹窗口宽度:一个字节只对随后这么多字节内的边界判定有影响,越过即被移出项抵消。 */
const BUZ_WINDOW = 32;

/**
 * 带**窗口移出项**的 Buzhash 滚动指纹。全仓只在这里定义一次折叠式:内存切块
 * (chunkContent)与流式扫描(hashFileViews)共用它,因为两处算出的边界必须逐位相同
 * —— 一处记得 carry、一处忘了,写进索引的 cdh 就和实际内容不符,而症状只是"这个文件
 * 永远同步不动",比崩掉难查得多。
 *
 * 折叠式:fp_i = XOR_{d=0}^{W-1} rot^d(GEAR[b_{i-d}]),由此推出逐步形式
 *   fp_i = rot1(fp_{i-1}) ^ GEAR[in] ^ rot^W(GEAR[out])
 * out 是 W 个字节前进场、现在离开窗口的那个字节。32 位整数上 rot^32 是恒等,所以移出项
 * 就是 GEAR[out] 本身。**移出项不能省**:只留累入项时,同一个字节被循环移位 32 次后回到
 * 原值,改动带来的差分会永久旋转下去而不消失,其后每个边界都跟着错位 —— 这正是当初
 * 「1 字节改写让整文件重传」的根因(记档见 ADR-0019)。
 */
class RollingFingerprint {
  /** 环形缓冲:槽位 i & (W-1) 存 W 个字节前进场的那个字节。 */
  private readonly entered = new Uint8Array(BUZ_WINDOW);
  private fp = 0;
  private seen = 0;

  /** 吃进一个字节,返回滚动后的指纹。 */
  step(byte: number): number {
    const i = this.seen++;
    const slot = i & (BUZ_WINDOW - 1);
    // 窗口还在填(前 W 个字节)时没有移出项,与上面的定义式一致
    const removal = i >= BUZ_WINDOW ? GEAR_TABLE[this.entered[slot]!]! : 0;
    this.entered[slot] = byte;
    this.fp = ((((this.fp << 1) | (this.fp >>> 31)) >>> 0) ^ GEAR_TABLE[byte]! ^ removal) >>> 0;
    return this.fp;
  }
}

/**
 * 按内容定义的边界切块,语义与 splitIntoBlocks 对齐(返回子数组视图、拼接即原文)。
 *
 * 边界由 RollingFingerprint 的低 20 位命中决定,而那个指纹带窗口移出项,所以**一个字节的
 * 影响只在随后 32 字节内有效**:扰动越过改动点 32 字节之后指纹与原文逐位相同,边界重新
 * 对齐(重同步)。实测 4MiB 伪随机文件、改动点固定在 1MiB+512、四个种子各自求块哈希交集:
 * 1 字节就地改写、7B/512B/10KB 中部插入、4KB 尾部追加,一律**只废改动所在的那一块**
 * (每个种子切出 3~6 块,作废数恒为 1)。改动前这里是"其后所有块全废"(复用 0)。
 * 说"一处改动"是就块**集合**而言:插入让其后所有块的偏移平移,但内容不变,而 CDC 的差集按
 * 哈希集合匹配(见 peer.requestMissingChunks),不按偏移 —— 偏移平移正是 CDC 相对定长块
 * 买到的东西。
 * 唯一超出保证的是那 32 字节扰动区本身:里面若恰好该有一个边界,改动会让它落在别的位置,
 * 于是要多费一块。实测 8MiB 文件、7 个改动点(含扰动区跨读取窗口边界的)1 字节改写与
 * 7 字节插入都是 1/11 块作废,但那是这批内容的结果、不是上界,所以测试按 ≤2 放宽
 * (test/blockstore.test.ts「CDC 重同步局部性」)。
 *
 * 规则:距上一边界不足 CDC_MIN_CHUNK 不判边界;此后逐字节滚动指纹,低 20 位全 0
 * 即收块(期望平均 ≈ 1MB),达 CDC_MAX_CHUNK 强制收块;EOF 就是边界(末块可短)。
 */
export function chunkContent(data: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  if (data.length === 0) return chunks;
  const buz = new RollingFingerprint();
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    const fp = buz.step(data[i]!);
    const len = i + 1 - start;
    if (
      (len >= CDC_MIN_CHUNK && (fp & CDC_MASK) === 0) ||
      len >= CDC_MAX_CHUNK ||
      i + 1 === data.length
    ) {
      chunks.push(data.subarray(start, i + 1));
      start = i + 1;
    }
  }
  return chunks;
}

/** 切块并哈希(索引构造侧统一入口:cdh = chunkHashes(data).hashes)。 */
export function chunkHashes(data: Buffer): { hashes: string[]; lengths: number[] } {
  const chunks = chunkContent(data);
  return {
    hashes: chunks.map(hashBlock),
    lengths: chunks.map((c) => c.length),
  };
}

// ---------------------------------------------------------------------------
// 发送侧的流式视图扫描
//
// 索引构造原先一律「readFileSync 整读 → 内存里分块/切 CDC」。接收侧在阶段 1a 已经
// 改成逐块写盘,发送侧却还留着整读:峰值至少是**一整个文件大小**(与接收侧同量级),
// 而且 readFileSync 有 ~2GiB 硬上限 —— 实测 2.15GiB 文件直接 ERR_FS_FILE_TOO_LARGE,
// 那样的文件根本进不了索引,也就永远同步不出去。
//
// 两个视图都能流式算,且必须与内存实现**逐字节等价**(写进索引的哈希只要错一个,
// 接收端每块校验都失败、文件永远落不了地,是数据完整性事故而不是性能退化):
//  - 定长块:窗口尺寸取 BLOCK_SIZE,一个窗口就是一块,哈希彼此独立,无需跨窗口状态;
//  - CDC:边界由滚动指纹决定,而指纹是**逐字节的纯折叠**(只由字节序列决定,与读取方式
//    无关),做成跨窗口的持久状态就能复现同一串边界。折叠式与它的状态都收在
//    RollingFingerprint 里,内存实现与这里用的是同一个类(只此一份,不给两边写歪的机会);
//    它带 32 字节窗口移出项,所以跨窗口时"最近 32 字节的进场记录"必须跟着过来,否则
//    移出项会读到脏槽位。块哈希用一个持续的 createHash 按片段喂(SHA-256 本身就是流式
//    折叠,分段 update 与整体 update 同值),边界落在窗口中间也只是换个片段。
// EOF 那一边界不在字节循环里判,而是「读完后若还有未收的块就收尾」—— 与内存实现
// 里 `i + 1 === data.length` 强制收块等价,这样文件长度恰为窗口整数倍时也不会漏末块。
// ---------------------------------------------------------------------------

/** 流式扫描的窗口尺寸:与定长块同尺寸,好让定长视图按窗口天然对齐。 */
const SCAN_WINDOW = BLOCK_SIZE;

export interface FileViews {
  /** 文件字节数(读到的总长,与 readFileSync 后的 data.length 同口径)。 */
  size: number;
  /** 定长块哈希(旧对端只认这个)。 */
  blocks: string[];
  /** CDC 块哈希;空文件为 []。 */
  cdh: string[];
  /** CDC 块长,与 cdh 一一对应。 */
  clens: number[];
}

/**
 * 一次流式读取同时算出索引要的 size / 定长块视图 / CDC 视图,峰值内存 ≈ 一个窗口
 * 加两条哈希列表,**与文件大小无关**。语义与
 * `{ blocks: splitIntoBlocks(d).map(hashBlock), ...chunkHashes(d), size: d.length }`
 * 完全一致(等价性由 test/blockstore.test.ts 逐字节比对钉住)。
 *
 * 打开失败/读失败直接抛(调用方 executor.applySend 本来就要求文件可读,scanner
 * 那边则按「变化处理」兜底)。
 *
 * 文件在扫描中途被人改短/改长:拿到的是**撕裂但自洽**的视图 —— size 就是实际读到的
 * 字节数,clens 之和等于 size、blocks 条数与之吻合(读不满的末窗按实际字节收,不存在
 * 「按旧长度补出一个幻影末块」那种形态)。旧的整读实现同样可能撕裂,且改内容会动 mtime
 * → 下一轮扫描重索引自愈;executor 自己落盘走 tmp+rename,不存在原地变短。
 */
export function hashFileViews(absPath: string): FileViews {
  const fd = openSync(absPath, 'r');
  try {
    const blocks: string[] = [];
    const cdh: string[] = [];
    const clens: number[] = [];
    const window = Buffer.allocUnsafe(SCAN_WINDOW);
    let size = 0; // 本窗口首字节的全局偏移,循环结束后即文件总长
    const buz = new RollingFingerprint(); // CDC 指纹:跨窗口连续(移出项要读前 32 字节的记录)
    let chunkStart = 0; // 当前 CDC 块的全局起点
    let chunkHash = createHash('sha256');
    for (;;) {
      // 填满一个窗口:短读继续读,只有 EOF 会带着 filled < SCAN_WINDOW 出来
      let filled = 0;
      let eof = false;
      while (filled < SCAN_WINDOW) {
        const n = readSync(fd, window, filled, SCAN_WINDOW - filled, size + filled);
        if (n <= 0) {
          eof = true;
          break;
        }
        filled += n;
      }
      if (filled === 0) break; // 文件刚好读完(长度为窗口整数倍时靠这次退出)

      blocks.push(hashBlock(window.subarray(0, filled)));

      let segStart = 0; // 本窗口内尚未喂进 chunkHash 的片段起点
      for (let j = 0; j < filled; j++) {
        const fp = buz.step(window[j]!);
        const len = size + j + 1 - chunkStart;
        if ((len >= CDC_MIN_CHUNK && (fp & CDC_MASK) === 0) || len >= CDC_MAX_CHUNK) {
          chunkHash.update(window.subarray(segStart, j + 1));
          cdh.push(chunkHash.digest('hex'));
          clens.push(len);
          chunkStart = size + j + 1;
          chunkHash = createHash('sha256');
          segStart = j + 1;
        }
      }
      chunkHash.update(window.subarray(segStart, filled));

      size += filled;
      if (eof) break;
    }
    if (chunkStart < size) {
      // EOF 就是边界:末块可短(CDC_MIN_CHUNK 之下也照收,与 chunkContent 一致)
      cdh.push(chunkHash.digest('hex'));
      clens.push(size - chunkStart);
    }
    return { size, blocks, cdh, clens };
  } finally {
    closeSync(fd);
  }
}

/**
 * 流式比对盘上内容与索引里的定长块哈希:逐块读、逐块比,**首处不符立刻返回**
 * (扫描每轮都要对每个已索引文件问一次「内容变了没」,既不该整读、也不该把后面的
 * 块读完)。语义与 scanner.contentChanged 的「整读后按块比」一致:长度或任一块
 * 哈希对不上即 false;文件读不到由调用方 try/catch 处理。
 */
export function blocksMatchOnDisk(absPath: string, expected: readonly string[]): boolean {
  const fd = openSync(absPath, 'r');
  try {
    const window = Buffer.allocUnsafe(BLOCK_SIZE);
    let count = 0;
    for (;;) {
      let filled = 0;
      let eof = false;
      while (filled < BLOCK_SIZE) {
        const n = readSync(fd, window, filled, BLOCK_SIZE - filled, count * BLOCK_SIZE + filled);
        if (n <= 0) {
          eof = true;
          break;
        }
        filled += n;
      }
      if (filled === 0) break; // 盘上比索引短:交给下面的长度判断
      if (count >= expected.length) return false; // 盘上比索引长
      if (hashBlock(window.subarray(0, filled)) !== expected[count]) return false;
      count++;
      if (eof) break;
    }
    return count === expected.length;
  } finally {
    closeSync(fd);
  }
}

/**
 * 从磁盘按 (offset, length) 读一个 CDC 块,不整读文件(动机同 readBlockAt:
 * 供块是数据面最热路径,预填同理)。读不满 length 说明文件被截短,抛错由
 * 调用方按「本地供不出这块」处理(回退网络请求 / 忽略请求)。
 */
export function readChunkAt(absPath: string, offset: number, length: number): Buffer {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0) {
    throw new Error(`bad chunk range ${offset}+${length} for ${absPath}`);
  }
  const fd = openSync(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
      const n = readSync(fd, buf, done, length - done, offset + done);
      if (n <= 0) {
        throw new Error(`chunk truncated at ${offset}+${length} for ${absPath}`);
      }
      done += n;
    }
    return buf;
  } finally {
    closeSync(fd);
  }
}
