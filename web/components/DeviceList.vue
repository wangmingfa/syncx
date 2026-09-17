<script setup lang="ts">
import { NButton } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';

const {
  status,
  busy,
  addDeviceOpen,
  toggleAddDevice,
  newDeviceId,
  newDeviceHost,
  newDevicePort,
  addDevice,
  askRemoveDevice,
  askUpgrade,
  reconnect,
  deviceFolderCount,
  monogram,
  deviceAddrLine,
  hoverDevices,
} = useStatusContext();
</script>

<template>
  <section class="col col--devices">
    <div class="col-head">
      <span>设备</span>
      <span class="badge">{{ status.devices.length }}</span>
      <n-button v-if="status.devices.length > 0" class="add-toggle" :class="{ 'is-invisible': addDeviceOpen }" :disabled="busy" :tabindex="addDeviceOpen ? -1 : 0" @click="toggleAddDevice">＋ 添加</n-button>
    </div>

    <!-- 粘贴对方设备 ID 即可配对(双方各加一次,mutual)。跨网段/无 mDNS 时填对方地址:ws://(前缀) + IP + :端口(默认 22000) -->
    <form v-if="addDeviceOpen || status.devices.length === 0" class="add-device" @submit.prevent="addDevice">
      <n-input v-model:value="newDeviceId" placeholder="粘贴对方设备 ID" />
      <div class="addr-group">
        <n-input v-model:value="newDeviceHost" placeholder="对方 IP" class="device-host">
          <template #prefix>ws://</template>
        </n-input>
        <span class="addr-colon">:</span>
        <n-input v-model:value="newDevicePort" placeholder="22000" class="device-port" />
      </div>
      <div class="add-form-actions">
        <n-button quaternary :disabled="busy" @click="toggleAddDevice">取消</n-button>
        <n-button type="primary" attr-type="submit" :disabled="busy">添加</n-button>
      </div>
    </form>

    <div v-if="status.devices.length === 0" class="empty">还没有设备 · 在上方粘贴对方设备 ID 添加</div>
    <div
      v-for="p in status.devices"
      :key="p.deviceId"
      class="item-card"
      :class="{ 'is-linked': hoverDevices.includes(p.deviceId) }"
    >
      <div class="item-top">
        <span class="avatar" :class="p.online ? 'online' : 'offline'">{{ monogram(p.deviceId) }}</span>
        <span class="item-title mono">{{ p.deviceId }}</span>
        <span class="status-pill" :class="p.online ? 'pill-online' : 'pill-offline'">
          {{ p.online ? '在线' : '离线' }}
        </span>
        <!-- 重连紧挨状态标签:动作跟着它要修的那种状态走,也省掉下方一整行 -->
        <span class="item-actions">
          <n-button
            v-if="!p.online"
            size="small"
            tertiary
            class="btn-inline"
            :disabled="busy"
            @click="reconnect(p.deviceId)"
          >
            重连
          </n-button>
          <n-button size="small" type="error" tertiary class="btn-inline" :disabled="busy" @click="askRemoveDevice(p.deviceId)">移除</n-button>
        </span>
      </div>
      <div class="item-sub">
        共享 {{ deviceFolderCount(p.deviceId) }} 个目录
      </div>
      <div class="item-addr">
        <span class="addr-label">版本</span><span class="addr-value mono">{{ p.version ?? '未知' }}</span>
      </div>
      <div v-if="p.url || p.hostname" class="item-addr">
        <span class="addr-label">{{ p.url ? '地址' : '主机名' }}</span><span class="addr-value mono">{{ deviceAddrLine(p) }}</span>
      </div>
      <div v-if="p.online && p.canUpgrade" class="actions">
        <n-button size="small" type="warning" :disabled="busy" class="btn-upgrade" @click="askUpgrade(p)">
          <template #icon>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </template>
          升级到 {{ p.version }}
        </n-button>
      </div>
    </div>
  </section>
</template>
