<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NCheckbox, NInput, NInputNumber } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';
import { apiPost, errText } from '../utils/api';
import ModalShell from './ModalShell.vue';

/**
 * 全局设置弹窗:发送带宽上限(全局兜底)、每路径版本份数、历史记录保留上限、
 * 同步事件 Webhook(完成/冲突/错误外推通知,飞书机器人地址自动适配格式)、
 * 电源守卫(计费网络/低电量自动挂起,仅 Windows 探测启用)。
 * 数值项都是「留空 = 回默认」的语义(后端 null 清除配置,走内置默认值);
 * 保存走 POST /api/settings,后端落盘并按需热生效(重建限速通道 / 执行器)。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { status, busy, refreshStatus, showToast } = useStatusContext();

// 三项都以 null 表示「未设置/回默认」;NInputNumber 清空输入后 value 即为 null
const maxSendKbps = ref<number | null>(null);
const versionsPerPath = ref<number | null>(null);
const historyMaxEvents = ref<number | null>(null);

// Webhook:地址 '' = 关闭;密钥留空 = 保持已存值不变(清空需点「清除密钥」)
const webhookUrl = ref('');
const webhookSecret = ref('');
const secretCleared = ref(false);
const secretAlreadySet = ref(false);
const testingWebhook = ref(false);

// 电源守卫(Windows):两个开关 + 低电量阈值;非 Windows 后端不探测,开关无实际作用
const pauseOnMeteredNetwork = ref(false);
const pauseOnLowBattery = ref(false);
const batteryPauseThreshold = ref<number | null>(null);

const DEFAULT_VERSIONS = 10;
const DEFAULT_HISTORY = 2000;
const DEFAULT_BATTERY_THRESHOLD = 20;

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const s = status.value.settings;
    maxSendKbps.value = s?.maxSendKbps ?? null;
    versionsPerPath.value = s?.versionsPerPath ?? null;
    historyMaxEvents.value = s?.historyMaxEvents ?? null;
    webhookUrl.value = s?.webhookUrl ?? '';
    webhookSecret.value = '';
    secretCleared.value = false;
    secretAlreadySet.value = s?.webhookSecretSet === true;
    pauseOnMeteredNetwork.value = s?.pauseOnMeteredNetwork === true;
    pauseOnLowBattery.value = s?.pauseOnLowBattery === true;
    batteryPauseThreshold.value = s?.batteryPauseThreshold ?? null;
  },
);

async function onSave(): Promise<void> {
  if (busy.value) return;
  const body: Record<string, unknown> = {
    maxSendKbps: maxSendKbps.value,
    versionsPerPath: versionsPerPath.value,
    historyMaxEvents: historyMaxEvents.value,
    webhookUrl: webhookUrl.value.trim() || null,
    // 开关:关 = 传 null 清除(false 与缺省同义,后端不留 false 值)
    pauseOnMeteredNetwork: pauseOnMeteredNetwork.value ? true : null,
    pauseOnLowBattery: pauseOnLowBattery.value ? true : null,
    batteryPauseThreshold: batteryPauseThreshold.value,
  };
  // 密钥三态:填了新值就覆盖;点了「清除」传 null;否则整个键不传 = 保持已存值
  const secret = webhookSecret.value.trim();
  if (secret) body.webhookSecret = secret;
  else if (secretCleared.value) body.webhookSecret = null;
  try {
    await apiPost('/api/settings', body);
    showToast('设置已保存');
    await refreshStatus();
    emit('close');
  } catch (e) {
    showToast(errText(e, '保存失败,请重试'), 'alert');
  }
}

async function onTestWebhook(): Promise<void> {
  if (testingWebhook.value) return;
  testingWebhook.value = true;
  try {
    const res = await apiPost<{ ok?: boolean; error?: string }>('/api/settings/webhook-test', {});
    if (res.ok) showToast('测试消息已送达');
    else showToast(res.error ?? '测试失败', 'alert');
  } catch (e) {
    showToast(errText(e, '测试失败'), 'alert');
  } finally {
    testingWebhook.value = false;
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

    <div class="edit-section-label">同步事件 Webhook</div>
    <n-input
      v-model:value="webhookUrl"
      class="settings-input"
      placeholder="https://… 留空 = 关闭通知"
      :disabled="busy"
      clearable
    />
    <n-input
      v-model:value="webhookSecret"
      class="settings-input"
      :placeholder="secretAlreadySet && !secretCleared ? '已设置(留空保持不变)' : '可选:签名密钥'"
      type="password"
      show-password-on="click"
      :disabled="busy"
    />
    <p class="confirm-note-extra">
      同步完成、出现冲突、目录持续出错时向该地址推送一条通知;飞书机器人地址自动按其格式发送,其余地址为 JSON。
      目录出错只在错误内容变化时推送一次,不会每轮重复打扰。
      <template v-if="secretAlreadySet && !secretCleared">
        密钥已保存,不回显;输入新值可覆盖,或
        <button type="button" class="settings-link" @click="secretCleared = true; webhookSecret = ''">清除已存密钥</button>。
      </template>
      <template v-else-if="secretCleared">密钥将被清除。</template>
    </p>
    <n-button size="small" :loading="testingWebhook" :disabled="busy" @click="onTestWebhook">发送测试消息</n-button>

    <div class="edit-section-label">计费网络 / 电池感知(仅 Windows)</div>
    <n-checkbox v-model:checked="pauseOnMeteredNetwork" class="settings-checkbox" :disabled="busy">检测到计费网络时自动挂起同步</n-checkbox>
    <n-checkbox v-model:checked="pauseOnLowBattery" :disabled="busy" class="settings-checkbox">用电池且电量过低时自动挂起同步</n-checkbox>
    <n-input-number
      v-model:value="batteryPauseThreshold"
      class="settings-input"
      :min="1"
      :max="99"
      :step="5"
      :placeholder="`默认 ${DEFAULT_BATTERY_THRESHOLD}`"
      :disabled="busy || !pauseOnLowBattery"
    >
      <template #suffix>%</template>
    </n-input-number>
    <p class="confirm-note-extra">
      daemon 每分钟探测一次联网成本与电池状态,命中条件时所有目录的数据面自动挂起(连接与配对照常),
      条件解除自动恢复;与手动暂停互不覆盖。挂起期间目录栏会显示原因徽标。非 Windows 机器不启用探测。
      阈值留空 = 默认 {{ DEFAULT_BATTERY_THRESHOLD }}%。
    </p>

    <template #footer>
      <n-button class="modal-cancel" :disabled="busy" @click="emit('close')">取消</n-button>
      <n-button type="primary" :loading="busy" @click="onSave">保存</n-button>
    </template>
  </ModalShell>
</template>
