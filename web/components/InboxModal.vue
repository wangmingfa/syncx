<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NInput } from 'naive-ui';
import type { DirectItem, StatusData } from '../types';
import type { DirectApi } from '../composables/useDirect';
import { ensureElevated, elevated } from '../utils/elevation';
import ModalShell from './ModalShell.vue';
import { fmtTime, folderPathPlaceholder } from '../utils/format';

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
  if (state === 'paused') return '等待重连';
  if (state === 'done') return '已完成';
  return '失败';
}
function percent(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
}
function isExternal(item: DirectItem): boolean {
  return item.kind === 'file' && item.external === true;
}
function savedPath(item: DirectItem): string {
  return item.kind === 'file' ? (item.path ?? '') : '';
}

/** 另存表单是弹窗内的临时视图状态,提交动作本身放在 useDirect + 提权单例里。 */
const savingId = ref<string | null>(null);
const savePath = ref('');
function startSave(id: string): void {
  savingId.value = id;
  savePath.value = '';
}
function cancelSave(): void {
  savingId.value = null;
  savePath.value = '';
}
function confirmSave(id: string): void {
  const dir = savePath.value.trim();
  if (!dir) return;
  // 写用户目录属敏感操作:与终端/文件管理器共用同一道门,验证成功后自动接续。
  void ensureElevated('将直发文件保存到指定目录', () => {
    void props.direct.reply(id, true, dir).then((ok) => {
      if (ok && savingId.value === id) cancelSave();
    });
  });
}
watch(
  () => props.open,
  (open) => {
    if (!open) cancelSave();
  },
);
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
          <n-button size="small" tertiary :disabled="busy" @click="startSave(p.id)">另存到…</n-button>
          <n-button size="small" type="primary" :disabled="busy" @click="direct.reply(p.id, true)">接收</n-button>
        </div>
        <div v-if="savingId === p.id" class="save-field">
          <span class="field__label">保存目录（daemon 所在机器的绝对路径）</span>
          <n-input v-model:value="savePath" size="small" :placeholder="folderPathPlaceholder(status.platform)" />
          <p class="form-hint">需先验证；文件直接写入该目录，同名自动加序号，不会进入共享目录或索引。</p>
          <div class="inbox-actions">
            <n-button size="small" @click="cancelSave">取消</n-button>
            <n-button size="small" type="primary" :disabled="!savePath.trim()" @click="confirmSave(p.id)">
              {{ elevated ? '接收并另存' : '验证并另存' }}
            </n-button>
          </div>
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
          <span v-if="isExternal(item)" class="inbox-saved">已另存</span>
          <span class="inbox-size">{{ direct.formatBytes(item.size) }}</span>
        </div>
        <div class="inbox-sub">来自 {{ item.from }} · {{ fmtTime(item.createdAt) }}</div>
        <div v-if="isExternal(item)" class="inbox-sub">已保存到 {{ savedPath(item) }}</div>
        <div v-if="item.kind === 'text'" class="inbox-preview">{{ item.preview }}</div>
        <div class="inbox-actions">
          <n-button v-if="item.kind === 'text'" size="small" tertiary :disabled="busy" @click="direct.copyItem(item)">复制</n-button>
          <n-button v-else size="small" tertiary :disabled="busy" @click="direct.downloadItem(item)">下载</n-button>
          <n-button size="small" type="error" tertiary :disabled="busy" @click="direct.removeItem(item.id)">
            {{ isExternal(item) ? '移除记录' : '删除' }}
          </n-button>
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
/* 路径输入与提示必须包成一组:分开写会叠加两块 margin,和全局 .form-hint 冲突。
   这里用 gap 排版,所以要把 .form-hint 自带的 margin-top 清掉,否则 4+4 叠加成 8px。 */
.save-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
  padding: 10px;
  border: 1px dashed var(--border);
  border-radius: 8px;
}
.save-field .field__label {
  margin-bottom: 0;
}
.save-field .form-hint {
  margin-top: 0;
}
.inbox-saved {
  flex: 0 0 auto;
  color: var(--success, #2e9b62);
  font-size: 11px;
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
