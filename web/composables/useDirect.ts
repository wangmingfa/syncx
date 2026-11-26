/**
 * 设备间直发的页面状态(ADR-0028):发送弹窗、待确认与收件箱操作都在这里,
 * 组件只负责渲染。数据本身走 status.direct(既有 WS 推送),这里不另起轮询。
 */
import { ref, type Ref } from 'vue';
import type { DirectItem, DeviceInfo } from '../types';
import type { CoreDeps } from './statusContext';
import { useToast } from './useToast';
import { apiJson, apiPost, errText } from '../utils/api';

export interface DirectApi {
  sendTarget: Ref<DeviceInfo | null>;
  openSend: (p: DeviceInfo) => void;
  closeSend: () => void;
  inboxOpen: Ref<boolean>;
  openInbox: () => void;
  textDraft: Ref<string>;
  fileDraft: Ref<File | null>;
  sending: Ref<boolean>;
  canDirect: (p: DeviceInfo) => boolean;
  sendText: (deviceId: string) => Promise<boolean>;
  sendFile: (deviceId: string) => Promise<boolean>;
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
  const inboxOpen = ref(false);
  const textDraft = ref('');
  const fileDraft = ref<File | null>(null);
  const sending = ref(false);

  function openSend(p: DeviceInfo): void {
    sendTarget.value = p;
    textDraft.value = '';
    fileDraft.value = null;
  }
  function closeSend(): void {
    if (sending.value) return;
    sendTarget.value = null;
  }

  function canDirect(p: DeviceInfo): boolean {
    return p.online && (p.caps?.includes('direct1') ?? false);
  }

  async function sendText(deviceId: string): Promise<boolean> {
    if (sending.value) return false;
    const text = textDraft.value;
    if (!text.trim()) {
      showToast('请输入要发送的文本', 'alert');
      return false;
    }
    sending.value = true;
    try {
      await apiPost('/api/direct/text', { deviceId, text });
      showToast('已发出,等待对方接收');
      await deps.refreshStatus();
      sendTarget.value = null;
      return true;
    } catch (e) {
      showToast(errText(e, '发送失败'), 'alert');
      return false;
    } finally {
      sending.value = false;
    }
  }

  async function sendFile(deviceId: string): Promise<boolean> {
    if (sending.value) return false;
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
      const url = `/api/direct/file?deviceId=${encodeURIComponent(deviceId)}&name=${encodeURIComponent(file.name)}&size=${file.size}`;
      await apiJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      showToast('已发出,等待对方确认接收');
      await deps.refreshStatus();
      sendTarget.value = null;
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
