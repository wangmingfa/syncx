import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDir, fillHandle } from './helpers.js';
import { createLocalExecutor, type LocalExecutor, type ReceiveHandle } from '../src/executor.js';
import { openIndexStore, type IndexStore } from '../src/indexstore.js';
import { BLOCK_SIZE, hashBlock, splitIntoBlocks, chunkHashes, blocksMatchOnDisk } from '../src/blockstore.js';
import { SlotBitmap, entryFingerprint, readManifest, partialPaths } from '../src/partial-store.js';
import type { IndexEntry } from '../src/index.js';

/**
 * 断点续传阶段 2 的行为面:在途内容躺在磁盘上,所以「重启 daemon」在测试里就是再建
 * 一个执行器 —— 每个续传用例都真的换一个新的 createLocalExecutor,不靠内部状态互相提醒。
 */

interface Env {
  root: string;
  index: IndexStore;
  /** 新建一个执行器(等价于 daemon 重启后重新装配目录)。 */
  mk(): LocalExecutor;
  scratch(path: string): { tmp: string; manifest: string };
  close(): void;
}

let seq = 0;

function setup(): Env {
  const dir = mkdtempSync(join(tmpdir(), `syncx-resume-${seq++}-`));
  const root = join(dir, 'share');
  mkdirSync(root, { recursive: true });
  const index = openIndexStore(join(dir, 'index.db'));
  const trash = join(dir, 'trash');
  return {
    root,
    index,
    mk: () => createLocalExecutor(root, index, trash),
    scratch: (path) => partialPaths(join(root, path)),
    close: () => {
      index.close();
      rmDir(dir);
    },
  };
}

/** 每块内容都不同:偏移写错的话哈希立刻对不上,不会「看起来对、数据全错」。 */
function contentOf(blocks: number): Buffer {
  const data = Buffer.alloc(blocks * BLOCK_SIZE);
  for (let b = 0; b < blocks; b++) {
    data.fill(String.fromCharCode(65 + (b % 26)), b * BLOCK_SIZE, (b + 1) * BLOCK_SIZE);
    data[b * BLOCK_SIZE + 7] = (b + 1) & 0xff;
  }
  return data;
}

function entryFor(path: string, data: Buffer, over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path,
    version: new Map([['DEV-B', 1]]),
    size: data.length,
    deleted: false,
    blocks: splitIntoBlocks(data).map(hashBlock),
    ...over,
  };
}

/**
 * 落地内容正确 = 文件长度收口 + 定长块视图逐块吻合。
 *
 * 不用 `toEqual(buffer)`:expect 的 deep-equal 在 3MB 上是**秒级**的(这组用例原本 16s,
 * 一半时间花在那次字节比较上),而 blocksMatchOnDisk 是流式的、首块不符即返回,
 * 断言的还正好是「落地的就是条目声明的那份内容」这个本命题。
 */
function expectLanded(env: Env, path: string, entry: IndexEntry): void {
  const abs = join(env.root, path);
  expect(statSync(abs).size).toBe(entry.size);
  expect(blocksMatchOnDisk(abs, entry.blocks)).toBe(true);
}

function appendSlots(handle: ReceiveHandle, blocks: readonly Buffer[], upto: number): void {
  for (let i = 0; i < upto; i++) handle.append(i, blocks[i]!);
}

describe('接收句柄续传', () => {
  it('resumes only the missing slots after the executor is replaced, and lands the right bytes', async () => {
    const env = setup();
    const data = contentOf(3);
    const blocks = splitIntoBlocks(data);
    const entry = entryFor('big.bin', data);
    const { tmp, manifest } = env.scratch('big.bin');

    // 第一轮:0 与 2 收到(乱序到达),1 未到 —— 断线,进度留在盘上
    const h1 = env.mk().beginReceive(entry, { cdc: false });
    h1.append(0, blocks[0]!);
    h1.append(2, blocks[2]!);
    h1.abort(true);
    expect(existsSync(tmp)).toBe(true);
    expect(existsSync(manifest)).toBe(true);

    // 第二轮:全新执行器(等价于 daemon 重启),同一份内容
    const second = env.mk();
    const h2 = second.beginReceive(entry, { cdc: false });
    expect([h2.has(0), h2.has(1), h2.has(2)]).toEqual([true, false, true]);
    expect(h2.count()).toBe(2);
    // 进度按已收字节起算,不是从 0 重来(传输进度条读的就是这个数)
    expect(h2.bytes()).toBe(blocks[0]!.length + blocks[2]!.length);

    h2.append(1, blocks[1]!);
    await second.finalizeReceive(entry, h2);

    expectLanded(env, 'big.bin', entry);
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(manifest)).toBe(false);
    expect(env.index.getEntry('big.bin')).toMatchObject({ path: 'big.bin', size: data.length });
    env.close();
  });

  it('re-requests a slot whose committed bytes were altered, and keeps the honest ones', async () => {
    const env = setup();
    const data = contentOf(3);
    const blocks = splitIntoBlocks(data);
    const entry = entryFor('big.bin', data);
    const h1 = env.mk().beginReceive(entry, { cdc: false });
    appendSlots(h1, blocks, 2); // 0、1 已落并已 commit
    h1.abort(true);

    // 模拟「崩在写的中间」/ 别的进程动过这一段:位图说 0 是好的,字节却不对
    const { tmp } = env.scratch('big.bin');
    const raw = readFileSync(tmp);
    raw[0] = (raw[0]! ^ 0xff) & 0xff;
    writeFileSync(tmp, raw);

    const h2 = env.mk().beginReceive(entry, { cdc: false });
    // 自检把它退回缺失态;1 没被动过,照样算已收 —— 自检读一遍盘,换来的是不重传好块
    expect(h2.has(0)).toBe(false);
    expect(h2.has(1)).toBe(true);
    expect(h2.count()).toBe(1);
    expect(h2.bytes()).toBe(blocks[1]!.length);

    h2.append(0, blocks[0]!);
    h2.append(2, blocks[2]!);
    await env.mk().finalizeReceive(entry, h2);
    expectLanded(env, 'big.bin', entry);
    env.close();
  });

  it('discards the whole partial when the content changed, even though the path is the same', async () => {
    const env = setup();
    const long = contentOf(3);
    const short = contentOf(2);
    const h1 = env.mk().beginReceive(entryFor('doc.bin', long), { cdc: false });
    appendSlots(h1, splitIntoBlocks(long), 2);
    h1.abort(true);
    expect(existsSync(env.scratch('doc.bin').tmp)).toBe(true);

    // 对端把文件改回短版本(路径不变、内容指纹变了):旧 tmp 一个字节都不能信
    const shortEntry = entryFor('doc.bin', short);
    const second = env.mk();
    const h2 = second.beginReceive(shortEntry, { cdc: false });
    expect(h2.count()).toBe(0);
    appendSlots(h2, splitIntoBlocks(short), 2);
    await second.finalizeReceive(shortEntry, h2);

    // 落地必须是新内容**且长度收口**:旧 tmp 的第三块残留在后面,就是截断没做到
    expectLanded(env, 'doc.bin', shortEntry);
    env.close();
  });

  it('starts clean when the tmp is gone but the manifest survived, and when the manifest is corrupt', async () => {
    const env = setup();
    const data = contentOf(3);
    const blocks = splitIntoBlocks(data);
    const entry = entryFor('big.bin', data);
    const h1 = env.mk().beginReceive(entry, { cdc: false });
    appendSlots(h1, blocks, 2);
    h1.abort(true);
    const { tmp, manifest } = env.scratch('big.bin');

    // 形态一:半对残骸(位图在、tmp 被清掉了) —— 不得凭空认为进度还在
    rmSync(tmp);
    const h2 = env.mk().beginReceive(entry, { cdc: false });
    expect(h2.count()).toBe(0);
    h2.abort(true);

    // 形态二:位图本身坏掉(写坏 / 别的版本改了格式) —— 同样按「无中间态」处理
    writeFileSync(manifest, '{ this is not json');
    const third = env.mk();
    const h3 = third.beginReceive(entry, { cdc: false });
    expect(h3.count()).toBe(0);
    appendSlots(h3, blocks, 3);
    await third.finalizeReceive(entry, h3);
    expectLanded(env, 'big.bin', entry);
    env.close();
  });

  it('commits the manifest only after the bytes it claims are durable', async () => {
    const env = setup();
    const slots = 11; // > PARTIAL_COMMIT_SLOTS(8),才看得出组提交的节奏
    const one = Buffer.alloc(BLOCK_SIZE, 3);
    const entry: IndexEntry = {
      path: 'many.bin',
      version: new Map([['DEV-B', 1]]),
      size: slots * BLOCK_SIZE,
      deleted: false,
      blocks: Array.from({ length: slots }, () => hashBlock(one)),
    };
    const fingerprint = entryFingerprint(entry);
    const { manifest } = env.scratch('many.bin');
    const handle = env.mk().beginReceive(entry, { cdc: false });

    handle.append(0, one);
    // 只写了一块(既不到一组、位图也没满):位图**不能**已经存在 ——
    // 它一旦领先于字节,崩溃后续传就会把那个空洞当成好块跳过
    expect(existsSync(manifest)).toBe(false);

    for (let i = 1; i < 8; i++) handle.append(i, one);
    const committed = readManifest(manifest, { fingerprint, cdc: false, slots });
    expect(committed).not.toBeNull();
    expect(new SlotBitmap(slots, committed!.bitmap).count()).toBe(8);
    // 指纹对不上就当没有:这是「这份位图说的是不是当前内容」的唯一判据
    expect(readManifest(manifest, { fingerprint: 'wrong', cdc: false, slots })).toBeNull();
    expect(existsSync(join(env.root, 'many.bin'))).toBe(false); // 提交中间态绝不碰目标文件

    handle.append(8, one);
    handle.abort(true); // 放弃时把最后一批字节交代干净,否则那段进度是白写的
    const afterAbort = readManifest(manifest, { fingerprint, cdc: false, slots });
    expect(new SlotBitmap(slots, afterAbort!.bitmap).count()).toBe(9);
    env.close();
  });

  it('treats a repeated block response as a no-op (idempotent, never double-counted)', () => {
    const env = setup();
    const data = contentOf(3);
    const blocks = splitIntoBlocks(data);
    const handle = env.mk().beginReceive(entryFor('big.bin', data), { cdc: false });
    handle.append(0, blocks[0]!);
    const before = handle.bytes();
    handle.append(0, blocks[0]!);
    expect(handle.count()).toBe(1);
    expect(handle.bytes()).toBe(before);
    env.close();
  });

  it('keeps the partial when the bitmap is not full, so the next round can pick it up', async () => {
    const env = setup();
    const data = contentOf(3);
    const blocks = splitIntoBlocks(data);
    const entry = entryFor('big.bin', data);
    const handle = env.mk().beginReceive(entry, { cdc: false });
    appendSlots(handle, blocks, 1);
    await expect(handle.finalize()).rejects.toThrow(/incomplete receive/);
    const { tmp, manifest } = env.scratch('big.bin');
    expect(existsSync(tmp)).toBe(true);
    // 没收齐就落地 = 把空洞当成内容:目标文件保持不存在,finalize 自己也不写位图
    expect(existsSync(manifest)).toBe(false);
    expect(existsSync(join(env.root, 'big.bin'))).toBe(false);
    // 真实管线在抛错后统一收口(completeIfReady 的 finally):这一步才把字节交代给位图
    handle.abort(true);
    expect(existsSync(manifest)).toBe(true);
    expect(env.mk().beginReceive(entry, { cdc: false }).count()).toBe(1);
    env.close();
  });

  it('voids the whole pair when a full bitmap does not match the declared content', async () => {
    const env = setup();
    const data = contentOf(3);
    const entry = entryFor('big.bin', data);
    const handle = fillHandle(env.mk(), entry, data); // 位图已满并已 commit
    const { tmp, manifest } = env.scratch('big.bin');
    const raw = readFileSync(tmp);
    raw[2 * BLOCK_SIZE] = (raw[2 * BLOCK_SIZE]! ^ 0xff) & 0xff; // 收齐之后被动过:留着也没用
    writeFileSync(tmp, raw);

    await expect(handle.finalize()).rejects.toThrow(/content mismatch/);
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(manifest)).toBe(false);
    expect(existsSync(join(env.root, 'big.bin'))).toBe(false);
    // 整对作废之后下一轮是从零开始,而不是拿一份被判定不干净的位图续下去
    expect(env.mk().beginReceive(entry, { cdc: false }).count()).toBe(0);
    env.close();
  });

  it('lands an empty file without ever creating a tmp (no slots to receive)', async () => {
    const env = setup();
    const entry = entryFor('empty.txt', Buffer.alloc(0));
    const executor = env.mk();
    const handle = executor.beginReceive(entry, { cdc: false });
    expect(handle.count()).toBe(0);
    expect(existsSync(env.scratch('empty.txt').tmp)).toBe(false); // 中间态按需创建
    await executor.finalizeReceive(entry, handle);
    expect(statSync(join(env.root, 'empty.txt')).size).toBe(0);
    expect(existsSync(env.scratch('empty.txt').tmp)).toBe(false);
    expect(existsSync(env.scratch('empty.txt').manifest)).toBe(false);
    env.close();
  });

  it('resumes under the CDC layout (offsets from clens prefix sums)', async () => {
    const env = setup();
    const data = contentOf(3);
    const { hashes: cdh, lengths: clens } = chunkHashes(data);
    const entry = entryFor('cdc.bin', data, { cdh, clens });
    const chunks: Buffer[] = [];
    for (let off = 0, i = 0; i < clens.length; i++) {
      chunks.push(data.subarray(off, off + clens[i]!));
      off += clens[i]!;
    }
    const executor = env.mk();
    const h1 = executor.beginReceive(entry, { cdc: true });
    appendSlots(h1, chunks, chunks.length - 1);
    h1.abort(true);

    const h2 = env.mk().beginReceive(entry, { cdc: true });
    expect(h2.count()).toBe(chunks.length - 1);
    chunks.forEach((c, i) => {
      if (!h2.has(i)) h2.append(i, c);
    });
    await executor.finalizeReceive(entry, h2);
    expectLanded(env, 'cdc.bin', entry);
    env.close();
  });

  it('does not reuse a partial opened under the other layout', () => {
    // 同一份内容,定长与 CDC 两种口径的偏移布局不同:串用会把块写到错误位置
    const env = setup();
    const data = contentOf(2);
    const { hashes: cdh, lengths: clens } = chunkHashes(data);
    const entry = entryFor('both.bin', data, { cdh, clens });
    const h = env.mk().beginReceive(entry, { cdc: false });
    appendSlots(h, splitIntoBlocks(data), 2);
    h.abort(true);
    expect(env.mk().beginReceive(entry, { cdc: true }).count()).toBe(0);
    env.close();
  });

  it('drops the pair only when told to, and is a no-op after a successful landing', async () => {
    const env = setup();
    const data = contentOf(3);
    const blocks = splitIntoBlocks(data);
    const entry = entryFor('big.bin', data);
    const { tmp, manifest } = env.scratch('big.bin');

    const dropped = env.mk().beginReceive(entry, { cdc: false });
    appendSlots(dropped, blocks, 2);
    dropped.abort(false); // 对端宣告该路径已删:整份作废
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(manifest)).toBe(false);

    const executor = env.mk();
    const landed = executor.beginReceive(entry, { cdc: false });
    appendSlots(landed, blocks, 3);
    await executor.finalizeReceive(entry, landed);
    // 终态收口统一调 abort(true):落地之后它必须什么都不能碰(目标已改名、位图已清零)
    landed.abort(true);
    expectLanded(env, 'big.bin', entry);
    expect(existsSync(manifest)).toBe(false);
    env.close();
  });
});

/**
 * 磁盘空间守卫的「已经占了多少盘」预估(见 executor.partialBytes)。
 *
 * 守卫只在 needed > 0 时才调用回调,所以这里的断言全都是**精确数字**:
 * 扣多了(把没提交的进度算进去)会让守卫在该拦的时候放行,写坏的方向是磁盘;
 * 扣少了是回到旧行为,大文件目录被误判空间不足。两个方向都得有用例钉住。
 */
describe('磁盘守卫的在途字节预估', () => {
  it('is zero when nothing has been received yet', () => {
    const env = setup();
    const entry = entryFor('big.bin', contentOf(3));
    expect(env.mk().partialBytes(entry, { cdc: false })).toBe(0);
    env.close();
  });

  it('credits exactly the slots the manifest has committed', () => {
    const env = setup();
    const data = contentOf(3);
    const blocks = splitIntoBlocks(data);
    const entry = entryFor('big.bin', data);
    const executor = env.mk();
    const h = executor.beginReceive(entry, { cdc: false });
    appendSlots(h, blocks, 2);
    h.abort(true); // 组提交在这里补做:位图落到 manifest 才算「已在盘上」
    expect(executor.partialBytes(entry, { cdc: false })).toBe(blocks[0]!.length + blocks[1]!.length);
    env.close();
  });

  it('credits nothing that the manifest has not committed yet', () => {
    const env = setup();
    const data = contentOf(3);
    const blocks = splitIntoBlocks(data);
    const entry = entryFor('big.bin', data);
    const executor = env.mk();
    const h = executor.beginReceive(entry, { cdc: false });
    appendSlots(h, blocks, 2);
    // 没收口(既没满位图也没 abort):tmp 里有了字节,位图却还没交代给磁盘
    expect(existsSync(env.scratch('big.bin').tmp)).toBe(true);
    expect(existsSync(env.scratch('big.bin').manifest)).toBe(false);
    expect(executor.partialBytes(entry, { cdc: false })).toBe(0);
    h.abort(false);
    env.close();
  });

  it('credits nothing once the content fingerprint stops matching', () => {
    const env = setup();
    const data = contentOf(3);
    const blocks = splitIntoBlocks(data);
    const entry = entryFor('big.bin', data);
    const executor = env.mk();
    const h = executor.beginReceive(entry, { cdc: false });
    appendSlots(h, blocks, 2);
    h.abort(true);

    // 同一路径同一尺寸,只有一个块的内容不同:续传会整对作废,那一段盘就不是这条内容的
    const altered = Buffer.from(data);
    altered[BLOCK_SIZE] = (altered[BLOCK_SIZE]! + 1) & 0xff;
    const other = entryFor('big.bin', altered);
    expect(executor.partialBytes(other, { cdc: false })).toBe(0);
    // 同一份内容仍然算得到,证明 0 是「内容不符」而不是「什么都没读到」
    expect(executor.partialBytes(entry, { cdc: false })).toBe(BLOCK_SIZE * 2);
    env.close();
  });

  it('credits nothing when the tmp is gone but the manifest survived', () => {
    const env = setup();
    const data = contentOf(3);
    const blocks = splitIntoBlocks(data);
    const entry = entryFor('big.bin', data);
    const executor = env.mk();
    const h = executor.beginReceive(entry, { cdc: false });
    appendSlots(h, blocks, 2);
    h.abort(true);
    rmSync(env.scratch('big.bin').tmp); // 残骸被外部清掉:位图还在,字节已经没了
    expect(executor.partialBytes(entry, { cdc: false })).toBe(0);
    expect(executor.partialBytes(entry, { cdc: false })).toBe(0);
    env.close();
  });

  it('credits the clens lengths under CDC and nothing under the other layout', () => {
    // 口径不同 → 槽位数与偏移布局都不同,位图不能挪用。peer 侧的 planCdc 与这里必须同口径,
    // 否则预估读不到位图,白扣一段(退回旧行为)。
    const env = setup();
    const data = contentOf(3);
    const { hashes: cdh, lengths: clens } = chunkHashes(data);
    const entry = entryFor('cdc.bin', data, { cdh, clens });
    expect(clens.length).toBeGreaterThan(1);
    const chunks: Buffer[] = [];
    for (let off = 0, i = 0; i < clens.length; i++) {
      chunks.push(data.subarray(off, off + clens[i]!));
      off += clens[i]!;
    }
    const executor = env.mk();
    const h = executor.beginReceive(entry, { cdc: true });
    appendSlots(h, chunks, 2);
    h.abort(true);
    expect(executor.partialBytes(entry, { cdc: true })).toBe(clens[0]! + clens[1]!);
    expect(executor.partialBytes(entry, { cdc: false })).toBe(0);
    env.close();
  });

  it('never throws: an unsafe path estimates zero, it does not break the round', () => {
    const env = setup();
    const entry = entryFor('../escape/secret.txt', contentOf(1));
    expect(() => env.mk().beginReceive(entry, { cdc: false })).toThrow(/unsafe path/);
    expect(env.mk().partialBytes(entry, { cdc: false })).toBe(0);
    env.close();
  });
});
