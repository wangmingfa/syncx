import type { DeviceInfo, SyncProgressItem } from '../types';

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

/** 进度区文案:用用户能看懂的语言,而非 pending/sending/receiving 系统术语。 */
export function progressText(p: SyncProgressItem): string {
  if (isActive(p)) return `传输中 · 发送 ${p.sending} · 接收 ${p.receiving}`;
  if (p.pending > 0) return `已排队 ${p.pending} 项,等待同步`;
  return '已同步';
}

/** 地址(host:port)与主机名合并到一行,避免纵向多占一行;两者都可能缺失。 */
export function deviceAddrLine(p: DeviceInfo): string {
  return [p.url ? stripWs(p.url) : '', p.hostname].filter(Boolean).join(' · ');
}
