/**
 * 设备间直发的页面状态(ADR-0028):发送弹窗、待确认与收件箱操作都在这里,
 * 组件只负责渲染。数据本身走 status.direct(既有 WS 推送),这里不另起轮询。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { DirectItem, DirectTransfer, DeviceInfo } from '../types';
import type { CoreDeps } from './statusContext';
import { useToast } from './useToast';
import { apiJson, apiPost, errText } from '../utils/api';

interface SendOutcome {
  deviceId: string;
  id?: string;
  /** true = 目标离线,内容已进本机队列,等它上线自动投递。 */
  queued?: boolean;
  error?: string;
}

interface DirectBatchResponse {
  id?: string;
  ids?: string[];
  results?: SendOutcome[];
}

/** 一个待发文件的队列项:拖入/选择后先入队,点发送再逐项投送。 */
export interface SendFileItem {
  key: string;
  file: File;
  state: 'pending' | 'sending' | 'queued' | 'done' | 'failed';
  error?: string;
}

export interface DirectApi {
  sendTarget: Ref<DeviceInfo | null>;
  /**
   * 弹窗里可勾选的目标:在线且支持 direct1 的直接发,离线设备进排队
   * (上线后自动投递)。在线但版本过旧的仍然不给勾 —— 排到超时也发不出去。
   */
  availableTargets: ComputedRef<DeviceInfo[]>;
  /** 本次发送选中的设备 ID;从卡片点「发送」时默认只选那一台。 */
  selectedDevices: Ref<string[]>;
  toggleTarget: (deviceId: string) => void;
  selectAllTargets: () => void;
  clearTargets: () => void;
  /** 从卡片点「发送」或拖文件到卡片打开弹窗;files 给出时预填文件队列并切到文件页。 */
  openSend: (p: DeviceInfo, files?: File[]) => void;
  closeSend: () => void;
  inboxOpen: Ref<boolean>;
  openInbox: () => void;
  textDraft: Ref<string>;
  fileDrafts: Ref<SendFileItem[]>;
  /**
   * 打包模式:一次发送多个文件时把它们压成一个 .zip 再投送(只发一份,对方只收一个文件)。
   * 默认关 —— 接收方通常要的是原始文件,打包只在「几十个小文件想一次性搬走」时更省事。
   */
  zipMode: Ref<boolean>;
  /** 把选择/拖入的文件加入队列;空文件与超限文件跳过并提示。 */
  addFiles: (files: File[]) => void;
  removeFile: (key: string) => void;
  /** 正在发送的文件对应的实时传输状态,来自 status.direct.transfers。 */
  transfers: ComputedRef<DirectTransfer[]>;
  sending: Ref<boolean>;
  /** 在线且支持直发:可以立刻投送。 */
  canDirect: (p: DeviceInfo) => boolean;
  /** 离线设备:可以排队,等它上线自动投递。 */
  canQueue: (p: DeviceInfo) => boolean;
  /** 这台设备是否只能排队(用于弹窗底部的按钮文案)。 */
  isQueuedTarget: (p: DeviceInfo | undefined) => boolean;
  sendText: (deviceIds: string[]) => Promise<boolean>;
  /** 逐文件投送队列:一个失败继续下一个,返回是否全部成功。 */
  sendFile: (deviceIds: string[]) => Promise<boolean>;
  /** saveTo 给出时走提权门(由 UI 负责),文件另存到 daemon 机器的该目录。 */
  reply: (id: string, accept: boolean, saveTo?: string) => Promise<boolean>;
  /** 一次投送的多文件成组确认:接收方只点一次,后端逐条 accept。 */
  replyBatch: (batchId: string, accept: boolean, saveTo?: string) => Promise<boolean>;
  /** 取消一条还在排队的投送(设备离线时才有这个入口)。 */
  cancelSend: (id: string) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  /** 清空收件箱(逐条删;二次确认在弹窗里)。 */
  clearInbox: () => void;
  copyItem: (item: DirectItem) => Promise<void>;
  downloadItem: (item: DirectItem) => Promise<void>;
  formatBytes: (n: number) => string;
}

/** 与后端 DIRECT_MAX_FILE_BYTES 对齐;前端只做即时拦截,后端仍会复核。 */
const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** 一次最多 20 个文件:与多设备上限一致,避免误拖整个目录把 daemon 打满。 */
const MAX_FILES = 20;

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
  const fileDrafts = ref<SendFileItem[]>([]);
  const zipMode = ref(false);
  const sending = ref(false);
  const transfers = computed(() => deps.status.value.direct?.transfers ?? []);
  const unread = computed(() => deps.status.value.direct?.unread ?? 0);
  let fileSeq = 0;

  /**
   * 打开过收件箱即视为看过:标记落盘在后端,刷新/重启后角标不会诈尸。
   * 旧后端既没有 unread 字段也没有这个接口,unread 恒为 0,不会误调。
   */
  async function markInboxRead(): Promise<void> {
    if (unread.value <= 0) return;
    try {
      await apiPost('/api/direct/inbox/read', {});
      await deps.refreshStatus();
    } catch {
      // 失败不打扰用户:角标下次推送仍在,再打开一次收件箱会重试。
    }
  }

  function openInbox(): void {
    inboxOpen.value = true;
    void markInboxRead();
  }

  /**
   * 到件提示:inbox 里冒出没见过的文本才弹 toast(首屏已有的旧条目不算)。
   * 只认文本 —— 文件要用户先点「接收」才进收件箱,再弹一次反而像没收到确认。
   * 收件箱开着时不弹:用户正看着它,底下还会立刻被标成已读。
   */
  let seenInbox: string[] = [];
  let inboxSeeded = false;
  watch(
    () => deps.status.value.direct?.inbox,
    (list) => {
      const items = list ?? [];
      const fresh = inboxSeeded ? items.filter((i) => i.kind === 'text' && !seenInbox.includes(i.id)) : [];
      seenInbox = items.map((i) => i.id);
      if (!inboxSeeded) {
        inboxSeeded = true;
        return;
      }
      if (!fresh.length || inboxOpen.value) return;
      const devices = deps.status.value.devices;
      const from = [...new Set(fresh.map((i) => devices.find((d) => d.deviceId === i.from)?.hostname ?? '未知设备'))];
      showToast(`收到 ${from.join('、')} 的 ${fresh.length} 条直发消息，点「收件箱」查看`, 'alert');
    },
  );

  // 收件箱开着时新到的内容立刻算已读(正在被看),关着才留给角标与脉冲提醒。
  watch(unread, (n) => {
    if (n > 0 && inboxOpen.value) void markInboxRead();
  });

  function openSend(p: DeviceInfo, files?: File[]): void {
    sendTarget.value = p;
    selectedDevices.value = [p.deviceId];
    textDraft.value = '';
    fileDrafts.value = [];
    if (files?.length) addFiles(files);
  }
  function closeSend(): void {
    if (sending.value) return;
    sendTarget.value = null;
    selectedDevices.value = [];
  }

  function addFiles(files: File[]): void {
    const before = fileDrafts.value.length;
    let skipped = 0;
    for (const file of files) {
      if (!file || file.size === 0 || file.size > MAX_FILE_BYTES) {
        skipped++;
        continue;
      }
      if (fileDrafts.value.length >= MAX_FILES) {
        skipped++;
        continue;
      }
      fileDrafts.value.push({ key: `f${Date.now()}-${fileSeq++}`, file, state: 'pending' });
    }
    if (skipped) showToast(`已跳过 ${skipped} 个文件（空文件、超过 100 MB 或超过 ${MAX_FILES} 个）`, 'alert');
    if (fileDrafts.value.length > before) showToast(`已加入 ${fileDrafts.value.length - before} 个文件`);
  }

  function removeFile(key: string): void {
    if (sending.value) return;
    fileDrafts.value = fileDrafts.value.filter((f) => f.key !== key);
  }

  function canDirect(p: DeviceInfo): boolean {
    return p.online && (p.caps?.includes('direct1') ?? false);
  }

  /** 离线的已配对设备:内容先排队,等它上线自动投递。 */
  function canQueue(p: DeviceInfo): boolean {
    return !p.online;
  }

  const availableTargets = computed(() => deps.status.value.devices.filter((d) => canDirect(d) || canQueue(d)));

  function isQueuedTarget(p: DeviceInfo | undefined): boolean {
    return !!p && canQueue(p);
  }

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

  /** 部分失败也算发出去了:明确告诉用户几台成功、几台排队、第一台失败的原因。 */
  function reportBatch(results: SendOutcome[], noun: string): void {
    const sent = results.filter((r) => r.id && !r.queued).length;
    const queued = results.filter((r) => r.id && r.queued).length;
    const failed = results.filter((r) => r.error);
    if (!failed.length) {
      if (queued && sent) showToast(`已发给 ${sent} 台${noun}，${queued} 台离线已排队`);
      else if (queued) showToast(`已排队 ${queued} 台${noun}，设备恢复连接后自动发送`);
      else showToast(`已发给 ${sent} 台${noun}`);
      return;
    }
    const reason = failed[0]?.error ?? '未知原因';
    const done = [
      sent ? `${sent} 台已发出` : '',
      queued ? `${queued} 台已排队` : '',
    ].filter(Boolean).join('、');
    showToast(done ? `${done}，${failed.length} 台失败：${reason}` : reason, 'alert');
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

  /**
   * 发一个文件到所有选中设备(不改队列状态),返回每台的结果供逐项汇总。
   * batch 把同一次「发送 N 个文件」串起来:接收方只弹一张卡、一次确认,
   * 而不是每来一个文件就打断一次。
   */
  async function uploadFile(file: File, ids: string[], batch: string): Promise<SendOutcome[]> {
    // 指纹由 daemon 在暂存时计算:局域网 HTTP 下浏览器没有 crypto.subtle。
    const query = new URLSearchParams();
    for (const id of ids) query.append('deviceIds', id);
    query.set('name', file.name);
    query.set('size', String(file.size));
    query.set('batch', batch);
    const res = await apiJson<DirectBatchResponse>(`/api/direct/file?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    return outcomes(res, ids);
  }

  /** 打包模式:只暂存,不投送(daemon 收进 inbox/.tmp/zip-<batch>/,等打包接口统一处理)。 */
  async function uploadZipEntry(file: File, batch: string): Promise<void> {
    const query = new URLSearchParams();
    query.set('zip', batch);
    query.set('name', file.name);
    query.set('size', String(file.size));
    await apiJson(`/api/direct/file?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  }

  /**
   * 打包发送:逐个暂存 → 让 daemon 打成 zip → 一次性投送。
   * 包体超过单文件上限(100MB)由后端拒绝,这里只如实转述原因。
   */
  async function sendAsZip(queue: SendFileItem[], ids: string[], batch: string): Promise<boolean> {
    let staged = 0;
    let current: SendFileItem | undefined;
    try {
      for (const item of queue) {
        current = item;
        item.state = 'sending';
        item.error = undefined;
        await uploadZipEntry(item.file, batch);
        staged++;
      }
      const res = await apiPost<DirectBatchResponse>('/api/direct/zip', { batch, deviceIds: ids });
      const results = outcomes(res, ids);
      const failed = results.filter((r) => r.error);
      const queued = results.filter((r) => r.id && r.queued);
      if (failed.length) {
        const reason = failed.map((r) => `${r.deviceId}：${r.error}`).join('；');
        for (const item of queue) {
          item.state = 'failed';
          item.error = reason;
        }
        showToast(`打包发送失败：${reason}`, 'alert');
        await deps.refreshStatus();
        return false;
      }
      if (queued.length === results.length) {
        for (const item of queue) item.state = 'queued';
        showToast(`压缩包已排队（${queue.length} 个文件），设备上线后自动发送`);
      } else {
        for (const item of queue) item.state = 'done';
        showToast(`已打包发送 ${queue.length} 个文件${queued.length ? `，${queued.length} 台离线已排队` : ''}`);
      }
      sendTarget.value = null;
      selectedDevices.value = [];
      fileDrafts.value = [];
      zipMode.value = false;
      await deps.refreshStatus();
      return true;
    } catch (e) {
      const msg = errText(e, '打包发送失败');
      if (current) {
        current.state = 'failed';
        current.error = msg;
      }
      showToast(staged ? `打包失败（已暂存 ${staged}/${queue.length} 个文件）：${msg}` : msg, 'alert');
      await deps.refreshStatus();
      return false;
    }
  }

  async function sendFile(deviceIds: string[]): Promise<boolean> {
    if (sending.value) return false;
    const ids = [...new Set(deviceIds.filter(Boolean))];
    if (!ids.length) {
      showToast('请至少选择一台设备', 'alert');
      return false;
    }
    const queue = fileDrafts.value.filter((f) => f.state !== 'done');
    if (!queue.length) {
      showToast('请选择要发送的文件', 'alert');
      return false;
    }
    sending.value = true;
    // 一次「发送」= 一个批次:队列里的每个文件都带同一个组号,接收方那边只弹一张卡。
    const batch = `db-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let okFiles = 0;
    let queuedFiles = 0;
    const failures: string[] = [];
    try {
      // 只有一个文件时打包没有意义(多一层壳),按单选忽略开关。
      if (zipMode.value && queue.length > 1) return await sendAsZip(queue, ids, batch);
      for (const item of queue) {
        item.state = 'sending';
        item.error = undefined;
        try {
          const results = await uploadFile(item.file, ids, batch);
          const failed = results.filter((r) => r.error);
          if (failed.length) {
            item.state = 'failed';
            item.error = failed.map((r) => `${r.deviceId}：${r.error}`).join('；');
            failures.push(`${item.file.name} ${failed.length} 台失败`);
          } else if (results.every((r) => r.queued)) {
            // 全部目标都离线:文件进了本机队列,别显示成「已发出」。
            item.state = 'queued';
            queuedFiles++;
          } else {
            item.state = 'done';
            okFiles++;
          }
        } catch (e) {
          item.state = 'failed';
          item.error = errText(e, '发送失败');
          failures.push(`${item.file.name}：${item.error}`);
        }
      }
      await deps.refreshStatus();
      if (failures.length) {
        showToast(`${okFiles + queuedFiles} 个文件已受理，${failures.length} 个失败：${failures[0]}`, 'alert');
      } else {
        if (queuedFiles && okFiles) showToast(`${okFiles} 个文件已发出，${queuedFiles} 个排队等待设备上线`);
        else if (queuedFiles) showToast(`${queuedFiles} 个文件已排队，设备上线后自动发送`);
        else showToast(`${okFiles} 个文件已发出，等待对方确认`);
        // 全部成功才关弹窗;有失败时留着队列让用户重试失败的项。
        sendTarget.value = null;
        selectedDevices.value = [];
        fileDrafts.value = [];
      }
      return failures.length === 0;
    } finally {
      sending.value = false;
    }
  }

  async function reply(id: string, accept: boolean, saveTo?: string): Promise<boolean> {
    try {
      await apiPost('/api/direct/reply', {
        id,
        accept,
        ...(saveTo ? { saveTo } : {}),
      });
      showToast(accept ? (saveTo ? '已接收,文件将保存到指定目录' : '已接收,文件传输中') : '已拒绝');
      await deps.refreshStatus();
      return true;
    } catch (e) {
      showToast(errText(e, '操作失败'), 'alert');
      return false;
    }
  }

  async function replyBatch(batchId: string, accept: boolean, saveTo?: string): Promise<boolean> {
    try {
      await apiPost('/api/direct/reply', {
        batchId,
        accept,
        ...(saveTo ? { saveTo } : {}),
      });
      showToast(accept ? (saveTo ? '已接收,文件将保存到指定目录' : '已接收,文件开始传输') : '已拒绝');
      await deps.refreshStatus();
      return true;
    } catch (e) {
      showToast(errText(e, '操作失败'), 'alert');
      return false;
    }
  }

  async function cancelSend(id: string): Promise<void> {
    try {
      await apiPost('/api/direct/cancel', { id });
      showToast('已取消排队');
      await deps.refreshStatus();
    } catch (e) {
      showToast(errText(e, '取消失败'), 'alert');
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

  /**
   * 清空收件箱。逐条复用 DELETE /api/direct/inbox/:id 而不是新开一个「清空」路由:
   * 这套前端同时喂 Node / Rust / MoonBit 三个 daemon,逐条删除是三者唯一的公共契约。
   * 快照里的 inbox 截断在 100 条,所以删完一轮要刷新再看,直到真的空了。
   */
  function clearInbox(): void {
    const total = deps.status.value.direct?.inbox.length ?? 0;
    if (!total) return;
    deps.askConfirm({
      title: '清空收件箱?',
      message: `将删除收件箱里的 ${total} 条记录,以及本机保存的正文与文件副本;另存到其它目录的文件只删记录。不可撤销。`,
      confirmText: '清空收件箱',
      action: async () => {
        let removed = 0;
        for (;;) {
          const before = deps.status.value.direct?.inbox ?? [];
          if (!before.length) break;
          let ok = 0;
          for (const id of before.map((i) => i.id)) {
            try {
              await apiJson(`/api/direct/inbox/${encodeURIComponent(id)}`, { method: 'DELETE' });
              ok++;
            } catch {
              // 单条失败(比如刚好被另一处删掉)不打断整体,由下一轮的收敛判断收手。
            }
          }
          removed += ok;
          await deps.refreshStatus();
          const after = deps.status.value.direct?.inbox.length ?? 0;
          // 有失败,或刷完一条没少(后端没真删),就收手 —— 否则这里会无限重试。
          if (ok < before.length || after >= before.length) break;
        }
        const left = deps.status.value.direct?.inbox.length ?? 0;
        if (left) showToast(`已清空 ${removed} 条,还有 ${left} 条没删掉`, 'alert');
        else showToast(`已清空 ${removed} 条`);
      },
    });
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
    openInbox,
    textDraft,
    fileDrafts,
    zipMode,
    addFiles,
    removeFile,
    transfers,
    sending,
    canDirect,
    canQueue,
    isQueuedTarget,
    sendText,
    sendFile,
    reply,
    replyBatch,
    cancelSend,
    removeItem,
    clearInbox,
    copyItem,
    downloadItem,
    formatBytes,
  };
}
