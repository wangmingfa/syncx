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
 */
export function readBlockAt(absPath: string, blockIndex: number): Buffer {
  const fd = openSync(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(BLOCK_SIZE);
    const bytes = readSync(fd, buf, 0, BLOCK_SIZE, blockIndex * BLOCK_SIZE);
    if (bytes <= 0) {
      throw new Error(`block ${blockIndex} out of range for ${absPath}`);
    }
    return bytes === BLOCK_SIZE ? buf : buf.subarray(0, bytes);
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
//  - **种子永久冻结**: Gear 表一旦换,所有历史 cdh 作废(表现为全量重传,不损坏
//    数据,但改种子必须当成协议变更对待)。
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

/**
 * 按内容定义的边界切块,语义与 splitIntoBlocks 对齐(返回子数组视图、拼接即原文)。
 *
 * 指纹用 **Buzhash(32 位循环窗口)**而非朴素累加:每个字节的贡献只在随后 32 个
 * 字节内有效(循环移位自然淘汰旧值),所以「中部插入一点内容」的扰动在越过插入点
 * 约 32 字节后完全消失 —— 之后的边界与原始文件逐位吻合(**重同步**)。朴素累加式
 * Gear 的指纹依赖整段前缀,插入会让其后所有边界永久错位,块哈希全换,CDC 的
 * 收益归零,这里刻意避开。边界判定同样不做块级重置,同理依赖其局部性。
 *
 * 规则:距上一边界不足 CDC_MIN_CHUNK 不判边界;此后逐字节滚动指纹,低 20 位全 0
 * 即收块(期望平均 ≈ 1MB),达 CDC_MAX_CHUNK 强制收块;EOF 就是边界(末块可短)。
 */
export function chunkContent(data: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  if (data.length === 0) return chunks;
  let fp = 0;
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    fp = ((((fp << 1) | (fp >>> 31)) >>> 0) ^ GEAR_TABLE[data[i]!]!) >>> 0;
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
