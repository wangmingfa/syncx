<script setup lang="ts">
import { ref, onMounted } from 'vue';
import StatusPage from './StatusPage.vue';
import LoginForm from './LoginForm.vue';

interface StatusData {
  deviceId: string;
  entries: number;
  tombstones: number;
  folders: Array<{ path: string; devices: string[] }>;
  peers: Array<{ deviceId: string; online: boolean; url?: string }>;
  syncProgress: Array<{ folder: string; pending: number; sending: number; receiving: number }>;
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
  <div id="app">
    <StatusPage v-if="status" :status="status" />
    <LoginForm v-else-if="authError" />
    <div v-else class="loading">加载中…</div>
  </div>
</template>
