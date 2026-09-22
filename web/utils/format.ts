import type { DeviceInfo, SyncProgressItem } from '../types.js';

/** 目录稳定标识(与后端 folderIdFor 一致:id 优先,回退 path),用作列表 key 与进度匹配。 */
export function folderKey(f: { id?: string; path: string }): string {
  return f.id ?? f.path;
}

/** 设备首字母徽标(浅色主题里替代纯文字,增强可读性)。 */
export function monogram(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '··';
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** 设备卡里展示对端地址时去掉 ws:// 前缀,只留 host:port。 */
export function stripWs(url: string): string {
  return url.startsWith('ws://') ? url.slice(5) : url;
}

export function progressPercent(p: SyncProgressItem): number {
  const total = p.pending + p.sending + p.receiving;
  return total > 0 ? Math.round((p.receiving / total) * 100) : 0;
}

/** 是否正在传输(有发送或接收活动)。 */
export function isActive(p: SyncProgressItem): boolean {
  return p.sending + p.receiving > 0;
}

/**
 * 瞬时速率的人类可读形式,自适应 B/s → GB/s。
 * 0 / undefined 返回空串(调用方决定整体省略,而不是显示「0 B/s」)。
 */
export function fmtRate(bps?: number): string {
  if (!bps || bps <= 0) return '';
  let v = bps;
  if (v < 1024) return `${Math.round(v)} B/s`;
  v /= 1024;
  const kb = v;
  if (kb < 1024) return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB/s`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB/s`;
  return `${(mb / 1024).toFixed(1)} GB/s`;
}

/** 发送/接收段的小标签:有速率时附在计数后面,如「发送 2 · 1.2 MB/s」。 */
function rateSegment(label: string, count: number, bps?: number): string {
  const rate = fmtRate(bps);
  return rate ? `${label} ${count} · ${rate}` : `${label} ${count}`;
}

/** 进度区文案:用用户能看懂的语言,而非 pending/sending/receiving 系统术语。 */
export function progressText(p: SyncProgressItem): string {
  if (isActive(p)) {
    return ['传输中', rateSegment('发送', p.sending, p.sendRate), rateSegment('接收', p.receiving, p.receiveRate)].join(' · ');
  }
  if (p.pending > 0) return `已排队 ${p.pending} 项,等待同步`;
  return '已同步';
}

/** 地址(host:port)与主机名合并到一行,避免纵向多占一行;两者都可能缺失。 */
export function deviceAddrLine(p: DeviceInfo): string {
  return [p.url ? stripWs(p.url) : '', p.hostname].filter(Boolean).join(' · ');
}

/**
 * 目录卡里「传输中文件」列表默认最多展示的行数。
 *
 * 后端 `files` 没有条数上限(整目录首批同步时可能上千条),全部渲染会把卡片撑得极高、
 * 把并列的设备列甩到屏幕外。超出部分收进「查看全部」,由用户显式展开。
 */
export const XFER_FILE_LIMIT = 5;

/**
 * 按展开状态截断「传输中文件」列表:展开返回全部,收起只给前 `limit` 条。
 * 条数不超过 `limit` 时两种状态结果一致(调用方据此决定是否渲染「查看全部」按钮)。
 */
export function visibleTransferFiles<T>(files: readonly T[], expanded: boolean, limit = XFER_FILE_LIMIT): T[] {
  return expanded ? [...files] : files.slice(0, limit);
}

/**
 * 共享目录输入框的路径示例文案。**必须按 daemon 所在平台给**(后端 status.platform):
 * 控制台经常被从另一台机器打开,用浏览器的 navigator 判断会给出错的示例 ——
 * 在 Windows 上看到 `/home/me/Documents` 正是这类误导。
 * platform 缺省(旧版后端未提供)时退回 POSIX 示例。
 */
export function folderPathPlaceholder(platform?: string): string {
  return platform === 'win32'
    ? '本机目录绝对路径,如 F:\\shared\\docs'
    : '本机目录绝对路径,如 /home/me/Documents';
}
