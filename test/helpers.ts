import {
  rmSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  existsSync,
} from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitIntoBlocks } from '../src/blockstore.js';
import type { IndexEntry } from '../src/index.js';
import type { LocalExecutor, ReceiveHandle } from '../src/executor.js';

/**
 * 把一份内容切成条目所声明的那些槽位字节(按本次收的口径)。
 *
 * 定长口径就是 `splitIntoBlocks`;CDC 口径的块长由条目自己带着(`clens` 是发送侧扫出来的
 * 实际边界),所以按它切片,和 `beginReceive` 里算偏移用的同一份数据 —— 换别的切法,
 * append 会撞上「块长与槽位不符」。顺带验一条不变式:`clens` 之和必须等于内容长度,
 * 条目自相矛盾时在这里就报出来,而不是让用例收到一半莫名失败。
 */
export function slotBlocks(entry: IndexEntry, data: Buffer, opts?: { cdc?: boolean }): Buffer[] {
  if (opts?.cdc !== true) return splitIntoBlocks(data);
  const out: Buffer[] = [];
  let off = 0;
  for (const len of entry.clens ?? []) {
    const part = data.subarray(off, off + len);
    if (part.length !== len) throw new Error(`entry ${entry.path}: clens 与实际内容长度不符`);
    out.push(part);
    off += len;
  }
  if (off !== data.length) throw new Error(`entry ${entry.path}: clens 之和 ${off} != 内容 ${data.length}`);
  return out;
}

/**
 * 把一份内容逐块喂进一个新建句柄(不落地),返回句柄本身。
 *
 * 冲突用例需要「先收齐、确认内容对,才把本地文件挪开」的那一段,以及要考察收完之后的
 * 中间态长什么样的用例,都从这里进 —— 正常落地请直接调用 landAll。
 * 要交付**与条目声明不符**的块(错块 / 缺块),请自己 beginReceive 再 append。
 */
export function fillHandle(
  executor: LocalExecutor,
  entry: IndexEntry,
  data: Buffer,
  opts?: { cdc?: boolean },
): ReceiveHandle {
  const handle = executor.beginReceive(entry, { cdc: opts?.cdc === true });
  const blocks = slotBlocks(entry, data, opts);
  for (let i = 0; i < blocks.length; i++) handle.append(i, blocks[i]!);
  return handle;
}

/**
 * 走完整接收管线落一份内容:beginReceive → 逐块 append → finalizeReceive。
 *
 * 阶段 2 之后这是接收侧**唯一**的落地通道(把块攒在内存里交给执行器的旧 API 已删除),
 * 所以测试要落地一个条目都得从这里进 —— 也就顺手把「句柄收得下自己宣告的块数」
 * 这条契约在每个用例里跑一遍。
 */
export async function landAll(
  executor: LocalExecutor,
  entry: IndexEntry,
  data: Buffer,
  opts?: { cdc?: boolean },
): Promise<void> {
  await executor.finalizeReceive(entry, fillHandle(executor, entry, data, opts));
}


/**
 * 跨平台安全删除目录(测试清理用)。
 *
 * Windows 与 Unix 的文件句柄语义不同:Unix 允许删除仍被打开的文件,Windows 则
 * 不允许 —— 若某测试持有尚未关闭的句柄(如 node:sqlite 的 DatabaseSync),在
 * Windows 上直接 rmSync 会抛 EPERM(EPERM: Permission denied)。此外 Windows 的
 * 防病毒软件 / 挂起的删除操作也会对刚创建的文件造成短暂的 EPERM / EBUSY 锁定。
 *
 * 本函数对 EPERM / EBUSY 做有限次退避重试,给 Windows 释放瞬时锁的机会;其它
 * 错误(如路径不存在已由 force 处理)直接抛出。注意:若句柄被测试永久持有而
 * 从未关闭,重试无法解决,真实根因仍是测试未调用 close(),需另行修复。
 */
export function rmDir(dir: string, retries = 12, delayMs = 120): void {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EPERM' && code !== 'EBUSY') throw err;
      if (attempt === retries - 1) throw err;
      sleepSync(delayMs);
    }
  }
}

/**
 * 探测当前环境能否创建「可用」的符号链接。
 *
 * Windows 上 `symlinkSync` 需要开发者模式或管理员权限(SeCreateSymbolicLink
 * 特权),普通用户会话会抛 EPERM;更隐蔽的是:部分沙箱/受限环境里 `symlinkSync`
 * 不报错,但创建的链接 `existsSync` 不可见、`realpathSync` 解析不到目标(即链接
 * 不可用)。涉及符号链接的测试若直接用这种「假成功」的链接建 fixture,守卫逻辑
 * 因 `existsSync(candidate)` 为 false 而跳过检查,导致用例误判通过/失败。
 *
 * 故探测不仅要「不抛错」,还要验证链接「真正可用」:创建后能 `existsSync` 可见、
 * 且 `realpathSync` 能解析回目标目录。不可用(受限/沙箱)时返回 false,让测试优雅
 * skip;Unix 与开启开发者模式的 Windows 返回 true,真正执行守卫逻辑。
 */
export function canCreateSymlinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'syncx-symlink-probe-'));
  try {
    const target = join(dir, 't');
    const link = join(dir, 'l');
    mkdirSync(target);
    symlinkSync(target, link);
    // 验证链接真正可用:可见且能解析回目标
    if (!existsSync(link)) return false;
    if (realpathSync(link) !== target) return false;
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sleepSync(ms: number): void {
  // 优先 Atomics.wait(worker 线程中可用),回退到忙等,保证任意运行环境都不会抛
  try {
    const view = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(view, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* 忙等 */
    }
  }
}
