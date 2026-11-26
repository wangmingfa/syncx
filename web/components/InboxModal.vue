<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NInput } from 'naive-ui';
import type { DirectItem, DirectPending, StatusData } from '../types';
import type { DirectApi } from '../composables/useDirect';
import { ensureElevated, elevated } from '../utils/elevation';
import ModalShell from './ModalShell.vue';
import FileIcon from './FileIcon.vue';
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
  if (state === 'queued') return '等待设备上线';
  if (state === 'offering') return '等待确认';
  if (state === 'transferring') return '传输中';
  if (state === 'paused') return '等待重连';
  if (state === 'done') return '已完成';
  if (state === 'canceled') return '已取消';
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

/**
 * 待确认项按批组合并:同一次「发送 N 个文件」在这里只占一张卡 —— 否则 20 个文件就是
 * 20 次「接收」点击,卡片还会把弹窗撑满。没有 batchId 的(旧发送端 / 单条投送)各自成组,
 * 渲染与以前完全一致。
 */
interface PendingGroup {
  /** 组 key:有 batchId 用它,否则用条目 id。 */
  key: string;
  batchId?: string;
  items: DirectPending[];
  /** 组内第一条:展示来自谁、什么时候、以及单条时的文件名。 */
  first: DirectPending;
}
const pendingGroups = computed<PendingGroup[]>(() => {
  const groups: PendingGroup[] = [];
  const byBatch = new Map<string, PendingGroup>();
  for (const p of props.status.direct?.pending ?? []) {
    if (!p.batchId) {
      groups.push({ key: p.id, items: [p], first: p });
      continue;
    }
    const existing = byBatch.get(p.batchId);
    if (existing) {
      existing.items.push(p);
      continue;
    }
    const group: PendingGroup = { key: p.batchId, batchId: p.batchId, items: [p], first: p };
    byBatch.set(p.batchId, group);
    groups.push(group);
  }
  return groups;
});
function groupBytes(g: PendingGroup): number {
  return g.items.reduce((sum, p) => sum + p.size, 0);
}

/** 另存表单是弹窗内的临时视图状态,提交动作本身放在 useDirect + 提权单例里。 */
const savingKey = ref<string | null>(null);
const savePath = ref('');
function startSave(g: PendingGroup): void {
  savingKey.value = g.key;
  savePath.value = '';
}
function cancelSave(): void {
  savingKey.value = null;
  savePath.value = '';
}
function confirmSave(g: PendingGroup): void {
  const dir = savePath.value.trim();
  if (!dir) return;
  // 写用户目录属敏感操作:与终端/文件管理器共用同一道门,验证成功后自动接续。
  void ensureElevated('将直发文件保存到指定目录', () => {
    const done = g.batchId
      ? props.direct.replyBatch(g.batchId, true, dir)
      : props.direct.reply(g.first.id, true, dir);
    void done.then((ok) => {
      if (ok && savingKey.value === g.key) cancelSave();
    });
  });
}
function acceptGroup(g: PendingGroup): void {
  void (g.batchId ? props.direct.replyBatch(g.batchId, true) : props.direct.reply(g.first.id, true));
}
function rejectGroup(g: PendingGroup): void {
  void (g.batchId ? props.direct.replyBatch(g.batchId, false) : props.direct.reply(g.first.id, false));
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
      <div v-for="g in pendingGroups" :key="g.key" class="inbox-card is-pending">
        <div class="inbox-row">
          <span class="inbox-title">
            <FileIcon v-if="g.items.length > 1" kind="files" />
            <FileIcon v-else :name="g.first.name" />
            <span class="inbox-name">{{ g.items.length > 1 ? `${g.items.length} 个文件` : g.first.name }}</span>
          </span>
          <span class="inbox-size">{{ direct.formatBytes(g.items.length > 1 ? groupBytes(g) : g.first.size) }}</span>
        </div>
        <div class="inbox-sub">来自 {{ g.first.from }} · {{ fmtTime(g.first.createdAt) }}<template v-if="g.items.length > 1"> · 一次确认即可全部接收</template></div>
        <ul v-if="g.items.length > 1" class="inbox-filelist">
          <li v-for="p in g.items" :key="p.id">
            <span class="inbox-title">
              <FileIcon :name="p.name" />
              <span class="inbox-file-name" :title="p.name">{{ p.name }}</span>
            </span>
            <span class="inbox-size">{{ direct.formatBytes(p.size) }}</span>
          </li>
        </ul>
        <div class="inbox-actions">
          <n-button size="small" :disabled="busy" @click="rejectGroup(g)">拒绝</n-button>
          <n-button size="small" tertiary :disabled="busy" @click="startSave(g)">另存到…</n-button>
          <n-button size="small" type="primary" :disabled="busy" @click="acceptGroup(g)">
            {{ g.items.length > 1 ? '全部接收' : '接收' }}
          </n-button>
        </div>
        <div v-if="savingKey === g.key" class="save-field">
          <span class="field__label">保存目录（daemon 所在机器的绝对路径）</span>
          <n-input v-model:value="savePath" size="small" :placeholder="folderPathPlaceholder(status.platform)" />
          <p class="form-hint">需先验证；文件直接写入该目录，同名自动加序号，不会进入共享目录或索引。</p>
          <div class="inbox-actions">
            <n-button size="small" @click="cancelSave">取消</n-button>
            <n-button size="small" type="primary" :disabled="!savePath.trim()" @click="confirmSave(g)">
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
          <span class="inbox-title">
            <FileIcon v-if="t.kind === 'text'" kind="text" />
            <FileIcon v-else-if="t.name" :name="t.name" />
            <FileIcon v-else kind="file" />
            <span class="inbox-name">{{ t.name ?? (t.kind === 'text' ? '文本' : '文件') }}</span>
          </span>
          <span class="inbox-state" :class="`is-${t.state}`">{{ stateLabel(t.state) }}</span>
        </div>
        <div class="inbox-sub">{{ t.direction === 'send' ? '发往' : '来自' }} {{ t.deviceId }} · {{ direct.formatBytes(t.bytesDone) }} / {{ direct.formatBytes(t.size) }}</div>
        <div class="inbar"><span :style="{ width: `${percent(t.bytesDone, t.size)}%` }" /></div>
        <!-- 排队项可以撤:内容还在本机暂存区,没发出去也不占对方任何东西。 -->
        <div v-if="t.direction === 'send' && t.state === 'queued'" class="inbox-actions">
          <n-button size="small" :disabled="busy" @click="direct.cancelSend(t.id)">取消排队</n-button>
        </div>
        <div v-if="t.error" class="inbox-error">{{ t.error }}</div>
      </div>
    </div>

    <div class="inbox-section">
      <div class="inbox-section-title">已收到<span class="badge">{{ status.direct?.inbox.length ?? 0 }}</span></div>
      <div v-if="!status.direct?.inbox.length" class="inbox-empty">还没有收到内容。在设备卡上点「发送」可从另一台设备投过来。</div>
      <div v-for="item in status.direct?.inbox ?? []" :key="item.id" class="inbox-card">
        <div class="inbox-row">
          <span class="inbox-title">
            <FileIcon v-if="item.kind === 'text'" kind="text" />
            <FileIcon v-else :name="item.kind === 'file' ? item.name : ''" />
            <span class="inbox-name">{{ item.kind === 'file' ? item.name : '文本' }}</span>
          </span>
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
.inbox-filelist {
  margin: 6px 0 0;
  padding: 0;
  max-height: 132px;
  overflow-y: auto;
  list-style: none;
}
.inbox-filelist li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 0 2px 8px;
  font-size: 12px;
}
.inbox-file-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--muted-strong);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inbox-saved {
  flex: 0 0 auto;
  color: var(--success, #2e9b62);
  font-size: 11px;
}
/* 图标 + 文件名成一组:图标与文字同一行,10px 的 .inbox-row gap 留给「标题 ↔ 大小」,
   组内间距收紧到 6px。行内不再用 baseline 对齐 —— 13px 的内联 SVG 会按自己的底边压下去,
   一栏里就会看到图标比文字低半格。 */
.inbox-title {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.inbox-row {
  display: flex;
  align-items: center;
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
/* 一行放不下就换行,别让按钮从左沿挤出去:批量卡是「拒绝 / 另存到… / 全部接收」三颗,
   320px 视口下卡片内容盒只有 187px、三颗要 213px —— 不换行时 justify-content: flex-end
   会把超出部分推到左侧,按钮直接压在卡片边框外面(>=360px 才自然放得下)。 */
.inbox-actions {
  display: flex;
  flex-wrap: wrap;
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
