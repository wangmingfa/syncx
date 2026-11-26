<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NInput } from 'naive-ui';
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
  if (!props.device || props.direct.sending.value) return;
  if (tab.value === 'text') void props.direct.sendText(props.device.deviceId);
  else void props.direct.sendFile(props.device.deviceId);
}
</script>

<template>
  <ModalShell
    :open="open && !!device"
    title="发送到设备"
    :description="device?.deviceId ?? ''"
    description-mono
    class="send-modal"
    :close-disabled="direct.sending.value"
    @close="emit('close')"
  >
    <div class="send-target">对方收到后会进入它的「收件箱」，不会写进任何共享目录。</div>
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
      <n-button type="primary" :loading="direct.sending.value" :disabled="busy || (tab === 'file' && !direct.fileDraft.value)" @click="submit">
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
