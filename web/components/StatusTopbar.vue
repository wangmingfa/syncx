<script setup lang="ts">
import { NButton } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';

const { status, busy, checkForUpdate, openLogs, openGuide, openAuth, logout } = useStatusContext();
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

    <n-button tertiary :disabled="busy" @click="checkForUpdate">
      <template #icon>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 3v5h-5" />
        </svg>
      </template>
      检查更新
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

    <n-button tertiary @click="openGuide">使用指南</n-button>
    <n-button tertiary @click="openAuth">登录密码</n-button>
    <n-button tertiary @click="logout">退出</n-button>

    <div class="topbar__spacer"></div>

    <span class="device-chip">
      <span class="dot" :class="status.devices.some((p) => p.online) ? 'dot-online' : 'dot-offline'"></span>
      <span class="mono">{{ status.deviceId }}</span>
      <span v-if="status.version" class="chip-version">{{ status.version === 'dev' ? status.version : `v${status.version}` }}</span>
    </span>
  </div>
</template>
