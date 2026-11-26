/**
 * 设备间直发的页面状态(ADR-0028):发送弹窗、待确认与收件箱操作都在这里,
 * 组件只负责渲染。数据本身走 status.direct(既有 WS 推送),这里不另起轮询。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { DirectItem, DeviceInfo } from '../types';
import type { CoreDeps } from './statusContext';
import { useToast } from './useToast';
import { apiJson, apiPost, errText } from '../utils/api';

interface SendOutcome {
  deviceId: string;
  id?: string;
  error?: string;
}

interface DirectBatchResponse {
  id?: string;
  ids?: string[];
  results?: SendOutcome[];
}

export interface DirectApi {
  sendTarget: Ref<DeviceInfo | null>;
  /** 弹窗里可勾选的目标(在线 + 支持 direct1),随 status 推送实时变化。 */
  availableTargets: ComputedRef<DeviceInfo[]>;
  /** 本次发送选中的设备 ID;从卡片点「发送」时默认只选那一台。 */
  selectedDevices: Ref<string[]>;
  toggleTarget: (deviceId: string) => void;
  selectAllTargets: () => void;
  clearTargets: () => void;
  openSend: (p: DeviceInfo) => void;
  closeSend: () => void;
  inboxOpen: Ref<boolean>;
  openInbox: () => void;
  textDraft: Ref<string>;
  fileDraft: Ref<File | null>;
  sending: Ref<boolean>;
  canDirect: (p: DeviceInfo) => boolean;
  sendText: (deviceIds: string[]) => Promise<boolean>;
  sendFile: (deviceIds: string[]) => Promise<boolean>;
  reply: (id: string, accept: boolean) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  copyItem: (item: DirectItem) => Promise<void>;
  downloadItem: (item: DirectItem) => Promise<void>;
  formatBytes: (n: number) => string;
}

/** 与后端 DIRECT_MAX_FILE_BYTES 对齐;前端只做即时拦截,后端仍会复核。 */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

export function useDirect(deps: CoreDeps & { copy: (text: string) => Promise<void> }): DirectApi {
  const { showToast } = useToast();
  const sendTarget = ref<DeviceInfo | null>(null);
  const selectedDevices = ref<string[]>([]);
  const inboxOpen = ref(false);
  const textDraft = ref('');
  const fileDraft = ref<File | null>(null);
  const sending = ref(false);

  function openSend(p: DeviceInfo): void {
    sendTarget.value = p;
    selectedDevices.value = [p.deviceId];
    textDraft.value = '';
    fileDraft.value = null;
  }
  function closeSend(): void {
    if (sending.value) return;
    sendTarget.value = null;
    selectedDevices.value = [];
  }

  function canDirect(p: DeviceInfo): boolean {
    return p.online && (p.caps?.includes('direct1') ?? false);
  }

  const availableTargets = computed(() => deps.status.value.devices.filter(canDirect));

  function toggleTarget(deviceId: string): void {
    if (sending.value) return;
    selectedDevices.value = selectedDevices.value.includes(deviceId)
      ? selectedDevices.value.filter((id) => id !== deviceId)
      : [...selectedDevices.value, deviceId];
  }
  function selectAllTargets(): void {
    if (!sending.value) selectedDevices.value = availableTargets.value.map((d) => d.deviceId);
  }
  function clearTargets(): void {
    if (!sending.value) selectedDevices.value = [];
  }

  /** 兼容单设备旧响应:没有 results 时用 id + 目标顺序兜一份。 */
  function outcomes(res: DirectBatchResponse, ids: string[]): SendOutcome[] {
    if (Array.isArray(res.results) && res.results.length) return res.results;
    return ids.map((deviceId, i) => ({ deviceId, ...(i === 0 && res.id ? { id: res.id } : {}) }));
  }

  /** 部分失败也算发出去了:明确告诉用户几台成功、第一台失败的原因。 */
  function reportBatch(results: SendOutcome[], noun: string): void {
    const ok = results.filter((r) => r.id).length;
    const failed = results.filter((r) => r.error);
    if (!failed.length) {
      showToast(`已发给 ${ok} 台${noun}`);
      return;
    }
    const reason = failed[0]?.error ?? '未知原因';
    if (ok) showToast(`已发给 ${ok} 台${noun}，${failed.length} 台失败：${reason}`, 'alert');
    else showToast(reason, 'alert');
  }

  async function sendText(deviceIds: string[]): Promise<boolean> {
    if (sending.value) return false;
    const ids = [...new Set(deviceIds.filter(Boolean))];
    if (!ids.length) {
      showToast('请至少选择一台设备', 'alert');
      return false;
    }
    const text = textDraft.value;
    if (!text.trim()) {
      showToast('请输入要发送的文本', 'alert');
      return false;
    }
    sending.value = true;
    try {
      const res = await apiPost<DirectBatchResponse>('/api/direct/text', { deviceIds: ids, text });
      reportBatch(outcomes(res, ids), '设备');
      await deps.refreshStatus();
      sendTarget.value = null;
      selectedDevices.value = [];
      return true;
    } catch (e) {
      showToast(errText(e, '发送失败'), 'alert');
      return false;
    } finally {
      sending.value = false;
    }
  }

  async function sendFile(deviceIds: string[]): Promise<boolean> {
    if (sending.value) return false;
    const ids = [...new Set(deviceIds.filter(Boolean))];
    if (!ids.length) {
      showToast('请至少选择一台设备', 'alert');
      return false;
    }
    const file = fileDraft.value;
    if (!file) {
      showToast('请选择要发送的文件', 'alert');
      return false;
    }
    if (file.size === 0 || file.size > MAX_FILE_BYTES) {
      showToast('文件大小需在 1 B ~ 100 MB 之间', 'alert');
      return false;
    }
    sending.value = true;
    try {
      // 指纹由 daemon 在暂存时计算:局域网 HTTP 下浏览器没有 crypto.subtle。
      const query = new URLSearchParams();
      for (const id of ids) query.append('deviceIds', id);
      query.set('name', file.name);
      query.set('size', String(file.size));
      const res = await apiJson<DirectBatchResponse>(`/api/direct/file?${query.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      reportBatch(outcomes(res, ids), '设备，等待对方确认');
      await deps.refreshStatus();
      sendTarget.value = null;
      selectedDevices.value = [];
      return true;
    } catch (e) {
      showToast(errText(e, '发送失败'), 'alert');
      return false;
    } finally {
      sending.value = false;
    }
  }

  async function reply(id: string, accept: boolean): Promise<void> {
    try {
      await apiPost('/api/direct/reply', { id, accept });
      showToast(accept ? '已接收,文件传输中' : '已拒绝');
      await deps.refreshStatus();
    } catch (e) {
      showToast(errText(e, '操作失败'), 'alert');
    }
  }

  async function removeItem(id: string): Promise<void> {
    try {
      await apiJson(`/api/direct/inbox/${encodeURIComponent(id)}`, { method: 'DELETE' });
      showToast('已删除');
      await deps.refreshStatus();
    } catch (e) {
      showToast(errText(e, '删除失败'), 'alert');
    }
  }

  async function copyItem(item: DirectItem): Promise<void> {
    try {
      const res = await fetch(`/api/direct/inbox/${encodeURIComponent(item.id)}/content`);
      if (!res.ok) throw new Error('读取失败');
      await deps.copy(await res.text());
    } catch (e) {
      showToast(errText(e, '复制失败'), 'alert');
    }
  }

  async function downloadItem(item: DirectItem): Promise<void> {
    try {
      const res = await fetch(`/api/direct/inbox/${encodeURIComponent(item.id)}/content`);
      if (!res.ok) throw new Error('读取失败');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = item.kind === 'file' ? item.name : `${item.id}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      showToast(errText(e, '下载失败'), 'alert');
    }
  }

  return {
    sendTarget,
    availableTargets,
    selectedDevices,
    toggleTarget,
    selectAllTargets,
    clearTargets,
    openSend,
    closeSend,
    inboxOpen,
    openInbox: () => { inboxOpen.value = true; },
    textDraft,
    fileDraft,
    sending,
    canDirect,
    sendText,
    sendFile,
    reply,
    removeItem,
    copyItem,
    downloadItem,
    formatBytes,
  };
}
