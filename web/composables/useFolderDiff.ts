import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { apiJson, errText } from '../utils/api';
import { copyText } from '../utils/clipboard';
import { stripWs } from '../utils/format';
import { useToast } from './useToast';
import type { CoreDeps } from './statusContext';
import type { FolderDiffData, FolderDiffItem, FolderInfo } from '../types';

/**
 * 内容对比弹窗的状态与动作。
 *
 * 每次对比都是**按需向对端索取实时快照**(后端只读,不改动任何一端状态),
 * 因此这里只负责:打开时拉一次、切换对端时重拉、手动重跑、复制报告。
 *
 * 并发保护:设备切换/重跑会让上一次请求还在飞。用单调递增的 seq 丢弃迟到响应 ——
 * 否则慢的那次(可能是另一个设备的)会覆盖掉当前结果,而两者看起来都「像是对的」。
 */
export interface FolderDiffApi {
  diffOpen: Ref<boolean>;
  diffFolder: Ref<FolderInfo | null>;
  diffDevice: Ref<string>;
  diffDevices: ComputedRef<string[]>;
  diffData: Ref<FolderDiffData | null>;
  diffLoading: Ref<boolean>;
  diffError: Ref<string>;
  openDiff: (f: FolderInfo) => void;
  closeDiff: () => void;
  runDiff: () => Promise<void>;
  switchDiffDevice: (device: string) => Promise<void>;
  copyDiff: () => Promise<void>;
}

export function useFolderDiff(deps: CoreDeps): FolderDiffApi {
  const { status } = deps;
  const { showToast } = useToast();

  const diffOpen = ref(false);
  const diffFolder = ref<FolderInfo | null>(null);
  const diffDevice = ref('');
  const diffData = ref<FolderDiffData | null>(null);
  const diffLoading = ref(false);
  const diffError = ref('');
  let seq = 0;

  const diffDevices = computed<string[]>(() => diffFolder.value?.devices ?? []);

  /** 打开某目录的对比弹窗:默认选第一个指派的设备并立即拉一次。 */
  function openDiff(f: FolderInfo): void {
    diffFolder.value = f;
    diffDevice.value = f.devices[0] ?? '';
    diffData.value = null;
    diffError.value = '';
    diffOpen.value = true;
    // 没有指派设备就不发请求(后端也会拒绝),弹窗内直接给提示
    if (diffDevice.value) void runDiff();
  }

  function closeDiff(): void {
    diffOpen.value = false;
    // 递增序号:关窗后迟到的响应不再写入,下次打开是干净状态
    seq += 1;
    diffLoading.value = false;
  }

  async function runDiff(): Promise<void> {
    const f = diffFolder.value;
    const device = diffDevice.value;
    if (!f || !device) return;
    const mine = ++seq;
    diffLoading.value = true;
    diffError.value = '';
    try {
      const id = f.id ?? f.path;
      const data = await apiJson<FolderDiffData>(
        `/api/folders/diff?folderId=${encodeURIComponent(id)}&device=${encodeURIComponent(device)}`,
      );
      if (mine !== seq) return;
      diffData.value = data;
    } catch (e) {
      if (mine !== seq) return;
      diffData.value = null;
      diffError.value = errText(e, '对比失败(对端可能离线或不支持该功能)');
    } finally {
      if (mine === seq) diffLoading.value = false;
    }
  }

  async function switchDiffDevice(device: string): Promise<void> {
    if (device === diffDevice.value) return;
    diffDevice.value = device;
    diffData.value = null;
    await runDiff();
  }

  async function copyDiff(): Promise<void> {
    const data = diffData.value;
    if (!data) return;
    const ok = await copyText(diffReportText(data, status.value.deviceId));
    showToast(ok ? '已复制对比结果到剪贴板' : '复制失败,请手动选择文本复制', ok ? 'info' : 'alert');
  }

  return {
    diffOpen,
    diffFolder,
    diffDevice,
    diffDevices,
    diffData,
    diffLoading,
    diffError,
    openDiff,
    closeDiff,
    runDiff,
    switchDiffDevice,
    copyDiff,
  };
}

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

/** 纯文本报告(复制到剪贴板 / 贴进对话),与弹窗同一份数据、同一套分类。 */
export function diffReportText(data: FolderDiffData, localDeviceId: string): string {
  const { diff } = data;
  const lines: string[] = [];
  lines.push(`对比 ${data.folderPath} ↔ ${data.deviceId}${data.deviceVersion ? ` (syncx ${data.deviceVersion})` : ''}`);
  lines.push(`目录 id ${data.folderId}`);
  lines.push(
    `对端快照取自 ${fmtTime(data.remoteAt)} · 本机索引 ${diff.localTotal} 条 · 对端 ${diff.remoteTotal} 条 · 双方一致 ${diff.counts['in-sync']} 条`,
  );
  // 设备身份与弹窗一致:主机名 + IP(对端再带版本)。贴给别人看时,
  // 「哪台机器 ↔ 哪台机器」比一串设备 id 有用得多。
  const localWhere = [data.localHostname, ...data.localAddresses].filter(Boolean).join(' · ');
  const remoteWhere = [data.deviceHostname ?? '', data.deviceUrl ? stripWs(data.deviceUrl) : '']
    .filter(Boolean)
    .join(' · ');
  lines.push(
    `设备 ${localDeviceId} = 本机${localWhere ? ` (${localWhere})` : ''},` +
      `${data.deviceId} = 对端${remoteWhere ? ` (${remoteWhere})` : ''}`,
  );

  // 与弹窗同一套提示:报告可信度打折的原因要先讲清楚(全 0 的进度不算「在传输」)
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
