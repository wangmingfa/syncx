<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import type { SyncEventItem } from '../types';
import { apiJson, errText } from '../utils/api';
import { copyText } from '../utils/clipboard';
import { useStatusContext } from '../composables/statusContext';
import ModalShell from './ModalShell.vue';

const props = defineProps<{
  /** 非空 = 打开该目录的记录弹窗并拉取历史。 */
  folder: { id?: string; path: string } | null;
  /** 轻提示(父级 useToast 提供)。 */
  notify: (msg: string, kind?: 'info' | 'alert') => void;
}>();
const emit = defineEmits<{ close: [] }>();
const { askConfirm, status } = useStatusContext();

/** 本机设备 id。记录里的方向标着「本地 / 对端：<id>」,不给本机 id 的话,
 *  一串 id 里认不出哪台是自己(与设备卡同源:都取 status.deviceId)。 */
const deviceId = computed<string>(() => status.value.deviceId);

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

// 复制当前展示的全部同步记录到剪贴板(首行带上与弹窗一致的本机 id 说明,
// 否则粘贴出去的一串「对端：<id>」照样认不出哪台是自己)
async function copyHistory(): Promise<void> {
  if (events.value.length === 0) return;
  const rows = events.value
    .map((ev) => {
      const dir =
        directionLabel(ev.direction) +
        (ev.direction !== 'local' && ev.deviceId ? `：${ev.deviceId}` : '');
      return `${fmtTime(ev.ts)}\t${actionLabel(ev.action)}\t${dir}\t${ev.path}`;
    });
  const text = `本机 ${deviceId.value} · 记录里的「本地」即本机，「对端」标注了来源设备 id\n\n${rows.join('\n')}`;
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
  <!-- 打开条件本来就是 folder 非空,这里把它投影成外壳要的布尔(emit 的语义不变) -->
  <ModalShell
    :open="!!folder"
    title="同步记录"
    :description="lastPath"
    description-mono
    wide
    @close="emit('close')"
  >
    <!-- 方向列的「本地 / 对端」与本机 id 成对出现:只标「对端：<id>」而不给本机 id,
         一串 id 里认不出哪台是自己。id 从注入的 status 取,与设备卡同源。 -->
    <p class="modal-lead">本机 <code class="mono">{{ deviceId }}</code> · 记录里的「本地」即本机，「对端」标注了来源设备 id</p>

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

    <template #footer>
      <n-button :disabled="events.length === 0" @click="copyHistory">复制记录</n-button>
      <n-button :disabled="events.length === 0" @click="askClearHistory">清空记录</n-button>
      <n-button type="primary" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>
</template>
