<script setup lang="ts">
import { ref } from 'vue';
import { NButton, NInput } from 'naive-ui';
import OsIcon from './OsIcon.vue';
import PairQrModal from './PairQrModal.vue';
import { useStatusContext } from '../composables/statusContext';
import { osIconLabel } from '../utils/os-icon';

const {
  status,
  busy,
  addDeviceOpen,
  toggleAddDevice,
  newDeviceId,
  newDeviceHost,
  newDevicePort,
  addDevice,
  addDiscovered,
  askRemoveDevice,
  askUpgrade,
  reconnect,
  deviceFolderCount,
  monogram,
  deviceAddrLine,
  hoverDevices,
  hoverDeviceId,
  onDeviceEnter,
  onDeviceLeave,
} = useStatusContext();

// 本机配对二维码:展示给「对方」扫的,与添加表单并列,方便两台设备面对面操作
const qrOpen = ref(false);
</script>

<template>
  <section class="col col--devices">
    <div class="col-head">
      <!-- 标题+徽标绑成一组(.col-head__lead):与 FolderList 同构,窄屏 wrap 时同进退 -->
      <div class="col-head__lead">
        <span>设备</span>
        <span class="badge">{{ status.devices.length }}</span>
      </div>
      <n-button v-if="status.devices.length > 0" class="add-toggle" :class="{ 'is-invisible': addDeviceOpen }" :disabled="busy" :tabindex="addDeviceOpen ? -1 : 0" @click="toggleAddDevice">＋ 添加</n-button>
    </div>

    <!-- 粘贴对方设备 ID 或 syncx:// 配对串即可配对(双方各加一次,mutual)。跨网段/无 mDNS 时填对方地址:ws://(前缀) + IP + :端口(默认 22000) -->
    <form v-if="addDeviceOpen || status.devices.length === 0" class="add-device" @submit.prevent="addDevice">
      <n-input v-model:value="newDeviceId" placeholder="粘贴对方设备 ID / syncx:// 配对串" />
      <div class="addr-group">
        <n-input v-model:value="newDeviceHost" placeholder="对方 IP" class="device-host">
          <template #prefix>ws://</template>
        </n-input>
        <span class="addr-colon">:</span>
        <n-input v-model:value="newDevicePort" placeholder="22000" class="device-port" />
      </div>
      <div class="add-form-actions">
        <n-button quaternary :disabled="busy" title="弹出本机配对二维码,给对方扫" @click="qrOpen = true">
          <template #icon>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="4" y="4" width="6" height="6" rx="1" />
              <rect x="14" y="4" width="6" height="6" rx="1" />
              <rect x="4" y="14" width="6" height="6" rx="1" />
              <path d="M14 14h3v3h-3zM20 14v0M17 20h3v-3" />
            </svg>
          </template>
          本机二维码
        </n-button>
        <n-button quaternary :disabled="busy" @click="toggleAddDevice">取消</n-button>
        <n-button type="primary" attr-type="submit" :disabled="busy">添加</n-button>
      </div>
    </form>

    <!-- 附近发现的设备:mDNS 扫到、但还没配对的邻居,一键添加(带学到的直连地址) -->
    <div v-if="status.discovered?.length" class="discovered">
      <div class="discovered-head">附近发现的设备</div>
      <div v-for="d in status.discovered" :key="d.deviceId" class="discovered-item">
        <span class="avatar online" aria-hidden="true">{{ monogram(d.deviceId) }}</span>
        <span class="discovered-id mono" :title="`${d.deviceId} · ${d.host}:${d.port}`">{{ d.deviceId }}</span>
        <span class="discovered-addr mono">{{ d.host }}</span>
        <n-button size="tiny" type="primary" tertiary :disabled="busy" @click="addDiscovered(d)">添加</n-button>
      </div>
    </div>

    <div v-if="status.devices.length === 0" class="empty">还没有设备 · 在上方粘贴对方设备 ID 添加</div>
    <div
      v-for="p in status.devices"
      :key="p.deviceId"
      class="item-card"
      :class="{ 'is-linked': hoverDevices.includes(p.deviceId) || hoverDeviceId === p.deviceId }"
      @mouseenter="onDeviceEnter(p.deviceId)"
      @mouseleave="onDeviceLeave()"
    >
      <div class="item-top">
        <span class="avatar" :class="p.online ? 'online' : 'offline'">
          <!-- 对端宣告了平台就画系统图标;旧版本对端不发该字段(undefined)则保持字母头像,
               不留空位。在线/离线仍由头像底色的 online/offline 表达,图标只额外去个色。 -->
          <OsIcon
            v-if="p.platform"
            :platform="p.platform"
            :offline="!p.online"
            :size="18"
            :hint="`${osIconLabel(p.platform)} · ${p.deviceId}`"
          />
          <template v-else>{{ monogram(p.deviceId) }}</template>
        </span>
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

    <!-- 本机配对二维码(给对方扫 / 复制配对串) -->
    <PairQrModal :open="qrOpen" @close="qrOpen = false" />
  </section>
</template>
