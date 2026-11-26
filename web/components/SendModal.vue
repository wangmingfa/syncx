<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { NButton, NCheckbox, NInput } from 'naive-ui';
import type { DeviceInfo } from '../types';
import type { DirectApi, SendFileItem } from '../composables/useDirect';
import { pastedImageName } from '../utils/format';
import ModalShell from './ModalShell.vue';

/** 给在线设备直发文本或文件:两页签共用底部动作区,避免两个弹窗反复开关。 */
const props = defineProps<{
  open: boolean;
  device: DeviceInfo | null;
  direct: DirectApi;
  busy: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const tab = ref<'text' | 'file'>('text');
const fileInput = ref<HTMLInputElement | null>(null);
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
    if (open) tab.value = props.direct.fileDrafts.value.length ? 'file' : 'text';
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

/**
 * 监听挂在整个文档上,而不是弹窗 DOM:刚打开弹窗时焦点可能还停在设备卡的「发送」按钮上,
 * 这时 Ctrl+V 的 target 在弹窗之外,挂 `.modal` 收不到。只处理「本弹窗是最上层」的情形 ——
 * 收件箱、提权门叠在上面时,那里的粘贴不该被这里截走。
 */
function onPaste(e: ClipboardEvent): void {
  if (props.direct.sending.value) return;
  const overlays = document.querySelectorAll('.modal-overlay');
  if (!overlays[overlays.length - 1]?.querySelector('.send-modal')) return;
  if (!pasteImages(e.clipboardData)) return;
  // 已经接住了:别让浏览器再往 textarea 里塞占位字符。
  e.preventDefault();
}

watch(
  () => props.open && !!props.device,
  (visible) => {
    if (visible) document.addEventListener('paste', onPaste);
    else document.removeEventListener('paste', onPaste);
  },
  { immediate: true },
);
onBeforeUnmount(() => document.removeEventListener('paste', onPaste));

function submit(): void {
  if (props.direct.sending.value) return;
  const ids = [...props.direct.selectedDevices.value];
  if (!ids.length) return;
  if (tab.value === 'text') void props.direct.sendText(ids);
  else void props.direct.sendFile(ids);
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
          <span class="send-target-id">{{ d.deviceId }}</span>
          <span v-if="d.hostname" class="send-target-host">{{ d.hostname }}</span>
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
      <span class="field__label">选择文件（可多选，也可把文件拖到设备卡上）</span>
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
      <!-- 打包是可选开关:默认逐个投送(接收方拿到原始文件),小文件多时打包更省事。 -->
      <n-checkbox
        v-if="direct.fileDrafts.value.length > 1"
        v-model:checked="direct.zipMode.value"
        class="send-zip"
        :disabled="direct.sending.value"
      >打包成一个压缩包发送</n-checkbox>
      <p v-if="direct.zipMode.value && direct.fileDrafts.value.length > 1" class="form-hint">对方只收到一个 .zip；只打包不压缩，包体上限 100 MB。</p>
      <p class="form-hint">单文件最大 100 MB、一次最多 20 个；也可以直接粘贴截图。对方需要点「接收」才会开始传输，文件落在其收件箱而非共享目录。</p>
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
.send-target-host {
  margin-left: 6px;
  overflow: hidden;
  color: var(--muted-strong);
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
