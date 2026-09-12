import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadConfig, saveConfig, normalizePeerUrl, DEFAULT_CONFIG, folderIdFor, type SharedFolderConfig, type DeviceConfig } from './config.js';

/**
 * 共享目录黑名单:平台相关。
 * - Unix:系统根目录与 /home/<user> 下的隐私目录(SSH/GPG/云/K8s 凭证等)。
 *   早期实现只写了 `/` 开头的 Unix 路径,在 Windows 上 resolve 出来是 `C:\Users\...`,
 *   正则永不命中 → 隐私目录可被直接加为共享(泄私钥)。这里补上 Windows 专属规则。
 * - 用 `(\/|$)` / `(\\|$)` 收尾而非 `\b`:`\b` 在 `.ssh` 与 `2` 之间不构成边界,
 *   会让 `.ssh2` 这类变体名绕过。
 */
function buildForbiddenPatterns(): RegExp[] {
  const patterns: RegExp[] = [
    /^\/(etc|usr|bin|sbin|boot|dev|proc|sys|lib|lib64|var|opt|root)(\/|$)/i,
    /^\/home\/[^/]+\/(\.ssh|\.ssh2|\.gnupg|\.config|\.local|\.cache|\.aws|\.kube|\.docker|\.docker\.cfg|AppData)(\/|$)/i,
  ];
  if (process.platform === 'win32') {
    // 只禁具体隐私子目录,不要禁整棵 AppData(否则 AppData\Local\Temp 等良性目录会被误伤)。
    // 隐私目录既可能直接位于用户主目录,也可能位于 AppData\Roaming|Local|LocalLow 下。
    const privDirs =
      '(\\.ssh|\\.ssh2|\\.gnupg|\\.config|\\.local|\\.cache|\\.aws|\\.kube|\\.docker|\\.docker\\.cfg)';
    patterns.push(
      // 用户主目录下:C:\Users\<user>\.ssh 等
      new RegExp(`^[A-Za-z]:\\\\Users\\\\[^\\\\]+\\\\${privDirs}(\\\\|$)`, 'i'),
      // AppData 三个已知作用域下的隐私目录:C:\Users\<user>\AppData\Roaming\.ssh 等
      new RegExp(
        `^[A-Za-z]:\\\\Users\\\\[^\\\\]+\\\\AppData\\\\(Roaming|Local|LocalLow)\\\\${privDirs}(\\\\|$)`,
        'i',
      ),
      // 系统目录(驱动盘符任意)
      /^[A-Za-z]:\\(Windows|ProgramData|Program Files|Program Files \(x86\)|Boot|Recovery)(\\|$)/i,
    );
  }
  return patterns;
}

const FORBIDDEN_PATTERNS = buildForbiddenPatterns();

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
export function addSharedFolder(configPath: string, path: string, devices: string[], id?: string, remote?: boolean): boolean {
  // 归一化前先拒绝相对路径:resolve 会把相对路径拼到 cwd 变成绝对路径,绕过 isAbsolute 校验,
  // 导致此前「rejects a relative path」的语义失效。必须在 resolve 之前判定。
  if (!isAbsolute(path)) {
    throw new Error(`folder path must be absolute: ${path}`);
  }
  // 归一化:尾斜杠、大小写(Windows)、./ 段等写法差异都收敛为同一个绝对路径,
  // 避免同一物理目录因输入字符串不同而被登记成两个共享条目(导致双扫双同步、设备去重失效)。
  const resolved = resolve(path);
  validateFolderPath(resolved);
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
  // 任意两个共享目录之间都不允许物理嵌套(本机自有 / 接收映射同等对待):
  // 嵌套会让同一批文件同时参与两份独立的索引与版本向量,产生重复订阅(fan-in)与同步歧义;
  // 共享是双向的,本机侧嵌套在对方设备上即表现为接收映射嵌套,故统一禁止,不区分来源。
  for (const f of config.sharedFolders) {
    const ep = resolve(f.path);
    if (ep === resolved) continue; // 完全重复交给下方去重合并,不在此报错
    if (resolved.startsWith(ep + sep) || ep.startsWith(resolved + sep)) {
      throw new Error(
        `shared folder must not nest inside or contain another shared folder: ${resolved} overlaps ${ep}`,
      );
    }
  }
  // 用归一化后的路径做去重(对已有条目也先 resolve 比对),等价写法(/a/b、/a/b/、/A/b)都落到同一条目
  const existing = config.sharedFolders.find((f) => resolve(f.path) === resolved);
  if (existing) {
    // 路径相同:合并设备列表。但若调用方显式传入的 id 与既有目录 id 不一致,说明意图是
    // 「同路径、不同目录 id」——这是矛盾:会让 wire 按 id 路由错乱、或两条同 id 目录共享索引库
    // (版本向量交叉写、session-manager 按 folderId 建索引后者覆盖前者 → 一条目录静默失效)。
    // 直接拒绝,让调用方改用既有 id 或另选路径。
    if (id !== undefined && folderIdFor(existing) !== id) {
      throw new Error(
        `path ${resolved} is already shared under folder id ${folderIdFor(existing)}; ` +
          `cannot accept a different folder id ${id} at the same path`,
      );
    }
    existing.devices = [...new Set([...existing.devices, ...devices])];
    saveConfig(configPath, config);
    return created;
  }
  // 新目录:folderId(= 显式 id 或自动生成)在本机必须唯一。否则两个不同 path 共享同一 folderId
  // 会打开同一个索引库文件(索引按 folderId 哈希命名),版本向量互相污染;且 session-manager 按
  // folderId 建 Map 时后者覆盖前者,导致其中一条目录静默不参与同步且无任何报错。
  const finalId = id ?? generateFolderId();
  if (config.sharedFolders.some((f) => folderIdFor(f) === finalId)) {
    throw new Error(`folder id ${finalId} is already used by another shared folder`);
  }
  config.sharedFolders.push({ path: resolved, devices, id: finalId, remote });
  saveConfig(configPath, config);
  return created;
}

/**
 * 接受目录共享邀请:把对端的 folderId 落到本机某个共享目录。
 *
 * 三种情况:
 * 1. 本机已有同 folderId 的目录 → 直接复用,把对端并入其设备列表(id 天然一致)。
 * 2. 本机无同 id 目录、但用户填的路径已是一个(不同 id 的)共享目录 → 把该目录的 id
 *    对齐成对方的 folderId(否则对端按 folderId 推送会找不到本机目录,静默不同步)。
 *    前置:该 folderId 不能被另一条「不同路径」的目录占用,否则拒绝。
 * 3. 全新路径 → 创建新目录,id 取对方的 folderId(走 addSharedFolder 的统一校验)。
 *
 * 之所以不简单地用 addSharedFolder(path, [peer], folderId) 复用其「按 path 合并」分支,
 * 是因为那个分支会保留既有目录的旧 id,导致 wire 路由的 folderId 与实际存储 id 不一致
 * (#3:静默不同步)。这里显式对齐 id,保证接受邀请后一定能按对端 folderId 收到推送。
 */
export function acceptFolderInvitation(
  configPath: string,
  folderId: string,
  deviceId: string,
  localPath?: string,
): void {
  const config = loadConfig(configPath);
  // 1) 同 folderId 复用
  const byId = config.sharedFolders.find((f) => folderIdFor(f) === folderId);
  if (byId) {
    byId.devices = [...new Set([...byId.devices, deviceId])];
    saveConfig(configPath, config);
    return;
  }
  const target = localPath?.trim();
  if (!target) {
    throw new Error('local path is required to accept a folder invitation');
  }
  if (!isAbsolute(target)) {
    throw new Error(`folder path must be absolute: ${target}`);
  }
  const resolved = resolve(target);
  validateFolderPath(resolved);
  // 2) 同路径、不同 id → 对齐 id
  const byPath = config.sharedFolders.find((f) => resolve(f.path) === resolved);
  if (byPath) {
    if (config.sharedFolders.some((f) => f !== byPath && folderIdFor(f) === folderId)) {
      throw new Error(`folder id ${folderId} is already used by another shared folder`);
    }
    byPath.id = folderId;
    byPath.devices = [...new Set([...byPath.devices, deviceId])];
    byPath.remote = true;
    saveConfig(configPath, config);
    return;
  }
  // 3) 全新路径:交给 addSharedFolder 统一校验(嵌套 / folderId 唯一 / 创建)
  addSharedFolder(configPath, resolved, [deviceId], folderId, true);
}

/** 精确设置某目录的设备列表(用于按目录多选设备的提交)。 */
export function setFolderDevices(configPath: string, path: string, devices: string[]): void {
  const config = loadConfig(configPath);
  const existing = config.sharedFolders.find((f) => resolve(f.path) === resolve(path));
  if (!existing) throw new Error(`folder not configured: ${path}`);
  existing.devices = [...new Set(devices)];
  saveConfig(configPath, config);
}

/** 设置某目录是否遵循 .gitignore 忽略规则(目录卡片上的开关;缺省 true)。 */
export function setFolderGitignore(configPath: string, path: string, enabled: boolean): void {
  const config = loadConfig(configPath);
  const existing = config.sharedFolders.find((f) => resolve(f.path) === resolve(path));
  if (!existing) throw new Error(`folder not configured: ${path}`);
  existing.useGitignore = enabled;
  saveConfig(configPath, config);
}

/** 按路径移除一个共享目录。 */
export function removeSharedFolder(configPath: string, path: string): void {
  const config = loadConfig(configPath);
  config.sharedFolders = config.sharedFolders.filter((f) => resolve(f.path) !== resolve(path));
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
