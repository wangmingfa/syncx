import type { IndexEntry } from './index.js';
import type { PeerTransport } from './peer.js';

/**
 * 仅向同目录的 transport 广播索引变更。
 *
 * 每个 transport 在建立会话时已按所在目录(folderId)绑定,因此这里绝不能跨
 * 目录发送 —— 否则目录 A 的条目会被错发到目录 B 的对等端,造成流量浪费甚至
 * 同名文件的元数据串扰(历史 bug,见 cli.ts 的扫描广播循环)。
 *
 * 这里发出去的是**增量**(只含本轮改动的那几条),必须按 delta 标注:接收方会
 * 只对这些路径做判定。若被当作全量,接收方会把「本机独有的条目」视为对端缺失
 * 而回推,两端来回互推形成静默的无限循环(2026-09-16 事故)。
 *
 * 同一设备可能挂着两条 transport(设备对之间每方向一条连接,设计内):广播
 * **按设备去重**,每台至多发一份 —— 同一份增量到两条连接会诱发对端双管线
 * 并排双落地、后一次覆盖窗口期编辑(2026-09 混版本实测坐实的静默分叉)。
 * 接收端单飞闸门是主锁,这里是发送侧的第二道锁;拿不到设备归属的 transport
 * (旧调用方/测试)不去重,维持旧行为。
 */
export function broadcastFolderUpdates(
  folder: { transports: PeerTransport[]; transportDevice?: Map<PeerTransport, string> },
  entries: IndexEntry[],
): void {
  if (entries.length === 0) return;
  const covered = new Set<string>();
  for (const transport of folder.transports) {
    const device = folder.transportDevice?.get(transport);
    if (device !== undefined) {
      if (covered.has(device)) continue;
      covered.add(device);
    }
    transport.sendEntries(entries, 'delta');
  }
}
