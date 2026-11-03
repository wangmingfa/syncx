/**
 * 控制 API 的性能探针(Termux/低端机排查专用,平时零噪声):
 *
 * 1. 请求耗时:响应结束时记一笔。慢请求(默认 ≥300ms,SYNCX_SLOW_REQ_MS 可调)
 *    恒定记录;设 SYNCX_PERF_LOG=1 时**所有**请求都记(排查「界面整体都卡」时用)。
 * 2. 事件循环卡顿采样:每秒 tick 一次,实际间隔超出理论间隔的部分就是期间被
 *    同步任务(扫描/索引/SQLite 大事务)饿掉的时长 —— 接口 handler 本身很快但
 *    UI 依然卡时,一定是这类饿死,采样器是唯一能逮住它的探针。
 *
 * 日志去向:daemon 传了 perfLog(即 --log-file 的 logger)就持久化;测试/最小
 * deps 未传时,仅在 SYNCX_PERF_LOG=1 下才退回 console,避免测试输出被刷屏。
 */

/** 单条性能日志的落点;daemon 注入 logger,缺失时只在显式开启下走 console。 */
export type PerfLog = (line: string) => void;

/** 慢请求阈值(ms);SYNCX_SLOW_REQ_MS 可调,0 = 全部请求都记。 */
export function slowRequestMs(): number {
  const raw = Number(process.env.SYNCX_SLOW_REQ_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 300;
}

/** 是否记录所有请求(SYNCX_PERF_LOG=1)。 */
export function logAllRequests(): boolean {
  return process.env.SYNCX_PERF_LOG === '1';
}

/** 挑选实际生效的落点:注入的 perfLog 优先;没有则仅显式开启时用 console。 */
export function pickSink(perfLog?: PerfLog): PerfLog | null {
  if (perfLog) return perfLog;
  return logAllRequests() ? (line) => console.log(line) : null;
}

// ---- 进程级共享探针(供不带 deps 的模块使用:git-monitor / executor 等) ----
// daemon 启动时注入一次;测试/工具不注入则静默(规则与 pickSink 相同)。

let processSink: PerfLog | null = null;

/** daemon 装配时注入进程级落点;传 null 撤销。 */
export function setProcessPerfSink(sink: PerfLog | null): void {
  processSink = sink;
}

/** 取当前生效的进程级落点:显式注入优先,否则仅在 SYNCX_PERF_LOG=1 时走 console。 */
export function processPerfSink(): PerfLog | null {
  return processSink ?? (logAllRequests() ? (line) => console.log(line) : null);
}

/**
 * 包装控制服务的请求处理器:响应结束时按阈值记一笔耗时。
 * method/path/status 一起带上,慢请求一眼定位到端点;duration 含响应体写完
 * (res 'finish' 事件),因为大 payload 的序列化同样是卡顿来源。
 */
export function instrumentRequest(
  sink: PerfLog | null,
  req: { method?: string; url?: string },
  res: { statusCode?: number; on(ev: 'finish', cb: () => void): unknown },
  pathname: string,
  startMs: number,
): void {
  res.on('finish', () => {
    if (!sink) return;
    const ms = performance.now() - startMs;
    const slow = ms >= slowRequestMs();
    if (!slow && !logAllRequests()) return;
    const tag = slow ? '[perf] 慢请求' : '[perf]';
    sink(`${tag} ${req.method ?? 'GET'} ${pathname} -> ${res.statusCode ?? 0} ${Math.round(ms)}ms`);
  });
}

/**
 * 事件循环卡顿采样器:返回停止函数(daemon 生命周期内其实不停)。
 * 每 tick 记录理论时刻与实际时刻的差值;差值大 = 期间有同步任务霸占主线程。
 * 超过 thresholdMs(默认 300,SYNCX_SLOW_REQ_MS 同源)才记,正常机器永不触发。
 */
export function startLoopLagSampler(sink: PerfLog, tickMs = 1000, thresholdMs?: number): () => void {
  const threshold = thresholdMs ?? slowRequestMs();
  let expected = Date.now() + tickMs;
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + tickMs;
    if (lag >= threshold) {
      sink(`[perf] 事件循环卡顿 ${Math.round(lag)}ms(期间有同步任务霸占主线程,接口排队等它)`);
    }
  }, tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
