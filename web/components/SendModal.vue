<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NCheckbox, NInput } from 'naive-ui';
import type { DeviceInfo } from '../types';
import type { DirectApi } from '../composables/useDirect';
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

watch(
  () => props.open,
  (open) => {
    if (open) tab.value = 'text';
  },
);

function pickFile(e: Event): void {
  const input = e.target as HTMLInputElement;
  props.direct.fileDraft.value = input.files?.[0] ?? null;
}

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
    <div class="send-target">对方收到后会进入它的「收件箱」，不会写进任何共享目录。</div>
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
        </n-checkbox>
      </div>
      <div v-else class="send-targets-empty">没有可直发的在线设备（需要对方也支持直发）</div>
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
      <p class="form-hint">发送后对方会收到提示；文本按原样保存，可在收件箱里复制。</p>
    </div>

    <div v-else class="send-pane">
      <span class="field__label">选择文件</span>
      <input ref="fileInput" class="send-file-input" type="file" :disabled="direct.sending.value" @change="pickFile" />
      <n-button quaternary :disabled="direct.sending.value" @click="fileInput?.click()">选择文件…</n-button>
      <div v-if="direct.fileDraft.value" class="send-file-picked">
        <span class="send-file-name">{{ direct.fileDraft.value.name }}</span>
        <span class="send-file-size">{{ direct.formatBytes(direct.fileDraft.value.size) }}</span>
      </div>
      <p class="form-hint">单文件最大 100 MB。对方需要点「接收」才会开始传输，文件落在其收件箱而非共享目录。</p>
    </div>

    <template #footer>
      <n-button class="modal-cancel" :disabled="direct.sending.value" @click="emit('close')">取消</n-button>
      <n-button type="primary" :loading="direct.sending.value" :disabled="busy || !direct.selectedDevices.value.length || (tab === 'file' && !direct.fileDraft.value)" @click="submit">
        {{ direct.sending.value ? '发送中' : '发送' }}
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
.send-file-picked {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
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
</style>
