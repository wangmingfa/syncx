import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BLOCK_SIZE,
  CDC_MAX_CHUNK,
  CDC_MIN_CHUNK,
  splitIntoBlocks,
  hashBlock,
  verifyBlock,
  readBlockAt,
  chunkContent,
  chunkHashes,
  readChunkAt,
} from '../src/blockstore.js';

/** 确定性伪随机数据(mulberry32):同 size 永远生成同样字节,插入测试可复现。 */
function pseudoRandom(size: number, seed = 0x12345678): Buffer {
  const buf = Buffer.allocUnsafe(size);
  let a = seed >>> 0;
  for (let i = 0; i < size; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    buf[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return buf;
}

describe('blockstore', () => {
  it('splits a small buffer into a single block', () => {
    const data = Buffer.from('hello syncx');
    const blocks = splitIntoBlocks(data);
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toEqual(data);
  });

  it('splits a buffer larger than one block', () => {
    const data = Buffer.alloc(BLOCK_SIZE + 10, 0xab);
    const blocks = splitIntoBlocks(data);
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.length).toBe(BLOCK_SIZE);
    expect(blocks[1]!.length).toBe(10);
    expect(Buffer.concat(blocks).equals(data)).toBe(true);
  });

  it('hashes a block with sha-256', () => {
    const hash = hashBlock(Buffer.from('hello'));
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('verifies a block against its hash', () => {
    const block = Buffer.from('hello');
    expect(verifyBlock(block, hashBlock(block))).toBe(true);
  });

  it('rejects a block whose content does not match the hash', () => {
    const block = Buffer.from('hello');
    const otherHash = hashBlock(Buffer.from('hellx'));
    expect(verifyBlock(block, otherHash)).toBe(false);
  });

  describe('readBlockAt(按偏移读单块)', () => {
    it('reads only the requested block without loading the whole file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'syncx-blockstore-'));
      try {
        // 2 块整 + 末块短:首尾与中间各不相同,能暴露「读错偏移 / 读到相邻块」的问题
        const head = Buffer.alloc(BLOCK_SIZE, 0x11);
        const mid = Buffer.alloc(BLOCK_SIZE, 0x22);
        const tail = Buffer.from('tail-bytes');
        const file = join(dir, 'big.bin');
        writeFileSync(file, Buffer.concat([head, mid, tail]));

        expect(readBlockAt(file, 0).equals(head)).toBe(true);
        expect(readBlockAt(file, 1).equals(mid)).toBe(true);
        expect(readBlockAt(file, 2).equals(tail)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws for an index beyond the file size (含文件被截短)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'syncx-blockstore-'));
      try {
        const file = join(dir, 'small.bin');
        writeFileSync(file, Buffer.from('tiny'));
        expect(() => readBlockAt(file, 0)).not.toThrow();
        expect(() => readBlockAt(file, 1)).toThrow(/out of range/);
        expect(() => readBlockAt(file, 99)).toThrow(/out of range/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reads exactly what splitIntoBlocks would slice, block by block', () => {
      const dir = mkdtempSync(join(tmpdir(), 'syncx-blockstore-'));
      try {
        const data = Buffer.alloc(BLOCK_SIZE * 2 + 1234, 0x5a);
        const file = join(dir, 'parity.bin');
        writeFileSync(file, data);
        splitIntoBlocks(data).forEach((expected, i) => {
          expect(readBlockAt(file, i).equals(expected)).toBe(true);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('chunkContent(CDC 内容定义分块)', () => {
    it('空缓冲切出空列表;小于下限的文件切出一整块', () => {
      expect(chunkContent(Buffer.alloc(0))).toEqual([]);
      const small = pseudoRandom(CDC_MIN_CHUNK - 1);
      const chunks = chunkContent(small);
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.length).toBe(small.length);
    });

    it('块边界只由内容决定:同一内容两次切分逐块相同(确定性)', () => {
      const data = pseudoRandom(6 * 1024 * 1024 + 777);
      const a = chunkContent(data).map(hashBlock);
      const b = chunkContent(Buffer.from(data)).map(hashBlock); // 拷贝一份再切:排除对同一 Buffer 的隐性依赖
      expect(b).toEqual(a);
    });

    it('拼接即原文,且块长落在 [下限, 上限] 内(末块除外)', () => {
      const data = pseudoRandom(9 * 1024 * 1024);
      const chunks = chunkContent(data);
      expect(Buffer.concat(chunks).equals(data)).toBe(true);
      expect(chunks.length).toBeGreaterThan(1);
      chunks.slice(0, -1).forEach((c) => {
        expect(c.length).toBeGreaterThanOrEqual(CDC_MIN_CHUNK);
        expect(c.length).toBeLessThanOrEqual(CDC_MAX_CHUNK);
      });
      // 平均块长量级 ~1MB(允许宽松区间,防掩码/下限改错)
      const avg = data.length / chunks.length;
      expect(avg).toBeGreaterThan(512 * 1024);
      expect(avg).toBeLessThan(3 * 1024 * 1024);
    });

    it('中部插入只让插入点附近的块变化,其余块哈希不变(CDC 的核心收益)', () => {
      const data = pseudoRandom(8 * 1024 * 1024);
      const before = chunkContent(data).map(hashBlock);
      expect(before.length).toBeGreaterThanOrEqual(5);
      // 在文件中部插入 10KB:定长分块会让其后所有块错位,CDC 只影响插入点附近
      const inserted = Buffer.alloc(10 * 1024, 0x77);
      const after = Buffer.concat([
        data.subarray(0, 4 * 1024 * 1024),
        inserted,
        data.subarray(4 * 1024 * 1024),
      ]);
      const afterHashes = chunkContent(after).map(hashBlock);
      const beforeSet = new Set(before);
      const changed = afterHashes.filter((h) => !beforeSet.has(h)).length;
      // Gear 在下一次边界命中处重同步:预期只有覆盖插入点的 1~2 块变新哈希
      expect(changed).toBeLessThanOrEqual(2);
      expect(afterHashes.length).toBeGreaterThanOrEqual(before.length - 1);
      // 对照组:同样的插入下定长块几乎全变(证明收益确实来自 CDC)
      const fixedBefore = splitIntoBlocks(data).map(hashBlock);
      const fixedAfter = splitIntoBlocks(after).map(hashBlock);
      const fixedChanged = fixedAfter.filter((h, i) => h !== fixedBefore[i]).length;
      expect(fixedChanged).toBeGreaterThanOrEqual(fixedBefore.length - 5);
    });

    it('尾部追加只影响末块(与定长块同形,不回退既有行为)', () => {
      const data = pseudoRandom(3 * 1024 * 1024);
      const before = chunkContent(data).map(hashBlock);
      const appended = Buffer.concat([data, pseudoRandom(1024, 0xabcdef)]);
      const after = chunkContent(appended).map(hashBlock);
      // 前缀块哈希逐一对应相等,仅末尾多出/替换了块
      const common = Math.min(before.length, after.length) - 1;
      expect(after.slice(0, common)).toEqual(before.slice(0, common));
    });

    it('chunkHashes 给出哈希与块长,前缀和即偏移(索引/供块两侧共用口径)', () => {
      const data = pseudoRandom(3 * 1024 * 1024 + 42);
      const { hashes, lengths } = chunkHashes(data);
      const chunks = chunkContent(data);
      expect(lengths).toEqual(chunks.map((c) => c.length));
      expect(hashes).toEqual(chunks.map(hashBlock));
      expect(lengths.reduce((s, l) => s + l, 0)).toBe(data.length);
    });
  });

  describe('readChunkAt(按偏移读单块)', () => {
    it('读出与 chunkContent 切片逐块一致的内容', () => {
      const dir = mkdtempSync(join(tmpdir(), 'syncx-blockstore-'));
      try {
        const data = pseudoRandom(2 * 1024 * 1024 + 1234);
        const file = join(dir, 'chunks.bin');
        writeFileSync(file, data);
        let offset = 0;
        for (const c of chunkContent(data)) {
          expect(readChunkAt(file, offset, c.length).equals(c)).toBe(true);
          offset += c.length;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('文件被截短、读不满时抛错(调用方回退网络请求)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'syncx-blockstore-'));
      try {
        const file = join(dir, 'short.bin');
        writeFileSync(file, Buffer.alloc(100, 0x33));
        expect(() => readChunkAt(file, 50, 100)).toThrow(/truncated/);
        expect(() => readChunkAt(file, 200, 10)).toThrow(/truncated/);
        expect(() => readChunkAt(file, -1, 10)).toThrow(/bad chunk range/);
        expect(() => readChunkAt(file, 0, 0)).toThrow(/bad chunk range/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
