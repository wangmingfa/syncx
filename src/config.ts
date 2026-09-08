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
   * 同步带宽上限,单位 KB/s。0 或不设置表示不限速。
   * 限制单个对端的发送速率,防止大文件同步占满 LAN 带宽。
   */
  maxBandwidthKbps?: number;
  /**
   * 是否把目录内 .gitignore 的规则并入忽略集(缺省 true = 遵循)。
   * 开启时 .gitignore 命中的文件/目录不参与同步;.syncxignore 优先级更高,可用负向规则覆盖。
   */
  useGitignore?: boolean;
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

/** 已知对端设备:通过「粘贴设备 ID」引入,未必已指派到任何目录。 */
export interface DeviceConfig {
  id: string;
  /** 可选备注名,仅本机展示用。 */
  name?: string;
}

/** 对方 daemon 推送过来的待确认项:配对请求 或 目录共享邀请。 */
export interface PendingOffer {
  /** 去重 / 确认用的唯一 id(由发起方确定性生成,便于重推幂等)。 */
  id: string;
  kind: 'pairing' | 'folder';
  /** 发起方设备 ID。 */
  fromDeviceId: string;
  /** 目录共享邀请:目录的稳定标识(与 wire/folderIdFor 一致)。 */
  folderId?: string;
  /** 目录共享邀请:展示用名称(同 folderId)。 */
  folderName?: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: number;
}

export interface Config {
  sharedFolders: SharedFolderConfig[];
  /** 手动配置的对端 ws:// 地址列表(mDNS 不可用时的回退)。 */
  peers: string[];
  /** 已知对端设备(按 ID 配对,不依赖邀请码)。 */
  knownDevices: DeviceConfig[];
  /** 对方推送过来的待确认项(配对 / 目录共享),确认或忽略后移出 pending。 */
  pendingOffers: PendingOffer[];
}

export const DEFAULT_CONFIG: Config = {
  sharedFolders: [],
  peers: [],
  knownDevices: [],
  pendingOffers: [],
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
    knownDevices: parsed.knownDevices ?? [],
    pendingOffers: parsed.pendingOffers ?? [],
  };
}

export function saveConfig(configPath: string, config: Config): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}
