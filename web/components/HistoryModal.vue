<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import type { SyncEventItem } from '../types';

const props = defineProps<{
  /** 非空 = 打开该目录的记录弹窗并拉取历史。 */
  folder: { id?: string; path: string } | null;
  /** 轻提示(父级 useToast 提供)。 */
  notify: (msg: string, kind?: 'info' | 'alert') => void;
}>();
const emit = defineEmits<{ close: [] }>();

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
      const res = await fetch(`/api/folders/history?folderId=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`history ${res.status}`);
      const data = (await res.json()) as { events: SyncEventItem[] };
      events.value = data.events ?? [];
    } catch {
      props.notify('读取同步记录失败');
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
      </div>
    </div>
  </Transition>
</template>
