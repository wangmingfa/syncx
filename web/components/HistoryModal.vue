<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import type { SyncEventItem } from '../types';
import { apiJson, errText } from '../utils/api';
import { copyText } from '../utils/clipboard';
import { useStatusContext } from '../composables/statusContext';

const props = defineProps<{
  /** 非空 = 打开该目录的记录弹窗并拉取历史。 */
  folder: { id?: string; path: string } | null;
  /** 轻提示(父级 useToast 提供)。 */
  notify: (msg: string, kind?: 'info' | 'alert') => void;
}>();
const emit = defineEmits<{ close: [] }>();
const { askConfirm } = useStatusContext();

const events = ref<SyncEventItem[]>([]);
const loading = ref(false);
const lastPath = ref('');

watch(
  () => props.folder,
  async (f) => {
    if (!f) return;
    lastPath.value = f.path;
    events.value = [];
    loading.value = true;
    try {
      const id = f.id ?? f.path;
      const data = await apiJson<{ events: SyncEventItem[] }>(
        `/api/folders/history?folderId=${encodeURIComponent(id)}`,
      );
      events.value = data.events ?? [];
    } catch (e) {
      props.notify(errText(e, '读取同步记录失败'));
    } finally {
      loading.value = false;
    }
  },
);

function actionLabel(a: string): string {
  return ({ add: '新增', update: '修改', delete: '删除', conflict: '冲突' } as Record<string, string>)[a] ?? a;
}

function directionLabel(d: string): string {
  return d === 'local' ? '本地' : '对端';
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

// 复制当前展示的全部同步记录到剪贴板
async function copyHistory(): Promise<void> {
  if (events.value.length === 0) return;
  const text = events.value
    .map((ev) => {
      const dir =
        directionLabel(ev.direction) +
        (ev.direction !== 'local' && ev.deviceId ? `：${ev.deviceId}` : '');
      return `${fmtTime(ev.ts)}\t${actionLabel(ev.action)}\t${dir}\t${ev.path}`;
    })
    .join('\n');
  const ok = await copyText(text);
  if (ok) {
    props.notify('已复制全部同步记录到剪贴板', 'info');
  } else {
    props.notify('复制失败，请手动选择记录复制', 'alert');
  }
}

// 清空当前目录的全部同步记录(不可逆,需二次确认)
async function clearHistory(): Promise<void> {
  const f = props.folder;
  if (!f) return;
  const id = f.id ?? f.path;
  await apiJson('/api/folders/history/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId: id }),
  });
  events.value = [];
}

// 触发二次确认弹窗(复用全局 ConfirmModal,防误删)
function askClearHistory(): void {
  const f = props.folder;
  if (!f) return;
  askConfirm({
    title: '清空同步记录',
    message: '将删除该目录的全部同步记录,此操作不可恢复。',
    detail: f.path,
    confirmText: '清空',
    note: '清空后仅移除历史条目,之后的新同步仍会正常记录。',
    action: clearHistory,
  });
}
</script>

<template>
  <Transition name="guide">
    <div v-if="folder" class="modal-overlay" @click.self="emit('close')">
      <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <n-button quaternary circle class="modal-close" aria-label="关闭" @click="emit('close')">×</n-button>
        <div class="modal-title-row">
          <h2 id="history-title" class="modal-title">同步记录</h2>
          <span class="modal-title-path mono" :title="lastPath">{{ lastPath }}</span>
        </div>

        <div v-if="loading" class="history-loading">读取中…</div>
        <div v-else-if="events.length === 0" class="empty">还没有同步记录</div>
        <ul v-else class="history-list">
          <li v-for="ev in events" :key="ev.ts + ev.path + ev.action" class="history-row">
            <span class="history-time">{{ fmtTime(ev.ts) }}</span>
            <span class="history-action" :class="'act-' + ev.action">{{ actionLabel(ev.action) }}</span>
            <span class="history-dir" :class="ev.direction === 'local' ? 'dir-local' : 'dir-remote'">{{ directionLabel(ev.direction) }}{{ ev.direction !== 'local' && ev.deviceId ? `：${ev.deviceId}` : '' }}</span>
            <span class="history-path mono break">{{ ev.path }}</span>
          </li>
        </ul>

        <div class="modal-actions">
          <n-button :disabled="events.length === 0" @click="copyHistory">复制记录</n-button>
          <n-button :disabled="events.length === 0" @click="askClearHistory">清空记录</n-button>
          <n-button type="primary" @click="emit('close')">关闭</n-button>
        </div>
      </div>
    </div>
  </Transition>
</template>
