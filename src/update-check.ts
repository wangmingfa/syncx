import { compareVersions } from './upgrade.js';

/**
 * npm 更新检查:daemon 运行期间定时查询 registry 的 latest dist-tag,
 * 发现更高版本时经 status.updateAvailable 下发,Web UI 弹升级提示。
 * 仅查询元数据与下载 tgz,不调用 npm CLI(避免 Windows npm.cmd 的 shell 依赖)。
 */

const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/@wangmingfa%2Fsyncx/latest';

/** registry latest 元数据(我们关心的字段)。 */
export interface RegistryLatest {
  version: string;
  tarballUrl: string;
}

export interface UpdateInfo {
  /** registry 上的最新版本。 */
  latest: string;
  /** 本机当前版本。 */
  current: string;
  /** tgz 下载地址。 */
  tarballUrl: string;
  /** 本次查询时间(毫秒)。 */
  checkedAt: number;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** 查询 registry latest:返回版本号与 tgz 地址;网络/解析失败抛错。 */
export async function fetchLatestRelease(fetchImpl: FetchLike = fetch as FetchLike): Promise<RegistryLatest> {
  const res = await fetchImpl(REGISTRY_LATEST_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`registry 查询失败(HTTP ${res.status})`);
  const body = (await res.json()) as { version?: unknown; dist?: { tarball?: unknown } };
  if (typeof body.version !== 'string' || typeof body.dist?.tarball !== 'string') {
    throw new Error('registry 返回结构异常');
  }
  return { version: body.version, tarballUrl: body.dist.tarball };
}

/** 下载 tgz 到内存(几百 KB 量级,无需落盘临时文件)。 */
export async function downloadTarball(url: string, fetchImpl: FetchLike = fetch as FetchLike): Promise<Buffer> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`更新包下载失败(HTTP ${res.status})`);
  const buf = Buffer.from(await (res as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer());
  if (buf.length === 0) throw new Error('更新包下载内容为空');
  return buf;
}

export interface UpdateChecker {
  /** 立即检查一次(结果缓存,失败保留上次结果)。 */
  check: () => Promise<UpdateInfo | undefined>;
  /** 启动定时检查(初始延迟 + 固定间隔)。 */
  start: (intervalMs?: number, initialDelayMs?: number) => void;
  /** 停止定时器(daemon 关闭时调用)。 */
  stop: () => void;
  /** 若发现更高版本返回更新信息,否则 undefined。 */
  available: () => UpdateInfo | undefined;
}

/** 创建更新检查器。仅打包态使用;dev 态不检查、不提示。 */
export function createUpdateChecker(currentVersion: string, opts: { fetchImpl?: FetchLike } = {}): UpdateChecker {
  let last: UpdateInfo | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function check(): Promise<UpdateInfo | undefined> {
    try {
      const r = await fetchLatestRelease(opts.fetchImpl);
      last = { latest: r.version, current: currentVersion, tarballUrl: r.tarballUrl, checkedAt: Date.now() };
    } catch {
      // 查询失败(离线等)很常见:保留上次结果,不打扰用户
    }
    return last;
  }

  return {
    check,
    start(intervalMs = 6 * 60 * 60_000, initialDelayMs = 30_000): void {
      if (timer) return;
      timer = setTimeout(function tick() {
        void check();
        timer = setTimeout(tick, intervalMs);
      }, initialDelayMs);
    },
    stop(): void {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    available(): UpdateInfo | undefined {
      if (!last) return undefined;
      return compareVersions(currentVersion, last.latest) < 0 ? last : undefined;
    },
  };
}
