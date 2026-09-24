<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';
import { apiJson, errText } from '../utils/api';
import { pairCodeUrl, qrToSvg } from '../utils/qrcode';
import type { PairCodeData } from '../types';
import ModalShell from './ModalShell.vue';

/**
 * 本机配对二维码:把 deviceId + 局域网地址 + 数据面端口拼成 syncx:// 配对串画成码。
 * 对端在「添加设备」处扫码或直接粘贴串即可配对,不用手抄 10 位设备 ID。
 * 展示所有局域网地址(多网卡机器对端可按网段挑可达的那个),默认高亮第一个。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { busy, copy } = useStatusContext();

const loading = ref(false);
const error = ref('');
const code = ref<PairCodeData | null>(null);
const pickedAddress = ref('');

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    code.value = await apiJson<PairCodeData>('/api/paircode');
    pickedAddress.value = code.value.addresses[0] ?? '';
  } catch (e) {
    error.value = errText(e, '获取配对信息失败');
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void load();
  },
);

const pairUrl = (): string => (code.value && pickedAddress.value ? pairCodeUrl(code.value.deviceId, pickedAddress.value, code.value.port) : '');
const qrSvg = (): string => (pairUrl() ? qrToSvg(pairUrl(), 4) : '');
</script>

<template>
  <ModalShell
    :open="open"
    title="本机配对二维码"
    description="在对方设备的「添加设备」里扫码,或直接粘贴下方的配对串"
    @close="emit('close')"
  >
    <div v-if="loading" class="pairqr-state">读取中…</div>
    <div v-else-if="error" class="pairqr-state is-error">{{ error }}</div>
    <template v-else-if="code">
      <div class="pairqr-code" v-html="qrSvg()"></div>

      <div class="edit-section-label">局域网地址</div>
      <div class="pairqr-addr">
        <button
          v-for="addr in code.addresses"
          :key="addr"
          type="button"
          class="pairqr-addr-item mono"
          :class="{ 'is-picked': addr === pickedAddress }"
          :title="addr === pickedAddress ? '已选用该地址生成二维码' : '点击改用该地址生成二维码'"
          @click="pickedAddress = addr"
        >{{ addr }}</button>
      </div>

      <div class="edit-section-label">配对串</div>
      <div class="pairqr-url mono">{{ pairUrl() }}</div>
    </template>

    <template #footer>
      <n-button class="modal-cancel" :disabled="busy" @click="emit('close')">关闭</n-button>
      <n-button v-if="code" type="primary" :disabled="busy || !pairUrl()" @click="copy(pairUrl())">复制配对串</n-button>
    </template>
  </ModalShell>
</template>
