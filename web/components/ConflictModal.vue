<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { apiJson, errText } from '../utils/api';
import { formatBytes } from '../utils/bytes';
import { useStatusContext } from '../composables/statusContext';
import ModalShell from './ModalShell.vue';

/** 一条冲突副本(与 src/conflicts.ts 的 ConflictCopy 同形)。 */
interface ConflictCopy {
  copyPath: string;
  originalPath: string;
  deviceId: string;
  size: number;
  mtime: number;
}

const props = defineProps<{
  /** 非空 = 打开该目录的冲突收件箱并实时扫盘。 */
  folder: { id?: string; path: string } | null;
  /** 轻提示(父级 useToast 提供)。 */
  notify: (msg: string, kind?: 'info' | 'alert') => void;
  /** 处理会改动盘面并触发广播,完成后让父级刷新状态。 */
  changed: () => void;
}>();
const emit = defineEmits<{ close: [] }>();
const { askConfirm, status } = useStatusContext();

const conflicts = ref<ConflictCopy[]>([]);
const truncated = ref(false);
const loading = ref(false);
const lastPath = ref('');
const busyPath = ref<string | null>(null);

watch(
  () => props.folder,
  (f) => {
    if (!f) return;
    lastPath.value = f.path;
    conflicts.value = [];
    truncated.value = false;
    void load(f.id ?? f.path);
  },
);

async function load(id: string): Promise<void> {
  loading.value = true;
  try {
    const data = await apiJson<{ conflicts?: ConflictCopy[]; truncated?: boolean }>(
      `/api/folders/conflicts?folderId=${encodeURIComponent(id)}`,
    );
    conflicts.value = data.conflicts ?? [];
    truncated.value = data.truncated === true;
  } catch (e) {
    props.notify(errText(e, '读取冲突列表失败'), 'alert');
  } finally {
    loading.value = false;
  }
}

/** 冲突来源设备:能对上已知设备就标主机名,认不出留 id。 */
function deviceLabel(id: string): string {
  const dev = status.value.devices.find((d) => d.deviceId === id);
  return dev?.hostname ? `${dev.hostname}（${id}）` : id;
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

async function doResolve(c: ConflictCopy, choice: 'keep-local' | 'discard'): Promise<void> {
  const f = props.folder;
  if (!f) return;
  busyPath.value = c.copyPath;
  try {
    await apiJson('/api/folders/conflicts/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: f.id ?? f.path, copyPath: c.copyPath, choice }),
    });
    props.notify(
      choice === 'keep-local'
        ? `已用本地版本覆盖 ${c.originalPath},将同步给对端`
        : '冲突副本已移入回收站',
      'info',
    );
    props.changed();
    await load(f.id ?? f.path);
  } catch (e) {
    props.notify(errText(e, '处理冲突失败'), 'alert');
  } finally {
    busyPath.value = null;
  }
}

// 「保留本地版」有覆盖对端内容的传播力(结果会广播出去),二次确认必须把后果说全
function askKeepLocal(c: ConflictCopy): void {
  askConfirm({
    title: '保留本地版本',
    message: `将用冲突副本覆盖回原文件「${c.originalPath}」,该结果会同步给对端。`,
    detail: c.copyPath,
    confirmText: '用本地版覆盖',
    note: '被覆盖的对端内容会先留档到「文件版本」,可再恢复;冲突副本移入回收站。',
    action: () => doResolve(c, 'keep-local'),
  });
}

function askDiscard(c: ConflictCopy): void {
  askConfirm({
    title: '丢弃冲突副本',
    message: '本地这份冲突副本将移入回收站,原文件(对端版本)保持不变。',
    detail: c.copyPath,
    confirmText: '丢弃',
    note: '回收站在本机配置目录下,不跨设备同步。',
    action: () => doResolve(c, 'discard'),
  });
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}
</script>

<template>
  <ModalShell
    :open="!!folder"
    title="待处理冲突"
    :description="lastPath"
    description-mono
    wide
    @close="emit('close')"
  >
    <p class="modal-lead">两边都改过同一文件时,输的一方被保留成冲突副本(绝不静默丢数据)。逐条选「保留哪版」或「丢弃副本」,处理结果会同步给对端。</p>

    <div v-if="loading" class="history-loading">读取中…</div>
    <div v-else-if="conflicts.length === 0" class="empty">
      该目录没有待处理的冲突副本
    </div>
    <template v-else>
      <p v-if="truncated" class="history-scope">冲突条目过多,仅列出前 500 条(按时间倒序)</p>
      <ul class="history-list conflict-list">
        <li v-for="c in conflicts" :key="c.copyPath" class="history-row">
          <span class="history-time">{{ fmtTime(c.mtime) }}</span>
          <span class="history-action act-conflict">冲突</span>
          <div class="conflict-paths">
            <span class="history-path mono break" :title="c.originalPath">原文件:{{ basename(c.originalPath) }}</span>
            <span class="conflict-from muted">来源 {{ deviceLabel(c.deviceId) }} · {{ formatBytes(c.size) }}</span>
          </div>
          <span class="conflict-ops">
            <n-button size="tiny" type="primary" quaternary :loading="busyPath === c.copyPath" :disabled="busyPath !== null" @click="askKeepLocal(c)">保留本地版</n-button>
            <n-button size="tiny" type="error" quaternary :disabled="busyPath !== null" @click="askDiscard(c)">丢弃</n-button>
          </span>
        </li>
      </ul>
    </template>

    <template #footer>
      <n-button type="primary" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>
</template>
