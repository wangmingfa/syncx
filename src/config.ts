import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { E2EKeyRecord } from './e2e.js';

/**
 * 共享根的目录身份指纹:根目录的 `dev` + `ino`,以十进制字符串存放。
 * 采集与比对实现见 `folder-identity.ts`;类型放在这里是因为它随配置持久化。
 *
 * 用字符串而不是 number:一是 JSON 无法序列化 BigInt,二是部分文件系统(如 XFS/ZFS)的
 * inode 超过 2^53,用 number 会丢精度、可能把两个不同目录算成同一个身份。
 */
export interface FolderIdentity {
  dev: string;
  ino: string;
  /**
   * 该目录**已经人工确认过**的设备号集合(含当前 `dev`)。
   *
   * 存在的理由:Android A/B 分区设备上,每次 OTA 会切到另一个 slot,`/data` 的
   * device-mapper minor 随之挪一位 —— `st_dev` 在两个值之间来回跳,而 inode 始终不变。
   * 于是「仅 dev 变」在这类机器上每次系统更新都要弹一次确认,而正确答案永远一样,
   * 只会把人训练成不看就点。规则改为:集合内的 dev 再出现 → 静默重采;
   * 没出现过的 dev → 仍弹一次确认,确认后才入集合。详见 docs/adr/0009 附录。
   *
   * 缺省(本次改动之前写的配置)= 只有 `dev` 一个值,行为与升级前一致。
   */
  devs?: string[];
}

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
   * 共享根的**身份指纹**(dev + ino),首次纳入同步时采集。
   *
   * 作用与 Syncthing 的 `.stfolder` 标记相同:区分「盘未挂载 / 目录被整体清空」与
   * 「用户确实删光了文件」——前者绝不能推断删除,否则会把对端文件成批删掉
   * (2026-09-15 事故)。但**不往用户目录里写任何文件**:标记文件那种做法虽然直观,
   * 却会在共享目录里留下常驻痕迹,并被 `git status` 报成未跟踪文件。
   *
   * 指纹强于标记文件:换盘、重新挂载、目录被删了重建都会改变 dev/ino;而「同一个路径上
   * 挂了另一块盘」这种情况,标记文件认不出、指纹能。目录内容被删空但根目录身份不变
   * (= 用户真的删了)则照常同步删除。
   *
   * 必须持久化、绝不能「缺了就补」:否则「先清空目录、再重启 daemon」会在启动时重新采集
   * 指纹,随即把空目录当成大规模删除广播出去,保护形同虚设。
   * 旧配置缺省(尚未采集),启动时一次性收养;平台不提供 ino 时保持缺省。
   */
  folderIdentity?: FolderIdentity;
  /** @deprecated 旧版的「`.syncx-folder` 标记已建立」标志,已被 folderIdentity 取代;仅在迁移时清理。 */
  markerChecked?: boolean;
  /**
   * 该目录是否暂停同步(目录卡片开关)。暂停 = 数据面停摆:不扫描、不广播、
   * 不挂对端传输通道(入站变更也因此被忽略);控制面照常 —— 连接保持在线,
   * 配对 / 邀请 / 版本宣告不受影响。全局恢复后目录自己的 paused 仍独立生效。
   */
  paused?: boolean;
  /**
   * 同步时段(目录设置弹窗),形如 `HH:MM-HH:MM`,支持跨午夜(如 `22:00-08:00`)。
   * 仅在该时段内同步:时段外数据面停摆(与 paused 同语义:不扫描、不广播、
   * 不挂传输通道),控制面照常;跨过窗口边界时由 daemon 的分钟级巡检自动摘/挂。
   * 空/缺省 = 全天同步;格式非法按全天处理(绝不因配置笔误把目录锁死)。
   */
  schedule?: string;
  /**
   * Git 提交同步模式:当共享目录是 git 仓库时,检测本地提交并通知其他设备自动提交。
   *
   * - 'off'(默认):不启用 git 同步
   * - 'send':检测并广播本地提交,但不自动提交对端通知
   * - 'receive':收到通知时自动提交,但不广播本地提交
   * - 'full':双向 —— 既广播本地提交,也自动提交对端通知
   *
   * 缺省 'off'(显式 opt-in),避免对非 git 目录产生不必要的 git 命令调用。
   * 旧配置缺省(尚未设置)按 'off' 处理。
   */
  gitSync?: GitSyncMode;
  /**
   * 冲突自动处理策略(版本向量并发时,见 peer.ts 的 conflict 分支)。
   *
   * - 'keep-both'(默认,存成 undefined):现行为 —— 拉回对端内容,本地保留为
   *   .sync-conflict 副本,进冲突收件箱等人工合并。
   * - 'newest-wins':按双方 mtime 判新旧,新者内容胜出、覆盖另一端(不落冲突副本)。
   *   mtime 经索引协议传给对端;任一侧缺 mtime(旧版对端 / 未扫描)退回 keep-both。
   *   注意跨设备比较依赖各机时钟,时钟漂移大的环境慎用。
   * - 'local-wins':本机内容始终胜出,不拉对端块;仅合并版本向量后把本机条目
   *   推回对端(合并结果支配对端版本,对端下一轮自动拉取本机内容收敛)。
   *
   * 仅作用于「真正的版本并发」;中转陈旧副本与接收模式的镜像覆盖仍走各自既有路径。
   * 旧配置缺省(尚未设置)按 'keep-both' 处理。
   */
  conflictPolicy?: ConflictPolicy;
  /**
   * 按需同步(稀疏文件,小盘设备刚需):对端推来的**非空文件**只记索引(含块哈希)
   * 为占位条目、不在本机落盘,用户在文件管理器点「下载」才拉块落地。空文件无盘可省,
   * 照常即时落地;双活冲突的裁决需要内容,冲突路径不受此开关影响(仍会落地)。
   *
   * 占位条目不进线上协议(旧对端零兼容负担)、不在全量宣告中(不谎称供得出内容)、
   * 不参与扫描墓碑(盘上没有 ≠ 本地删除)。与端到端加密同开的目录里,e2e 通道优先
   * (盲区端本就不收明文,无需再占位)。旧配置缺省 = 关闭,行为与之前完全一致。
   */
  onDemand?: boolean;
  /**
   * 选择性同步(子目录级按需):这些目录前缀('/' 分隔,与索引同形)下的对端**非空
   * 文件**按 onDemand 同款口径处理 —— 只记占位条目、不落盘,文件管理器点「下载」
   * 再拉块。目录整体 onDemand=true 时本字段多余(整盘已占位化),二者是「或」关系。
   * 只影响**之后的接收**:开关不改既有实体文件,也不落地既有占位(与目录级同语义)。
   * 旧配置缺省 = 空列表。
   */
  onDemandDirs?: string[];
  /**
   * 单文件暂停:这些相对路径('/' 分隔,与索引同形)的文件在本目录**双向冻结**——
   * 本机改动不外推、对端改动不落地(含对端删除),但文件保留在索引与盘上,
   * 恢复后下一轮索引交换自然收敛。与整目录 paused 不同:那是通道级停摆,
   * 这里只冻结列出的路径,目录其余文件照常同步。旧配置缺省 = 空列表。
   */
  pausedFiles?: string[];
  /**
   * 上次观测到的 HEAD 提交哈希(**仅本机使用,不进 wire、不跨设备对齐**)。
   *
   * 与 gitSync 配套:扫描时拿当前 HEAD 与它比对,不同即说明产生了新提交。存进配置而不只放
   * 内存,是为了让 daemon 停机期间的提交在重启后仍能被检出并补广播 —— 缺省时只能把重启后的
   * HEAD 重新当基线,停机期间那次提交的消息就永久不会传播了。
   *
   * 每次 gitSync 模式被改动时清空(devices.setFolderGitSync):改模式视为「重新启用」,
   * 从当前 HEAD 重新起基线,绝不把启用前积压的历史提交一次性重放出去。
   */
  gitLastCommitHash?: string;
  /**
   * 端到端加密密钥记录(passphrase 经 scrypt 派生;salt/key 皆 base64,**口令本体永不落盘**)。
   * 设置后,列在 e2eUntrusted 里的对端只收密文视图:路径与内容逐块加密,盲区节点「只存块、
   * 看不懂内容」,且永不回源(可信端忽略其索引宣告)。语义与已知边界见 src/e2e.ts 头注释。
   */
  e2eKey?: E2EKeyRecord;
  /** 不可信对端的设备 id 列表(仅与 e2eKey 同时生效;名单内的 devices 成员走密文视图)。 */
  e2eUntrusted?: string[];
  /** 是否已设置口令(buildStatus 出站内存 e2eKey 后置此标志;密钥本体永不出 daemon)。 */
  e2eKeySet?: boolean;
}

/** Git 提交同步的四种模式;定义见 SharedFolderConfig.gitSync 的注释。 */
export type GitSyncMode = 'off' | 'send' | 'receive' | 'full';

/** 冲突自动处理策略;定义与语义见 SharedFolderConfig.conflictPolicy 的注释。 */
export type ConflictPolicy = 'keep-both' | 'newest-wins' | 'local-wins';

const CONFLICT_POLICIES: readonly string[] = ['keep-both', 'newest-wins', 'local-wins'];

/** 校验 conflictPolicy 取值(供设置入口拒绝笔误,非法值 400 而非静默失效)。 */
export function isConflictPolicy(v: unknown): v is ConflictPolicy {
  return typeof v === 'string' && CONFLICT_POLICIES.includes(v);
}

const GIT_SYNC_MODES: readonly string[] = ['off', 'send', 'receive', 'full'];

/** 校验 gitSync 取值(供设置入口拒绝笔误,非法值 400 而非静默失效)。 */
export function isGitSyncMode(v: unknown): v is GitSyncMode {
  return typeof v === 'string' && GIT_SYNC_MODES.includes(v);
}

/** 目录的 wire 标识:优先 id,缺省用 path。 */
export function folderIdFor(folder: SharedFolderConfig): string {
  return folder.id ?? folder.path;
}

/**
 * 选择性同步判定:相对路径('/' 分隔,与索引同形)是否落在 dirs 里某个目录前缀
 * 之下(等于该目录本身,或其后代)。列表缺省/为空恒 false。
 */
export function isUnderDirPrefix(relPath: string, dirs: string[] | undefined): boolean {
  if (!dirs || dirs.length === 0) return false;
  for (const d of dirs) {
    if (relPath === d || relPath.startsWith(`${d}/`)) return true;
  }
  return false;
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
 * 某个共享目录的删除回收站目录:`<configDir>/trash/<index key 哈希>`。
 *
 * 刻意放在**共享目录之外**——放在共享根里的 `.syncx-trash` 会在用户的目录里留下常驻痕迹
 * (并被 `git status` 报成未跟踪文件)。命名与索引库同源(同一个 key、同一种哈希),使
 * 「目录实例 → 回收站」的对应关系与「目录实例 → 索引库」完全一致。
 *
 * 代价:共享盘与 configDir 不在同一个文件系统时,删除无法用 rename,退化为拷贝后删
 * (见 executor 的 moveToTrash),大文件会慢一些、瞬时占双倍空间。
 */
export function folderTrashPath(configDir: string, key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 16);
  return join(configDir, 'trash', hash);
}

/**
 * 某个共享目录的文件版本目录:`<configDir>/versions/<index key 哈希>`。
 *
 * 与回收站同一设计哲学、同一命名规则(同 key、同哈希):本机文件被对端版本**覆盖**前,
 * 旧内容快照一份到这里(见 executor 的 snapshotVersion)——回收站只保护「删除」,
 * 这里保护「修改」,被覆盖的旧内容不再直接丢失。
 * 同样刻意放在共享目录之外,不在用户目录留痕迹;跨文件系统时快照退化为拷贝。
 */
export function folderVersionsPath(configDir: string, key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 16);
  return join(configDir, 'versions', hash);
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

/**
 * 一条分享链接的持久化记录(免登录限时下载,见 share.ts)。
 * 令牌的签名不落盘(HMAC 由控制令牌派生);记录只存**校验与展示**所需:
 * id 是主键(撤销=删记录)、expiresAt 参与签名比对、downloads 是审计计数。
 * path 为共享目录内相对路径('/' 分隔);folderId 用 wire 口径(id ?? path)。
 */
export interface ShareRecord {
  id: string;
  folderId: string;
  path: string;
  createdAt: number;
  expiresAt: number;
  /** 成功匿名下载的累计次数(缺省 0)。 */
  downloads?: number;
  /** 最近一次匿名下载时间(毫秒)。 */
  lastDownloadAt?: number;
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
  /** 全局暂停同步:所有目录的数据面一起停摆;各目录自己的 paused 独立保留。 */
  paused?: boolean;
  /**
   * 分享链接总开关(默认关闭):true 才允许创建/使用 /s/ 免登录下载。
   * 关闭时既有的全部链接立即失效(404),不残留可达入口 —— 一键止血。
   */
  shareEnabled?: boolean;
  /** 在册的分享链接记录(见 ShareRecord / share.ts);撤销 = 从列表删记录。 */
  shares?: ShareRecord[];
  /**
   * 全局发送带宽上限(KB/s):目录未单独配置 maxBandwidthKbps 时的兜底默认。
   * 0/缺省 = 不限速。目录级配置优先级更高(未配置才落到这里)。
   */
  maxSendKbps?: number;
  /** 每路径保留的文件版本份数上限(超出删最旧,见 executor.pruneVersions)。缺省 10。 */
  versionsPerPath?: number;
  /** 每目录保留的同步记录条数上限(超出轮转,见 history.ts)。缺省 2000。 */
  historyMaxEvents?: number;
  /**
   * 同步事件 Webhook 地址(见 webhook.ts):完成 / 冲突 / 错误三类事件 POST 到这里。
   * 飞书群机器人地址自动按飞书格式加签。缺省/空 = 关闭。
   */
  webhookUrl?: string;
  /** Webhook 签名密钥:通用载荷带 x-syncx-signature HMAC 头;飞书按其算法加 timestamp/sign。 */
  webhookSecret?: string;
  /**
   * 检测到按流量计费的联网(WinRT CostType,见 powerguard)时自动挂起所有目录数据面。
   * 仅 Windows 生效;缺省/false = 关闭。
   */
  pauseOnMeteredNetwork?: boolean;
  /** 用电池且电量低于阈值时自动挂起数据面;仅 Windows 生效;缺省 = 关闭。 */
  pauseOnLowBattery?: boolean;
  /** 低电量挂起阈值(%),1–99;缺省 20。 */
  batteryPauseThreshold?: number;
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

/** 同步时段的合法形态:`HH:MM-HH:MM`(小时/分钟允许一位数,如 `8:00-22:30`)。 */
const SCHEDULE_RE = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

/** 校验同步时段字符串形态(供设置入口拒绝笔误,避免存进去才发现不生效)。 */
export function isValidSchedule(schedule: string): boolean {
  const m = SCHEDULE_RE.exec(schedule.trim());
  if (!m) return false;
  return Number(m[1]) <= 23 && Number(m[3]) <= 23 && Number(m[2]) <= 59 && Number(m[4]) <= 59;
}

/**
 * 某时刻是否处于同步时段内。规则:
 *  - 空/缺省 = 全天同步(返回 true);
 *  - 格式非法 = 全天同步 —— 时段是节流手段而非安全边界,解析失败按「不设限」处理,
 *    绝不因配置笔误把目录永久锁死;
 *  - `from === to` 视为零长度窗口,同样按全天处理(用户想要「只在某刻同步」没有意义);
 *  - 支持跨午夜(`22:00-08:00`):`from > to` 时落在两段任一即在窗口内。
 * 时段按 daemon 本机时区的墙上时间解释(用户填的就是自己看到的钟表时间)。
 */
export function isWithinSchedule(schedule: string | undefined, now: Date = new Date()): boolean {
  const s = schedule?.trim();
  if (!s) return true;
  const m = SCHEDULE_RE.exec(s);
  if (!m || !isValidSchedule(s)) return true;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  if (from === to) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (from < to) return cur >= from && cur < to;
  return cur >= from || cur < to;
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
    paused: parsed.paused === true ? true : undefined,
    // 分享链接:开关只认 true;记录逐条清洗(手改坏掉的 JSON 不能让脏条目进校验路径)
    shareEnabled: parsed.shareEnabled === true ? true : undefined,
    shares: sanitizeShares(parsed.shares),
    // 全局设置:手改 config.json 填了非法值(负数/字符串)时丢弃,回退默认,不让坏值外溢
    maxSendKbps: sanitizeCount(parsed.maxSendKbps, 0),
    versionsPerPath: sanitizeCount(parsed.versionsPerPath, 1),
    historyMaxEvents: sanitizeCount(parsed.historyMaxEvents, 1),
    // Webhook:手改 config.json 填了非字符串/空串时丢弃,与全局设置同一套「坏值回退」口径
    webhookUrl: normalizeWebhookString(parsed.webhookUrl, 500),
    webhookSecret: normalizeWebhookString(parsed.webhookSecret, 200),
    // 电源守卫:布尔开关只认 true(缺省/false 都不落 true);阈值非法丢弃回默认 20
    pauseOnMeteredNetwork: parsed.pauseOnMeteredNetwork === true ? true : undefined,
    pauseOnLowBattery: parsed.pauseOnLowBattery === true ? true : undefined,
    batteryPauseThreshold: sanitizePercent(parsed.batteryPauseThreshold),
  };
}

/**
 * 清洗分享记录列表:仅保留字段完整、时间可解释的条目(id/folderId/path 为非空字符串,
 * createdAt/expiresAt 为有限数且 expiresAt > createdAt),计数类字段丢弃非法值。
 * 超上限(500)从尾部截断 —— 上限只是防御坏数据撑爆配置,正常创建路径另有更严的活跃数约束。
 */
function sanitizeShares(v: unknown): ShareRecord[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ShareRecord[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const s = item as Record<string, unknown>;
    if (
      typeof s.id !== 'string' || s.id === '' ||
      typeof s.folderId !== 'string' || s.folderId === '' ||
      typeof s.path !== 'string' || s.path === '' ||
      typeof s.createdAt !== 'number' || !Number.isFinite(s.createdAt) ||
      typeof s.expiresAt !== 'number' || !Number.isFinite(s.expiresAt) ||
      s.expiresAt <= s.createdAt
    ) {
      continue;
    }
    const rec: ShareRecord = {
      id: s.id,
      folderId: s.folderId,
      path: s.path,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    };
    if (typeof s.downloads === 'number' && Number.isFinite(s.downloads) && s.downloads >= 0) {
      rec.downloads = Math.floor(s.downloads);
    }
    if (typeof s.lastDownloadAt === 'number' && Number.isFinite(s.lastDownloadAt)) {
      rec.lastDownloadAt = s.lastDownloadAt;
    }
    out.push(rec);
    if (out.length >= 500) break;
  }
  return out.length > 0 ? out : undefined;
}

/** 清洗百分比配置(1–99):非有限数/越界返回 undefined(调用方走内置默认)。 */
function sanitizePercent(v: unknown): number | undefined {  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  return n >= 1 && n <= 99 ? n : undefined;
}

/** 清洗一个 Webhook 字符串配置:非字符串/空白/超长返回 undefined。 */
function normalizeWebhookString(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s !== '' && s.length <= maxLen ? s : undefined;
}

/** 清洗一个「非负整数」配置值:非法(负数/非有限数)返回 undefined;0 保留(0 = 不限速语义)。 */
function sanitizeCount(v: unknown, min: number): number | undefined {
  const n = typeof v === 'number' ? Math.floor(v) : NaN;
  if (!Number.isFinite(n) || n < min) return undefined;
  return n;
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
    } catch (err) {
      // 只有「已被占用」值得重试;目录被删(ENOENT)/句柄耗尽等错误重试也不可能
      // 成功,立即抛出 —— 否则 microSleep 会阻塞事件循环空转满 5s 才报错
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
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
