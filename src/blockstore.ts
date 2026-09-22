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
