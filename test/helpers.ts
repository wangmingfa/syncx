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
