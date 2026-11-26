<script setup lang="ts">
import { NButton } from 'naive-ui';
import type { StatusData } from '../types';
import type { DirectApi } from '../composables/useDirect';
import ModalShell from './ModalShell.vue';
import { fmtTime } from '../utils/format';

/** 直发收件箱:待确认文件、在途进度、已收到的文本/文件。 */
const props = defineProps<{
  open: boolean;
  status: StatusData;
  direct: DirectApi;
  busy: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

function stateLabel(state: string): string {
  if (state === 'offering') return '等待确认';
  if (state === 'transferring') return '传输中';
  if (state === 'done') return '已完成';
  return '失败';
}
function percent(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
}
</script>

<template>
  <ModalShell
    :open="open"
    title="收件箱"
    description="其它设备直发给你的内容"
    class="inbox-modal"
    wide
    esc-close
    @close="emit('close')"
  >
    <div v-if="status.direct?.pending.length" class="inbox-section">
      <div class="inbox-section-title">待确认<span class="badge">{{ status.direct.pending.length }}</span></div>
      <div v-for="p in status.direct.pending" :key="p.id" class="inbox-card is-pending">
        <div class="inbox-row">
          <span class="inbox-name">{{ p.name }}</span>
          <span class="inbox-size">{{ direct.formatBytes(p.size) }}</span>
        </div>
        <div class="inbox-sub">来自 {{ p.from }} · {{ fmtTime(p.createdAt) }}</div>
        <div class="inbox-actions">
          <n-button size="small" :disabled="busy" @click="direct.reply(p.id, false)">拒绝</n-button>
          <n-button size="small" type="primary" :disabled="busy" @click="direct.reply(p.id, true)">接收</n-button>
        </div>
      </div>
    </div>

    <div v-if="status.direct?.transfers.length" class="inbox-section">
      <div class="inbox-section-title">传输中</div>
      <div v-for="t in status.direct.transfers" :key="t.id" class="inbox-card">
        <div class="inbox-row">
          <span class="inbox-name">{{ t.name ?? (t.kind === 'text' ? '文本' : '文件') }}</span>
          <span class="inbox-state" :class="`is-${t.state}`">{{ stateLabel(t.state) }}</span>
        </div>
        <div class="inbox-sub">{{ t.direction === 'send' ? '发往' : '来自' }} {{ t.deviceId }} · {{ direct.formatBytes(t.bytesDone) }} / {{ direct.formatBytes(t.size) }}</div>
        <div class="inbar"><span :style="{ width: `${percent(t.bytesDone, t.size)}%` }" /></div>
        <div v-if="t.error" class="inbox-error">{{ t.error }}</div>
      </div>
    </div>

    <div class="inbox-section">
      <div class="inbox-section-title">已收到<span class="badge">{{ status.direct?.inbox.length ?? 0 }}</span></div>
      <div v-if="!status.direct?.inbox.length" class="inbox-empty">还没有收到内容。在设备卡上点「发送」可从另一台设备投过来。</div>
      <div v-for="item in status.direct?.inbox ?? []" :key="item.id" class="inbox-card">
        <div class="inbox-row">
          <span class="inbox-name">{{ item.kind === 'file' ? item.name : '文本' }}</span>
          <span class="inbox-size">{{ direct.formatBytes(item.size) }}</span>
        </div>
        <div class="inbox-sub">来自 {{ item.from }} · {{ fmtTime(item.createdAt) }}</div>
        <div v-if="item.kind === 'text'" class="inbox-preview">{{ item.preview }}</div>
        <div class="inbox-actions">
          <n-button v-if="item.kind === 'text'" size="small" tertiary :disabled="busy" @click="direct.copyItem(item)">复制</n-button>
          <n-button v-else size="small" tertiary :disabled="busy" @click="direct.downloadItem(item)">下载</n-button>
          <n-button size="small" type="error" tertiary :disabled="busy" @click="direct.removeItem(item.id)">删除</n-button>
        </div>
      </div>
    </div>

    <template #footer>
      <n-button class="modal-cancel" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>
</template>

<style scoped>
.inbox-section + .inbox-section {
  margin-top: 18px;
}
.inbox-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-strong);
}
.inbox-card {
  padding: 10px 12px;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.inbox-card.is-pending {
  border-color: var(--accent);
}
.inbox-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.inbox-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.inbox-size,
.inbox-state {
  flex: 0 0 auto;
  color: var(--muted-strong);
  font-size: 11px;
}
.inbox-state.is-done {
  color: var(--success, #2e9b62);
}
.inbox-state.is-failed {
  color: var(--error, #d03050);
}
.inbox-sub {
  margin-top: 4px;
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.inbox-preview {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--surface-2, rgba(127, 127, 127, 0.12));
  color: var(--muted-strong);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow: auto;
}
.inbox-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.inbar {
  height: 4px;
  margin-top: 8px;
  border-radius: 2px;
  background: var(--surface-2, rgba(127, 127, 127, 0.12));
  overflow: hidden;
}
.inbar > span {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}
.inbox-error {
  margin-top: 6px;
  color: var(--error, #d03050);
  font-size: 11px;
}
.inbox-empty {
  padding: 16px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}
</style>
