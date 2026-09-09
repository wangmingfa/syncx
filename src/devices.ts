import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig, saveConfig, normalizePeerUrl, DEFAULT_CONFIG, type SharedFolderConfig, type DeviceConfig } from './config.js';

const FORBIDDEN_PATTERNS = [
  /^\/(etc|usr|bin|sbin|boot|dev|proc|sys|lib|lib64|var|opt|root)\b/i,
  // 常见系统/隐私目录:SSH/GPG、配置与缓存、以及云/容器/K8s 凭证所在目录。
  // \b 边界让 .ssh2 这类变体名绕过,显式列入
  /^\/home\/[^/]+\/(\.ssh|\.ssh2|\.gnupg|\.config|\.local|\.cache|\.aws|\.kube|\.docker|\.docker\.cfg)\b/i,
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

/** 生成一个稳定的短目录标识(跨设备同步时两边须配置同一 id 才能对上)。 */
export function generateFolderId(): string {
  return randomBytes(6).toString('hex');
}

/**
 * 添加一个共享目录;目录已存在则合并其设备列表。
 * id 缺省时自动生成;跨设备同步场景下可显式传入对方机器的同一目录 id。
 * 目录不存在时自动创建(mkdir -p 语义,Web UI 里填「打算新建」的路径是合法用法);
 * 路径已存在但不是目录(文件/符号链接指向文件)则报错。
 * 返回是否执行了自动创建(供 API 提示用户)。
 */
export function addSharedFolder(configPath: string, path: string, devices: string[], id?: string): boolean {
  validateFolderPath(path);
  const resolved = resolve(path);
  let created = false;
  if (existsSync(resolved)) {
    if (!statSync(resolved).isDirectory()) {
      throw new Error(`path exists and is not a directory: ${resolved}`);
    }
  } else {
    mkdirSync(resolved, { recursive: true });
    created = true;
  }
  const config = loadConfig(configPath);
  const existing = config.sharedFolders.find((f) => f.path === path);
  if (existing) {
    existing.devices = [...new Set([...existing.devices, ...devices])];
  } else {
    config.sharedFolders.push({ path, devices, id: id ?? generateFolderId() });
  }
  saveConfig(configPath, config);
  return created;
}

/** 精确设置某目录的设备列表(用于按目录多选设备的提交)。 */
export function setFolderDevices(configPath: string, path: string, devices: string[]): void {
  const config = loadConfig(configPath);
  const existing = config.sharedFolders.find((f) => f.path === path);
  if (!existing) throw new Error(`folder not configured: ${path}`);
  existing.devices = [...new Set(devices)];
  saveConfig(configPath, config);
}

/** 设置某目录是否遵循 .gitignore 忽略规则(目录卡片上的开关;缺省 true)。 */
export function setFolderGitignore(configPath: string, path: string, enabled: boolean): void {
  const config = loadConfig(configPath);
  const existing = config.sharedFolders.find((f) => f.path === path);
  if (!existing) throw new Error(`folder not configured: ${path}`);
  existing.useGitignore = enabled;
  saveConfig(configPath, config);
}

/** 按路径移除一个共享目录。 */
export function removeSharedFolder(configPath: string, path: string): void {
  const config = loadConfig(configPath);
  config.sharedFolders = config.sharedFolders.filter((f) => f.path !== path);
  saveConfig(configPath, config);
}

/** 列出已知设备(按 ID 引入,未必已指派到目录)。 */
export function listKnownDevices(configPath: string): DeviceConfig[] {
  return loadConfig(configPath).knownDevices;
}

/** 添加一个已知设备 ID(已存在则幂等)。 */
export function addKnownDevice(configPath: string, deviceId: string): void {
  if (!deviceId) throw new Error('device id is required');
  const config = loadConfig(configPath);
  if (!config.knownDevices.some((d) => d.id === deviceId)) {
    config.knownDevices.push({ id: deviceId });
    saveConfig(configPath, config);
  }
}

/** 添加一个手动配置的对端地址(已存在则幂等)。仅接受 ws:// 开头的地址;
 *  入库前规范化(::ffff: 剥离、host 小写),使 [::ffff:10.0.0.2]:22000 与 10.0.0.2:22000 视为同一条。 */
export function addPeer(configPath: string, address: string): void {
  if (!/^ws:\/\//i.test(address)) {
    throw new Error('peer address must start with ws://');
  }
  const config = loadConfig(configPath);
  const normalized = normalizePeerUrl(address);
  if (!config.peers.includes(normalized)) {
    config.peers.push(normalized);
    saveConfig(configPath, config);
  }
}

/** 移除一个手动或反向发现学到的对端地址(按完整 URL 精确匹配,幂等)。 */
export function removePeer(configPath: string, address: string): void {
  const config = loadConfig(configPath);
  const before = config.peers.length;
  config.peers = config.peers.filter((p) => p !== address);
  if (config.peers.length !== before) {
    saveConfig(configPath, config);
  }
}

/** 移除已知设备:同时从各目录的 devices 列表里摘除该设备。 */
export function removeKnownDevice(configPath: string, deviceId: string): void {
  const config = loadConfig(configPath);
  config.knownDevices = config.knownDevices.filter((d) => d.id !== deviceId);
  for (const f of config.sharedFolders) {
    f.devices = f.devices.filter((d) => d !== deviceId);
  }
  saveConfig(configPath, config);
}

export function ensureConfigFile(configPath: string): void {
  if (!existsSync(configPath)) {
    saveConfig(configPath, structuredClone(DEFAULT_CONFIG));
  }
}

/**
 * 对端设备 ID 是否被授权建立连接。
 * - 在任一共享目录的 devices 列表中 → 授权(目录既决定能否连,也决定同步什么)
 * - 已在 knownDevices(粘贴对方 ID 配对)→ 也授权(对齐 Syncthing 设备引入:
 *   引入即建立可信连接,目录指派只决定同步哪些目录,不决定能否连接)
 * 空 ID 一律拒绝。
 */
export function isPeerAllowed(
  peerId: string,
  sharedFolders: SharedFolderConfig[],
  knownDevices: DeviceConfig[] = [],
): boolean {
  if (!peerId) return false;
  if (sharedFolders.some((f) => f.devices.includes(peerId))) return true;
  return knownDevices.some((d) => d.id === peerId);
}
