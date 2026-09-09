<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton } from 'naive-ui';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

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
    const res = await fetch('/api/logs?lines=800');
    if (!res.ok) throw new Error(`logs ${res.status}`);
    const data = (await res.json()) as { ok: boolean; error?: string; file?: string; truncated?: number; lines?: string[] };
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
  } catch {
    error.value = '读取日志失败,请重试';
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
</script>

<template>
  <Transition name="guide">
    <div v-if="open" class="modal-overlay" @click.self="emit('close')">
      <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="logs-title">
        <n-button quaternary circle class="modal-close" aria-label="关闭" @click="emit('close')">×</n-button>
        <h2 id="logs-title" class="modal-title">运行日志</h2>
        <p v-if="file" class="modal-lead mono break">
          {{ file }}<template v-if="truncated > 0"> · 已省略最早 {{ truncated }} 行</template>
        </p>

        <div v-if="loading" class="history-loading">读取中…</div>
        <template v-else-if="error">
          <div class="logs-unavailable" role="alert">{{ error }}</div>
          <p class="confirm-note-extra">
            在启动 daemon 时加上 <code class="mono">--log-file &lt;路径&gt;</code> 参数(如
            <code class="mono">syncx start --log-file ~/.syncx/syncx.log</code>),日志会同步写入该文件,这里即可查看。
          </p>
        </template>
        <pre v-else ref="view" class="logs-view mono">{{ lines.join('\n') }}</pre>

        <div class="modal-actions">
          <n-button :loading="loading" @click="fetchLogs">刷新</n-button>
          <n-button type="primary" @click="emit('close')">关闭</n-button>
        </div>
      </div>
    </div>
  </Transition>
</template>
