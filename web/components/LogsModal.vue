<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { apiJson, errText } from '../utils/api';
import { useToast } from '../composables/useToast';
import { copyText } from '../utils/clipboard';
import ModalShell from './ModalShell.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const { showToast } = useToast();

const loading = ref(false);
const lines = ref<string[]>([]);
const error = ref('');
const file = ref('');
const truncated = ref(0);
const view = ref<HTMLElement | null>(null);

async function fetchLogs(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const data = await apiJson<{
      ok: boolean;
      error?: string;
      file?: string;
      truncated?: number;
      lines?: string[];
    }>('/api/logs?lines=800');
    if (!data.ok) {
      // 未设置 --log-file 或读取失败:展示原因,引导用户补启动参数
      error.value = data.error ?? '读取日志失败';
      lines.value = [];
      return;
    }
    lines.value = data.lines ?? [];
    file.value = data.file ?? '';
    truncated.value = data.truncated ?? 0;
    // 下一帧滚到底部:日志按时间正序,最新在最后
    requestAnimationFrame(() => {
      const el = view.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  } catch (e) {
    error.value = errText(e, '读取日志失败,请重试');
  } finally {
    loading.value = false;
  }
}

// 每次打开都重新拉取一次日志尾部
watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    lines.value = [];
    error.value = '';
    await fetchLogs();
  },
);

// 复制当前展示的全部日志到剪贴板
async function copyLogs(): Promise<void> {
  if (lines.value.length === 0) return;
  const ok = await copyText(lines.value.join('\n'));
  if (ok) {
    showToast('已复制全部日志到剪贴板', 'info');
  } else {
    showToast('复制失败，请手动选择日志复制', 'alert');
  }
}
</script>

<template>
  <!-- 日志文件路径放标题右侧(和其它弹窗的「标题 + 右侧路径」一致),原先它在正文第一行;
       截断提示留在正文,那里说的不是「看的是哪个文件」而是「看到的少了一截」。 -->
  <ModalShell
    :open="open"
    title="运行日志"
    :description="file"
    description-mono
    wide
    @close="emit('close')"
  >
    <p v-if="truncated > 0" class="modal-lead">已省略最早 {{ truncated }} 行</p>

    <div v-if="loading" class="history-loading">读取中…</div>
    <template v-else-if="error">
      <div class="logs-unavailable" role="alert">{{ error }}</div>
      <p class="confirm-note-extra">
        在启动 daemon 时加上 <code class="mono">--log-file &lt;路径&gt;</code> 参数(如
        <code class="mono">syncx start --log-file ~/.syncx/syncx.log</code>),日志会同步写入该文件,这里即可查看。
      </p>
    </template>
    <pre v-else ref="view" class="logs-view mono">{{ lines.join('\n') }}</pre>

    <template #footer>
      <n-button :disabled="lines.length === 0" @click="copyLogs">复制日志</n-button>
      <n-button :loading="loading" @click="fetchLogs">刷新</n-button>
      <n-button type="primary" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>
</template>
