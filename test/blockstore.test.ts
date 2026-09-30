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
  hashFileViews,
  blocksMatchOnDisk,
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

/**
 * 发送侧流式扫描必须与内存实现**逐字节等价**。
 *
 * 这不是性能测试:算出的哈希直接写进索引,错一个字节就意味着接收端逐块校验全红、
 * 文件永远落不了地 —— 是数据完整性事故,不是慢一点。所以尺寸要专门挑:空文件、
 * 窗口边界前后(让 CDC 边界既可能落在窗口中间、也可能恰好压在窗口尾)、
 * CDC_MIN_CHUNK 前后、EOF 末块,以及被 CDC_MAX_CHUNK 强制收块的那条分支。
 */
describe('流式视图扫描 hashFileViews', () => {
  /** 内存参照实现(executor/scanner 改造前用的就是这一套)。 */
  function inMemory(data: Buffer): { size: number; blocks: string[]; cdh: string[]; clens: number[] } {
    const { hashes, lengths } = chunkHashes(data);
    return { size: data.length, blocks: splitIntoBlocks(data).map(hashBlock), cdh: hashes, clens: lengths };
  }

  function withTempFile(content: Buffer, fn: (file: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-views-'));
    try {
      const file = join(dir, 'f.bin');
      writeFileSync(file, content);
      fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** 三种内容形态各有侧重:随机(边界不规则)、常量(边界恒在 MIN)、递增字节(与窗口错位)。 */
  function flavors(size: number): Buffer[] {
    return [
      pseudoRandom(size, 0x12345678),
      Buffer.alloc(size, 0x41),
      Buffer.from(Array.from({ length: size }, (_, i) => i & 0xff)),
    ];
  }

  const SIZES = [
    0, 1, 2, 999,
    BLOCK_SIZE - 1, BLOCK_SIZE, BLOCK_SIZE + 1, 2 * BLOCK_SIZE,
    CDC_MIN_CHUNK - 1, CDC_MIN_CHUNK, CDC_MIN_CHUNK + 1,
    3 * BLOCK_SIZE + 7,
  ];

  it.each(SIZES)('与内存实现逐字节一致(size=%i)', (size) => {
    for (const data of flavors(size)) {
      withTempFile(data, (file) => {
        expect(hashFileViews(file)).toEqual(inMemory(data));
      });
    }
  });

  it('被 CDC_MAX_CHUNK 强制收块的路径同样吻合', () => {
    // 常量 0x41 区在 4MB 内一次都不命中掩码(实测),所以必然撑到上限被强制收块;
    // 前面垫 1MB 伪随机造出两个自然边界,好让那条强制边界落在窗口**中间**、
    // 而不是恰好压在 1MB 整数倍上(那正是最容易把「片段起点算错」掩盖掉的巧合)。
    // 末尾再留一块 EOF 收尾块,覆盖「强制边界之后还有内容」这条分支。
    const data = Buffer.concat([
      pseudoRandom(BLOCK_SIZE, 0x12345678),
      Buffer.alloc(5 * BLOCK_SIZE + 7, 0x41),
    ]);
    withTempFile(data, (file) => {
      const views = hashFileViews(file);
      expect(views.clens).toContain(CDC_MAX_CHUNK); // 确认这条用例真的走到了强制分支
      expect(views.clens.reduce((s, l) => s + l, 0)).toBe(data.length);
      expect(views).toEqual(inMemory(data));
    });
  });

  it('中部插入(长度变了、跨窗口边界)同样逐字节吻合', () => {
    const base = pseudoRandom(4 * BLOCK_SIZE, 0xabcdef);
    const at = BLOCK_SIZE + 512; // 插在第 1 个窗口边界附近
    const moved = Buffer.concat([
      base.subarray(0, at),
      Buffer.from([1, 2, 3, 4, 5, 6, 7]),
      base.subarray(at),
    ]);
    withTempFile(base, (fileA) => {
      expect(hashFileViews(fileA)).toEqual(inMemory(base));
    });
    withTempFile(moved, (fileB) => {
      // 注意:这里只断言「流式 == 内存」。CDC 改动后能复用多少块是 chunkContent
      // 自己的性质(当前实现:除纯追加外全块作废),与流式扫描无关,不在本条闸门里。
      expect(hashFileViews(fileB)).toEqual(inMemory(moved));
    });
  });
});

describe('流式内容比对 blocksMatchOnDisk', () => {
  function withTempFile(content: Buffer, fn: (file: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-match-'));
    try {
      const file = join(dir, 'f.bin');
      writeFileSync(file, content);
      fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const blockHashes = (data: Buffer): string[] => splitIntoBlocks(data).map(hashBlock);

  it('内容一致为真;中间改一个字节为假', () => {
    const data = pseudoRandom(2 * BLOCK_SIZE + 4096, 0x42);
    withTempFile(data, (file) => {
      expect(blocksMatchOnDisk(file, blockHashes(data))).toBe(true);
      const touched = Buffer.from(data);
      touched[BLOCK_SIZE + 10] = (touched[BLOCK_SIZE + 10]! + 1) & 0xff; // 长度不变,只有块哈希能发现
      expect(touched.length).toBe(data.length);
      expect(blocksMatchOnDisk(file, blockHashes(touched))).toBe(false);
    });
  });

  it('盘上变长(多出整块)或变短都为假', () => {
    const data = pseudoRandom(2 * BLOCK_SIZE, 0x43);
    const shorter = data.subarray(0, BLOCK_SIZE + 10);
    const longer = Buffer.concat([data, Buffer.alloc(BLOCK_SIZE, 0x5a)]);
    withTempFile(shorter, (file) => {
      expect(blocksMatchOnDisk(file, blockHashes(data))).toBe(false); // 盘上比索引短
    });
    withTempFile(longer, (file) => {
      expect(blocksMatchOnDisk(file, blockHashes(data))).toBe(false); // 盘上比索引长
    });
  });

  it('空文件与空块列表吻合;非空列表对空文件为假', () => {
    withTempFile(Buffer.alloc(0), (file) => {
      expect(blocksMatchOnDisk(file, [])).toBe(true);
      expect(blocksMatchOnDisk(file, [hashBlock(Buffer.alloc(BLOCK_SIZE, 1))])).toBe(false);
    });
  });

  it('文件读不到时抛错(scanner 侧按「已变化」兜底)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-match-'));
    try {
      expect(() => blocksMatchOnDisk(join(dir, 'missing.bin'), ['x'])).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * CDC 的省流量承诺最终落在一条算术性质上:滚动指纹必须带**窗口移出项**,一个字节的
 * 贡献才只在随后 32 字节内有效,越过即归零,扰动之后的边界与原文逐位吻合(重同步)。
 * 只有累入项时,循环移位 32 次回到原值 → 扰动永不衰减,「重同步」退化成「转到某一步
 * 低 20 位恰好为 0」,取决于改动长度而非内容局部性;1 字节改写会让其后所有块作废,
 * 全文件重传 —— CDC 的收益归零,而且没人会察觉,因为数据始终是对的。
 *
 * 所以本组断言的是**行为**(改动能复用多少块),不是「流式 == 内存」:等价性只保证两处
 * 实现一致,两者一起错它照样绿。流式那条刻意把改动点压在读取窗口边界上,32 字节 carry
 * 跨窗口写错只会在「块集合与内存实现不一致」时露出来。
 */
describe('CDC 重同步局部性(指纹的窗口移出项)', () => {
  const FILE_SIZE = 8 * 1024 * 1024;

  /** 改动点:文件头/尾、CDC_MIN_CHUNK 刚过、窗口边界前后(含扰动区横跨边界的位置)。 */
  const OFFSETS = [
    4096,
    CDC_MIN_CHUNK + 1,
    BLOCK_SIZE - 3, // 32 字节扰动区正好跨过第 1、2 个读取窗口
    BLOCK_SIZE + 20,
    2 * BLOCK_SIZE - 16,
    4 * 1024 * 1024,
    FILE_SIZE - 8192,
  ];

  /** after 里有多少块的内容在 before 中不存在(= 必须重新过网的量)。 */
  function changedChunks(before: string[], after: string[]): number {
    const seen = new Set(before);
    return after.filter((h) => !seen.has(h)).length;
  }

  function withTempFiles(contents: Buffer[], fn: (files: string[]) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-resync-'));
    try {
      fn(contents.map((c, i) => {
        const file = join(dir, `f${i}.bin`);
        writeFileSync(file, c);
        return file;
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const base = () => pseudoRandom(FILE_SIZE, 0x2468ace1);

  it.each(OFFSETS)('1 字节就地改写(偏移 %i)只废改动所在的那一块', (at) => {
    const data = base();
    const touched = Buffer.from(data);
    touched[at] = (touched[at]! + 1) & 0xff;
    const before = chunkContent(data).map(hashBlock);
    expect(before.length).toBeGreaterThanOrEqual(5); // 这尺寸确实切出了多块,断言不是空转
    expect(changedChunks(before, chunkContent(touched).map(hashBlock))).toBeLessThanOrEqual(2);
  });

  it.each(OFFSETS)('中部插入 7 字节(偏移 %i)只废改动附近的块', (at) => {
    const data = base();
    const touched = Buffer.concat([data.subarray(0, at), Buffer.from([9, 8, 7, 6, 5, 4, 3]), data.subarray(at)]);
    const before = chunkContent(data).map(hashBlock);
    expect(before.length).toBeGreaterThanOrEqual(5);
    expect(changedChunks(before, chunkContent(touched).map(hashBlock))).toBeLessThanOrEqual(2);
  });

  it.each(OFFSETS)('流式扫描在小改动下复用同样的块(偏移 %i)', (at) => {
    const data = base();
    const touched = Buffer.from(data);
    touched[at] = (touched[at]! + 1) & 0xff;
    withTempFiles([data, touched], ([fileA, fileB]) => {
      const before = hashFileViews(fileA!);
      const after = hashFileViews(fileB!);
      // 与内存实现给出同样的块集合:一次改写只该改一处内容,两侧必须同判
      expect(after.cdh.map((h, i) => [h, after.clens[i]]).sort()).toEqual(
        chunkContent(touched).map((c) => [hashBlock(c), c.length]).sort(),
      );
      expect(changedChunks(before.cdh, after.cdh)).toBeLessThanOrEqual(2);
    });
  });
});
