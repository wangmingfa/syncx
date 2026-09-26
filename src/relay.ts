import type { IndexEntry } from './index.js';
import type { PeerTransport } from './peer.js';

/**
 * 中转(relay,见 ADR-0014):把一批刚落地的索引条目转发给同目录的**其它** transport。
 *
 * 关键护栏:
 *  - 排除 `source`(收到这批条目的那条 transport),绝不原路弹回给来源端 —— 这是防回声环的
 *    第一道闸;第二道闸在接收端:来源端对「自己刚发来的版本」判 `equal` 直接空操作(见
 *    peer.ts 的 onLanded 触发条件与版本向量比较)。两道闸叠加,版本向量一旦全网一致,
 *    所有比较都变 `equal`,消息图自然静止。
 *  - 只发 `delta`(仅这些路径),绝不能当 `full` —— 把收到的 delta 当全量会诱使接收端为
 *    「它没提到的本地条目」回推,两端互为回声(2026-09-16 事故形态)。
 *  - 同一设备可能挂着两条 transport(每方向一条连接),中转**按设备去重**:每台
 *    至多发一份,来源设备的其余连接也不收(它刚发过,再收只会诱发对端双管线重复落地)。
 *    拿不到设备归属(未传映射的旧调用)退回逐 transport 转发,维持旧行为。
 *  - 标记 `relayed: true`,让接收端区分「并发版本 = 兄弟真改过(保留冲突副本)」与
 *    「并发版本 = 兄弟只是陈旧同步副本(直接覆盖,不刷 .sync-conflict)」。
 *  - 空列表直接返回,避免无意义的帧(也顺便挡住「落地零条却触发中转」的退化路径)。
 */
export function relayToSiblings(
  transports: PeerTransport[],
  source: PeerTransport,
  entries: IndexEntry[],
  transportDevice?: Map<PeerTransport, string>,
): void {
  if (entries.length === 0) return;
  const sourceDevice = transportDevice?.get(source);
  const covered = new Set<string>();
  for (const transport of transports) {
    if (transport === source) continue;
    const device = transportDevice?.get(transport);
    if (device !== undefined) {
      if (device === sourceDevice || covered.has(device)) continue;
      covered.add(device);
    }
    transport.sendEntries(entries, 'delta', { relayed: true });
  }
}
