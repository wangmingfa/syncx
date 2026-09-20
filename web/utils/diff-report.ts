import { stripWs } from './format';
import type { FolderCompareData, FolderDiffItem } from '../types';

/** 版本向量 → `本机:2 对端:1`。 */
function versionText(
  version: Array<[string, number]>,
  localDeviceId: string,
  remoteDeviceId: string,
): string {
  if (version.length === 0) return '无版本';
  return version
    .map(([device, count]) => {
      const label = device === localDeviceId ? '本机' : device === remoteDeviceId ? '对端' : device;
      return `${label}:${count}`;
    })
    .join(' ');
}

function sideText(
  side: FolderDiffItem['local'],
  localDeviceId: string,
  remoteDeviceId: string,
): string {
  if (!side) return '无';
  const size = side.deleted ? '已删除' : `${side.size}B`;
  return `${size} ${side.digest ? side.digest.slice(0, 8) : '—'} ${versionText(side.version, localDeviceId, remoteDeviceId)}`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** 纯文本报告(复制到剪贴板 / 贴进对话),与对比页同一份数据、同一套分类。 */
export function diffReportText(data: FolderCompareData, localDeviceId: string): string {
  const { diff } = data;
  const lines: string[] = [];
  lines.push(`对比 ${data.folderPath} ↔ ${data.deviceId}${data.deviceVersion ? ` (syncx ${data.deviceVersion})` : ''}`);
  lines.push(`目录 id ${data.folderId}`);
  lines.push(
    `对端快照取自 ${fmtTime(data.remoteAt)} · 本机索引 ${diff.localTotal} 条 · 对端 ${diff.remoteTotal} 条 · 双方一致 ${diff.counts['in-sync']} 条`,
  );
  // 设备身份与对比页一致:主机名 + IP(对端再带版本)。贴给别人看时,
  // 「哪台机器 ↔ 哪台机器」比一串设备 id 有用得多。
  const localWhere = [data.localHostname, ...data.localAddresses].filter(Boolean).join(' · ');
  const remoteWhere = [data.deviceHostname ?? '', data.deviceUrl ? stripWs(data.deviceUrl) : '']
    .filter(Boolean)
    .join(' · ');
  lines.push(
    `设备 ${localDeviceId} = 本机${localWhere ? ` (${localWhere})` : ''},` +
      `${data.deviceId} = 对端${remoteWhere ? ` (${remoteWhere})` : ''}`,
  );

  // 与对比页同一套提示:报告可信度打折的原因要先讲清楚(全 0 的进度不算「在传输」)
  if (transferring(data.localProgress)) {
    lines.push(
      `[提示] 本机此刻在传输(发送 ${data.localProgress!.sending} · 接收 ${data.localProgress!.receiving} · 待处理 ${data.localProgress!.pending}),报告可能含传输中的中间态`,
    );
  }
  if (transferring(data.remoteProgress)) {
    lines.push(
      `[提示] 对端此刻在传输(发送 ${data.remoteProgress!.sending} · 接收 ${data.remoteProgress!.receiving} · 待处理 ${data.remoteProgress!.pending}),报告可能含传输中的中间态`,
    );
  }
  if (!diff.remoteRulesKnown) {
    lines.push('[注] 对端未提供忽略规则(版本较旧),「规则使然」的差异无法区分,已按普通差异计入');
  }

  const groups: Array<{ kind: FolderDiffItem['kind']; title: string }> = [
    { kind: 'content-mismatch', title: '内容错位(版本相同但内容不一致)' },
    { kind: 'conflict', title: '冲突(两边都改过)' },
    { kind: 'local-newer', title: '待推送(本机较新)' },
    { kind: 'remote-newer', title: '待拉取(对端较新)' },
    { kind: 'ignored-locally', title: '本机按规则忽略(不是故障)' },
    { kind: 'ignored-remotely', title: '对端按规则忽略(不是故障)' },
  ];
  for (const { kind, title } of groups) {
    const items = diff.items.filter((i) => i.kind === kind);
    if (items.length === 0) continue;
    lines.push('');
    lines.push(`【${title}】${items.length}`);
    for (const item of items) {
      lines.push(`  ${item.path}${item.rule ? `  ← 规则 \`${item.rule}\`${item.hard ? '(硬忽略)' : ''}` : ''}`);
      if (item.kind !== 'ignored-locally' && item.kind !== 'ignored-remotely') {
        lines.push(`    本机 ${sideText(item.local, localDeviceId, data.deviceId)}`);
        lines.push(`    对端 ${sideText(item.remote, localDeviceId, data.deviceId)}`);
      }
      if (item.disk === 'missing') lines.push('    [本机盘上已无此文件:索引陈旧]');
      if (item.disk === 'size-differs') lines.push('    [本机盘上大小与索引不符:索引陈旧]');
    }
  }
  return lines.join('\n');
}

/** 进度是否表示「此刻真的有传输在跑」(全 0 的进度不是)。 */
function transferring(p?: { pending: number; sending: number; receiving: number }): boolean {
  return !!p && p.pending + p.sending + p.receiving > 0;
}
