/**
 * 内容对比结果的终端呈现。
 *
 * 纯函数:输入是 /api/folders/diff 的 JSON,输出是待打印的行。与 Web 弹窗同一份数据、
 * 同一套分类,只是排版不同 —— 排查时用户常直接 ssh 到那台机器上,CLI 的输出比截图
 * 更快,也能直接进日志。
 *
 * 呈现原则(与 Web 弹窗一致):
 *  - 每条差异都给**结论**,不只列路径:待推送 / 待拉取 / 冲突 / 内容错位 / 规则使然;
 *  - 「规则使然」与真差异必须分栏:用户照着报告去修一个「其实是我们自己按规则不收」
 *    的条目,是最没意义的排查;
 *  - 索引与磁盘不符单独标注(索引陈旧,不是两端不同步);
 *  - 每组行数封顶,长列表不至于把终端刷爆。
 */

import type { FolderDiffResult } from './session-manager.js';
import { diffTotal, type DiffItem } from './diff.js';

export interface DiffTextOptions {
  /** 本机设备 id:版本向量里把它显示成「本机」,其余显示成「对端」或原样。 */
  localDeviceId: string;
  /** 每组最多列多少条(其余折叠成一句「还有 N 条」)。 */
  maxPerGroup?: number;
}

/** 本地时区的 `YYYY-MM-DD HH:mm:ss`(不用 toLocaleString,格式随环境变)。 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 「刚刚 / N 分钟前 / N 小时前」,便于一眼判断快照新不新。 */
function formatAgo(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

/** 版本向量 → `本机:2 对端:1`(第三个设备的贡献原样显示其 id)。 */
function formatVersion(version: Array<[string, number]>, localDeviceId: string, remoteDeviceId: string): string {
  if (version.length === 0) return '无版本';
  return version
    .map(([device, count]) => {
      const label = device === localDeviceId ? '本机' : device === remoteDeviceId ? '对端' : device;
      return `${label}:${count}`;
    })
    .join(' ');
}

/** 一行的单侧描述:`版本 · 大小 · 摘要前 8 位`。 */
function formatSide(
  side: DiffItem['local'],
  localDeviceId: string,
  remoteDeviceId: string,
): string {
  if (!side) return '无';
  const size = side.deleted ? '已删除' : `${side.size}B`;
  const digest = side.digest ? side.digest.slice(0, 8) : '—';
  return `${size} · ${digest} · ${formatVersion(side.version, localDeviceId, remoteDeviceId)}`;
}

function diskNote(item: DiffItem): string {
  if (item.disk === 'missing') return '  [⚠ 本机盘上已无此文件:索引陈旧,不是两端不同步]';
  if (item.disk === 'size-differs') return '  [⚠ 本机盘上大小与索引不符:索引陈旧]';
  return '';
}

/**
 * 进度是否表示「此刻真的有传输在跑」。
 *
 * 目录进度常态存在(空闲时 0/0/0),只看字段有没有会让报告凭空多一句
 * 「本机此刻在传输(发送 0 · 接收 0 · 待处理 0)」。后端已不下发全 0 的进度,
 * 这里再挡一道:呈现层不假设载荷干净。用类型谓词是为了顺带收窄调用点。
 */
function transferring(
  p?: { pending: number; sending: number; receiving: number },
): p is { pending: number; sending: number; receiving: number } {
  return !!p && p.pending + p.sending + p.receiving > 0;
}

export function formatFolderDiff(result: FolderDiffResult, options: DiffTextOptions): string[] {
  const maxPerGroup = options.maxPerGroup ?? 20;
  const { localDeviceId } = options;
  const { diff } = result;
  const now = result.remoteAt;
  const lines: string[] = [];

  lines.push(`对比 ${result.folderPath} ↔ ${result.deviceId}${result.deviceVersion ? ` (syncx ${result.deviceVersion})` : ''}`);
  lines.push(`目录 id ${result.folderId}`);
  lines.push(
    `对端快照取自 ${formatTime(result.remoteAt)}(${formatAgo(result.remoteAt, now)}) · ` +
      `本机索引 ${diff.localTotal} 条 · 对端 ${diff.remoteTotal} 条 · 双方一致 ${diff.counts['in-sync']} 条`,
  );
  lines.push(`设备 ${localDeviceId} = 本机,${result.deviceId} = 对端`);

  if (transferring(result.localProgress)) {
    lines.push(
      `[提示] 本机此刻在传输(发送 ${result.localProgress.sending} · 接收 ${result.localProgress.receiving} · 待处理 ${result.localProgress.pending}),报告可能含传输中的中间态`,
    );
  }
  if (transferring(result.remoteProgress)) {
    lines.push(
      `[提示] 对端此刻在传输(发送 ${result.remoteProgress.sending} · 接收 ${result.remoteProgress.receiving} · 待处理 ${result.remoteProgress.pending}),报告可能含传输中的中间态`,
    );
  }
  if (!diff.remoteRulesKnown) {
    lines.push('[提示] 对端未提供忽略规则(版本较旧),「规则使然」的差异无法区分,已按普通差异计入');
  }

  const total = diffTotal(diff.counts);
  if (total === 0) {
    lines.push('');
    lines.push('✔ 没有差异:两端同一目录 id 的内容一致。');
    return lines;
  }

  /** 打印一组:标题 + 若干条(path 与两侧描述)。 */
  const group = (title: string, items: DiffItem[], render: (item: DiffItem) => string[]): void => {
    if (items.length === 0) return;
    lines.push('');
    lines.push(`${title} ${items.length}`);
    for (const item of items.slice(0, maxPerGroup)) {
      lines.push(...render(item));
    }
    if (items.length > maxPerGroup) {
      lines.push(`  … 还有 ${items.length - maxPerGroup} 条`);
    }
  };

  const byKind = (kind: DiffItem['kind']): DiffItem[] => diff.items.filter((i) => i.kind === kind);

  group('✕ 内容错位 —— 版本向量相同但内容不一致(正常不该出现,优先查这类)', byKind('content-mismatch'), (item) => [
    `  ${item.path}${diskNote(item)}`,
    `      本机 ${formatSide(item.local, localDeviceId, result.deviceId)}`,
    `      对端 ${formatSide(item.remote, localDeviceId, result.deviceId)}`,
  ]);

  group('⚠ 冲突 —— 两边都改过,看 .sync-conflict-* 副本', byKind('conflict'), (item) => [
    `  ${item.path}${diskNote(item)}`,
    `      本机 ${formatSide(item.local, localDeviceId, result.deviceId)}`,
    `      对端 ${formatSide(item.remote, localDeviceId, result.deviceId)}`,
  ]);

  group('→ 待推送(本机较新)—— 长期不变说明推送卡住', byKind('local-newer'), (item) => [
    `  ${item.path}${diskNote(item)}`,
    `      本机 ${formatSide(item.local, localDeviceId, result.deviceId)}   对端 ${formatSide(item.remote, localDeviceId, result.deviceId)}`,
  ]);

  group('← 待拉取(对端较新)—— 接收模式的目录里这属正常', byKind('remote-newer'), (item) => [
    `  ${item.path}${diskNote(item)}`,
    `      本机 ${formatSide(item.local, localDeviceId, result.deviceId)}   对端 ${formatSide(item.remote, localDeviceId, result.deviceId)}`,
  ]);

  const ignoredHere = byKind('ignored-locally');
  const ignoredThere = byKind('ignored-remotely');
  if (ignoredHere.length + ignoredThere.length > 0) {
    lines.push('');
    lines.push(`· 规则使然的差异 ${ignoredHere.length + ignoredThere.length} —— 不是故障(两端按各自的忽略规则安静分叉)`);
    if (ignoredHere.length > 0) {
      lines.push(`  本机忽略(对端有、本机不收) ${ignoredHere.length}`);
      for (const item of ignoredHere.slice(0, maxPerGroup)) {
        lines.push(`    ${item.path}  ← 规则 \`${item.rule ?? '?'}\`${item.hard ? '(硬忽略,不可解除)' : ''}`);
      }
      if (ignoredHere.length > maxPerGroup) lines.push(`    … 还有 ${ignoredHere.length - maxPerGroup} 条`);
    }
    if (ignoredThere.length > 0) {
      lines.push(`  对端忽略(本机有、对端不收) ${ignoredThere.length}`);
      for (const item of ignoredThere.slice(0, maxPerGroup)) {
        lines.push(`    ${item.path}  ← 规则 \`${item.rule ?? '?'}\`${item.hard ? '(硬忽略,不可解除)' : ''}`);
      }
      if (ignoredThere.length > maxPerGroup) lines.push(`    … 还有 ${ignoredThere.length - maxPerGroup} 条`);
    }
  }

  lines.push('');
  lines.push(
    `差异合计 ${total}:内容错位 ${diff.counts['content-mismatch']} · 冲突 ${diff.counts.conflict} · ` +
      `待推送 ${diff.counts['local-newer']} · 待拉取 ${diff.counts['remote-newer']} · ` +
      `规则使然 ${diff.counts['ignored-locally'] + diff.counts['ignored-remotely']}`,
  );
  if (diff.counts['content-mismatch'] > 0) {
    lines.push('提示:内容错位是索引与内容被错写的信号;处置办法是让两端重新比对同一份内容(重传该文件)。');
  }
  return lines;
}
