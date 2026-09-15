import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

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
  /**
   * 接收模式(只读,只拉不推):本机只从对端拉取变更、应用对端删除,但**绝不**把本机
   * 的本地新增/修改/删除反灌给对端。用于「完整端 ↔ 残缺端」这类场景,防止把本机
   * (可能不完整的)状态当「删除」广播出去、误删对端文件。典型用法:在残缺端勾选,
   * 让它单向镜像完整端。缺省 false = 双向同步。
   */
  receiveOnly?: boolean;
  /**
   * 本机目录实例 ID(**仅本机使用,不进 wire、不参与跨设备 folderId 对齐**)。
   *
   * 每次「新增目录 / 接受邀请新建 / 路径被重新指派 id」都会生成一个新的 instanceId,
   * 索引库文件按它命名 —— 使「索引寿命 = 目录实例寿命」成为结构不变式:目录被移除后
   * 重新添加、或 folderId 兜回来复用时,都会打开一个全新的空索引库,**不可能继承上一轮
   * 的旧条目/旧墓碑**(旧条目在磁盘已消失时会被判定为「本地删除」并广播出去,成批删掉
   * 对端文件 —— 2026-09-15 事故)。
   *
   * 缺省(旧配置)回退为 folderId,沿用既有索引文件名,升级时不触发重扫。
   */
  instanceId?: string;
  /**
   * 本机是否已为该目录建立 `.syncx-folder` 标记(缺省 = 尚未建立,启动时一次性收养)。
   * 标记存在于共享根是「目录已正确挂载/内容可信」的信号;标记缺失时扫描会跳过该目录、
   * 绝不推断删除,用于防「盘未挂载 / 目录被整体清空」被误判成「用户删光了文件」。
   * 之所以需要这个持久化闸门而不是「缺了就补」:否则「先清空目录、再重启 daemon」
   * 会在启动时重建标记,随即把空目录当成大规模删除广播出去,保护形同虚设。
   */
  markerChecked?: boolean;
}

/** 目录的 wire 标识:优先 id,缺省用 path。 */
export function folderIdFor(folder: SharedFolderConfig): string {
  return folder.id ?? folder.path;
}

/**
 * 索引库的命名 key:优先本机 instanceId(目录实例化后),缺省回退 folderId(旧配置,
 * 沿用既有文件名、升级不触发重扫)。与 wire 身份(folderIdFor)刻意解耦。
 */
export function folderIndexKey(folder: SharedFolderConfig): string {
  return folder.instanceId ?? folderIdFor(folder);
}

/** 生成一个新的目录实例 ID(本机唯一,不影响 wire 身份)。 */
export function generateFolderInstanceId(): string {
  return randomBytes(6).toString('hex');
}

/** 每个共享目录独立的索引库文件路径(按索引 key 的哈希命名,避免路径字符问题)。 */
export function folderIndexPath(configDir: string, key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 16);
  return join(configDir, `index-${hash}.db`);
}

/**
 * 删除某共享目录的索引库文件(按 folderId 哈希定位的 index-<hash>.db)。
 * best-effort:文件不存在时返回 false;被运行中的 daemon 持有连接时(尤其 Windows
 * 下 unlink 打开中的文件会 EBUSY/EPERM)也返回 false 且不抛错——daemon 场景交由
 * reloadConfig 在关闭索引连接后再删除,确保跨平台都能清掉。
 */
export function purgeFolderIndex(configDir: string, key: string): boolean {
  const dbPath = folderIndexPath(configDir, key);
  if (!existsSync(dbPath)) return false;
  try {
    unlinkSync(dbPath);
    return true;
  } catch {
    return false;
  }
}

/** 索引库主文件及其 SQLite sidecar(journal/wal/shm)的命名形态。 */
const INDEX_FILE_RE = /^index-([0-9a-f]{16})\.db(?:-(?:journal|wal|shm))?$/;

/**
 * 启动时回收孤儿索引库:删除 configDir 下所有「不属于当前 config 期望集合」的
 * `index-*.db`(连同其 sidecar)。期望集合 = 每个配置目录的 folderIndexKey 哈希。
 *
 * 为什么需要它(两条此前无解的路径):
 *  1. 关着 daemon 直接改 config.json 删目录 → 压根不会走 markIndexForPurge;
 *  2. 进程在「登记清理」与「热重载真正删除」之间重启 → 内存登记丢失,清理意图永久蒸发。
 * 二者都会留下旧索引;同一索引 key 兜回来复用时,旧条目/旧墓碑会再次参与对账,成批删掉
 * 对端文件。索引库是可再生缓存(最坏代价只是重扫一次),删除是安全的。
 *
 * 必须在 SyncSessionManager 构造**之前**调用:此时没有任何索引句柄被持有,
 * Windows 下 unlink 也不会遇到 EBUSY。
 *
 * @returns 实际删除的文件绝对路径(删除失败如被占用的会跳过,留待下次启动再试)。
 */
export function purgeOrphanIndexFiles(configDir: string, config: Config): string[] {
  if (!existsSync(configDir)) return [];
  const expected = new Set(
    config.sharedFolders.map((f) => basename(folderIndexPath(configDir, folderIndexKey(f)))),
  );
  let names: string[];
  try {
    names = readdirSync(configDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const m = INDEX_FILE_RE.exec(name);
    if (!m) continue;
    if (expected.has(`index-${m[1]}.db`)) continue; // 在册目录(含其 sidecar)保留
    const full = join(configDir, name);
    try {
      unlinkSync(full);
      removed.push(full);
    } catch {
      // 仍被占用(daemon 在跑):跳过,下次启动再试。索引残留不会因此变成正确性问题,
      // 因为目录实例化后新实例永远打开新文件名的空库。
    }
  }
  return removed;
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
