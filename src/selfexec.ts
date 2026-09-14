import { chmodSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 强制给文件补可执行位(Unix)。
 * - 已带执行位(任一 exec bit)则不动;
 * - Windows 上 chmod 对 exec 位无效,调用方应在入口跳过,这里也不依赖它;
 * - 无写权限(全局目录属 root 且以普通用户运行)或文件不存在时静默跳过,不影响调用方。
 */
export function ensureExecutable(path: string): void {
  try {
    const st = statSync(path);
    if (!(st.mode & 0o111)) chmodSync(path, st.mode | 0o111);
  } catch {
    /* 无写权限等场景跳过 */
  }
}

/**
 * bundle 自身启动早期补执行位:跨平台升级(尤其 Windows → Linux)后,换入的
 * bundle 在 Unix 上可能落到 0644(Windows 无 POSIX exec 位,tar 头记录 ~0644)。
 * 逻辑位于新 bundle 的启动代码,故只要对端版本含本修,老接收方换入后首次被
 * node 拉起即自修,不依赖接收方旧代码。dev 态(.ts)与 Windows 跳过。
 */
export function ensureSelfExecutable(): void {
  if (process.platform === 'win32') return;
  const selfPath = fileURLToPath(import.meta.url);
  if (/\.tsx?$/.test(selfPath)) return; // dev 态(源码/测试)不触发
  ensureExecutable(selfPath);
}
