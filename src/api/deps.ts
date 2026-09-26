import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SyncHistoryFilter } from '../history.js';
import type { IgnoreVerdict } from '../ignore.js';

export interface ControlServerDeps {
  token: string;
  /**
   * 数据目录(--config-dir / --config 的解析结果,cli 传 configPath 所在目录)。
   * GET /api/auth 会把它带给登录页:令牌输入框的路径提示据此动态生成,
   * 数据目录隔离(dev .syncx-dev / 自定义 --config)时不再误导用户去 ~/.syncx 找。
   */
  configDir?: string;
  /**
   * 账号密码落盘位置(cli 传 ~/.syncx/auth.json)。
   * 不传则禁用账号密码登录,只保留 control.token 一条通道;
   * 文件不存在时同样退回「仅令牌登录」,设置密码后才启用账号登录。
   */
  authFile?: string;
  /** stop 命令经 POST /api/shutdown 触发的优雅关闭;不传则该端点返回 503。 */
  shutdown?: () => void;
  /**
   * 状态推送通道(`WS /api/events`)。传入后控制服务在 upgrade 阶段完成鉴权并把
   * 连接交给它;不传则对 `/api/events` 的握手一律拒绝(测试里的最小 deps 用不着)。
   */
  statusHub?: { attach(socket: import('ws').WebSocket): void };
  /**
   * Web UI 触发的「从对端拉取安装包自更新」:完成校验与 updater 派发后返回新版本号;
   * 路由在响应完 HTTP 后调用 shutdown 优雅关闭,由 updater 完成换入与重启。
   * 抛错(设备离线/版本不匹配/校验失败)时路由返回 400 与原因。
   */
  selfUpdate?: (deviceId: string) => Promise<{ version: string }>;
  /** Web UI「检查更新」:立即查一次 npm registry;返回 undefined = 无可用更新。 */
  checkForUpdate?: () => Promise<{ latest: string; current: string } | undefined>;
  /** Web UI 确认后的 npm 自升级:下载官方 tgz → 校验 → updater 接管;抛错返回 400。 */
  selfUpdateNpm?: () => Promise<{ version: string }>;
  /**
   * Web UI「上传安装包」第一步:只读预检上传的 tgz —— 校验结构/包名/版本并实跑 -v,
   * 读出包内版本后清理临时目录,不改动任何运行期状态。current 为当前运行版本。
   */
  inspectLocalPackage?: (tgz: Buffer) => Promise<{ version: string; name: string; current: string }>;
  /**
   * Web UI「上传安装包」第二步:走与 npm/P2P 同一条自更新管线(校验 → updater 接管换入 →
   * 拉起新 daemon,失败回滚)。路由响应后优雅关闭,由 updater 完成替换。抛错返回 400。
   */
  selfUpdateUpload?: (tgz: Buffer) => Promise<{ version: string }>;
  getStatus: () => unknown;
  /** 添加共享目录;返回是否自动创建了不存在的目录(供前端提示)。
   *  receiveOnly 为 true 时该目录设为接收模式(只拉不推)。 */
  addFolder?: (path: string, devices: string[], id?: string, receiveOnly?: boolean) => boolean;
  /** 移除共享目录。opts.purgeIndex 为 true 时一并删除该目录的索引库文件(清掉历史残留)。 */
  removeFolder?: (path: string, opts?: { purgeIndex?: boolean }) => void;
  /** 添加一个已知对端设备 ID(按 ID 配对,不依赖邀请码)。可选 address 直接写入
   *  config.peers 并立即直连,用于跨网段/无 mDNS 时手动指定对方 ws:// 地址。 */
  addDevice?: (deviceId: string, address?: string) => void;
  /** 移除一个已知对端设备(同时从各目录 devices 中摘除)。 */
  removeDevice?: (deviceId: string) => void;
  /** 精确设置某目录的设备列表(按目录多选设备的提交)。 */
  setFolderDevices?: (path: string, devices: string[]) => void;
  /** 设置某目录是否遵循 .gitignore 忽略规则(缺省 true)。 */
  setFolderUseGitignore?: (path: string, enabled: boolean) => void;
  /** 设置某共享目录是否暂停同步(按 folderId;暂停 = 数据面停摆,控制面照常)。 */
  setFolderPaused?: (folderId: string, paused: boolean) => void;
  /** 设置某目录的同步时段(HH:MM-HH:MM,支持跨午夜;空串 = 清除,全天同步)。 */
  setFolderSchedule?: (folderId: string, schedule: string) => void;
  /** 设置某目录的 git 提交同步模式(off / send / receive / full)。 */
  setFolderGitSync?: (folderId: string, mode: 'off' | 'send' | 'receive' | 'full') => void;
  /** 设置某目录的冲突自动处理策略(keep-both / newest-wins / local-wins)。 */
  setFolderConflictPolicy?: (folderId: string, policy: 'keep-both' | 'newest-wins' | 'local-wins') => void;
  /**
   * 设置某目录的端到端加密口令 / 不可信节点名单(键出现才改;passphrase null/'' = 清除,
   * 连带清空名单)。生效靠 manager 内部摘挂数据通道,见 devices.setFolderE2E 与 e2e.ts。
   */
  setFolderE2E?: (folderId: string, patch: { passphrase?: string | null; untrusted?: string[] | null }) => void;
  /** 「优先同步」:把该目录某个在传文件的块请求插到对端发送队列最前。 */
  prioritizeTransfer?: (folderId: string, path: string) => void;
  /** 忽略规则编辑器:读 .syncxignore 原始行 + 内置默认 + 是否并入 .gitignore。 */
  getFolderIgnoreInfo?: (folderId: string) => { lines: string[]; builtin: string[]; useGitignore: boolean };
  /** 忽略规则编辑器:保存 .syncxignore 并让该目录规则立即生效。 */
  setFolderIgnoreLines?: (folderId: string, lines: string[]) => void;
  /** 忽略规则编辑器:实时测试一条路径(草稿行给定时按「保存后」预测)。 */
  testFolderIgnore?: (folderId: string, path: string, draftLines?: string[]) => IgnoreVerdict;
  /** 写入全局设置(设置弹窗):maxSendKbps / versionsPerPath / historyMaxEvents / webhook* / 电源守卫;null = 回默认。 */
  setGlobalSettings?: (patch: {
    maxSendKbps?: number | null;
    versionsPerPath?: number | null;
    historyMaxEvents?: number | null;
    webhookUrl?: string | null;
    webhookSecret?: string | null;
    pauseOnMeteredNetwork?: boolean | null;
    pauseOnLowBattery?: boolean | null;
    batteryPauseThreshold?: number | null;
  }) => void;
  /** 测试 Webhook:真实投递一条测试事件并等回执。 */
  testWebhook?: () => Promise<{ ok: boolean; error?: string }>;
  /** 「目录不可信」时重新采集身份指纹(仅更新 folderIdentity,不动索引)。 */
  reAdoptFolderIdentity?: (folderId: string) => void;
  /** 全局暂停/恢复同步(所有目录一起停;各目录自己的 paused 独立保留)。 */
  setGlobalPaused?: (paused: boolean) => void;
  /** 列出待确认项(对方推送的配对 / 目录共享邀请)。 */
  getOffers?: () => unknown;
  /**
   * 读取某共享目录的同步记录(倒序)。limit 为展示条数(路由已 clamp 到 1..HISTORY_MAX_EVENTS);
   * filter 为服务端筛选条件(direction/device/action/q)。
   * 返回 SyncHistoryResult:{ events, total, matched, oldestTs, maxRetention }。
   */
  getFolderHistory?: (folderId: string, limit?: number, filter?: SyncHistoryFilter) => unknown;
  /**
   * 全局时间线:汇总所有共享目录的同步记录按时间归并(条目带 folderPath)。
   * limit/filter 语义与 getFolderHistory 一致;total/matched 为各目录之和。
   */
  getGlobalHistory?: (limit?: number, filter?: SyncHistoryFilter) => unknown;
  /** 同步周报:近 7 天各目录变更/冲突/对端活跃度汇总(见 report.ts)。 */
  getWeeklyReport?: () => unknown;
  /** 清空某共享目录的同步记录(不可逆)。参数为目录 ID。 */
  clearFolderHistory?: (folderId: string) => unknown;
  /** 冲突收件箱:实时扫描共享目录内残留的 .sync-conflict-* 副本,返回 { conflicts, truncated }。 */
  listFolderConflicts?: (folderId: string) => unknown;
  /** 处理一条冲突副本:keep-local=副本覆盖回原路径(原内容留档);discard=副本进回收站。 */
  resolveFolderConflict?: (folderId: string, copyPath: string, choice: 'keep-local' | 'discard') => void;
  /** 冲突「查看对比」:原文件 vs 冲突副本两个本机侧,返回与 /api/folders/file 同形状的数据。 */
  conflictFilePair?: (folderId: string, copyPath: string) => unknown;
  /** 把逐块合并后的内容写回原文件(当前内容先留档;副本不动,由用户显式清理)。 */
  applyConflictMerge?: (folderId: string, copyPath: string, content: string) => void;
  /** 一键清理:把所有「与原文件无差异」的冲突副本移入回收站,返回 { removed } 条数。 */
  cleanIdenticalConflicts?: (folderId: string) => { removed: number };
  /**
   * 文件版本:被对端覆盖修改前,旧内容由 executor 自动快照进版本目录
   * (`<configDir>/versions/<index key>`,见 folderVersionsPath)。这里提供
   * 列表 / 恢复 / 删除。file 为版本文件相对版本目录的路径(含 `.syncx-v-` 时间戳后缀)。
   */
  listFolderVersions?: (folderId: string) => unknown;
  /** 把某个版本恢复回共享目录原路径(覆盖前当前内容也会留档一份)。 */
  restoreFolderVersion?: (folderId: string, file: string) => void;
  /** 删除单个版本文件(不可逆)。 */
  deleteFolderVersion?: (folderId: string, file: string) => void;
  /**
   * 文件时间机器:读取单个版本文件内容(时间轴上任意两版对比用)。
   * 返回 FileCompareData 单侧形状:{ exists, size, text? , binary? , tooLarge? }。
   */
  getFolderVersionContent?: (folderId: string, file: string) => unknown;
  /**
   * 文件时间机器:把整个目录回滚到目标时刻(证据=版本快照+回收站+同步记录,全启发式)。
   * dryRun 只回计划;执行时当前内容一律先进版本/回收站(回滚本身可逆)。
   */
  rollbackFolder?: (folderId: string, targetTs: number, dryRun: boolean) => unknown;
  /**
   * 内容对比(诊断):把本机某共享目录与指定对端的**同一目录 id** 逐条比对,
   * 返回分类后的差异报告(见 diff.ts)。全程只读,不改动任何一端的状态。
   * 设备离线 / 该目录未共享给对端 / 对端版本过旧时抛错,路由转成 400。
   */
  diffFolder?: (folderId: string, deviceId: string) => Promise<unknown>;
  /**
   * 双栏对比页:在差异分类之外,再给出**两侧的条目清单**(供目录结构对齐视图用)。
   * 与 diffFolder 同源、同样全程只读;失败原因也一致(离线 / 未共享 / 对端版本过旧)。
   */
  compareFolder?: (folderId: string, deviceId: string) => Promise<unknown>;
  /**
   * 读同一个文件在本机与对端的两侧内容(文件内容对比弹窗)。只读。
   * 二进制 / 超过体积上限时该侧不回传内容,只给大小与标记,由弹窗降级展示。
   */
  readFilePair?: (folderId: string, deviceId: string, path: string) => Promise<unknown>;
  /**
   * 把一侧文件的内容同步到另一侧(对比页的逐块应用 / 整文件覆盖)。
   * direction:'pull' 写入本机;'push' 写入对端。
   * content 省略表示「整文件照抄来源侧」,给了则以给定内容为准(逐块应用的结果)。
   */
  applyFileSync?: (opts: {
    folderId: string;
    deviceId: string;
    path: string;
    direction: 'pull' | 'push';
    content?: string;
  }) => Promise<void>;
  /**
   * 日志文件路径(--log-file 启动参数)。设置后 GET /api/logs 可读取日志尾部;
   * 未设置时该端点返回 ok:false,前端提示需以 --log-file 启动才有日志可看。
   */
  logFile?: string;
  /** 确认一个待确认项;目录共享邀请需附带 localPath(本机落地路径)。
   *  receiveOnly 为 true 时把该目录设为接收模式(只拉不推)。 */
  acceptOffer?: (offerId: string, localPath?: string, receiveOnly?: boolean) => void;
  /** 忽略一个待确认项。 */
  declineOffer?: (offerId: string) => void;
  /** 恢复一个已忽略的待确认项(置回 pending)。 */
  restoreOffer?: (offerId: string) => void;
  /** 手动触发一轮扫描。 */
  rescan?: () => void;
  /** 手动重连指定对端。 */
  reconnect?: (deviceId: string) => void;
  /**
   * 开发模式的 vite dev server 基址(如 `http://127.0.0.1:5173`)。
   * 设置后,非控制端点的 web 请求会 302 重定向到该地址,由 vite 原生提供 HMR;
   * 浏览器访问 8384 的页面会自动跳到 5173,无需先跑 `vite build`。
   * 控制端点(/api、登录、增删目录)仍由 8384 本地处理。
   * 生产/打包形态不传,走内嵌 bundle 直接提供页面。
   */
  devViteUrl?: string;
  /**
   * 是否源码 dev 运行态(非打包单文件运行时)。为 true 时,所有自更新接口
   * (/api/self-update*) 一律拒绝,作为前端入口拦截之外的最后一道防线,
   * 防止有人直连 API 在 dev 态触发自更新。
   */
  devMode?: boolean;

  // ---- 配对二维码 / 文件管理器 / 浏览器内终端 ----
  /**
   * 本机配对信息(GET /api/paircode):deviceId + 数据面端口 + 局域网地址。
   * 前端把三者拼成 syncx:// 配对串画二维码,对端扫码/粘贴即可配对。
   * port 为 0(对端服务未就绪)时路由返回 503。
   */
  pairCode?: () => { deviceId: string; port: number; addresses: string[] };
  /** 列举共享目录内某子目录(filebrowser.listDirectory,含路径越界防护)。 */
  listFolderDirectory?: (folderId: string, relPath: string, limit?: number) => unknown;
  /** 解析共享目录内某相对路径为绝对路径(下载用);越界/不存在抛错转 400。 */
  resolveFolderFile?: (folderId: string, relPath: string) => string;
  /** 删除共享目录内单个文件或整个子目录(递归);真实删除,扫描后传播给对端。 */
  deleteFolderEntry?: (folderId: string, relPath: string) => void;
  /**
   * 浏览器内终端(`WS /api/terminal`)。传入后在 upgrade 阶段完成鉴权并把连接交给它;
   * 不传则对 /api/terminal 的握手一律拒绝。见 src/api/terminal.ts。
   */
  terminal?: { handle(socket: import('ws').WebSocket): void; close(): void };
}

/** 域路由处理器的统一签名:处理了请求返回 true,未命中返回 false(交给下一个域)。 */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;
