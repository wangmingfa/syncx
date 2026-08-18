import type { IndexEntry } from './index.js';
import type { PeerTransport } from './peer.js';

/**
 * 仅向同目录的 transport 广播索引变更。
 *
 * 每个 transport 在建立会话时已按所在目录(folderId)绑定,因此这里绝不能跨
 * 目录发送 —— 否则目录 A 的条目会被错发到目录 B 的对等端,造成流量浪费甚至
 * 同名文件的元数据串扰(历史 bug,见 cli.ts 的扫描广播循环)。
 */
export function broadcastFolderUpdates(
  folder: { transports: PeerTransport[] },
  entries: IndexEntry[],
): void {
  if (entries.length === 0) return;
  for (const transport of folder.transports) {
    transport.sendEntries(entries);
  }
}
