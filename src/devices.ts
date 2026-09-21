import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, isAbsolute, sep, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadConfig, saveConfig, mutateConfig, normalizePeerUrl, DEFAULT_CONFIG, folderIdFor, folderIndexKey, generateFolderInstanceId, purgeFolderIndex, type Config, type FolderIdentity, type SharedFolderConfig, type DeviceConfig } from './config.js';
import { readFolderIdentity } from './folder-identity.js';

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
    /^\/(etc|usr|bin|sbin|boot|dev|proc|sys|lib|lib64|opt|root)(\/|$)/i,
    // /var 下禁止共享系统目录,但放行临时目录:macOS 的 os.tmpdir() 就是 /var/folders/...,
    // POSIX 另有 /var/tmp。否则在 macOS 上用临时目录建出来的路径会被误判为非法(测试全挂)。
    // 负向先行断言: /var 及 /var/<段> 照禁,仅豁免 folders / tmp 这两个段(及其子树)。
    /^\/var(?:\/(?!(?:folders|tmp)(?:\/|$))|$)/i,
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

/** 本机平台的中文名,用在路径类报错里,让用户一眼看出「本机是哪个平台」。 */
function platformLabel(): string {
  switch (process.platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    default:
      return 'Linux';
  }
}

/** 按本机平台给一个真实可用的绝对路径示例(比写死 /home/me 更有指引性)。 */
function localPathExample(): string {
  return process.platform === 'win32' ? 'F:\\shared\\docs' : join(homedir(), 'Documents');
}

/** Windows 盘符路径(F:\x / F:/x)—— 只在 Windows 上算绝对路径。 */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * 「不是本机绝对路径」的友好报错。
 *
 * 最高频的踩坑:在 macOS / Linux 上填了 Windows 盘符路径(如 `F:\shared\docs`)——
 * POSIX 的 isAbsolute() 对它恒为 false,原来的英文报错完全没说清「本机」「该填什么」。
 * 这里把最常见的两种情况分开说,并点明「共享目录永远指本机目录」这条设计前提。
 */
function absolutePathError(input: string): Error {
  const head =
    process.platform !== 'win32' && WINDOWS_DRIVE_PATH.test(input)
      ? `「${input}」是 Windows 盘符路径,本机是 ${platformLabel()},不认这种写法`
      : `「${input}」不是本机绝对路径`;
  return new Error(
    `${head}。共享目录只能填本机目录(每台设备各填各的,不填其它设备的路径),如 ${localPathExample()}`,
  );
}

/**
 * 校验共享目录路径:必须是绝对路径,不得指向系统敏感目录或用户隐私目录。
 * 相对路径会被 resolve 到当前工作目录,这通常不是用户想要的。
 */
function validateFolderPath(path: string): void {
  if (!path || typeof path !== 'string') {
    throw new Error('请填写共享目录路径');
  }
  if (!isAbsolute(path)) {
    throw absolutePathError(path);
  }
  const resolved = resolve(path);
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(resolved)) {
      throw new Error(`该目录不允许作为共享目录(系统目录或用户隐私目录,如 .ssh):「${resolved}」`);
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
/**
 * 在已加载的 config 上追加/合并一个共享目录(被 addSharedFolder 与 acceptFolderInvitation 复用)。
 * 不做磁盘 IO,只在内存 config 上原地修改;由调用方负责持锁与落盘。
 * @param identity 调用方已采集的共享根身份指纹(见 folder-identity.ts)。此处**刻意不做
 *   磁盘 IO** —— stat 放在 config 临界区外,临界区保持微秒级;采集不到(平台不提供 inode)
 *   则留空,运行期退化为「结构守卫」而不会凭空信任。
 * 返回是否新建了共享条目(区分「目录已存在仅合并设备」与「新增条目」)。
 */
function addSharedFolderTo(
  config: Config,
  resolved: string,
  devices: string[],
  id: string | undefined,
  remote: boolean,
  receiveOnly: boolean,
  identity?: FolderIdentity,
): boolean {
  // 任意两个共享目录之间都不允许物理嵌套(本机自有 / 接收映射同等对待):
  // 嵌套会让同一批文件同时参与两份独立的索引与版本向量,产生重复订阅(fan-in)与同步歧义;
  // 共享是双向的,本机侧嵌套在对方设备上即表现为接收映射嵌套,故统一禁止,不区分来源。
  for (const f of config.sharedFolders) {
    const ep = resolve(f.path);
    if (ep === resolved) continue; // 完全重复交给下方去重合并,不在此报错
    if (resolved.startsWith(ep + sep) || ep.startsWith(resolved + sep)) {
      throw new Error(
        `共享目录之间不能互相嵌套:「${resolved}」与「${ep}」存在包含关系(任一方向都不允许)`,
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
        `「${resolved}」已经是共享目录(目录 ID 为 ${folderIdFor(existing)}),` +
          `不能在同一路径上改用另一个目录 ID(${id})`,
      );
    }
    existing.devices = [...new Set([...existing.devices, ...devices])];
    return false;
  }
  // 新目录:folderId(= 显式 id 或自动生成)在本机必须唯一。否则两个不同 path 共享同一 folderId
  // 会打开同一个索引库文件(索引按 folderId 哈希命名),版本向量互相污染;且 session-manager 按
  // folderId 建 Map 时后者覆盖前者,导致其中一条目录静默不参与同步且无任何报错。
  const finalId = id ?? generateFolderId();
  if (config.sharedFolders.some((f) => folderIdFor(f) === finalId)) {
    throw new Error(`目录 ID「${finalId}」已被另一个共享目录占用`);
  }
  config.sharedFolders.push({
    path: resolved,
    devices,
    id: finalId,
    remote,
    receiveOnly: receiveOnly === true,
    // 新条目 = 新目录实例:索引库按 instanceId 命名,使「索引寿命 = 目录实例寿命」。
    // 于是「移除后重加」「folderId 兜回来复用」都只会打开全新的空索引,结构上不可能
    // 继承上一轮的旧条目/旧墓碑(否则会把磁盘上已不存在的旧条目当删除广播出去)。
    instanceId: generateFolderInstanceId(),
    // 身份指纹由调用方采集后传入(此处不做磁盘 IO);采不到则留空,运行期走结构守卫。
    folderIdentity: identity,
  });
  return true;
}

/**
 * 添加一个共享目录;目录已存在则合并其设备列表。
 * id 缺省时自动生成;跨设备同步场景下可显式传入对方机器的同一目录 id。
 * 目录不存在时自动创建(mkdir -p 语义,Web UI 里填「打算新建」的路径是合法用法);
 * 路径已存在但不是目录(文件/符号链接指向文件)则报错。
 * 返回是否执行了目录自动创建(供 API 提示用户)。
 */
export function addSharedFolder(
  configPath: string,
  path: string,
  devices: string[],
  id?: string,
  remote?: boolean,
  receiveOnly?: boolean,
): boolean {
  // 归一化前先拒绝相对路径:resolve 会把相对路径拼到 cwd 变成绝对路径,绕过 isAbsolute 校验,
  // 导致此前「rejects a relative path」的语义失效。必须在 resolve 之前判定。
  if (!isAbsolute(path)) {
    throw absolutePathError(path);
  }
  // 归一化:尾斜杠、大小写(Windows)、./ 段等写法差异都收敛为同一个绝对路径,
  // 避免同一物理目录因输入字符串不同而被登记成两个共享条目(导致双扫双同步、设备去重失效)。
  const resolved = resolve(path);
  validateFolderPath(resolved);
  let created = false;
  if (existsSync(resolved)) {
    if (!statSync(resolved).isDirectory()) {
      throw new Error(`该路径已存在,但不是目录(无法作为共享目录):「${resolved}」`);
    }
  } else {
    mkdirSync(resolved, { recursive: true });
    created = true;
  }
  // 采集共享根身份指纹(dev + ino):运行期据此区分「盘未挂载/目录被换掉」与「用户确实
  // 删光了文件」。刻意**不往共享目录里写任何文件** —— 标记文件那种做法会在用户目录里留下
  // 常驻痕迹,并被 git status 报成未跟踪文件。
  const identity = readFolderIdentity(resolved);
  // 目录落盘与校验在锁外完成;共享条目登记放进 mutateConfig 临界区,保证
  // load→改→save 原子,避免 daemon 与 CLI 并发改配置时后写覆盖前写。
  mutateConfig(configPath, (config) => {
    addSharedFolderTo(config, resolved, devices, id, remote ?? false, receiveOnly === true, identity ?? undefined);
  });
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
  receiveOnly?: boolean,
): void {
  mutateConfig(configPath, (config) => {
    // 1) 同 folderId 复用
    const byId = config.sharedFolders.find((f) => folderIdFor(f) === folderId);
    if (byId) {
      byId.devices = [...new Set([...byId.devices, deviceId])];
      if (receiveOnly) byId.receiveOnly = true;
      return;
    }
    const target = localPath?.trim();
    if (!target) {
      throw new Error('请填写本机落地目录,用于接受这个共享邀请');
    }
    if (!isAbsolute(target)) {
      throw absolutePathError(target);
    }
    const resolved = resolve(target);
    validateFolderPath(resolved);
    // 2) 同路径、不同 id → 对齐 id
    const byPath = config.sharedFolders.find((f) => resolve(f.path) === resolved);
    if (byPath) {
      if (config.sharedFolders.some((f) => f !== byPath && folderIdFor(f) === folderId)) {
        throw new Error(`目录 ID「${folderId}」已被另一个共享目录占用`);
      }
      byPath.id = folderId;
      byPath.devices = [...new Set([...byPath.devices, deviceId])];
      byPath.remote = true;
      if (receiveOnly) byPath.receiveOnly = true;
      return;
    }
    // 3) 全新路径:自动创建目录(与 addSharedFolder 的「自动创建」承诺一致)并采集身份指纹,
    //    再复用 addSharedFolderTo 统一校验(嵌套 / folderId 唯一)。
    //    注意此处只对**新实例**采集:新实例索引为空,扫描不会产生任何墓碑,采集是安全的;
    //    而 case 1/2 命中的是既有实例(索引非空),若目录处于「未挂载/被换掉」的坏状态,
    //    贸然采集就把坏状态当成正常身份记了下来 —— 那种情况留给用户在界面上「移除并重新添加」。
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true });
    }
    const identity = readFolderIdentity(resolved);
    addSharedFolderTo(config, resolved, [deviceId], folderId, true, receiveOnly === true, identity ?? undefined);
  });
}

/** 精确设置某目录的设备列表(用于按目录多选设备的提交)。 */
export function setFolderDevices(configPath: string, path: string, devices: string[]): void {
  mutateConfig(configPath, (config) => {
    const existing = config.sharedFolders.find((f) => resolve(f.path) === resolve(path));
    if (!existing) throw new Error(`该目录尚未配置为共享目录:「${path}」`);
    existing.devices = [...new Set(devices)];
  });
}

/** 设置某目录是否遵循 .gitignore 忽略规则(目录卡片上的开关;缺省 true)。 */
export function setFolderGitignore(configPath: string, path: string, enabled: boolean): void {
  mutateConfig(configPath, (config) => {
    const existing = config.sharedFolders.find((f) => resolve(f.path) === resolve(path));
    if (!existing) throw new Error(`该目录尚未配置为共享目录:「${path}」`);
    existing.useGitignore = enabled;
  });
}

/** 按路径移除一个共享目录。 */
/**
 * 移除一个共享目录(从 config.sharedFolders 滤除)。
 * @param purgeIndex 为 true 时一并删除该目录的索引库文件(~/.syncx/index-<hash>.db),
 *   清掉历史残留,避免同目录重加时复用旧索引(旧墓碑/条目会再次参与对账,导致误删/误改)。
 *   删除为 best-effort:daemon 仍持有该库连接时(尤其 Windows)会失败,交由 reloadConfig
 *   在关闭索引连接后再删,确保跨平台可用。
 */
export function removeSharedFolder(configPath: string, path: string, purgeIndex = false): void {
  const configDir = dirname(configPath);
  let removedKey: string | undefined;
  mutateConfig(configPath, (config) => {
    const target = config.sharedFolders.find((f) => resolve(f.path) === resolve(path));
    // 索引库按「目录实例 key」(instanceId ?? folderId)命名,移除时按同一口径定位
    removedKey = target ? folderIndexKey(target) : undefined;
    config.sharedFolders = config.sharedFolders.filter((f) => resolve(f.path) !== resolve(path));
  });
  if (purgeIndex && removedKey) {
    purgeFolderIndex(configDir, removedKey);
  }
}

/** 列出已知设备(按 ID 引入,未必已指派到目录)。 */
export function listKnownDevices(configPath: string): DeviceConfig[] {
  return loadConfig(configPath).knownDevices;
}

/** 添加一个已知设备 ID(已存在则幂等)。 */
export function addKnownDevice(configPath: string, deviceId: string): void {
  if (!deviceId) throw new Error('请填写设备 ID');
  if (listKnownDevices(configPath).some((d) => d.id === deviceId)) return; // 幂等
  mutateConfig(configPath, (config) => {
    config.knownDevices.push({ id: deviceId });
  });
}

/** 添加一个手动配置的对端地址(已存在则幂等)。仅接受 ws:// 开头的地址;
 *  入库前规范化(::ffff: 剥离、host 小写),使 [::ffff:10.0.0.2]:22000 与 10.0.0.2:22000 视为同一条。 */
export function addPeer(configPath: string, address: string): void {
  if (!/^ws:\/\//i.test(address)) {
    throw new Error(`对端地址必须以 ws:// 开头:「${address}」`);
  }
  const normalized = normalizePeerUrl(address);
  if (loadConfig(configPath).peers.includes(normalized)) return; // 幂等
  mutateConfig(configPath, (config) => {
    config.peers.push(normalized);
  });
}

/** 移除一个手动或反向发现学到的对端地址(按完整 URL 精确匹配,幂等)。 */
export function removePeer(configPath: string, address: string): void {
  mutateConfig(configPath, (config) => {
    config.peers = config.peers.filter((p) => p !== address);
  });
}

/** 移除已知设备:同时从各目录的 devices 列表里摘除该设备。 */
export function removeKnownDevice(configPath: string, deviceId: string): void {
  mutateConfig(configPath, (config) => {
    config.knownDevices = config.knownDevices.filter((d) => d.id !== deviceId);
    for (const f of config.sharedFolders) {
      f.devices = f.devices.filter((d) => d !== deviceId);
    }
  });
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
