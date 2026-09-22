<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NDropdown, NPopover } from 'naive-ui';
import type { DropdownOption } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';
import { formatBytes } from '../utils/bytes';

const { status, busy, checkForUpdate, openUpload, openLogs, openTopology, openTraffic, openGuide, openAuth, logout } = useStatusContext();

/** 累计收发(流量按钮直接把这组数当标签用:不点开也扫一眼可见)。 */
const trafficText = computed<string>(() => {
  const t = status.value.traffic;
  if (!t || (t.sent === 0 && t.received === 0)) return '流量';
  return `↑${formatBytes(t.sent)} · ↓${formatBytes(t.received)}`;
});

/**
 * 低频操作收进「更多」下拉:顶栏曾排 8 个按钮,笔记本宽度下把 device-chip 挤到
 * 第二行(本机信息是状态页的锚点,不该被挤走)。日志/拓扑/流量留在外面是高频项,
 * 其余收进菜单;小屏天然只剩一个「更多」,无需再按断点藏按钮。
 */
const moreOptions = computed<DropdownOption[]>(() => [
  { label: '检查更新', key: 'check-update', disabled: busy.value },
  { label: '上传升级', key: 'upload', disabled: busy.value },
  { type: 'divider', key: 'd-guide' },
  { label: '使用指南', key: 'guide' },
  { label: '登录密码', key: 'auth' },
  { type: 'divider', key: 'd-logout' },
  { label: '退出登录', key: 'logout' },
]);

function onMoreSelect(key: string): void {
  switch (key) {
    case 'check-update':
      void checkForUpdate();
      break;
    case 'upload':
      openUpload();
      break;
    case 'guide':
      openGuide();
      break;
    case 'auth':
      openAuth();
      break;
    case 'logout':
      void logout();
      break;
  }
}

/** 本机网络信息(主机名 + 局域网地址):不外显,hover chip 时浮出。 */
const ips = computed<string[]>(() => status.value.localAddresses ?? []);
const hasLocalInfo = computed<boolean>(() => !!status.value.hostname || ips.value.length > 0);
</script>

<template>
  <div class="topbar">
    <div class="brand">
      <svg class="brand__mark" viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#4a7fc0" />
            <stop offset="1" stop-color="#2bb6ac" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="9" fill="url(#lg)" />
        <g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round">
          <path d="M8.5 13H20" />
          <path d="M24 19H12" />
        </g>
        <path d="M20 10.5 24.5 13 20 15.5Z" fill="#fff" />
        <path d="M12 16.5 7.5 19 12 21.5Z" fill="#fff" />
      </svg>
      <div class="brand__text">
        <div class="brand__name">SYNCX</div>
        <div class="brand__sub">P2P LAN SYNC</div>
      </div>
    </div>

    <n-button tertiary @click="openTraffic" title="传输统计:累计收发与最近 24 小时曲线(daemon 重启清零)">
      <template #icon>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 17 9 11l3.5 3.5L20 6" />
          <path d="M4 21h16" />
        </svg>
      </template>
      {{ trafficText }}
    </n-button>

    <n-button tertiary @click="openLogs">
      <template #icon>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 5h16" />
          <path d="M4 12h16" />
          <path d="M4 19h10" />
        </svg>
      </template>
      日志
    </n-button>

    <n-button tertiary :disabled="busy" @click="openTopology">
      <template #icon>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="5" cy="6" r="2.2" />
          <circle cx="19" cy="6" r="2.2" />
          <circle cx="12" cy="18" r="2.2" />
          <path d="M6.8 7.4 10.4 16M17.2 7.4 13.6 16M7 6h10" />
        </svg>
      </template>
      拓扑
    </n-button>

    <n-dropdown trigger="click" placement="bottom-end" :options="moreOptions" @select="onMoreSelect">
      <n-button tertiary>
        <template #icon>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="19" cy="12" r="1.7" />
          </svg>
        </template>
        更多
      </n-button>
    </n-dropdown>

    <div class="topbar__spacer"></div>

    <!-- 主机名与局域网地址不占顶栏空间:hover 本机 chip 浮出明细(旧后端没下发时不挂浮层) -->
    <n-popover trigger="hover" placement="bottom-end" :disabled="!hasLocalInfo" :style="{ maxWidth: '420px' }">
      <template #trigger>
        <span class="device-chip">
          <span class="dot" :class="status.devices.some((p) => p.online) ? 'dot-online' : 'dot-offline'"></span>
          <span class="mono">{{ status.deviceId }}</span>
          <span v-if="status.version" class="chip-version">{{ status.version === 'dev' ? status.version : `v${status.version}` }}</span>
          <svg v-if="hasLocalInfo" class="chip-caret" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </template>
      <div class="chip-info">
        <div v-if="status.hostname" class="chip-info-row">
          <span class="chip-info-label">主机名</span>
          <span class="mono">{{ status.hostname }}</span>
        </div>
        <div v-for="ip in ips" :key="ip" class="chip-info-row">
          <span class="chip-info-label">IPv4</span>
          <span class="mono">{{ ip }}</span>
        </div>
      </div>
    </n-popover>
  </div>
</template>
