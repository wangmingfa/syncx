import { existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
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
  /**
   * 该共享目录是否来自「接收对端邀请」(而非本机主动 add 共享自有目录)。
   * 仅用于展示/诊断区分;嵌套约束对本机自有与接收映射同等生效:
   * 任意两个共享目录都不得物理嵌套(共享是双向的,本机嵌套在对方侧即表现为接收映射嵌套)。
   * 旧配置缺省为 undefined,按「本机自有」处理。
   */
  remote?: boolean;
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
  /** 发起方主机名(hello 宣告);用于邀请卡展示来源主机。旧版本对端不发送时为 undefined。 */
  fromHostname?: string;
  /** 发起方入站源 IP(本机视角,从入站 socket 提取);用于邀请卡展示来源 IP。
   *  本机主动出站连接收到的邀请无法取到对方源 IP,为 undefined。 */
  fromIp?: string;
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

/**
 * 规范化一条 ws:// 对端地址:
 *   - 剥离 IPv4-mapped IPv6 前缀(::ffff:a.b.c.d → a.b.c.d)。peer server 双栈监听(::),
 *     旧版本入站反向发现会把 IPv4 对端存成 ws://[::ffff:a.b.c.d]:port,与手动填的
 *     纯 IPv4 形式无法按字符串去重,同一对端在 config.peers 里留下两条等价记录。
 *   - host 统一小写;IPv6 host 保持方括号形式。
 * 解析失败(不符合 ws://host:port 形态)原样返回,交由上层校验逻辑处理。
 */
export function normalizePeerUrl(address: string): string {
  const m = /^ws:\/\/\[([^\]]+)\]:(\d+)$/i.exec(address) ?? /^ws:\/\/([^[\]:]+):(\d+)$/i.exec(address);
  const hostRaw = m?.[1];
  const port = m?.[2];
  if (!m || hostRaw === undefined || port === undefined) return address;
  let host = hostRaw.toLowerCase();
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length);
  return `ws://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/**
 * 规范化并对 config.peers 去重(加载时自愈旧数据):
 * 丢弃非字符串/空项,逐条规范化后按首次出现顺序保留唯一形式。
 * 例如旧配置里的 ws://[::ffff:10.0.0.2]:22000 会归一成 ws://10.0.0.2:22000,
 * 与手动配置的纯 IPv4 条目合并为一条。
 */
export function normalizePeerList(peers: unknown): string[] {
  if (!Array.isArray(peers)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of peers) {
    if (typeof p !== 'string' || p === '') continue;
    const norm = normalizePeerUrl(p);
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  const raw = readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as Config;
  return {
    sharedFolders: parsed.sharedFolders ?? [],
    // 加载时规范化 + 去重:旧版本遗留的 ::ffff: 形式条目自愈合并,不必手动清理 config.json
    peers: normalizePeerList(parsed.peers),
    knownDevices: parsed.knownDevices ?? [],
    pendingOffers: parsed.pendingOffers ?? [],
  };
}

/**
 * 原子写配置:先写临时文件再 rename(同目录内 rename 是原子操作),避免并发读
 * (如 `syncx status` / daemon 读取)读到半截 JSON 导致 JSON.parse 抛错。
 */
export function saveConfig(configPath: string, config: Config): void {
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  renameSync(tmp, configPath);
}

/**
 * 跨进程配置锁:daemon 与 CLI 都可能对配置做 load→改→save,用锁文件串行化临界区,
 * 防止并发写互相覆盖(后写覆盖前写,丢失一方改动)。锁文件以 `wx` 排他创建,
 * 已存在则视为被占用;持有者崩溃遗留的陈旧锁(>30s)会被回收。临界区极短
 * (load+mutate+save 微秒级),争用罕见。
 * 同时维护本进程重入深度:同一进程内的嵌套 mutateConfig 不会自我死锁。
 */
const configLockDepth = new Map<string, number>();

function microSleep(ms: number): void {
  // 主线程可用的亚毫秒级同步休眠;SharedArrayBuffer + Atomics.wait 不可用则退化为极短自旋
  try {
    const view = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(view, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

function acquireConfigLock(configPath: string): void {
  const depth = configLockDepth.get(configPath) ?? 0;
  if (depth > 0) {
    configLockDepth.set(configPath, depth + 1);
    return; // 本进程已持锁,重入直接放行
  }
  const lockPath = `${configPath}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx'); // 排他创建,已存在则抛 EEXIST
      closeSync(fd);
      configLockDepth.set(configPath, 1);
      return;
    } catch {
      // 陈旧锁回收:持有者崩溃未释放且超过 30s,直接删除后重试
      try {
        if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > 30000) {
          unlinkSync(lockPath);
        }
      } catch { /* 忽略,进入重试 */ }
      if (Date.now() > deadline) {
        throw new Error(`acquire config lock timeout: ${configPath}`);
      }
      microSleep(2);
    }
  }
}

function releaseConfigLock(configPath: string): void {
  const depth = configLockDepth.get(configPath) ?? 0;
  if (depth <= 1) {
    try { unlinkSync(`${configPath}.lock`); } catch { /* 已不存在则忽略 */ }
    configLockDepth.delete(configPath);
  } else {
    configLockDepth.set(configPath, depth - 1);
  }
}

/**
 * 串行化「加载 → 修改 → 保存」为一个临界区:持锁期间独占配置读写,避免 daemon 与
 * CLI 并发改配置时后写覆盖前写。mutator 在内存 config 上原地修改即可,无需自行 load/save。
 * - mutator 返回 `false` → 视为无改动,跳过落盘(用于去重命中 / echo 等 no-op 路径,
 *   避免对端频繁 hello 反复重写 config.json);返回 `true` 或 `void` → 照常保存。
 * - mutator 抛错会向上传播,且在锁释放后(finally)才抛出,不会留下持锁状态。
 */
export function mutateConfig(configPath: string, mutator: (config: Config) => boolean | void): void {
  acquireConfigLock(configPath);
  try {
    const config = loadConfig(configPath);
    const changed = mutator(config);
    if (changed !== false) {
      saveConfig(configPath, config);
    }
  } finally {
    releaseConfigLock(configPath);
  }
}
