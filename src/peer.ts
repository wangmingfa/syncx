import type { IndexEntry } from './index.js';
import { buildPlan, buildDeltaPlan } from './plan.js';
import type { BlockRequest, BlockResponse } from './messages.js';
import type { LocalExecutor, ReceiveHandle } from './executor.js';
import { resolveSharePath, preserveLocalAsConflict, createMemoryReceiveHandle } from './executor.js';
import { verifyBlock, hashBlock, BLOCK_SIZE, CDC_MAX_CHUNK } from './blockstore.js';
import { decPathFor, encryptBlock } from './e2e.js';
import { parseIgnoreRules, isIgnoredPath, isHardIgnored, type IgnoreRule } from './ignore.js';
import { mergeVersions } from './version.js';
import type { ConflictPolicy } from './config.js';
import type { ProgressCounts, TransferFile } from './status.js';
import { equalPairs, runAudit, type DriftReport } from './drift.js';

/**
 * 索引消息的两种语义:
 *  - `full`:这条消息是**本机索引的完整声明**(会话建立时互发),接收方按并集规划;
 *  - `delta`:只包含本轮改动的那几条,接收方**只判消息里提到的路径**。
 * 语义搞反的后果不对称:把 delta 当 full 会引发两端互为回声的无限循环
 * (2026-09-16 事故);把 full 当 delta 最多是少一次回推,而双方各自在会话建立时
 * 都会发 full,收敛不受影响。所以**缺省一律按 delta**(见 SyncPeer.onPeerIndex)。
 */
export type IndexMode = 'full' | 'delta';

export interface PeerTransport {
  sendEntries(entries: IndexEntry[], mode: IndexMode, opts?: { relayed?: boolean }): void;
  sendBlockRequest(request: BlockRequest): void;
  /** opts.priority = 源块请求带「优先同步」标记:实现侧据此把响应插到发送队列最前。 */
  sendBlockResponse(response: BlockResponse, opts?: { priority?: boolean }): void;
  /**
   * 本端「已经生成、还没真正离开本机」的字节数:排队中的信封 + 协议栈写缓冲。
   * 供块前的窗口判定用(见 SEND_WINDOW_BYTES)。
   *
   * 可选:它只是「实现侧愿意看见背压」的能力探测 —— 测试替身与不具备缓冲可见性的
   * 实现不提供时,调用方退回「不设限」的旧行为,而不是误判成「永远满」。
   */
  pendingOutboundBytes?(): number;
  /**
   * 订阅「发送侧腾出了空间」,返回退订函数。回调必须**幂等且轻量**:实现侧可能在
   * 每次出队与每次轮询都触发一次,不保证「刚好凑够一块」才叫醒。
   */
  onOutboundSpace?(cb: () => void): () => void;
}

/** 对端索引到达时的附加说明。缺省(undefined)按 delta 处理,见 IndexMode。 */
export interface PeerIndexOptions {
  full?: boolean;
  /**
   * 这条索引是中转来的(某兄弟 peer 收到后又转发给我),见 ADR-0014。
   * 接收端据此区分「并发版本 = 兄弟端自己真改过(保留冲突副本)」与
   * 「并发版本 = 兄弟端只是陈旧同步副本(直接覆盖,不生成 .sync-conflict)」,
   * 避免给从没改过文件的设备刷出一堆冲突副本。旧版对端不发该字段,忽略即可。
   */
  relayed?: boolean;
}

/** 一条待记录的同步变更(不含 folderId,由调用方补全)。 */
export interface SyncEventInput {
  ts: number;
  path: string;
  action: 'add' | 'update' | 'delete' | 'conflict';
  direction: 'local' | 'remote';
  deviceId?: string;
  /** 本次传输耗时(毫秒)。语义与缺省规则见 history.ts 的 SyncEvent.durationMs。 */
  durationMs?: number;
}

/**
 * 接收认领台账(目录级共享)里的一条记录:该路径的这个版本正被某条 SyncPeer
 * 管线接收中。claimId 标识认领者 —— 同一连接对同版本重规划(磁盘守卫重放、
 * 重复增量)不该被自己的认领挡住;连接拆除时按它精确释放,死认领者不卡活管线。
 */
export interface ReceiveClaim {
  claimId: number;
  /** 版本指纹(尺寸+全部块哈希的摘要):只对「同一版本」去重,不同版本照常规划 */
  key: string;
  ts: number;
}

/**
 * 认领的保鲜期:超过此时长的认领视作死认领,不再挡住其它管线。取值须大于一条
 * 健康接收的最坏时长:块级放弃上限(5s×3 快重试 + 30s 长重试)约 105s,再给
 * 大文件收块与落地留余量。连接拆除本就主动释放,这里只是进程内异常路径的兜底。
 */
const RECEIVE_CLAIM_TTL_MS = 5 * 60_000;

export interface SyncPeerDeps {
  transport: PeerTransport;
  localIndex: Map<string, IndexEntry>;
  executor?: LocalExecutor;
  readLocalBlock(path: string, blockIndex: number): Buffer;
  /**
   * CDC 口径的本地读块:按 (偏移, 长度) 只读内容分块列表里的某一块(预填与供块共用)。
   * 可选:旧调用方/测试没提供时,CDC 视图整体退化为定长块口径(只损失差集收益,
   * 不影响正确性)。实现侧须与 readLocalBlock 同样做符号链接越界守卫。
   */
  readLocalChunk?(path: string, offset: number, length: number): Buffer;
  deviceId: string;
  /** Peer device ID, used to name conflict copies. */
  remoteDeviceId?: string;
  /** 共享目录根路径:块请求服务侧用它拒绝经符号链接逃逸目录的路径。 */
  root?: string;
  /**
   * 取共享目录**当前生效**的忽略规则行(`.gitignore` + `.syncxignore` + 内置默认)。
   *
   * 是函数而非数组快照,这是刻意的:`.gitignore` 是运行期改的 —— `scanOnce` 每轮重读
   * 并整体回写 `folder.ignoreLines`。若在会话建立时快照一份,刚写进忽略的路径要等
   * 重连之后才被入向闸门挡住,而扫描侧(外推)下一轮就生效了 —— 同一个规则两个方向
   * 生效时间不一致,排查起来极难。
   *
   * 用途有二:接收保护据此跳过被忽略的文件(冷启动不覆盖);入向闸门据此丢弃
   * 命中的条目(见 docs/adr/0012)。
   */
  readIgnoreLines?: () => string[];
  /**
   * 从对端索引里丢弃硬忽略条目(见 HARD_IGNORE_NAMES)时回调一次,参数是路径列表。
   * 这条路径是「静默保护」——正常运行时不该触发,一旦触发说明对端在推 .git 之类的
   * 内容(对端版本旧、或对端把忽略规则负向覆盖了),值得在日志里留痕便于定位。
   */
  onHardIgnoredDropped?: (paths: string[], remoteDeviceId: string) => void;
  /** 记录一次同步变更(新增/修改/删除/冲突),由上层写入历史存储。 */
  onEvent?: (ev: SyncEventInput) => void;
  /**
   * 网络字节计数(流量统计):每发出一块/收下一块回调一次增量。
   * 与瞬时速率共用 recordBytes 通道 —— 本地预填的块(磁盘读)不走这里,口径是网络量。
   */
  onTraffic?: (sent: number, received: number) => void;
  /**
   * 收到并落地远程条目后回调(中转用,见 ADR-0014):上层据此把这批条目转发给
   * 同目录的其它 transport。只在「增量(非 full)接收」时触发——full 交换已经
   * 收敛整张网,无需再中转,否则每次(重)连都会把整份索引爆发式转发给兄弟端。
   * 包含真正进入 receive/conflict 落地的条目,以及应用对端墓碑的删除(二者的
   * 版本向量已是最终值);不含 send 与本地墓碑外推——这两类是本机决策动作,
   * 本机扫描生成它们时已通过 broadcast 广播过,再中转纯属重复。
   */
  onLanded?: (entries: IndexEntry[]) => void;
  /**
   * 一条待接收因块请求长期无响应而被放弃时回调(路径, 缺失块数)。这是
   * 「对端索引声明有、但内容长期供不出」的兜底出口 —— 典型是对端编辑器的
   * tmp 中间文件进了索引随即被改名。上层据此打 WARN 日志并刷新状态推送,
   * 否则用户只能对着一条永不消失的「接收中」进度条(2026-09-22 事故)。
   */
  onStallDrop?: (path: string, missingBlocks: number) => void;
  /**
   * 接收模式(只拉不推):本机只从对端拉取变更、应用对端删除,但**绝不**把本机
   * 的本地新增/修改/删除反灌给对端。开启后:本地较新/本地墓碑不再外推,冲突
   * 直接以对端版本覆盖本地。缺省 false = 双向同步。
   */
  receiveOnly?: boolean;
  /**
   * 取该目录**当前生效**的冲突自动处理策略(见 config.SharedFolderConfig.conflictPolicy)。
   * 与 readIgnoreLines 同理用函数而非快照:策略在设置弹窗改完后无需重连即生效。
   * 缺省(旧调用方/测试)按 'keep-both' = 现行为(拉回远端 + 本地留冲突副本)。
   */
  getConflictPolicy?: () => ConflictPolicy;
  /**
   * 磁盘空间守卫(见 ROADMAP「磁盘空间守卫」):本轮规划出的接收量(字节,已扣除
   * 将被覆盖的本地文件将释放的体积)在落盘前问一次上层。返回 false = 空间不足 →
   * 本轮**跳过全部 receive/conflict 动作**(删除照常应用 —— 删除是释放空间的方向;
   * send 也照常,推出去不占本机盘),并记下本轮索引,待空间恢复后由上层调
   * {@link SyncPeer.retryDiskBlocked} 重放。缺省(旧调用方/测试)恒放行。
   */
  checkDiskSpace?: (neededBytes: number) => boolean;
  /**
   * 按需同步(稀疏文件,见 config.SharedFolderConfig.onDemand / onDemandDirs):取该目录
   * 对**给定路径当前生效**的按需判定(与 getConflictPolicy 同构,设置弹窗改完即生效、无需
   * 重连)。整目录 onDemand 或路径命中 onDemandDirs 前缀时为 true —— 对端推来的**非空文件**
   * 只记占位条目(块哈希齐备、盘上无实体),不发块请求;用户点「下载」经
   * {@link SyncPeer.materialize} 才真正拉块落地。空文件无盘可省,照常落地;
   * 冲突路径需要内容,不受影响。入参为条目相对路径(旧调用方忽略之即可)。
   */
  getOnDemand?: (path: string) => boolean;
  /**
   * 单文件暂停(见 config.SharedFolderConfig.pausedFiles):该路径在本连接上**双向冻结**
   * —— send/receive/conflict/delete 动作一律跳过,本地索引不前移。恢复后下一轮索引
   * 交换自然收敛(两侧仍以各自的索引版本为准)。取函数:设置即生效,无需重连。
   */
  isPausedPath?: (path: string) => boolean;
  /**
   * 端到端加密视图(对不可信peer的盲区口径,见 src/e2e.ts):该目录为此对端设了口令时,
   * 上层交给它的 transport 已是密文变换壳(sendEntries 前条目被换成密文视图)。SyncPeer
   * 再补两道:①对端索引宣告**整轮忽略**(盲区端只有密文副本,它的「回推」会把密文当
   * 明文塞进本机共享目录);②块请求按「密文路径→解回明文路径→读明文块→现场加密」响应,
   * 全程不出明文内容。缺省 undefined = 普通双向同步,一切照旧。
   */
  e2eKey?: Buffer;
  /**
   * 接收认领台账(同一共享目录的**所有** SyncPeer 共享同一个 Map,由上层创建传入):
   * 设备对之间至多两条连接(每方向一条,设计内),每条会话各挂一份 SyncPeer,
   * 同一份增量会在两条连接各到一次 —— 两条管线并发比对同一份尚未前移的
   * localIndex、各自拉块落地,第二次落地把窗口期的本地编辑原样打回(旧内容被
   * snapshotVersion 存档,事后两侧索引一致、扫描无感 = 静默永久分叉,2026-09
   * 混版本实测坐实)。规划接收前先在此认领:同版本已被**其它管线**认领(保鲜期内)
   * 就跳过。缺省(旧调用方/单测)不设闸门,行为与从前一致。
   */
  receiveLedger?: Map<string, ReceiveClaim>;
  /**
   * drift 哨兵(抽样审计)的出口:本轮抽到的若干条路径审完,把汇总计数与检出明细交上去。
   *
   * 上层拿它只有一件事可做 —— 落日志。SyncPeer 侧对检出的东西**不做任何处置**:要修就得在
   * 「本机这份」与「对端那份」之间挑一个赢家,而内容已经分叉的场景里恰恰没有任何证据说明
   * 哪份是对的。为什么宁可报而不修,见 docs/adr/0022。
   *
   * 缺省(旧调用方/单测)不跑审计 —— 与 `SYNCX_DRIFT_SAMPLE_N=0` 同效。
   */
  onDriftAudit?: (report: DriftReport) => void;
  /**
   * drift 哨兵的节流状态(同一共享目录的**所有** SyncPeer 共享同一个对象,由上层创建传入):
   * 设备对之间至多两条连接(每方向一条,设计内),每条会话各挂一份 SyncPeer,而它们审的是
   * **同一份本机索引与同一块盘**。各记各的话,同一次分叉会按连接各报一遍(噪音),而轮次序号
   * 每次重连都归零 —— 抽样靠 (path, round) 取点,round 一归零就等于永远验同一个槽。
   * 与 receiveLedger 同理:共享的是「这一台机器上的事实」,不是「这一条连接上的事实」。
   * 缺省(旧调用方/单测)退化成每连接一份,行为与从前一致。
   */
  driftState?: DriftState;
}

/** drift 哨兵按目录共享的节流状态(见 SyncPeerDeps.driftState)。 */
export interface DriftState {
  /** 上次真跑审计的时刻(被闸门跳过的轮**不**推进它)。 */
  lastAt: number;
  /** 已跑过的轮次序号:抽样的步进与取槽都按它滚动。 */
  round: number;
}

export interface SyncPeer {
  onPeerIndex(entries: IndexEntry[], opts?: PeerIndexOptions): Promise<void>;
  onBlockRequest(request: BlockRequest): void;
  onBlockResponse(response: BlockResponse): Promise<void>;
  getSyncProgress(): ProgressCounts;
  /**
   * 磁盘守卫放行后重放被拦下的那轮索引(见 deps.checkDiskSpace)。
   * 没有积压(未拦截过 / 已重放)时是空操作;重放轮再次空间不足会重新挂起等待下次重放。
   */
  retryDiskBlocked(): void;
  /**
   * 「优先同步」(传输优先级):用户点名某在传文件插队。
   *
   * 本端能做两件事:①为该路径全部未收齐的块**重发**带 priority 标记的块请求 ——
   * 发送端据此把这些文件的块响应插到限速队列最前(重复响应在接收闸门处去重,安全);
   * ②记住该路径直到落地/中止,后续超时重试同样带标记,并在传输进度里透出 priority。
   * 不在接收中的路径调用是空操作(还没开传的文件本就按规划顺序进行,无需插队)。
   */
  markPriority(path: string): void;
  /**
   * 按需同步:把一个占位条目(见 IndexEntry.placeholder / deps.getOnDemand)真正拉回来
   * 落盘。复用既有块管线(pending + requestMissingBlocks + completeIfReady),零新协议帧。
   * 该路径此刻不在占位态(不是占位/不存在/已落地)时是空操作;已在拉取中则幂等。
   */
  materialize(path: string): boolean;
  /**
   * 释放本管线在接收认领台账(见 deps.receiveLedger)中的**全部**在手持仓,并作废本管线的
   * 在途接收(句柄收口、pending 清空)。
   * 连接拆除时必须调用:死掉的管线不落地也不重试,若留着认领,另一条(活着的)
   * 连接对同一版本会一直跳到保鲜期过,把一次普通的断开演变成分钟级的收敛延迟。
   */
  releaseClaims(): void;
}

interface PendingEntry {
  kind: 'receive' | 'conflict';
  /** The remote entry to land. */
  entry: IndexEntry;
  /** The local entry, only for conflicts. */
  local?: IndexEntry;
  /**
   * 落盘句柄:块到达即交给它逐块写盘(executor.beginReceive 的磁盘句柄,或无执行器时的
   * 内存替身)。「已收到哪些槽位 / 收了多少字节」都以它为准 —— pending 里不再留任何
   * 内容缓冲,接收侧的内存峰值因此与文件大小无关。
   */
  handle: ReceiveHandle;
  /**
   * 本次接收按 CDC 内容分块口径规划:true 时槽位下标对应 entry.cdh/clens
   * (而不是 entry.blocks);句柄据此决定每块的落盘偏移。
   */
  cdc: boolean;
  /**
   * 待接收的**规划时刻**(openPending 那一刻)。收齐落地时用它算 durationMs 写进同步记录。
   * 语义是「本机决定要收这个版本」→「文件落地完成」,含排队与逐块传输,不含对端生成内容。
   *
   * 注意它是**本轮规划**的时刻:断点续传接上旧 tmp 时磁盘进度可能来自更早的一轮,
   * 于是 durationMs 只计本次续传用时。宁可短报,不要把两轮之前的等待算进来。
   */
  startedAt: number;
}

/** 单个块请求的超时与重试状态。 */
interface PendingBlockRequest {
  timeout: ReturnType<typeof setTimeout>;
  retries: number;
  /** 所属接收路径(键只做身份、不做结构:清路径在途项按字段匹配)。 */
  path: string;
  /** 该在途请求的块口径(与所属 PendingEntry.cdc 一致),用于键消歧与重试闭包。 */
  cdc: boolean;
}

const BLOCK_REQUEST_TIMEOUT_MS = 5000;
const MAX_BLOCK_RETRIES = 3;
/** 快速重试耗尽后的长间隔退避:继续重试而非立即丢弃条目。 */
const BLOCK_RETRY_LONG_MS = 30_000;
/**
 * 块重试总上限(发送次数):3 次快速(5s)+ 20 次长间隔(30s)≈ 10 分钟。
 * 耗尽后放弃该块;某路径的全部在途块都放弃时,整条待接收一并放弃(见
 * dropIfUnservable)。无限重试的代价是「对端文件已消失时进度条永久虚报」
 * (2026-09-22 事故:对端编辑器 tmp 中间文件进索引后随即被改名,块请求永远
 * 无人应答,UI 挂着「接收 1 · 0%」十几小时),有界重试 + 下游自愈更划算。
 */
const MAX_BLOCK_RETRIES_TOTAL = 23;

/**
 * 「发送中」的租约时长:对端每来一个块请求,就给该路径续一次期;超过这个时长
 * 没有新请求,即认为这条文件已经传完。
 *
 * 用租约而不是「本轮计划推送的条数」这种计数器,是因为计数器没有衰减路径:
 * 它只在下一次收到对端索引时才被重算,而建立连接时互发的那次全量索引之后,
 * 对端可能很久都不再发索引 —— 于是卡片会永远停在「传输中 · 发送 N」(2026-09-16
 * 两端卡片转圈不停的事故形态之一)。租约天然自愈,不需要任何外部事件来清零。
 *
 * 取 15s:块请求的超时是 5s,正常的块流至少每 5s 会来一波(超时后的重试本身也续期),
 * 所以只有真正停下来不传了,租约才会过期。集成测试可用 SYNCX_SERVE_LEASE_MS 调短。
 */
const SERVE_LEASE_MS = Number(process.env.SYNCX_SERVE_LEASE_MS) || 15_000;

/**
 * 发送侧在途字节窗口:供一块之前先看「本机还悬着多少没发出去的字节」,超过上限就把
 * 这条块请求挂进延迟队列,而不是无脑把响应压进发送队列。
 *
 * 为什么必须有上限:接收端会为整个文件**一次性**发出全部缺块请求(见
 * requestMissingBlocks / requestMissingChunks),而发送队列的排空速度只受 TCP 与
 * 限速器支配。2.2GB 文件 = 550 条 4MB 块请求,每条在队列里都是一份 base64 后的
 * JSON 字符串(≈1.34 倍明文),实测把 daemon 顶到 8GB 堆上限 OOM —— 峰值正比于
 * 「对端一次要多少块」,而本机对此毫无发言权。
 *
 * 取 64MB:约 1GbE 上 0.5 秒的在途量,链路不会因为等本机放行而空转;又远大于一个
 * CDC 块的上线体量(4MB → ≈5.6MB),不至于一块就把窗口占死。慢链路上它退化成
 * 「至多攒 0.5 秒的量」,而「与文件大小无关」这条性质保持不变。
 * 集成测试可用 SYNCX_SEND_WINDOW_BYTES 调小,在小文件上触发挂起与重放。
 */
const SEND_WINDOW_BYTES = Number(process.env.SYNCX_SEND_WINDOW_BYTES) || 64 * 1024 * 1024;

/**
 * 延迟队列的长度上限(条数,不是字节)。挂起的只是请求元数据,给上限是因为请求由
 * 对端决定:不设限的话,一个恶意或陈旧的接收端可以无限索块,把「省内存」的机制
 * 变成另一种内存耗尽。到顶即视同「这条请求我没听见」,对端自会重试。
 */
const DEFERRED_MAX = 4096;

/**
 * drift 哨兵每轮抽样的路径条数默认值(见 drift.ts)。取 8:成本上界 = 8 次「读一块 + 一次
 * sha256」,与目录里有多少文件无关。一块的字节数按被验的那套视图定:定长块 ≤ BLOCK_SIZE,
 * 内容定义块 ≤ CDC_MAX_CHUNK —— 所以两侧都有 CDC 视图时,一轮的最坏情况是 32MB 而不是 8MB
 * (平均块长 ≈1MB,8MB 是典型值不是上限)。环境变量 SYNCX_DRIFT_SAMPLE_N 设 0 整道关闭。
 */
const DRIFT_SAMPLE_N_DEFAULT = 8;
/**
 * 两次审计的最小间隔默认值:半小时。哨兵要抓的是「静默分叉」,它以周为单位积累,
 * 半小时一轮已经把覆盖转完一圈绰绰有余(每轮 8 条、槽位随轮次轮换),再把间隔收紧
 * 就只是在给一个几乎不响的东西分配盘读预算。环境变量 SYNCX_DRIFT_INTERVAL_MS 覆盖。
 *
 * 两个旋钮都在**建管线时**读(见 createSyncPeer),不做成模块常量:那会把值冻在
 * import 那一刻,而「把抽样数压到 2、间隔压到 0」正是集成用例走到这条路径的办法。
 * 用 envInt 而不是本文件常见的 `Number(env) || 默认`:对抽样数来说 **0 是要能生效的
 * 取值**(关掉哨兵),而 `|| 8` 会把用户明确写下的 0 悄悄变回 8。
 */
const DRIFT_INTERVAL_MS_DEFAULT = 30 * 60 * 1000;

/** 读整型环境旋钮:未设/空串/非有限/负数都退回默认值。 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

/**
 * 速率采样窗口:瞬时速率 = 最近这段时间内实测字节的平均值。
 * 与兜底状态推送周期(5s)同阶,保证每次快照都能看到窗口内的新鲜数据。
 */
const RATE_WINDOW_MS = 5000;
/**
 * 窗口时间跨度的下限:刚开传的第一帧,分母若取真实跨度(可能只有几毫秒)
 * 会冒出离谱的瞬时峰值;按至少 1s 平滑。
 */
const RATE_SPAN_FLOOR_MS = 1000;

/**
 * 接收认领者的进程内身份发号:每条 SyncPeer 建出来分一个,台账据此区分
 * 「自己的重规划」与「另一条管线的同版本接收」。
 */
let NEXT_CLAIM_ID = 1;

/**
 * Wire one sync round over an injected transport: on receiving the peer's
 * index, send newer local entries, request missing blocks, apply deletions
 * and prepare conflict copies; collect block responses until a file is
 * complete, then apply it via the executor.
 */
export function createSyncPeer(deps: SyncPeerDeps): SyncPeer {
  const { transport, localIndex, executor, readLocalBlock, readLocalChunk, deviceId, remoteDeviceId, root, onEvent, onTraffic, readIgnoreLines, receiveOnly, getConflictPolicy, getOnDemand, isPausedPath, checkDiskSpace, onHardIgnoredDropped, onLanded, onStallDrop, e2eKey, receiveLedger, onDriftAudit, driftState } = deps;
  const pending = new Map<string, PendingEntry>();
  // 逐块跟踪超时重试:块响应丢失/丢弃时自动重发,避免文件永远收不齐
  const pendingBlocks = new Map<string, PendingBlockRequest>();
  // 磁盘守卫积压:被拦下的那轮索引原文,等上层空间恢复后经 retryDiskBlocked 重放。
  // 不能只等对端下一轮增量 —— 对端没有新改动就不会再发,接收会无限期停摆。
  let diskBlockedRetry: { entries: IndexEntry[]; opts?: PeerIndexOptions } | null = null;
  // 「优先同步」点名中的接收路径:块请求(含超时重试)都带 priority 标记,
  // 直到该文件落地 / 中止 / 被放弃才清除(见 completeIfReady / abortPending / dropIfUnservable)。
  const priorities = new Set<string>();
  // 本管线的台账身份 + 当前持有的接收认领路径集(见 deps.receiveLedger)
  const claimId = NEXT_CLAIM_ID++;
  const myClaims = new Set<string>();
  // 正在向外供块的路径 → 最后一次发出该文件块的时间,用于展示「发送中」(见 SERVE_LEASE_MS)
  const serving = new Map<string, number>();
  // 文件级发送进度:每个供块路径累计 已发字节 / 总字节。servedBlocks 记录已发出的块下标,
  // 对端重试同一块时不重复计入(否则进度会虚高)。总字节取本地索引的 size,缺则回退 0。
  const servingBytes = new Map<string, { done: number; total: number }>();
  const servedBlocks = new Map<string, Set<number>>();
  // 速率采样:每个块「真正发出 / 真正收下」时记一笔(t + 字节数),读取时按滚动窗口
  // 平均。放在 peer 级(每对端一份)而非全局:速率天然按「目录 × 对端」隔离,join 后
  // 的 ProgressCounts 就各自带各的速率。本地预填的块不记 —— 那是磁盘读,不是网络传输。
  const rateSamples: Array<{ t: number; sent: number; recv: number }> = [];
  function pruneRateSamples(now: number): void {
    while (rateSamples.length > 0 && now - rateSamples[0]!.t > RATE_WINDOW_MS) rateSamples.shift();
  }
  function recordBytes(sent: number, recv: number): void {
    const now = Date.now();
    rateSamples.push({ t: now, sent, recv });
    pruneRateSamples(now);
    // 同一口径喂给全局流量账本(累计 + 采样环);本地预填不走这里,记的都是网络量
    if (onTraffic && (sent > 0 || recv > 0)) onTraffic(sent, recv);
  }
  /** 窗口内的平均速率(字节/秒);窗口里没有该方向的字节时返回 0(上层据此省略字段)。 */
  function bytesPerSecond(kind: 'sent' | 'recv'): number {
    pruneRateSamples(Date.now());
    if (rateSamples.length === 0) return 0;
    let sum = 0;
    for (const s of rateSamples) sum += s[kind];
    const spanMs = Math.max(Date.now() - rateSamples[0]!.t, RATE_SPAN_FLOOR_MS);
    return Math.round(sum / (spanMs / 1000));
  }

  // 忽略规则的解析结果按「数组实例」缓存:readIgnoreLines 每次扫描返回全新数组,
  // 引用变化即失效。这样一条索引消息只解析一次规则,而不是每个条目解析一遍
  // (`.gitignore` 动辄上百行,逐条构造正则的代价会随索引规模放大)。
  let cachedIgnoreLines: string[] | undefined;
  let cachedIgnoreRules: IgnoreRule[] = [];
  function currentIgnoreRules(): IgnoreRule[] {
    const lines = readIgnoreLines?.() ?? [];
    if (lines !== cachedIgnoreLines) {
      cachedIgnoreLines = lines;
      cachedIgnoreRules = parseIgnoreRules(lines);
    }
    return cachedIgnoreRules;
  }

  /**
   * 在途块请求的键:路径 + 块下标 + 块口径。cdc 参与键构造,因为同一路径下
   * 「定长第 i 块」与「CDC 第 i 块」是两个不同的东西(重规划切换口径时
   * 两套重试不能互相顶掉)。path/cdc 同时存进记录本体,清路径在途项按字段
   * 匹配而不是解析键字符串(路径可含冒号,键只做身份、不做结构)。
   */
  function blockKey(path: string, blockIndex: number, cdc: boolean): string {
    return `${cdc ? 'c' : 'b'}:${path}:${blockIndex}`;
  }

  // ---- 发送侧在途窗口(见 SEND_WINDOW_BYTES)----
  /**
   * 被窗口挡下来的块请求,按 FIFO 等待重放;带 priority 标记的插到队首。
   * 只存请求本身(几十字节元数据),**不读盘、不加密** —— 这正是它省内存的地方:
   * 挡在读取之前,而不是攒着已经读出来的块。
   */
  const deferredQueue: BlockRequest[] = [];
  /** deferredQueue 的键集合:同一块被对端超时重试 N 次,队列里也只留一份。 */
  const deferredKeys = new Set<string>();
  let pumpScheduled = false;

  /**
   * 这条请求的响应上线后大概占多少在途字节 —— **不读盘**的估算:索引里拿得到块长就按
   * 实际长度(CDC 块的 clens / 定长块的末尾残块),拿不到按该口径的上限;再加密文
   * tag(16B)、base64(×4/3)与 JSON 信封。宁可高估:高估只是这一轮少供一块,
   * 低估会让窗口形同虚设。
   */
  function expectedWireBytes(request: BlockRequest): number {
    let plain = request.cdc ? CDC_MAX_CHUNK : BLOCK_SIZE;
    const entry = localIndex.get(request.path);
    if (entry && !entry.deleted) {
      if (request.cdc) {
        if (cdcUsable(entry)) plain = entry.clens[request.blockIndex] ?? CDC_MAX_CHUNK;
      } else {
        const remain = entry.size - request.blockIndex * BLOCK_SIZE;
        if (remain > 0 && remain < BLOCK_SIZE) plain = remain;
      }
    }
    return Math.ceil((plain + 16) / 3) * 4 + 256;
  }

  /**
   * 发送侧还放得下这一块的量吗。transport 不报在途量(测试替身、无缓冲可见性的
   * 实现)时恒为 true:退回不设限的旧行为,绝不因「拿不到数据」而永远挂起请求。
   */
  function hasSendRoom(wireBytes: number): boolean {
    const inFlight = transport.pendingOutboundBytes?.();
    if (inFlight === undefined) return true;
    // 单块就超过整个窗口时窗口没有意义(4MB 的 CDC 上限远小于 64MB,这条只防
    // 未来把窗口调小或把块调大时踩到):放行它,否则它会永远卡在队首,
    // 让整条延迟队列停摆 —— 那比当初的 OOM 更难查。
    if (wireBytes >= SEND_WINDOW_BYTES) return true;
    return inFlight + wireBytes <= SEND_WINDOW_BYTES;
  }

  /** 把一条供块请求挂进延迟队列(去重;优先请求插队到队首)。 */
  function deferRequest(request: BlockRequest): void {
    if (deferredQueue.length >= DEFERRED_MAX) return; // 满则装作没听见,对端的重试会再来
    const key = blockKey(request.path, request.blockIndex, request.cdc === true);
    if (deferredKeys.has(key)) return;
    deferredKeys.add(key);
    if (request.priority === true) deferredQueue.unshift(request);
    else deferredQueue.push(request);
  }

  /**
   * 重放延迟队列,直到窗口再次装满或队列清空。每次都重新读在途量:上一次重放
   * 自己就把窗口用掉了,不重新判定就会一路放行到 OOM。
   * fromPump=true 让 handleBlockRequest 跳过复检(复检已在队列头做过;再挡会形成
   * 「弹出→重新入队」的空转,而且重放时窗口判定刚通过)。
   */
  function pumpDeferred(): void {
    while (deferredQueue.length > 0) {
      const head = deferredQueue[0]!;
      if (!hasSendRoom(expectedWireBytes(head))) return;
      deferredQueue.shift();
      deferredKeys.delete(blockKey(head.path, head.blockIndex, head.cdc === true));
      handleBlockRequest(head, true);
    }
  }

  /**
   * 「腾出空间」回调的入口:合并到下一个微任务再重放。直接在回调栈里 pump 等于把
   * 「读盘 + 加密 + base64 一整窗」压在发送队列的出队循环里,一个 tick 能把 socket
   * 发送堵几百毫秒 —— 内存省了,链路反而抖。
   */
  function schedulePump(): void {
    if (pumpScheduled || deferredQueue.length === 0) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pumpDeferred();
    });
  }
  // 订阅一次即可:回调列表随 transport 一起回收,而 transport 与本管线同生共死。
  transport.onOutboundSpace?.(schedulePump);

  /**
   * 条目的版本指纹:尺寸 + 全部块哈希(CDC 视图一并计入)的摘要。只用于台账里
   * 「是否同一版本」的相等比较 —— 同一设备经两条连接发来的同一份宣告,结构相等,
   * 指纹必相等;任何真实改动(尺寸/块/边界变)指纹即变,新照收不误。
   */
  function versionKey(entry: IndexEntry): string {
    if (entry.deleted) return 'tombstone';
    return hashBlock(Buffer.from(`${entry.size}|${entry.blocks.join(',')}|${entry.cdh?.join(',') ?? ''}`, 'utf8'));
  }

  /**
   * 单飞闸门(主锁,见 deps.receiveLedger):该路径的这个版本若已被**另一条管线**
   * 认领且仍在保鲜期,返回 false —— 本管线跳过规划,杜绝双份落地互相覆盖;
   * 否则认领并返回 true。自己重认领同版本(磁盘守卫重放/重复增量)放行,
   * 不同版本覆盖认领(带保鲜期戳),台账里永远至多一条新鲜认领。
   */
  function tryClaim(path: string, entry: IndexEntry): boolean {
    if (!receiveLedger) return true;
    const key = versionKey(entry);
    const holder = receiveLedger.get(path);
    if (
      holder &&
      holder.claimId !== claimId &&
      holder.key === key &&
      Date.now() - holder.ts < RECEIVE_CLAIM_TTL_MS
    ) {
      return false;
    }
    receiveLedger.set(path, { claimId, key, ts: Date.now() });
    myClaims.add(path);
    return true;
  }

  /**
   * 释放本管线对该路径的认领(接收有了确定结局:落地/中止/放弃,或短动作即时释放)。
   * 台账已被其它管线的更新版本认领覆盖时不动它 —— 那条认领属于新持有者。
   */
  function releaseClaim(path: string): void {
    if (!receiveLedger || !myClaims.delete(path)) return;
    if (receiveLedger.get(path)?.claimId === claimId) receiveLedger.delete(path);
  }

  /** 中止某路径的在途接收与块重试:对端声明它已删除时,继续拉块毫无意义,
   *  而且迟到的块响应会把刚删除的文件临时复活。中间态一并作废 —— 这份内容已经
   *  没有出处了,留着只是盘上残骸。 */
  function abortPending(path: string): void {
    pending.get(path)?.handle.abort(false);
    pending.delete(path);
    priorities.delete(path);
    releaseClaim(path);
    for (const [key, request] of pendingBlocks) {
      if (request.path !== path) continue;
      clearTimeout(request.timeout);
      pendingBlocks.delete(key);
    }
  }

  /**
   * 某路径最后一个在途块请求被放弃时调用:条目仍未收齐 → 整条放弃接收。
   * 放弃是安全的,自愈路径有三 —— ①对端扫描器发现文件消失后推墓碑(delete
   * 分支本就会清 pending);②对端文件回来后推新版本增量(onPeerIndex 重新
   * 规划 receive,从零重排);③任何重连都会互发全量索引(full 轮重建)。
   * 反之留着只会让「接收中」永久虚报,误导用户以为传输卡死。
   *
   * 中间态这里**保留**(keepPartial):放弃的成因里有一大类是「对端这会儿供不出」
   * (文件被占用、链路抖动、对端重启),而不是「这份内容不存在」。等它回来重新宣告时,
   * 已收到的字节不必再传一遍。真有内容不存在的残骸由扫描器的 TTL 回收兜底。
   */
  function dropIfUnservable(path: string): void {
    const item = pending.get(path);
    if (!item) return;
    for (const request of pendingBlocks.values()) {
      if (request.path === path) return; // 还有别的块在途
    }
    item.handle.abort(true);
    pending.delete(path);
    priorities.delete(path);
    releaseClaim(path);
    onStallDrop?.(path, slotCount(item) - item.handle.count());
  }

  /** 发送单个块请求并设置超时重试。cdc = 请求按内容分块口径索块(见 BlockRequest.cdc)。 */
  function requestBlock(path: string, blockIndex: number, hash: string, cdc: boolean): void {
    const key = blockKey(path, blockIndex, cdc);
    const existing = pendingBlocks.get(key);
    const retries = existing?.retries ?? 0;
    if (existing) clearTimeout(existing.timeout);

    // 总重试耗尽:对端长期供不出这块(索引声明有,磁盘上多半已没有 ——
    // 典型如编辑器 tmp 中间文件)。不再发送,放弃该块;若这是该路径最后一个
    // 在途块,整条待接收一并放弃,进度条随之归零。
    if (existing && retries >= MAX_BLOCK_RETRIES_TOTAL) {
      pendingBlocks.delete(key);
      dropIfUnservable(path);
      return;
    }

    transport.sendBlockRequest({
      deviceId,
      path,
      blockIndex,
      hash,
      // 被「优先同步」点名的路径:请求带标记,让对端发送队列把这些块插到最前
      ...(priorities.has(path) ? { priority: true } : {}),
      // CDC 口径请求:对端(须是新版)按该条目的 clens 前缀和算偏移供块
      ...(cdc ? { cdc: true } : {}),
    });
    const nextRetries = retries + 1;
    // 快速重试(5s×3)覆盖瞬时故障(丢包/对端短暂忙碌),之后退避到 30s 长间隔,
    // 给对端较长故障(重启、文件被锁)留恢复窗口;超过总上限才放弃。
    const timeout = setTimeout(
      () => requestBlock(path, blockIndex, hash, cdc),
      nextRetries > MAX_BLOCK_RETRIES ? BLOCK_RETRY_LONG_MS : BLOCK_REQUEST_TIMEOUT_MS,
    );
    pendingBlocks.set(key, { retries: nextRetries, timeout, path, cdc });
  }

  /**
   * 条目是否具备可用的 CDC 视图:cdh 与 clens 等长且非空。
   * decodeIndex 已按同一口径做过严进(见 IndexEntry.clens),这里直接复用判定。
   */
  function cdcUsable(entry: IndexEntry): entry is IndexEntry & { cdh: string[]; clens: number[] } {
    return !!entry.cdh && !!entry.clens && entry.cdh.length > 0 && entry.cdh.length === entry.clens.length;
  }

  /** 一条待接收的块槽位数:按规划口径(CDC / 定长)取对应列表长度。 */
  function slotCount(item: PendingEntry): number {
    return item.cdc ? item.entry.cdh!.length : item.entry.blocks.length;
  }

  /** 待接收在某槽位上的期望哈希(口径跟随规划)。 */
  function slotHashes(item: PendingEntry): string[] {
    return item.cdc ? item.entry.cdh! : item.entry.blocks;
  }

  /**
   * 本轮接收是否按 CDC 口径规划。判据全在「本端能不能差集」:对端条目带 cdh/clens
   * 而本机对应条目也有 CDC 视图(实体文件在盘上)才启用 —— 能算出差集才有收益。
   * 「对端供不出 CDC 块」不构成风险:对端能把 cdh 宣告出来,就必然能按自己算的
   * clens 供块(同一份内容的纯函数);真对不上(旧数据/竞态)接收端哈希闸门会拦下,
   * 走既有的有界重试 + 放弃 + 下轮收敛,退化的是效率,不是正确性。
   * 占位条目(盘上无实体)按定长口径:materialize 本就要拉全部内容,无差集可言。
   */
  function planCdc(remoteEntry: IndexEntry): boolean {
    if (!cdcUsable(remoteEntry) || readLocalChunk === undefined) return false;
    const local = localIndex.get(remoteEntry.path);
    return !!local && !local.deleted && !local.placeholder && cdcUsable(local);
  }

  // drift 哨兵的旋钮:抽样条数与最小间隔。envInt 而不是 `Number(x) || 默认值`:显式 0
  // (整道关掉)必须能表达。两个都在**建管线时**读,不做模块常量,否则值冻在 import 时。
  const sampleN = envInt('SYNCX_DRIFT_SAMPLE_N', DRIFT_SAMPLE_N_DEFAULT);
  const intervalMs = envInt('SYNCX_DRIFT_INTERVAL_MS', DRIFT_INTERVAL_MS_DEFAULT);
  // 节流状态按目录共享(见 deps.driftState):同一设备的两条连接各挂一份 SyncPeer,审的是同一块盘,
  // 各记各的会把一次分叉按连接报两遍,而轮次归零等于抽样槽位永远不轮换。
  // 未传时退化成每连接一份(旧调用方与单测的路径)。
  const drift = driftState ?? { lastAt: 0, round: 0 };

  /**
   * 闲时抽样审计(drift 哨兵)。三道门:①上层没接线或旋钮关到 0;②这条连接此刻有传输在跑
   * (`pending` 非空 = 本机正在收,盘上同一批路径正被逐块写;`serving` 非空 = 本机正在供块,
   * 再加 8 次定位读只是跟传输抢盘);③距**本目录**上次审计未到间隔(状态见 deps.driftState,
   * 所以这条闸门管的是整个目录,不是某一条连接 —— 代价是间隔到点后第一个交换索引的对端跑掉这一轮,
   * 其余对端整个窗口内被跳过;A 检查比的是那个对端的宣告,所以三台以上设备时安静的那几台覆盖率
   * 低于按轮数算出的上界,取舍见 ADR-0022 的 Consequences)。
   *
   * 挂在 `onPeerIndex` 末尾而不是扫描器里,是因为**候选集只在这一刻拿得起来**:本机不持久化
   * 每个对端的索引(每轮临时建一个 Map 就丢掉),离开这轮消息就没有「对端宣告」可比了。
   * 代价是审计跟着「有人来交换索引」走而不是跟着时钟走 —— 长期空闲意味着没有改动在流动,
   * 也就没有分叉在积累,这个方向上不亏。
   *
   * 端到端加密的对端走不到这里(`onPeerIndex` 开头就返回),这是对的:盲区端宣告的是密文视图
   * 的块哈希,拿它比本机明文盘等于把每条路径都报成漂移。
   */
  function runDriftAudit(remote: Map<string, IndexEntry>): void {
    if (onDriftAudit === undefined || sampleN === 0) return;
    if (pending.size > 0 || serving.size > 0) return;
    const now = Date.now();
    if (now - drift.lastAt < intervalMs) return;
    drift.lastAt = now;

    const candidates = equalPairs(remote.values(), localIndex);
    // 没有候选也照发报告:日志里的 sampled 计数就是「这一轮真跑了」的证据。
    // 少了它,「一切干净」与「哨兵从没跑起来」在日志里长得一模一样。
    drift.round++;
    const report = runAudit(candidates, {
      round: drift.round,
      n: sampleN,
      cdcOf: (pair) => planCdc(pair.remote),
      // 没有执行器就只跑 A:少了 verify 是「这道检查没做」,报成「做了且干净」是假安心。
      verify: executor ? (samples) => executor.verifySampledSlots(samples) : undefined,
    });
    onDriftAudit({ ...report, peer: remoteDeviceId ?? '', round: drift.round });
  }

  /**
   * 开启某路径的待接收:规划时刻定块口径(CDC / 定长),槽位数随口径取对应
   * 列表长度;此后请求、响应校验、收齐判定都用 slotCount/slotHashes 统一换算,
   * 内容则逐块交给落盘句柄(见 completeIfReady)。
   *
   * 句柄是断点续传的载体:同一内容的接收重新开启时,beginReceive 会读回磁盘上的旧位图,
   * 只补缺的槽位。**只可能**出现在全新规划的时刻 —— 若该路径已有在途接收(含半截 tmp),
   * 调用方要么走 materialize 的幂等分支,要么本轮直接跳过,不会重复 open。
   */
  function openPending(kind: 'receive' | 'conflict', remoteEntry: IndexEntry, local?: IndexEntry): void {
    const cdc = planCdc(remoteEntry);
    const slots = cdc ? remoteEntry.cdh!.length : remoteEntry.blocks.length;
    // 句柄创建即路径校验(执行器的硬忽略/越界闸门在这里是最后一道):不安全就整条不接收,
    // 后续 requestMissingBlocks 取不到 pending 项自然空转,本轮该路径不产生任何磁盘动作。
    let handle: ReceiveHandle;
    try {
      handle = executor?.beginReceive(remoteEntry, { cdc }) ?? createMemoryReceiveHandle(slots);
    } catch {
      // 不收这条:路径在执行器闸门处被拒(硬忽略 / 符号链接越界)。认领当场交还,
      // 否则台账要空挂到保鲜期过,把同一设备上别的版本一并挡在门外。
      releaseClaim(remoteEntry.path);
      return;
    }
    pending.set(remoteEntry.path, {
      kind,
      entry: remoteEntry,
      ...(local ? { local } : {}),
      handle,
      cdc,
      startedAt: Date.now(),
    });
  }

  /**
   * 请求一个文件缺失的块:先与本地索引比对块哈希,哈希相同的块直接从本地文件
   * 读取填充(免网络重传),其余才向对端发块请求。两种口径:
   *  - 定长:按**下标**对齐(本地第 i 块 vs 对端第 i 块)。改尾部块/追加受益,
   *    中部插入会让其后块整体错位、全不匹配,退化为全量请求(旧行为,原样保留);
   *  - CDC:按**哈希集合成员**对齐(见 requestMissingChunks)—— 边界随内容浮动,
   *    中部小改只让插入点附近的块变新哈希,其余块在本地文件里原样存在,直接预填。
   */
  function requestMissingBlocks(path: string, entry: IndexEntry): void {
    const item = pending.get(path);
    if (!item) return;
    if (item.cdc) {
      requestMissingChunks(path, item);
      return;
    }
    const localEntry = localIndex.get(path);
    // 墓碑条目内容不可信(文件已删,块哈希指向旧内容):整体走网络请求
    const localBlocks = localEntry && !localEntry.deleted ? localEntry.blocks : undefined;
    entry.blocks.forEach((hash, blockIndex) => {
      if (item.handle.has(blockIndex)) return; // 已预填或已收到,不重复
      if (localBlocks?.[blockIndex] === hash) {
        try {
          const data = readLocalBlock(path, blockIndex);
          // 本地文件可能在扫描与规划之间被改写:哈希校验不过就不信本地块
          if (verifyBlock(data, hash)) {
            item.handle.append(blockIndex, data);
            return;
          }
        } catch {
          // 文件被移动/删除/暂时不可读:回退网络请求
        }
      }
      requestBlock(path, blockIndex, hash, false);
    });
  }

  /**
   * CDC 口径的缺失块请求(见 requestMissingBlocks)。本地块按「哈希 → 偏移」的
   * **集合成员**匹配:块边界由内容决定,插入/删除让整体错位后,块自身的哈希
   * 依然与本地文件里同一段字节吻合 —— 这正是定长下标匹配做不到的差集。
   * 同哈希多块(重复内容)取最先出现的一处;读出的块仍逐块 verifyBlock 校验,
   * 本地文件在两处状态之间被改写时校验不过,自然回退网络请求。
   */
  function requestMissingChunks(path: string, item: PendingEntry): void {
    const entry = item.entry;
    const cdh = entry.cdh!;
    const clens = entry.clens!;
    const local = localIndex.get(path);
    const localHits = new Map<string, { offset: number; length: number }>();
    if (local && !local.deleted && !local.placeholder && cdcUsable(local)) {
      let lo = 0;
      for (let i = 0; i < local.cdh.length; i++) {
        const h = local.cdh[i]!;
        if (!localHits.has(h)) localHits.set(h, { offset: lo, length: local.clens[i]! });
        lo += local.clens[i]!;
      }
    }
    for (let i = 0; i < cdh.length; i++) {
      const hash = cdh[i]!;
      if (!item.handle.has(i)) {
        const hit = localHits.get(hash);
        if (hit) {
          try {
            const data = readLocalChunk!(path, hit.offset, hit.length);
            if (verifyBlock(data, hash)) item.handle.append(i, data);
          } catch {
            // 文件被移动/删除/暂时不可读:回退网络请求
          }
        }
      }
      if (!item.handle.has(i)) requestBlock(path, i, hash, true);
    }
  }

  /** 收齐全部块(或空文件本身)后把句柄落地;未就绪则无操作。 */
  async function completeIfReady(path: string): Promise<void> {
    const item = pending.get(path);
    if (!item || item.handle.count() !== slotCount(item)) return;

    pending.delete(path);
    priorities.delete(path); // 已落地:优先标记的使命完成,后续该路径的新传输回到默认排队

    try {
      if (item.kind === 'conflict' && item.local) {
        // 落地时重新读取本地最新条目:冲突规划到块收齐之间,本地可能已被
        // 新一轮扫描更新(A:1→A:2),用规划时捕获的旧版本合并会回退版本向量
        const currentLocal = localIndex.get(path) ?? item.local;
        const landed = await executor?.applyConflict(
          path,
          currentLocal,
          item.entry,
          item.handle,
          remoteDeviceId ?? '',
        );
        // 同步内存索引,使后续规划基于最新本地状态:以实际落盘结果为准
        if (landed) {
          localIndex.set(path, landed);
        }
        onEvent?.({
          ts: Date.now(),
          path,
          action: 'conflict',
          direction: 'remote',
          deviceId: remoteDeviceId,
          durationMs: Date.now() - item.startedAt,
        });
      } else {
        const isNew = !localIndex.has(path);
        // 冷启动保护:本机磁盘已有同名文件、但本机索引尚未记录(对端“热”且先于本机
        // 首扫推送)时,先保留为 .sync-conflict 副本,避免被对端版本静默覆盖。
        // 忽略规则命中的文件不保护(旧行为即会接收覆盖,避免把被忽略文件反向同步出去)。
        let preserved = false;
        if (isNew && root !== undefined && remoteDeviceId) {
          try {
            if (!isIgnoredPath(currentIgnoreRules(), path, false)) {
              preserved = preserveLocalAsConflict(root, path, remoteDeviceId);
            }
          } catch {
            // 路径校验 / 重命名失败不阻断接收,退回旧行为(覆盖);保护仅为防丢数据增强
            preserved = false;
          }
        }
        await executor?.finalizeReceive(item.entry, item.handle);
        localIndex.set(path, item.entry);
        onEvent?.({
          ts: Date.now(),
          path,
          action: preserved ? 'conflict' : isNew ? 'add' : 'update',
          direction: 'remote',
          deviceId: remoteDeviceId,
          durationMs: Date.now() - item.startedAt,
        });
      }
    } finally {
      // 句柄统一在此收口:落地成功时它是空操作(句柄已关、中间态已清),抛错时它关掉写句柄
      // 并把已收的字节留在盘上(keepPartial)—— 半途而废的接收下一轮 beginReceive 会接着写。
      // 不关句柄的代价是 Windows 上 tmp 一直被攥着:rename 不了、删不掉、目录也清不空。
      item.handle.abort(true);
      // 接收有了确定结局(成功落地,或抛错半途而废):交还认领,让同一设备的另一条
      // 连接在后续轮次仍能接手这一版本 —— 抛错那一种还会从磁盘中间态接着收
      // (pending 已删,但下一轮规划会经 beginReceive 读回位图续传)。
      releaseClaim(path);
    }
  }

  /**
   * 端到端加密视图下的供块(见 deps.e2eKey):盲区按预告的「encPath + 密文块哈希」来索块,
   * 本端解回真实路径读明文、现场加密、以密文块响应 —— 明文内容永不上线。
   * 任一校验不过(encPath 解不开 / 本地无此条目 / 块号越界 / 对方要的哈希与我现算的
   * 密文哈希不符)一律静默忽略:不符说明宣告与请求之间内容变过,或对端在乱问,
   * 让它的超时重试 + 下轮索引自然收敛即可。
   */
  function serveE2EBlock(request: BlockRequest, fromPump: boolean): void {
    if (e2eKey === undefined) return;
    // 盲区视图永远不带 cdh/clens(块长序列是内容侧信道,见 IndexEntry.cdh),
    // 盲区端也就只可能按定长口径索块;带 CDC 标记的请求不属于该会话的协议,忽略。
    if (request.cdc) return;
    let realPath: string;
    try {
      realPath = decPathFor(e2eKey, request.path);
    } catch {
      return;
    }
    const local = localIndex.get(realPath);
    if (!local || local.deleted) return;
    if (!Number.isInteger(request.blockIndex) || request.blockIndex < 0 || request.blockIndex >= local.blocks.length) return;
    // 在途窗口:挡在解路径与查索引之后、读盘与加密之前(见 SEND_WINDOW_BYTES)。
    // 估算按**明文**块长走 —— 密文比明文多一个 tag,响应再经 base64,已在
    // expectedWireBytes 里计入;盲区路径查不到本地条目,自然退回 BLOCK_SIZE 上限。
    if (!fromPump && !hasSendRoom(expectedWireBytes(request))) {
      deferRequest(request);
      return;
    }
    let plain: Buffer;
    try {
      plain = readLocalBlock(realPath, request.blockIndex);
    } catch {
      return;
    }
    const cipher = encryptBlock(e2eKey, request.path, request.blockIndex, plain);
    if (hashBlock(cipher) !== request.hash) return;
    serving.set(request.path, Date.now());
    const sentSet = servedBlocks.get(request.path) ?? new Set<number>();
    if (!sentSet.has(request.blockIndex)) {
      sentSet.add(request.blockIndex);
      servedBlocks.set(request.path, sentSet);
      const rec = servingBytes.get(request.path) ?? { done: 0, total: 0 };
      rec.done += cipher.length;
      servingBytes.set(request.path, rec);
    }
    recordBytes(cipher.length, 0);
    transport.sendBlockResponse(
      { deviceId, path: request.path, blockIndex: request.blockIndex, hash: request.hash, data: cipher },
      { priority: request.priority === true },
    );
  }

  /**
   * 供块总入口:校验请求 → (窗口允许才)读盘 → 加密上线。
   *
   * `fromPump` = true 表示这条来自延迟队列重放:pumpDeferred 已在队列头确认过窗口
   * 有位置,这里不再复检 —— 复检会因估算误差把它重新挂回队列,和「弹出→入队」一起
   * 构成空转。其余闸门(路径防护、索引越界、本地读取)一律照走,重放的请求
   * 与刚到的请求在同一条代码路径上,不存在「重放绕过了校验」的暗道。
   */
  function handleBlockRequest(request: BlockRequest, fromPump: boolean): void {
    // 端到端加密视图:盲区按「密文路径 + 密文块哈希」索块,服务路径完全不同,整支移交
    if (e2eKey !== undefined) {
      serveE2EBlock(request, fromPump);
      return;
    }
    // 越界/非整数索引直接拒绝,避免对本地文件做无谓的整文件读取
    if (!Number.isInteger(request.blockIndex) || request.blockIndex < 0) return;
    // 读取侧路径防护(与写入侧 resolveSharePath 同款):拒绝 ../ 与经符号链接
    // 逃逸共享目录的路径,防止恶意对端经块请求读取目录外文件
    if (root !== undefined) {
      try {
        resolveSharePath(root, request.path);
      } catch {
        return;
      }
    }
    // 在途窗口:必须挡在读盘之前 —— 读出来再挂起等于什么都没省(见 SEND_WINDOW_BYTES)
    if (!fromPump && !hasSendRoom(expectedWireBytes(request))) {
      deferRequest(request);
      return;
    }
    let data: Buffer;
    let layoutHash: string;
    if (request.cdc) {
      // CDC 口径:按本机条目 clens 前缀和定位偏移,只供那一块。
      // 本机没有该路径的 CDC 视图(旧数据/版本错位)时静默忽略 —— 对端走
      // 超时重试;错位是有界的(本机扫描重算后下一轮宣告就带上 cdh),且对端
      // 若真是旧版口径混发,哈希闸门自会拦下,不会落错内容。
      const entry = localIndex.get(request.path);
      if (readLocalChunk === undefined || !entry || entry.deleted || !cdcUsable(entry)) return;
      if (request.blockIndex >= entry.cdh.length) return;
      let offset = 0;
      for (let i = 0; i < request.blockIndex; i++) offset += entry.clens[i]!;
      try {
        data = readLocalChunk(request.path, offset, entry.clens[request.blockIndex]!);
      } catch {
        return;
      }
      layoutHash = entry.cdh[request.blockIndex]!;
    } else {
      try {
        data = readLocalBlock(request.path, request.blockIndex);
      } catch {
        // 本地文件可能在块请求在途时被删除或重命名(如同步冲突处理),
        // 对端会在下一轮索引交换中收敛;忽略该请求即可。
        return;
      }
      layoutHash = request.hash;
    }
    // 块确实发出去了 → 该路径进入「发送中」,并按最后一个块续期租约
    serving.set(request.path, Date.now());
    // 文件级发送进度:按块精确累计,跳过已发过的块(对端重试不重复计)
    const sentSet = servedBlocks.get(request.path) ?? new Set<number>();
    if (!sentSet.has(request.blockIndex)) {
      sentSet.add(request.blockIndex);
      servedBlocks.set(request.path, sentSet);
      const total = localIndex.get(request.path)?.size ?? 0;
      const rec = servingBytes.get(request.path) ?? { done: 0, total };
      rec.total = total || rec.total;
      rec.done += data.length;
      servingBytes.set(request.path, rec);
    }
    // 块确实发出去了:记一笔发送字节,供瞬时速率统计
    recordBytes(data.length, 0);
    // 源请求带「优先同步」标记 → 本端发送队列把这个响应插到最前(见 wire.ts)
    transport.sendBlockResponse(
      {
        deviceId,
        path: request.path,
        blockIndex: request.blockIndex,
        // CDC 响应回填的是块的真实哈希(clens 若与对端认知有错位,接收端校验自然不过)
        hash: layoutHash,
        data,
        ...(request.cdc ? { cdc: true } : {}),
      },
      { priority: request.priority === true },
    );
  }

  const self: SyncPeer = {
    async onPeerIndex(entries: IndexEntry[], opts?: PeerIndexOptions): Promise<void> {
      // 端到端加密视图(不可信对端):本机对该对端**只出不进**。盲区端回推的索引全是
      // 密文视图条目(路径是密文名、块哈希是密文块的),若当真接收会把密文当明文写进
      // 共享目录;它也没有本机没有的东西,整轮直接忽略最安全。
      if (e2eKey !== undefined) return;
      // 缺省按 delta 处理。旧版对端不带 full 字段,而它**确实**会发增量索引
      // (扫描到改动就只广播那几条);把增量当全量做并集规划,就会为「它没提到的
      // 本地条目」回推变更 → 两端互为回声、无限循环。反过来把全量当增量最多是
      // 这一轮少回推一次,而双方在会话建立时都会各发一次全量,收敛不受影响。
      const full = opts?.full ?? false;

      // 全量轮次:这条消息是对端索引的完整声明,可以据此丢弃上一轮的在途状态
      // (基于过期条目重试的块请求、已不再被对方索引引用的 pending)。增量轮次
      // 绝不可做这两件事:消息里没提到 ≠ 对端没有了,清掉会把正在传的文件腰斩。
      if (full) {
        for (const bReq of pendingBlocks.values()) clearTimeout(bReq.timeout);
        pendingBlocks.clear();
      }

      // 入向闸门一:硬忽略(.git/.hg/.svn/.syncx-trash/.syncx-folder,见 ADR 0008)——
      // 对端推来的这些条目**一条都不收**,活条目与墓碑一视同仁。这是「本机 .git 被对端搅坏」
      // 唯一可靠的堵法——本机的忽略集管不住对端的忽略集:对端版本旧(早于内置忽略加入)、
      // 或对端在 .syncxignore 里写了 `!.git`,都会把 .git 条目推过来。若不拦,活条目会被写进
      // 本机 .git 目录,墓碑会让本机真实的 .git 文件被移进回收站(2026-09-15 事故即此路径)。
      // 丢弃后不进 buildPlan,因此既不落盘也不回推,对端下一轮仍会推,但每次都被丢弃。
      //
      // 入向闸门二:本机忽略规则(.gitignore/.syncxignore,见 ADR 0012)—— **同样活条目与
      // 墓碑一律丢弃**。只挡外推是不够的:被忽略的路径本机不再扫描,它的本地改动就
      // **没有任何索引保护**,而对端的索引里往往仍留着这条(规则变更不会回溯清理任何一端的
      // 索引库),会话建立互发全量索引时本机内存索引已过滤掉它 → 被判成「对端有、本机没有」
      // = remote-newer → 拉回来覆盖落盘。而冷启动保护(preserveLocalAsConflict)对被忽略路径
      // 是刻意跳过的,所以没有冲突副本、直接盖掉(2026-09-16 实测:/shared/mo 的
      // .workbuddy/memory/*.md 与 .idea/workspace.xml 在本机重启时被对端那份旧内容盖回)。
      // 丢弃意味着忽略路径**不会再被本机应用任何入向变更**:对端新增/修改不再覆盖本机,
      // 对端删除也不再跟着删——两边安静分叉,这正是「本机不碰它」的语义。
      // 注意硬忽略仍走在前面:它比用户规则更强(不可用 `!` 解开),这里的分支只是为了留痕。
      const rules = currentIgnoreRules();
      const dropped: string[] = [];
      const remote = new Map<string, IndexEntry>();
      for (const e of entries) {
        if (isHardIgnored(e.path)) {
          dropped.push(e.path);
          continue;
        }
        if (isIgnoredPath(rules, e.path, false)) continue;
        remote.set(e.path, e);
      }
      if (dropped.length > 0) {
        onHardIgnoredDropped?.(dropped, remoteDeviceId ?? '');
      }

      const actions = full ? buildPlan(localIndex, remote) : buildDeltaPlan(localIndex, remote);
      // 磁盘空间守卫:先预估本轮入向体积(扣除被覆盖的本地文件将释放的空间,
      // 再扣除已在磁盘中间态里的那些字节),不足就整轮跳过 receive/conflict ——
      // 宁可推迟,也不要写到一半失败。
      // 删除照常应用(它是释放空间的方向),send 照常外推(不占本机盘);
      // 本轮索引原文记下,空间恢复后由上层调 retryDiskBlocked 重放。
      let diskSkipsReceive = false;
      if (checkDiskSpace) {
        let needed = 0;
        for (const action of actions) {
          if (action.kind !== 'receive' && action.kind !== 'conflict') continue;
          const incoming = action.kind === 'receive' ? action.entry : action.remote;
          // 按需同步下 receive 会变成占位(不占盘),不计入预估;冲突仍需内容,照算
          if (action.kind === 'receive' && incoming.blocks.length > 0 && getOnDemand?.(action.path)) continue;
          const current = localIndex.get(action.path);
          // 在途 tmp 已占的字节要扣:阶段 2 之后 tmp 活到整场传输结束(断线重连还留着),
          // 不扣就把「已经写好的那一半」当成新一轮需求 —— 同目录连续传几个大文件会误报空间不足。
          // 块口径必须与 openPending 同一个 planCdc:口径不同则指纹与槽位数都不同,位图读不出来,
          // 这一段就白扣了(偏保守,不写坏数据)。partialBytes 自己保证不抛错。
          const already = executor?.partialBytes(incoming, { cdc: planCdc(incoming) }) ?? 0;
          needed += Math.max(0, incoming.size - (current && !current.deleted ? current.size : 0) - already);
        }
        if (needed > 0 && !checkDiskSpace(needed)) {
          diskSkipsReceive = true;
          diskBlockedRetry = { entries, opts };
        } else {
          // 本轮放行:清掉此前的积压,避免重连/新改动后旧索引被重复重放
          diskBlockedRetry = null;
        }
      }
      const sends: IndexEntry[] = [];
      // 本轮索引实际引用的 pending 路径:仅用于全量轮次清理上一轮遗留的陈旧条目
      const livePending = new Set<string>();
      // 本轮真正落地(receive/conflict 接收、应用对端墓碑)的远程条目:供 onLanded 中转给兄弟端
      const landed: IndexEntry[] = [];

      for (const action of actions) {
        // 单文件暂停:该路径在本连接上双向冻结 —— 不外推、不落地、不应用删除,
        // 本地索引保持原版本;解冻后下一轮交换自然收敛
        if (isPausedPath?.(action.path)) continue;
        if (diskSkipsReceive && (action.kind === 'receive' || action.kind === 'conflict')) continue;
        switch (action.kind) {
          case 'send':
            // 接收模式:本地较新的变更绝不外推,仅作为镜像忽略
            if (!receiveOnly) sends.push(action.entry);
            break;
          case 'delete': {
            const localEntry = localIndex.get(action.path);
            const remoteEntry = remote.get(action.path);
            if (localEntry?.deleted) {
              // 本地墓碑:接收模式下不外推(避免把完整端误删),双向模式才传播给对端
              if (!receiveOnly) sends.push(localEntry);
            } else if (remoteEntry?.deleted) {
              // 对端墓碑:本地删除。接收模式下同样执行——对端即权威源,删除也跟随
              await executor?.applyDelete(action.path, remoteEntry);
              localIndex.set(action.path, remoteEntry);
              // 该路径已在对端消失,中止本机在途接收,避免迟到块响应把它复活
              abortPending(action.path);
              onEvent?.({ ts: Date.now(), path: action.path, action: 'delete', direction: 'remote', deviceId: remoteDeviceId });
              // 应用对端墓碑也要纳入中转(ADR-0014):否则 hub 应用删除后,兄弟端在
              // 增量通道上永远学不到这条墓碑(本端扫描不会再为它生成事件,索引里已是
              // 墓碑),文件在兄弟端残留到下一次 full 交换(重连)才被补删——三端拓扑下
              // 「编辑器 tmp 中间文件」在叶子端长期残留即此形态(2026-09-20)。接收端走
              // 同一套 plan 机器:并发真改动仍按 conflict 保留冲突副本,不会误删。
              landed.push(remoteEntry);
            }
            break;
          }
          case 'receive': {
            const remoteEntry = remote.get(action.path);
            if (remoteEntry) {
              // 单飞闸门:同一设备的另一条连接已在接收这一版本 → 本管线跳过
              // (双份落地互相覆盖是静默分叉的根因,见 deps.receiveLedger)
              if (!tryClaim(remoteEntry.path, remoteEntry)) break;
              // 按需同步:非空文件先只记占位条目(块哈希齐备、盘上无实体),
              // 不发块请求、不落盘 —— 用户点「下载」时经 materialize() 再拉。
              // 空文件(blocks=0)无盘可省,照常即时落地。占位不进 landed(不中转),
              // 且 encodeIndex 把它挡在 wire 之外(不谎称自己供得出内容)。
              if (getOnDemand?.(remoteEntry.path) && remoteEntry.blocks.length > 0) {
                const placeholder: IndexEntry = { ...remoteEntry, placeholder: true };
                const isNew = !localIndex.has(remoteEntry.path);
                localIndex.set(remoteEntry.path, placeholder);
                await executor?.applyPlaceholder(placeholder);
                onEvent?.({
                  ts: Date.now(),
                  path: remoteEntry.path,
                  action: isNew ? 'add' : 'update',
                  direction: 'remote',
                  deviceId: remoteDeviceId,
                });
                // 占位是即时短动作(不进 pending),做完即交还认领
                releaseClaim(remoteEntry.path);
                break;
              }
              openPending('receive', remoteEntry);
              livePending.add(remoteEntry.path);
              landed.push(remoteEntry);
              requestMissingBlocks(remoteEntry.path, remoteEntry);
              // 空文件(0 块)不产生块请求,直接落地
              await completeIfReady(remoteEntry.path);
            }
            break;
          }
          case 'conflict': {
            const remoteEntry = remote.get(action.path);
            const localEntry = localIndex.get(action.path);
            // 单飞闸门:冲突动作同样会拉块+落地(或外推合并版本),双管线并发动手
            // 会刷出两份冲突副本/重演覆盖,与 receive 同闸
            if (remoteEntry && !tryClaim(action.path, remoteEntry)) break;
            // 本端是否真的改过这条文件:版本向量里带本机 deviceId 计数器 > 0 才算。
            // 否则只是「之前从别处同步来的陈旧副本」,与中转来的并发版本不构成真冲突。
            const genuineLocalEdit = !!localEntry && (localEntry.version.get(deviceId) ?? 0) > 0;
            // 中转场景(relayed):兄弟端只是陈旧同步副本 → 直接覆盖,不生成 .sync-conflict
            // (ADR-0014)。接收模式本就镜像覆盖。这两种都走 receive 落地,不保留冲突副本。
            if (receiveOnly || (opts?.relayed === true && !genuineLocalEdit)) {
              if (remoteEntry) {
                openPending('receive', remoteEntry);
                livePending.add(remoteEntry.path);
                landed.push(remoteEntry);
                requestMissingBlocks(remoteEntry.path, remoteEntry);
                await completeIfReady(remoteEntry.path);
              }
              break;
            }
            // 冲突自动策略(目录配置 conflictPolicy;缺省 keep-both = 下面的冲突副本行为)。
            // 只介入「真正的双活内容并发」:任一侧是墓碑时不判新旧/胜负,
            // 走既有 applyConflict 路径(双方删除有专门的墓碑合并)。
            const policy = getConflictPolicy?.() ?? 'keep-both';
            if (
              policy !== 'keep-both' &&
              remoteEntry &&
              localEntry &&
              !remoteEntry.deleted &&
              !localEntry.deleted
            ) {
              // 判胜负:local-wins 无条件保本地;newest-wins 比对双方 mtime ——
              // 任一侧缺 mtime(旧版对端不发 / 本机条目未记录)或打平都判不了,
              // remoteWins 保持 undefined,退回 keep-both 留冲突副本。
              let remoteWins: boolean | undefined;
              if (policy === 'local-wins') {
                remoteWins = false;
              } else if (localEntry.mtime !== undefined && remoteEntry.mtime !== undefined) {
                if (remoteEntry.mtime > localEntry.mtime) remoteWins = true;
                else if (localEntry.mtime > remoteEntry.mtime) remoteWins = false;
              }
              if (remoteWins === true) {
                // 对端内容胜出:按 receive 直接落地覆盖本地,不生成冲突副本。
                // landRemote 覆盖前的 snapshotVersion 旧内容快照仍会留一份兜底。
                openPending('receive', remoteEntry);
                livePending.add(remoteEntry.path);
                landed.push(remoteEntry);
                requestMissingBlocks(remoteEntry.path, remoteEntry);
                await completeIfReady(remoteEntry.path);
                break;
              }
              if (remoteWins === false) {
                // 本机内容胜出:不拉任何块,只在索引里采纳合并后的版本向量。
                // merged 逐设备取 max、支配对端版本 → 把本机条目回推,对端本轮
                // 即判「我方较新」来拉本机内容,收敛由协议自然完成、不会乒乓。
                const keep =
                  (await executor?.applyConflictKeepLocal(localEntry, remoteEntry)) ??
                  { ...localEntry, version: mergeVersions(localEntry.version, remoteEntry.version) };
                localIndex.set(action.path, keep);
                sends.push(keep);
                onEvent?.({
                  ts: Date.now(),
                  path: action.path,
                  action: 'conflict',
                  direction: 'local',
                  deviceId: remoteDeviceId,
                });
                // 保本地不拉块,即时短动作:做完即交还认领
                releaseClaim(action.path);
                break;
              }
            }
            if (remoteEntry && localEntry) {
              openPending('conflict', remoteEntry, localEntry);
              livePending.add(remoteEntry.path);
              landed.push(remoteEntry);
              requestMissingBlocks(remoteEntry.path, remoteEntry);
              await completeIfReady(remoteEntry.path);
            } else if (remoteEntry) {
              // 认领了却没动手(本地条目缺失,冲突分支落空):交还认领不留悬仓
              releaseClaim(action.path);
            }
            break;
          }
        }
      }

      // 中转(ADR-0014):非 full 的增量接收落地后,把这批条目转发给同目录其它 transport。
      // 排除源端由 relayToSiblings 负责;full 交换已收敛整网,不中转避免(重)连时爆发式转发。
      // 接收模式(receiveOnly)设备不中转:它的契约就是「不向外推任何索引帧」,中转也是外推。
      if (!opts?.full && !receiveOnly && landed.length > 0) {
        onLanded?.(landed);
      }

      // 清理上一轮遗留、本轮**全量**索引已不再引用的陈旧 pending 条目:
      // 对端删除/改名后这些条目会永久滞留(进度虚报),且迟到的块响应
      // 可能把刚删除的文件临时复活。增量轮次不做这件事 —— 消息里没有的路径
      // 只是「这轮没提」,清掉就会把正在传的文件腰斩、且不会再有谁重新规划它。
      // 这里只需删 pending:本轮的 pendingBlocks 已在上面整体清掉(含全部定时器)。
      //
      // 中间态只关句柄、不删文件(abort(true)):同一台设备的另一条连接可能正在写同一个
      // tmp(认领保鲜期 5min 短于块重试预算 10min,两条管线确实能重叠),这里没有资格
      // 判它的字节没用。真没用的残骸由扫描器的 TTL 回收。
      if (full) {
        for (const path of pending.keys()) {
          if (!livePending.has(path)) {
            pending.get(path)!.handle.abort(true);
            pending.delete(path);
            releaseClaim(path);
          }
        }
      }

      // 出向硬闸门(localIndex 出口的兜底):进入 localIndex 的条目本已被 filterIndexedEntries
      // 与扫描器过滤过,这里再收一道,保证「任何来源的硬忽略条目都不上线」这一性质只由
      // 本文件的 sendEntries 调用点决定,不依赖上游每一处都记得过滤。
      const outbound = sends.filter((e) => !isHardIgnored(e.path));
      if (outbound.length > 0) {
        // 规划出来的回推永远是「针对某几条路径的应答」,即 delta
        transport.sendEntries(outbound, 'delta');
      }

      // 抽样审计放在最后:它要读盘(成本上限 = 抽样数 × 一块),不能压在本轮的回推之后。
      // 此刻本轮的动作已全部应用完,`pending` 反映的是「还有文件没收齐」——正在收就不审。
      runDriftAudit(remote);
    },

    onBlockRequest(request: BlockRequest): void {
      handleBlockRequest(request, false);
    },

    async onBlockResponse(response: BlockResponse): Promise<void> {
      const item = pending.get(response.path);
      if (!item) return;
      // 口径以 pending 规划时定下的为准(响应里的 cdc 回显只是线索,不作判据):
      // 期望哈希与槽位边界都从对应列表取,任何口径的迟到/杂散响应都过不了哈希闸门
      const hashes = slotHashes(item);
      // 边界校验:非法/越界 blockIndex 会写进句柄算出的偏移之外,污染 tmp 的字节布局
      if (
        !Number.isInteger(response.blockIndex) ||
        response.blockIndex < 0 ||
        response.blockIndex >= hashes.length
      ) {
        return;
      }
      // 块内容必须与本次请求期望的哈希一致(防对端回填自洽但错误的块)
      if (response.hash !== hashes[response.blockIndex]) return;
      // 大小上限:定长块不超过 BLOCK_SIZE,CDC 块不超过 CDC_MAX_CHUNK;
      // 超大响应直接丢弃,避免哈希前先撑爆内存
      if (response.data.length > (item.cdc ? CDC_MAX_CHUNK : BLOCK_SIZE)) return;
      if (!verifyBlock(response.data, response.hash)) return;
      // 重复响应(如重传)不重复计数,避免虚增提前落地不完整文件
      if (item.handle.has(response.blockIndex)) return;

      // 到达即落盘:句柄把它写进 tmp 的最终偏移,内存里不再攒任何块
      item.handle.append(response.blockIndex, response.data);
      // 块真的收下了(重复响应在上面已被挡掉):记一笔接收字节,供瞬时速率统计
      recordBytes(0, response.data.length);
      // 块在到达 = 这条认领还活着:保鲜期随进度滚动。上层拿「认领新鲜度」当
      // 接收在途的判据(git 提交通知的延迟结算),不能让慢链路上传了几十分钟
      // 的健康认领因规划时刻过期而误判为停摆。
      if (receiveLedger?.get(response.path)?.claimId === claimId) {
        receiveLedger.get(response.path)!.ts = Date.now();
      }

      // 块已收到,清除对应的超时重试
      const bKey = blockKey(response.path, response.blockIndex, item.cdc);
      const bReq = pendingBlocks.get(bKey);
      if (bReq) {
        clearTimeout(bReq.timeout);
        pendingBlocks.delete(bKey);
      }

      await completeIfReady(response.path);
    },

    getSyncProgress(): ProgressCounts {
      const files: TransferFile[] = [];
      // 接收中:已收字节直接问句柄(本地预填与断点续传接上的旧进度同样计入,因为
      // 它们都是真的落在了 tmp 里)
      for (const [path, item] of pending) {
        if (item.kind !== 'receive') continue;
        files.push({
          path,
          direction: 'receive',
          bytesDone: item.handle.bytes(),
          bytesTotal: item.entry.size,
          // 被「优先同步」点名中的行:UI 据此显示已提队状态,再点一次也无妨(幂等)
          ...(priorities.has(path) ? { priority: true } : {}),
        });
      }
      let receiving = 0;
      for (const item of pending.values()) {
        if (item.kind === 'receive') receiving += 1;
      }
      // 「发送中」= 租约内正被对端拉块的文件数。注意它统计的是**文件数**而不是块数:
      // 一个文件可能被请求几十个块,但对用户而言那是「1 个文件在传」。
      const now = Date.now();
      let servingCount = 0;
      for (const [path, ts] of serving) {
        if (now - ts > SERVE_LEASE_MS) {
          serving.delete(path);
          servingBytes.delete(path);
          servedBlocks.delete(path);
          continue;
        }
        servingCount += 1;
        const rec = servingBytes.get(path);
        if (rec) files.push({ path, direction: 'send', bytesDone: rec.done, bytesTotal: rec.total });
      }
      const result: ProgressCounts = {
        pending: pending.size,
        sending: servingCount,
        receiving,
      };
      // 速率按需携带:窗口内没有该方向的字节时省略字段,空闲快照保持与旧版同形
      const sendRate = bytesPerSecond('sent');
      if (sendRate > 0) result.sendRate = sendRate;
      const receiveRate = bytesPerSecond('recv');
      if (receiveRate > 0) result.receiveRate = receiveRate;
      if (files.length) result.files = files;
      return result;
    },
    retryDiskBlocked(): void {
      // 空间恢复后重放被拦下的那轮:与首次规划完全同路径(守卫再判一次,
      // 仍不足会重新挂起等下次重放,所以这里不必预判)。
      const saved = diskBlockedRetry;
      if (!saved) return;
      diskBlockedRetry = null;
      void self.onPeerIndex(saved.entries, saved.opts);
    },
    markPriority(path: string): void {
      const item = pending.get(path);
      if (!item) return; // 不在接收中:无队可插(还没开传的文件本就按规划顺序进行)
      priorities.add(path);
      // 为该路径全部未收齐的块**重发**带标记的块请求:发送端按请求标记把对应
      // 响应插到限速队列最前。重复块响应在 onBlockResponse 的闸门处去重,安全;
      // requestBlock 自身会清旧定时器,重试链不重复叠加。口径跟随该条待接收的规划。
      const hashes = slotHashes(item);
      for (let i = 0; i < hashes.length; i++) {
        if (!item.handle.has(i)) requestBlock(path, i, hashes[i]!, item.cdc);
      }
    },
    materialize(path: string): boolean {
      const entry = localIndex.get(path);
      // 只受理「本机有占位条目」的路径:非占位(已是实体)/ 不存在 / 墓碑都无需拉块
      if (!entry || entry.deleted || !entry.placeholder) return false;
      if (pending.has(path)) return true; // 已在拉取中:幂等
      // 去占位标志后走标准接收管线(pending → 块请求 → completeIfReady 落盘并 saveEntry,
      // 落地的 entry 不带 placeholder,索引自动从占位转实体)。
      // 口径必为定长:占位态盘上没有实体文件,planCdc 对占位条目判 false(无差集可言)。
      const target: IndexEntry = { ...entry, placeholder: undefined };
      // 认领同一版本:否则另一条连接在拉取窗口内规划同版本会双份落地(见 tryClaim)。
      // 落地终局由 completeIfReady 的 finally 交还;半途放弃(块重试耗尽)由 dropIfUnservable 交还。
      if (!tryClaim(path, target)) return true; // 他人在拉:幂等返回,不重复起头
      openPending('receive', target);
      requestMissingBlocks(path, target);
      return true;
    },

    releaseClaims(): void {
      // 管线随连接一起作废:在途接收的写句柄必须先关掉。Node 不会替你关打开的 fd,
      // 而一个被攥住句柄的 tmp 在 Windows 上既 rename 不掉也删不掉(内存版句柄无操作)。
      // 中间态一律保留:重连后的新管线经 beginReceive 读回位图,已收的字节不必重传。
      for (const item of pending.values()) item.handle.abort(true);
      pending.clear();
      if (!receiveLedger) return;
      for (const path of myClaims) {
        if (receiveLedger.get(path)?.claimId === claimId) receiveLedger.delete(path);
      }
      myClaims.clear();
    },
  };
  return self;
}
