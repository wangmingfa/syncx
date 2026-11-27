<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { NButton, NCheckbox, NInput } from 'naive-ui';
import type { DeviceInfo } from '../types';
import type { DirectApi, SendFileItem } from '../composables/useDirect';
import { deviceAddrLine, pastedImageName } from '../utils/format';
import { claimSendDrops } from '../composables/directDropTarget';
import { ensureElevated } from '../utils/elevation';
import OsIcon from './OsIcon.vue';
import ModalShell from './ModalShell.vue';

/** 给在线设备直发文本或文件:两页签共用底部动作区,避免两个弹窗反复开关。 */
const props = defineProps<{
  open: boolean;
  device: DeviceInfo | null;
  direct: DirectApi;
  busy: boolean;
  /** 本机后端能否把多个文件打成一个 zip(目前只有 Node 后端实现了打包)。 */
  zipSupported: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const tab = ref<'text' | 'file'>('text');
const fileInput = ref<HTMLInputElement | null>(null);
/** 文件页签里的「本机路径」输入:daemon 直接读盘投送,不经过浏览器上传。 */
const pathDraft = ref('');
const targetSummary = computed(() => {
  const ids = props.direct.selectedDevices.value;
  if (ids.length === 1) return ids[0] ?? props.device?.deviceId ?? '';
  return `已选 ${ids.length} 台设备`;
});
/** 同名文件在多个设备上有多笔传输:按文件名汇总发送进度,取最小值避免高估。 */
function fileProgress(item: SendFileItem): number | null {
  if (item.state === 'pending') return 0;
  const rows = props.direct.transfers.value.filter(
    (t) => t.direction === 'send' && t.kind === 'file' && t.name === item.file.name && t.size > 0,
  );
  if (!rows.length) return item.state === 'done' ? 100 : null;
  return Math.min(...rows.map((t) => Math.round((t.bytesDone / t.size) * 100)));
}
function fileStateLabel(item: SendFileItem): string {
  if (item.state === 'failed') return '失败';
  if (item.state === 'queued') return '排队中';
  if (item.state === 'done') return '已发出';
  if (item.state === 'sending') {
    const pct = fileProgress(item);
    return pct === null ? '发送中' : `发送中 ${pct}%`;
  }
  return '待发送';
}

/** 选中的设备全都离线时,按钮改口径:这次只是排队,不会立刻发出去。 */
const queuedOnly = computed(() => {
  const ids = props.direct.selectedDevices.value;
  if (!ids.length) return false;
  return ids.every((id) => {
    const d = props.direct.availableTargets.value.find((t) => t.deviceId === id);
    return d ? props.direct.isQueuedTarget(d) : false;
  });
});

/** 底部主按钮文案:发送中 > 多文件 > 排队/发送。 */
const submitLabel = computed(() => {
  if (props.direct.sending.value) return '发送中';
  const many = tab.value === 'file' ? props.direct.fileDrafts.value.length : 0;
  // 打包只有一个文件时忽略开关(后端也按单文件走),文案跟着实际行为走。
  if (many > 1 && props.direct.zipMode.value) {
    return queuedOnly.value ? `排队打包 ${many} 个文件` : `打包发送 ${many} 个文件`;
  }
  if (many > 1) return queuedOnly.value ? `排队 ${many} 个文件` : `发送 ${many} 个文件`;
  return queuedOnly.value ? '排队发送' : '发送';
});

watch(
  () => props.open,
  (open) => {
    // 拖文件到设备卡时会预填队列,此时直接落在文件页,省得用户再点一次。
    if (open) {
      tab.value = props.direct.fileDrafts.value.length ? 'file' : 'text';
      pathDraft.value = '';
    }
  },
);

function pickFile(e: Event): void {
  const input = e.target as HTMLInputElement;
  props.direct.addFiles(Array.from(input.files ?? []));
  // 清空 input,允许再次选同一批文件(否则 change 不触发)。
  input.value = '';
}

/**
 * 剪贴板里的图片直接进文件队列:把截图发给对方是最常见的用法,不必先存盘再选文件。
 * 只认图片文件,纯文本粘贴照旧走 textarea 的默认行为(这里不拦)。
 */
function pasteImages(data: DataTransfer | null): number {
  if (!data) return 0;
  const at = new Date();
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    files.push(new File([blob], pastedImageName(item.type, at, files.length + 1), {
      type: item.type,
      lastModified: at.getTime(),
    }));
  }
  if (!files.length) return 0;
  props.direct.addFiles(files);
  tab.value = 'file';
  return files.length;
}

/** 本弹窗是不是最上层:提权门/收件箱叠在上面时,粘贴与拖入都不该被这里截走。 */
function isTopmost(): boolean {
  const overlays = document.querySelectorAll('.modal-overlay');
  return !!overlays[overlays.length - 1]?.querySelector('.send-modal');
}

/**
 * 监听挂在整个文档上,而不是弹窗 DOM:刚打开弹窗时焦点可能还停在设备卡的「发送」按钮上,
 * 这时 Ctrl+V 的 target 在弹窗之外,挂 `.modal` 收不到。
 */
function onPaste(e: ClipboardEvent): void {
  if (props.direct.sending.value) return;
  if (!isTopmost()) return;
  if (!pasteImages(e.clipboardData)) return;
  // 已经接住了:别让浏览器再往 textarea 里塞占位字符。
  e.preventDefault();
}

/**
 * 弹窗打开期间整页拖入的**文件**都归这里:加入发送队列并切到「文件」页签。
 * 页面级升级遮罩靠 claimSendDrops 让路 —— 否则拖个文件进来先弹「仅支持 .tgz 安装包」,
 * 松手又什么都不做,和「这个弹窗就是用来发文件的」预期正好相反。
 * 与粘贴同理挂在 window 上:焦点在弹窗内或弹窗外都接得住。
 */
const dropActive = ref(false);

function isFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

function onWindowDragOver(e: DragEvent): void {
  if (!isFileDrag(e)) return;
  // 必须 preventDefault:不认领的话浏览器判定这里不接受投放,drop 根本不会派发
  e.preventDefault();
  const ok = !props.direct.sending.value && isTopmost();
  dropActive.value = ok;
  if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? 'copy' : 'none';
}

function onWindowDrop(e: DragEvent): void {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dropActive.value = false;
  if (props.direct.sending.value) return;
  // 提权门叠在上面时这一投不归这里(但依旧 preventDefault,别让浏览器直接打开文件)。
  if (!isTopmost()) return;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.length) return;
  props.direct.addFiles(files);
  tab.value = 'file';
}

function onWindowDragLeave(e: DragEvent): void {
  // relatedTarget 还在页面内 = 只是在子元素之间挪动,别把提示收起
  if (e.relatedTarget) return;
  dropActive.value = false;
}

function clearDrag(): void {
  dropActive.value = false;
}

function attachWindowHooks(): void {
  document.addEventListener('paste', onPaste);
  window.addEventListener('dragover', onWindowDragOver);
  window.addEventListener('drop', onWindowDrop);
  window.addEventListener('dragleave', onWindowDragLeave);
  window.addEventListener('dragend', clearDrag);
}

function detachWindowHooks(): void {
  document.removeEventListener('paste', onPaste);
  window.removeEventListener('dragover', onWindowDragOver);
  window.removeEventListener('drop', onWindowDrop);
  window.removeEventListener('dragleave', onWindowDragLeave);
  window.removeEventListener('dragend', clearDrag);
  clearDrag();
}

watch(
  () => props.open && !!props.device,
  (visible) => {
    claimSendDrops(visible);
    if (visible) attachWindowHooks();
    else detachWindowHooks();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  claimSendDrops(false);
  detachWindowHooks();
});

function submit(): void {
  if (props.direct.sending.value) return;
  const ids = [...props.direct.selectedDevices.value];
  if (!ids.length) return;
  if (tab.value === 'text') void props.direct.sendText(ids);
  else void props.direct.sendFile(ids);
}

/**
 * 按路径发送:路径指 daemon 所在机器,后端会读它 —— 这是「把任意文件读出去」的
 * 能力,和另存到任意目录同一条提权门。验证通过后自动接续本次发送。
 */
function submitPath(): void {
  if (props.direct.sending.value) return;
  const path = pathDraft.value.trim();
  const ids = [...props.direct.selectedDevices.value];
  if (!path || !ids.length) return;
  void ensureElevated('读取本机文件并按路径直发', () => {
    void props.direct.sendPath(ids, path);
  });
}
</script>

<template>
  <ModalShell
    :open="open && !!device"
    title="发送到设备"
    :description="targetSummary"
    :description-mono="direct.selectedDevices.value.length === 1"
    class="send-modal"
    :close-disabled="direct.sending.value"
    @close="emit('close')"
  >
    <!-- 拖动中的提示:说明这一投会进发送队列,不是升级安装包 -->
    <div v-if="dropActive" class="send-drop-hint">松开鼠标，把文件加入发送队列</div>
    <div class="send-target">对方收到后会进入它的「收件箱」，不会写进任何共享目录；离线设备会先在本机排队，上线后自动发送（24 小时内有效）。</div>
    <div class="send-targets">
      <div class="send-targets-head">
        <span class="field__label">发送到（可多选）</span>
        <span class="send-targets-actions">
          <button type="button" :disabled="direct.sending.value" @click="direct.selectAllTargets()">全选</button>
          <button type="button" :disabled="direct.sending.value" @click="direct.clearTargets()">清空</button>
        </span>
      </div>
      <div v-if="direct.availableTargets.value.length" class="send-targets-list">
        <n-checkbox
          v-for="d in direct.availableTargets.value"
          :key="d.deviceId"
          :checked="direct.selectedDevices.value.includes(d.deviceId)"
          :disabled="direct.sending.value"
          class="send-target-row"
          @update:checked="direct.toggleTarget(d.deviceId)"
        >
          <!-- 每行尽量答全「发给谁、往哪儿发」:系统图标认平台,地址行与设备卡同源
               (deviceAddrLine:配置地址优先、回退会话地址,再拼主机名)。旧版对端没有
               platform / 地址时对应块整块不渲染,不留空位。 -->
          <OsIcon v-if="d.platform" :platform="d.platform" :offline="!d.online" :size="13" class="send-target-os" />
          <span class="send-target-id">{{ d.deviceId }}</span>
          <span v-if="deviceAddrLine(d)" class="send-target-addr" :title="deviceAddrLine(d)">{{ deviceAddrLine(d) }}</span>
          <span v-if="!d.online" class="send-target-offline">离线·排队</span>
        </n-checkbox>
      </div>
      <div v-else class="send-targets-empty">没有可发送的设备（在线设备需支持直发；离线设备会先排队）</div>
    </div>
    <div class="send-tabs" role="tablist" aria-label="发送内容类型">
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'text'"
        :class="{ 'is-active': tab === 'text' }"
        @click="tab = 'text'"
      >文本</button>
      <button
        type="button"
        role="tab"
        :aria-selected="tab === 'file'"
        :class="{ 'is-active': tab === 'file' }"
        @click="tab = 'file'"
      >文件</button>
    </div>

    <div v-if="tab === 'text'" class="send-pane">
      <label class="field__label" for="direct-text">文本内容</label>
      <n-input
        id="direct-text"
        v-model:value="direct.textDraft.value"
        type="textarea"
        :autosize="{ minRows: 6, maxRows: 12 }"
        placeholder="输入要发给对方的一段文本（最多 64 KB）"
        :disabled="direct.sending.value"
      />
      <p class="form-hint">对方在线会立刻收到；离线时内容先在本机排队，等它上线自动送达。文本按原样保存，可在收件箱里复制。也可以直接粘贴截图（Ctrl/⌘+V），会当作文件发送。</p>
    </div>

    <div v-else class="send-pane">
      <span class="field__label">选择文件（可多选；也可以把文件直接拖进这个窗口）</span>
      <input ref="fileInput" class="send-file-input" type="file" multiple :disabled="direct.sending.value" @change="pickFile" />
      <n-button quaternary :disabled="direct.sending.value" @click="fileInput?.click()">选择文件…</n-button>
      <div v-if="direct.fileDrafts.value.length" class="send-file-list">
        <div v-for="item in direct.fileDrafts.value" :key="item.key" class="send-file-row" :class="`is-${item.state}`">
          <span class="send-file-name" :title="item.file.name">{{ item.file.name }}</span>
          <span class="send-file-size">{{ direct.formatBytes(item.file.size) }}</span>
          <span class="send-file-state">{{ fileStateLabel(item) }}</span>
          <button
            type="button"
            class="send-file-remove"
            :disabled="direct.sending.value || item.state === 'done'"
            title="从队列移除"
            @click="direct.removeFile(item.key)"
          >移除</button>
        </div>
      </div>
      <p v-else class="form-hint">还没有选择文件。</p>
      <!-- 打包是可选开关:默认逐个投送(接收方拿到原始文件),小文件多时打包更省事。
           开关按后端能力出现 —— 没实现 `/api/direct/zip` 的后端上留着它只会点了报错。 -->
      <n-checkbox
        v-if="zipSupported && direct.fileDrafts.value.length > 1"
        v-model:checked="direct.zipMode.value"
        class="send-zip"
        :disabled="direct.sending.value"
      >打包成一个压缩包发送</n-checkbox>
      <p v-if="zipSupported && direct.zipMode.value && direct.fileDrafts.value.length > 1" class="form-hint">对方只收到一个 .zip；只打包不压缩，包体上限 100 MB。</p>
      <p class="form-hint">单文件最大 {{ direct.formatBytes(direct.maxFileBytes.value) }}、一次最多 20 个；也可以直接粘贴截图。对方需要点「接收」才会开始传输，文件落在其收件箱而非共享目录。</p>
      <!-- 大文件不必先上传:daemon 直接读本机路径。能力按后端声明出现;
           读任意文件属敏感操作,发送前过一次提权门。 -->
      <div v-if="direct.sendByPath.value" class="send-path">
        <span class="field__label">或填 daemon 所在机器的文件路径，直接读盘发送</span>
        <div class="send-path__row">
          <div class="send-path__input">
            <n-input
              v-model:value="pathDraft"
              placeholder="/Users/me/big.iso（绝对路径）"
              :disabled="direct.sending.value"
              @keyup.enter="submitPath"
            />
          </div>
          <n-button :disabled="direct.sending.value || !pathDraft.trim() || !direct.selectedDevices.value.length" @click="submitPath">按路径发送</n-button>
        </div>
        <p class="form-hint">路径指运行 daemon 的这台机器（不一定是你要发送的那台）。文件只读不改、不占收件箱磁盘；对方必须在线，离线不排队。</p>
      </div>
    </div>

    <template #footer>
      <n-button class="modal-cancel" :disabled="direct.sending.value" @click="emit('close')">取消</n-button>
      <n-button type="primary" :loading="direct.sending.value" :disabled="busy || !direct.selectedDevices.value.length || (tab === 'file' && !direct.fileDrafts.value.length)" @click="submit">
        {{ submitLabel }}
      </n-button>
    </template>
  </ModalShell>
</template>

<style scoped>
/*
 * 拖动提示:虚线框压在内容顶部,颜色随主题走。
 * 发送中不亮(dropActive 为 false),此时 dropEffect 是 none,拖进来也不会入队。
 */
.send-drop-hint {
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px dashed var(--accent, #4f7cff);
  border-radius: 8px;
  background: var(--accent-soft, rgba(79, 124, 255, 0.1));
  color: var(--accent, #4f7cff);
  font-size: 12px;
  text-align: center;
}
.send-target {
  margin-bottom: 12px;
  color: var(--muted-strong);
  font-size: 12px;
}
.send-targets {
  margin-bottom: 14px;
}
.send-targets-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.send-targets-actions {
  display: inline-flex;
  gap: 10px;
}
.send-targets-actions button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent, #4f7cff);
  font-size: 11px;
  cursor: pointer;
}
.send-targets-actions button:disabled {
  color: var(--muted);
  cursor: not-allowed;
}
.send-targets-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.send-target-row {
  min-height: 26px;
}
.send-target-id {
  margin-left: 4px;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
}
/* 系统图标跟在勾选框后面:离线自动去色减淡(OsIcon 内建),与设备卡同语义 */
.send-target-os {
  margin-left: 4px;
}
.send-target-addr {
  margin-left: 6px;
  /* 长地址优先省略,把行宽留给 deviceId 与「离线·排队」标记 */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--muted-strong);
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 离线设备的排队标记:与「在线」用法不同,别做成绿色/成功色 */
.send-target-offline {
  flex: 0 0 auto;
  margin-left: 8px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface-2, rgba(127, 127, 127, 0.14));
  color: var(--muted-strong);
  font-size: 10px;
}
.send-targets-empty {
  padding: 10px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  color: var(--muted-strong);
  font-size: 11px;
}
.send-tabs {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  margin-bottom: 12px;
  border-radius: 8px;
  background: var(--surface-2, rgba(127, 127, 127, 0.12));
}
.send-tabs button {
  padding: 5px 16px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted-strong);
  font-size: 12px;
  cursor: pointer;
}
.send-tabs button.is-active {
  background: var(--surface-1, rgba(127, 127, 127, 0.2));
  color: var(--text);
  font-weight: 600;
}
.send-pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.send-file-input {
  display: none;
}
.send-file-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 168px;
  overflow-y: auto;
}
/* 打包开关:紧跟在文件清单后面,和清单算一组,不额外撑开段落间距。 */
.send-zip {
  margin-top: 6px;
  font-size: 12px;
}
/* 按路径发送:与「选文件」是同一件事的两种入口,用虚线隔开,不抢主流程的视觉重量。 */
.send-path {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}
.send-path__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.send-path__input {
  flex: 1 1 auto;
  min-width: 0;
}
.send-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.send-file-row.is-failed {
  border-color: var(--error, #e88080);
}
.send-file-row.is-done {
  opacity: 0.62;
}
.send-file-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.send-file-size {
  flex: 0 0 auto;
  color: var(--muted-strong);
  font-size: 11px;
}
.send-file-state {
  flex: 0 0 auto;
  min-width: 58px;
  color: var(--muted-strong);
  font-size: 11px;
  text-align: right;
}
.send-file-row.is-failed .send-file-state {
  color: var(--error, #e88080);
}
.send-file-remove {
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent, #4f7cff);
  font-size: 11px;
  cursor: pointer;
}
.send-file-remove:disabled {
  color: var(--muted);
  cursor: not-allowed;
}
</style>
