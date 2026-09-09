import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ControlServerDeps {
  token: string;
  /**
   * 账号密码落盘位置(cli 传 ~/.syncx/auth.json)。
   * 不传则禁用账号密码登录,只保留 control.token 一条通道;
   * 文件不存在时同样退回「仅令牌登录」,设置密码后才启用账号登录。
   */
  authFile?: string;
  /** stop 命令经 POST /api/shutdown 触发的优雅关闭;不传则该端点返回 503。 */
  shutdown?: () => void;
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
  getStatus: () => unknown;
  /** 添加共享目录;返回是否自动创建了不存在的目录(供前端提示)。 */
  addFolder?: (path: string, devices: string[], id?: string) => boolean;
  removeFolder?: (path: string) => void;
  /** 添加一个已知对端设备 ID(按 ID 配对,不依赖邀请码)。可选 address 直接写入
   *  config.peers 并立即直连,用于跨网段/无 mDNS 时手动指定对方 ws:// 地址。 */
  addDevice?: (deviceId: string, address?: string) => void;
  /** 移除一个已知对端设备(同时从各目录 devices 中摘除)。 */
  removeDevice?: (deviceId: string) => void;
  /** 精确设置某目录的设备列表(按目录多选设备的提交)。 */
  setFolderDevices?: (path: string, devices: string[]) => void;
  /** 设置某目录是否遵循 .gitignore 忽略规则(缺省 true)。 */
  setFolderUseGitignore?: (path: string, enabled: boolean) => void;
  /** 列出待确认项(对方推送的配对 / 目录共享邀请)。 */
  getOffers?: () => unknown;
  /** 读取某共享目录的同步记录(最近变更,倒序)。参数为目录 ID。 */
  getFolderHistory?: (folderId: string) => unknown;
  /**
   * 日志文件路径(--log-file 启动参数)。设置后 GET /api/logs 可读取日志尾部;
   * 未设置时该端点返回 ok:false,前端提示需以 --log-file 启动才有日志可看。
   */
  logFile?: string;
  /** 确认一个待确认项;目录共享邀请需附带 localPath(本机落地路径)。 */
  acceptOffer?: (offerId: string, localPath?: string) => void;
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
}

/** 域路由处理器的统一签名:处理了请求返回 true,未命中返回 false(交给下一个域)。 */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;
