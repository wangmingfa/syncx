import { createHash } from 'node:crypto';
import type { IndexEntry } from './index.js';

/**
 * 索引指纹:对本机**将上线**的条目集合算一个内容摘要,供会话建立时的
 * 「指纹跳过」用 —— 双方先换一条几十字节的指纹,一致就省掉数百 KB 的全量索引
 * 互换(链路抖动场景下每次重连都互换一次,是移动端流量尖峰与编解码耗电的主因)。
 *
 * 口径必须与 encodeIndex(src/messages.ts)的上线过滤**完全一致**,否则会出现
 * 「指纹相等但全量其实不同」的漏同步:
 *  - placeholder 条目被 encodeIndex 挡在线外,这里同样排除(占位是本机状态,
 *    不是对端可见内容;两侧占位差异靠条目**集合**不同体现,不会误判相等);
 *  - **mtime 必须排除**:它记的是「本机落盘时刻」,同一份内容在两台机器上
 *    mtime 必然不同,混进来会让指纹永远对不上,优化失效(数据不会错);
 *  - blocks 的顺序有意义(定长块按下标定位),不能排序;
 *  - 版本向量是 Map,迭代顺序取决于各机插入历史,必须按 deviceId 排序后序列化;
 *  - 条目按路径排序,消灭 Map/数组顺序带来的伪差异。
 *
 * 失败方向是安全的:指纹相等要求内容完全一致(跳过 = plan 必为空);
 * 任何不一致都退回「发全量」的旧路径,最多少省一次,绝不漏同步。
 */
export function indexFingerprint(entries: IndexEntry[]): string {
  const canonical = entries
    .filter((e) => e.placeholder !== true)
    .map((e) => ({
      path: e.path,
      version: [...e.version.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      size: e.size,
      deleted: e.deleted === true,
      blocks: e.blocks,
      ...(e.cdh && e.clens ? { cdh: e.cdh, clens: e.clens } : {}),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
