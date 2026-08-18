import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface SharedFolderConfig {
  path: string;
  devices: string[];
  /**
   * 稳定的目录标识,跨设备约定一致(wire 消息用它在同一 socket 上区分目录)。
   * 缺省时回退为 path(单机 Web UI 添加的目录;跨设备同步请显式配置相同 id)。
   */
  id?: string;
  /**
   * 冲突解决策略:
   * - keep-conflict-copy: 保留本地冲突副本,落地远端版本(默认)
   * - keep-newest: 保留 mtime 较新的版本,删除另一方
   * - keep-larger: 保留文件较大的版本,删除另一方
   * - keep-local: 保留本地版本,忽略远端
   */
  conflictPolicy?: 'keep-conflict-copy' | 'keep-newest' | 'keep-larger' | 'keep-local';
  /**
   * 同步带宽上限,单位 KB/s。0 或不设置表示不限速。
   * 限制单个对端的发送速率,防止大文件同步占满 LAN 带宽。
   */
  maxBandwidthKbps?: number;
}

/** 目录的 wire 标识:优先 id,缺省用 path。 */
export function folderIdFor(folder: SharedFolderConfig): string {
  return folder.id ?? folder.path;
}

/** 每个共享目录独立的索引库文件路径(按 folderId 的哈希命名,避免路径字符问题)。 */
export function folderIndexPath(configDir: string, folderId: string): string {
  const hash = createHash('sha1').update(folderId).digest('hex').slice(0, 16);
  return join(configDir, `index-${hash}.db`);
}

export interface Config {
  sharedFolders: SharedFolderConfig[];
  /** 手动配置的对端 ws:// 地址列表(mDNS 不可用时的回退)。 */
  peers: string[];
}

export const DEFAULT_CONFIG: Config = {
  sharedFolders: [],
  peers: [],
};

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  const raw = readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as Config;
  return {
    sharedFolders: parsed.sharedFolders ?? [],
    peers: parsed.peers ?? [],
  };
}

export function saveConfig(configPath: string, config: Config): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}
