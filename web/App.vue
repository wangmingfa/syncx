<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { NConfigProvider, type GlobalThemeOverrides } from 'naive-ui';
import StatusPage from './StatusPage.vue';
import LoginForm from './LoginForm.vue';

// 让 naive-ui 控件沿用品牌色与圆角,与现有卡片/面板视觉统一
const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#4a7fc0',
    primaryColorHover: '#5e8ecb',
    primaryColorPressed: '#3f6ea8',
    primaryColorSuppl: '#5e8ecb',
    borderRadius: '9px',
    fontSize: '14px',
  },
};

interface OfferInfo {
  id: string;
  kind: 'pairing' | 'folder';
  fromDeviceId: string;
  folderId?: string;
  folderName?: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: number;
}

interface StatusData {
  deviceId: string;
  entries: number;
  tombstones: number;
  folders: Array<{ id?: string; path: string; devices: string[] }>;
  devices: Array<{ deviceId: string; online: boolean; url?: string; folders: string[] }>;
  syncProgress: Array<{ folder: string; pending: number; sending: number; receiving: number }>;
  offers: OfferInfo[];
}

// 纯 CSR:页面由客户端挂载,状态由 /api/status 拉取,不再依赖 SSR 注入
const status = ref<StatusData | null>(null);
const authError = ref(false);

onMounted(async () => {
  try {
    const res = await fetch('/api/status');
    if (res.status === 401) {
      authError.value = true;
      return;
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    status.value = (await res.json()) as StatusData;
  } catch {
    authError.value = true;
  }
});
</script>

<template>
  <n-config-provider :theme-overrides="themeOverrides">
    <StatusPage v-if="status" :status="status" />
    <LoginForm v-else-if="authError" />
    <div v-else class="loading">加载中…</div>
  </n-config-provider>
</template>
