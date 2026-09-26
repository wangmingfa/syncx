import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StatusPayload } from '../../status.js';
import type { ControlServerDeps } from '../deps.js';
import { pathname, sendJson } from '../helpers.js';

/**
 * Prometheus 抓取端点(需登录:Bearer 控制令牌或会话 cookie 均可)。
 *
 * GET /metrics : Prometheus 文本暴露格式(text/plain; version=0.0.4)。
 * 只出**聚合数值**,不出路径/设备 id/主机名等可识别信息 —— 但流量与条目数本身
 * 也算使用习惯,故不放免认证组(与 /healthz 的分工:那个只报活,这个要鉴权)。
 * Prometheus 侧配置 `authorization: { credentials_file: ... }` 填 control.token 即可。
 *
 * 数值全部取自 deps.getStatus()(与 Web 状态页同一口径),缺字段的旧载荷
 * 自动跳过对应指标,不会渲染 NaN。folder 标签取 `id ?? path`(与状态页目录键一致)。
 */
export async function tryMetricsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
): Promise<boolean> {
  const path = req.url ? pathname(req.url) : '/';
  if (path !== '/metrics') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  let text: string;
  try {
    text = renderMetrics(deps.getStatus() as StatusPayload);
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : '渲染指标失败' });
    return true;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
  return true;
}

/** 指标标签值转义(反斜杠/双引号/换行,与 Prometheus 文本格式规范一致)。 */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** 数值直出:非有限数(NaN/Infinity)渲染 0,避免污染抓取。 */
function num(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '0';
}

/** 布尔直 1/0(缺省视为 false)。 */
function bool(v: unknown): string {
  return v === true ? '1' : '0';
}

/**
 * 渲染 Prometheus 文本。参数按 Partial 对待:getStatus 的载荷在测试桩/旧后端
 * 下可能缺字段,所有段落各自判空、缺则整段跳过(HELP/TYPE 也不出)。
 */
export function renderMetrics(s: Partial<StatusPayload> | null | undefined): string {
  const status = s ?? {};
  const lines: string[] = [];
  /** 输出一条指标:首次遇到该名字时先补 HELP/TYPE 头(Prometheus 文本格式要求)。 */
  const emitted = new Set<string>();
  const help = (name: string, text: string, type: 'gauge' | 'counter'): void => {
    if (emitted.has(name)) return;
    emitted.add(name);
    lines.push(`# HELP ${name} ${text}`, `# TYPE ${name} ${type}`);
  };
  const metric = (name: string, text: string, type: 'gauge' | 'counter', value: string, labels = ''): void => {
    help(name, text, type);
    lines.push(`${name}${labels} ${value}`);
  };

  // —— 存活与进程 ——
  metric('syncx_up', 'daemon 是否在响应(恒 1)', 'gauge', '1');
  metric('syncx_uptime_seconds', '进程运行时长(秒)', 'gauge', String(Math.round(process.uptime())));
  const version = typeof status.version === 'string' ? status.version : 'unknown';
  const platform = typeof status.platform === 'string' ? status.platform : 'unknown';
  metric(
    'syncx_build_info',
    'daemon 版本与平台(label 形式)',
    'gauge',
    '1',
    `{version="${escapeLabel(version)}",platform="${escapeLabel(platform)}"}`,
  );

  // —— 索引规模 ——
  metric('syncx_index_entries', '本机索引条目数(未删)', 'gauge', num(status.entries));
  metric('syncx_index_tombstones', '本机索引墓碑数', 'gauge', num(status.tombstones));

  // —— 全局开关 ——
  metric('syncx_paused', '全局暂停同步(1=数据面停摆)', 'gauge', bool(status.paused));
  metric('syncx_power_guard', '电源守卫挂起中(计费网络/低电量)', 'gauge', status.powerGuard ? '1' : '0');

  // —— 目录 ——
  const folders = Array.isArray(status.folders) ? status.folders : [];
  metric('syncx_shared_folders', '共享目录数', 'gauge', String(folders.length));
  for (const f of folders) {
    const key = escapeLabel(f.id ?? f.path);
    metric('syncx_folder_paused', '目录级暂停(1=该目录数据面停摆)', 'gauge', bool(f.paused), `{folder="${key}"}`);
    metric('syncx_folder_on_demand', '目录级按需同步开关', 'gauge', bool(f.onDemand), `{folder="${key}"}`);
    metric(
      'syncx_folder_devices',
      '目录指派的设备数',
      'gauge',
      String(Array.isArray(f.devices) ? f.devices.length : 0),
      `{folder="${key}"}`,
    );
  }

  // —— 对端 ——
  const devices = Array.isArray(status.devices) ? status.devices : [];
  const online = devices.filter((d) => d?.online === true).length;
  metric('syncx_peers_configured', '已配对设备数', 'gauge', String(devices.length));
  metric('syncx_peers_online', '当前在线设备数(握手完成)', 'gauge', String(online));

  // —— 待确认邀请 ——
  const offers = Array.isArray(status.offers) ? status.offers : [];
  metric('syncx_offers_pending', '待确认的配对/共享邀请数', 'gauge', String(offers.length));

  // —— 传输进度(每目录) ——
  for (const p of Array.isArray(status.syncProgress) ? status.syncProgress : []) {
    const key = escapeLabel(p?.folder ?? '');
    metric('syncx_transfer_pending_files', '各目录待同步文件数(计划里未开工)', 'gauge', num(p?.pending), `{folder="${key}"}`);
    metric('syncx_transfer_sending_files', '各目录正在发送的文件数', 'gauge', num(p?.sending), `{folder="${key}"}`);
    metric('syncx_transfer_receiving_files', '各目录正在接收的文件数', 'gauge', num(p?.receiving), `{folder="${key}"}`);
  }

  // —— 流量累计(daemon 重启清零,counter 语义仍成立:重启处 reset) ——
  if (status.traffic) {
    metric('syncx_traffic_sent_bytes_total', '累计发送字节(daemon 启动以来)', 'counter', num(status.traffic.sent));
    metric('syncx_traffic_received_bytes_total', '累计接收字节(daemon 启动以来)', 'counter', num(status.traffic.received));
  }

  // —— 冲突副本与目录错误 ——
  for (const [folderId, count] of Object.entries(status.conflictCounts ?? {})) {
    metric('syncx_conflict_copies', '目录内残留冲突副本数', 'gauge', num(count), `{folder="${escapeLabel(folderId)}"}`);
  }
  for (const e of Array.isArray(status.folderErrors) ? status.folderErrors : []) {
    metric('syncx_folder_error', '目录最近一次同步错误(1=有错误未消除)', 'gauge', '1', `{folder="${escapeLabel(e?.folder ?? '')}"}`);
  }

  return lines.join('\n') + '\n';
}
