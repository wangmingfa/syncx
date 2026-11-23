<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NInput } from 'naive-ui';
import type { DeviceInfo } from '../types';
import ModalShell from './ModalShell.vue';

/** 与 useDevices 的默认端口保持一致(留空回退)。 */
const DEFAULT_PEER_PORT = '22000';

const props = defineProps<{
  open: boolean;
  /** 正在编辑的设备(打开时预填当前地址;设备 ID 只读,不提供修改入口)。 */
  device: DeviceInfo | null;
  busy: boolean;
}>();
const emit = defineEmits<{
  close: [];
  /** 保存:只提交 IP/端口,设备 ID 原样带回用于定位。 */
  save: [payload: { deviceId: string; host: string; port: string }];
}>();

const host = ref('');
const port = ref(DEFAULT_PEER_PORT);

/** 从 ws://host:port 拆出 host/port;IPv6 的方括号在这里去掉,提交时由 useDevices 补回。 */
function parseAddress(addr?: string): { host: string; port: string } {
  const m = addr ? /^ws:\/\/(\[[^\]]+\]|[^:/]+):(\d+)\/?$/i.exec(addr) : null;
  if (!m) return { host: '', port: DEFAULT_PEER_PORT };
  return { host: m[1]!.replace(/^\[|\]$/g, ''), port: m[2]! };
}

watch(
  () => props.device,
  (d) => {
    if (!d) return;
    // 优先用配置里持久化的地址(离线也能编辑);没有则回退到当前会话地址
    const { host: h, port: p } = parseAddress(d.address ?? d.url);
    host.value = h;
    port.value = p;
  },
);

function onSave(): void {
  if (props.busy || !props.device) return;
  emit('save', { deviceId: props.device.deviceId, host: host.value, port: port.value });
}
</script>

<template>
  <!-- 没有正在编辑的设备就不该开(只看 open 会渲染出一个空壳),条件投影给外壳 -->
  <ModalShell
    :open="open && !!device"
    title="编辑设备"
    :description="device?.deviceId ?? ''"
    description-mono
    @close="emit('close')"
  >
    <div class="edit-section-label">设备 ID</div>
    <div class="edit-device-id mono">{{ device?.deviceId }}</div>
    <p class="confirm-note-extra">设备 ID 是配对身份,不可修改。调整 IP/端口不影响配对关系与共享目录。</p>

    <div class="edit-section-label">对端地址</div>
    <div class="edit-device-addr">
      <n-input
        v-model:value="host"
        class="edit-device-host"
        placeholder="对方 IP 或主机名"
        :disabled="busy"
      >
        <template #prefix>ws://</template>
      </n-input>
      <span class="edit-device-colon">:</span>
      <n-input v-model:value="port" class="edit-device-port" placeholder="22000" :disabled="busy" />
    </div>
    <p class="confirm-note-extra">
      局域网内对端 IP 变化或端口冲突时,在这里改成新地址。保存后本机会立即按新地址重连;
      对端离线时则等它上线后用新地址连接(旧地址会从配置中移除)。
    </p>

    <template #footer>
      <n-button class="modal-cancel" :disabled="busy" @click="emit('close')">取消</n-button>
      <n-button type="primary" :loading="busy" @click="onSave">保存</n-button>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 设备 ID 只读展示:用与输入框同高的一行呈现,明确「这是身份、不是可编辑字段」 */
.edit-device-id {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--muted);
  overflow-wrap: anywhere;
}

/* host:port 一行:host 可伸缩,port 固定窄列,冒号居中对齐 */
.edit-device-addr {
  display: flex;
  align-items: center;
  gap: 8px;
}

.edit-device-host {
  flex: 1 1 auto;
  min-width: 0;
}

.edit-device-port {
  flex: 0 0 96px;
}

.edit-device-colon {
  color: var(--muted);
}
</style>
