import { statfsSync } from 'node:fs';

/**
 * 磁盘守卫保留水位:所在盘的可用空间低于这个值就视为「盘快满」,停止接收。
 * 256MB 的依据:同步器写失败最伤的不是「这次没收下」,而是半截文件与
 * 反复重试继续压盘 —— 留出系统/应用运行的余量,让失败提前到「预估阶段」。
 */
export const DISK_GUARD_MIN_FREE_BYTES = 256 * 1024 * 1024;

/**
 * 查询某路径所在磁盘的真实可用空间(字节)。
 *
 * statfsSync 需要 Node ≥19.6(本项目 engines 要求 ≥22.13,可直用);
 * 用 bavail(非特权用户实际可写,不含 root 预留块)而不是 bfree。
 * 返回 undefined = 查询失败(路径暂不可读 / 平台不支持)—— 调用方须按
 * 「无意见,放行」处理:守卫绝不能因为自己读不到而比没有守卫时更糟。
 */
export function freeBytesAt(path: string): number | undefined {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}
