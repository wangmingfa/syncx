import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { loadConfig, saveConfig, DEFAULT_CONFIG, type SharedFolderConfig } from './config.js';

const FORBIDDEN_PATTERNS = [
  /^\/(etc|usr|bin|sbin|boot|dev|proc|sys|lib|lib64|var|opt|root)\b/i,
  // 常见系统/隐私目录:SSH/GPG、配置与缓存、以及云/容器/K8s 凭证所在目录
  /^\/home\/[^/]+\/(\.ssh|\.gnupg|\.config|\.local|\.cache|\.aws|\.kube|\.docker|\.docker\.cfg)\b/i,
];

/**
 * 校验共享目录路径:必须是绝对路径,不得指向系统敏感目录或用户隐私目录。
 * 相对路径会被 resolve 到当前工作目录,这通常不是用户想要的。
 */
function validateFolderPath(path: string): void {
  if (!path || typeof path !== 'string') {
    throw new Error('folder path is required');
  }
  if (!isAbsolute(path)) {
    throw new Error(`folder path must be absolute: ${path}`);
  }
  const resolved = resolve(path);
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(resolved)) {
      throw new Error(`folder path not allowed: ${resolved}`);
    }
  }
}

/** 列出共享目录配置(已配对设备包含在每条记录的 devices 中)。 */
export function listDevices(configPath: string): SharedFolderConfig[] {
  return loadConfig(configPath).sharedFolders;
}

/** 添加一个共享目录;目录已存在则更新其设备列表。 */
export function addSharedFolder(configPath: string, path: string, devices: string[]): void {
  validateFolderPath(path);
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
