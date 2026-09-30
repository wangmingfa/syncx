import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * 发送侧内存守卫:同步路径**不得**把整个文件一次性读进内存。
 *
 * 三处曾经整读(`readFileSync`),都是「文件大小 × 1」的峰值,而且受 readFileSync
 * 的 ~2GiB 硬上限约束(越过就 ERR_FS_FILE_TOO_LARGE,文件永远同步不出去):
 *  - executor.applySend —— 本机改动的文件入索引(定长视图 + CDC 视图);
 *  - scanner.contentChanged —— 每轮扫描对每个已索引文件问一次「内容变了没」;
 *  - e2e.toBlindEntries —— 每次挂接/重连给盲区端重算密文视图。
 * 接收侧的阶段 1a 已经证明这一类问题的量法:同步执行的代码采样不到 RSS 峰值,
 * 所以钉住**分配方式**本身 —— 整读只有一个入口,就是 fs.readFileSync。
 *
 * 量法:包住 node:fs 的 readFileSync,只在测量窗口内记录它返回的 Buffer 长度。
 * 改前:峰值 = 文件大小;改后:峰值 ≈ 0(发送路径一次整读都不做)。
 */
const watch = vi.hoisted(() => ({ recording: false, peak: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const real = actual.readFileSync;
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof real>) => {
      const out = (real as (...rest: unknown[]) => unknown)(...args);
      if (watch.recording && Buffer.isBuffer(out) && out.byteLength > watch.peak) {
        watch.peak = out.byteLength;
      }
      return out;
    }) as typeof real,
  };
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOCK_SIZE, CDC_MAX_CHUNK, hashBlock, hashFileViews, splitIntoBlocks } from '../src/blockstore.js';
import { createLocalExecutor } from '../src/executor.js';
import { openIndexStore } from '../src/indexstore.js';
import { scanFolder } from '../src/scanner.js';
import { deriveE2EKey, e2eKeyBuffer, toBlindEntries } from '../src/e2e.js';
import type { IndexEntry } from '../src/index.js';

const FILE_BYTES = 24 * BLOCK_SIZE; // 24MB:够大让「整读」与「逐块」在数值上无可混淆
const WHOLE_READ_LIMIT = 4 * BLOCK_SIZE; // 给 4MB 余量;任何 O(文件大小) 的整读都会越过

/** 确定性伪随机数据:两侧算出的哈希可比,且 CDC 会切出真实长度的块。 */
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

async function peakDuring(fn: () => void | Promise<void>): Promise<number> {
  watch.peak = 0;
  watch.recording = true;
  try {
    await fn();
  } finally {
    watch.recording = false;
  }
  return watch.peak;
}

const dirs: string[] = [];
function setup(): { dir: string; root: string; index: ReturnType<typeof openIndexStore> } {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-sendmem-'));
  dirs.push(dir);
  const root = join(dir, 'share');
  mkdirSync(root, { recursive: true });
  return { dir, root, index: openIndexStore(join(dir, 'index.db')) };
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const data = pseudoRandom(FILE_BYTES);
const plainEntry = (path: string, over: Partial<IndexEntry> = {}): IndexEntry => ({
  path,
  version: new Map([['DEV-A', 1]]),
  size: FILE_BYTES,
  deleted: false,
  blocks: splitIntoBlocks(data).map(hashBlock),
  ...over,
});

describe('发送侧内存守卫(不得整文件读入)', () => {
  it('applySend 逐块算视图:没有 O(文件大小) 的整读,入索引的哈希与内存实现一致', async () => {
    const { root, index } = setup();
    writeFileSync(join(root, 'big.bin'), data);
    const executor = createLocalExecutor(root, index, join(root, '.syncx-trash'));

    const peak = await peakDuring(async () => {
      await executor.applySend('big.bin', 'DEV-A');
    });
    const written = index.getEntry('big.bin')!;

    // 正确性先断言:流式算出来的定长视图 + CDC 视图,与整读实现逐字节相同
    const expected = hashFileViews(join(root, 'big.bin'));
    expect(written.size).toBe(FILE_BYTES);
    expect(written.blocks).toEqual(expected.blocks);
    expect(written.cdh).toEqual(expected.cdh);
    expect(written.clens).toEqual(expected.clens);
    // 内容够长,CDC 里应有被强制收块的满块(否则这条用例覆盖不到那条分支)
    expect(expected.cdh.length).toBeGreaterThan(1);
    expect(expected.clens.some((l) => l >= CDC_MAX_CHUNK)).toBe(true);

    expect(peak).toBeLessThan(WHOLE_READ_LIMIT);
    index.close();
  }, 120_000);

  it('scanFolder 的内容比对逐块短路:没有整读,且判不出假变化', async () => {
    const { root, index } = setup();
    writeFileSync(join(root, 'big.bin'), data);
    // mtime 差得远 → 免哈希快速路径不成立 → 必须走哈希比对;但内容其实没变
    index.saveEntry(plainEntry('big.bin', { mtime: 1 }));

    let changed: string[] = [];
    const peak = await peakDuring(() => {
      changed = scanFolder(root, index, [], 'DEV-A').changed;
    });

    expect(changed).toEqual([]); // 内容确实没变:不该被报成改动
    expect(peak).toBeLessThan(WHOLE_READ_LIMIT);
    index.close();
  }, 120_000);

  it('toBlindEntries 逐块加密宣告:没有整读,尺寸与块数口径不变', async () => {
    const { root, index } = setup();
    writeFileSync(join(root, 'big.bin'), data);
    index.saveEntry(plainEntry('big.bin'));
    const key = e2eKeyBuffer(deriveE2EKey('正确的马儿跳'))!;
    const blockCount = splitIntoBlocks(data).length;

    let blind: IndexEntry[] = [];
    const peak = await peakDuring(() => {
      blind = toBlindEntries([index.getEntry('big.bin')!], key, root);
    });

    expect(blind).toHaveLength(1);
    expect(blind[0]!.blocks).toHaveLength(blockCount);
    // 密文尺寸 = 明文 + 每块一个 16B tag(与改造前同口径)
    expect(blind[0]!.size).toBe(FILE_BYTES + blockCount * 16);
    expect(peak).toBeLessThan(WHOLE_READ_LIMIT);
    index.close();
  }, 120_000);
});
