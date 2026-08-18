import { existsSync } from 'node:fs';
import { loadConfig, saveConfig, DEFAULT_CONFIG, type SharedFolderConfig } from './config.js';

/** 列出共享目录配置(已配对设备包含在每条记录的 devices 中)。 */
export function listDevices(configPath: string): SharedFolderConfig[] {
  return loadConfig(configPath).sharedFolders;
}

/** 添加一个共享目录;目录已存在则更新其设备列表。 */
export function addSharedFolder(configPath: string, path: string, devices: string[]): void {
  const config = loadConfig(configPath);
  const existing = config.sharedFolders.find((f) => f.path === path);
  if (existing) {
    existing.devices = [...new Set([...existing.devices, ...devices])];
  } else {
    config.sharedFolders.push({ path, devices });
  }
  saveConfig(configPath, config);
}

/** 按路径移除一个共享目录。 */
export function removeSharedFolder(configPath: string, path: string): void {
  const config = loadConfig(configPath);
  config.sharedFolders = config.sharedFolders.filter((f) => f.path !== path);
  saveConfig(configPath, config);
}

export function ensureConfigFile(configPath: string): void {
  if (!existsSync(configPath)) {
    saveConfig(configPath, structuredClone(DEFAULT_CONFIG));
  }
}

/** 对端设备 ID 是否被任一共享目录授权。空 ID 或空列表一律拒绝。 */
export function isPeerAllowed(peerId: string, sharedFolders: SharedFolderConfig[]): boolean {
  if (!peerId || sharedFolders.length === 0) return false;
  return sharedFolders.some((f) => f.devices.includes(peerId));
}
