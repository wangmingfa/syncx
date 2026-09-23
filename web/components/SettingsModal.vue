<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NInputNumber } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';
import { apiPost, errText } from '../utils/api';
import ModalShell from './ModalShell.vue';

/**
 * 全局设置弹窗:发送带宽上限(全局兜底)、每路径版本份数、历史记录保留上限。
 * 三项都是「留空 = 回默认」的语义(后端 null 清除配置,走内置默认值);
 * 保存走 POST /api/settings,后端落盘并按需热生效(重建限速通道 / 执行器)。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { status, busy, refreshStatus, showToast } = useStatusContext();

// 三项都以 null 表示「未设置/回默认」;NInputNumber 清空输入后 value 即为 null
const maxSendKbps = ref<number | null>(null);
const versionsPerPath = ref<number | null>(null);
const historyMaxEvents = ref<number | null>(null);

const DEFAULT_VERSIONS = 10;
const DEFAULT_HISTORY = 2000;

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const s = status.value.settings;
    maxSendKbps.value = s?.maxSendKbps ?? null;
    versionsPerPath.value = s?.versionsPerPath ?? null;
    historyMaxEvents.value = s?.historyMaxEvents ?? null;
  },
);

async function onSave(): Promise<void> {
  if (busy.value) return;
  try {
    await apiPost('/api/settings', {
      maxSendKbps: maxSendKbps.value,
      versionsPerPath: versionsPerPath.value,
      historyMaxEvents: historyMaxEvents.value,
    });
    showToast('设置已保存');
    await refreshStatus();
    emit('close');
  } catch (e) {
    showToast(errText(e, '保存失败,请重试'), 'alert');
  }
}
</script>

<template>
  <ModalShell :open="open" title="全局设置" description="对所有共享目录生效;目录级设置优先于这里的默认值" @close="emit('close')">
    <div class="edit-section-label">发送带宽上限</div>
    <n-input-number
      v-model:value="maxSendKbps"
      class="settings-input"
      :min="0"
      :step="512"
      placeholder="不限速"
      :disabled="busy"
    >
      <template #suffix>KB/s</template>
    </n-input-number>
    <p class="confirm-note-extra">
      每个对端的发送速率上限(目录单独配置「maxBandwidthKbps」时不走这里)。
      大文件同步占满 LAN 带宽时用它兜底;留空 = 不限速。
    </p>

    <div class="edit-section-label">每路径版本份数</div>
    <n-input-number
      v-model:value="versionsPerPath"
      class="settings-input"
      :min="1"
      :step="1"
      :placeholder="`默认 ${DEFAULT_VERSIONS}`"
      :disabled="busy"
    >
      <template #suffix>份</template>
    </n-input-number>
    <p class="confirm-note-extra">
      本机文件被对端覆盖前,旧内容会自动留档;同一路径超过这个份数时删最旧的。
      留空 = 默认 {{ DEFAULT_VERSIONS }} 份。
    </p>

    <div class="edit-section-label">历史记录保留上限</div>
    <n-input-number
      v-model:value="historyMaxEvents"
      class="settings-input"
      :min="1"
      :step="500"
      :placeholder="`默认 ${DEFAULT_HISTORY}`"
      :disabled="busy"
    >
      <template #suffix>条 / 目录</template>
    </n-input-number>
    <p class="confirm-note-extra">每个目录最多保留多少条同步记录,超出后丢弃最旧的。留空 = 默认 {{ DEFAULT_HISTORY }} 条。</p>

    <template #footer>
      <n-button class="modal-cancel" :disabled="busy" @click="emit('close')">取消</n-button>
      <n-button type="primary" :loading="busy" @click="onSave">保存</n-button>
    </template>
  </ModalShell>
</template>
