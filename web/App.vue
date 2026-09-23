<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { NConfigProvider, darkTheme, type GlobalThemeOverrides } from 'naive-ui';
import StatusPage from './StatusPage.vue';
import LoginForm from './LoginForm.vue';
import ComparePage from './ComparePage.vue';
import { route } from './utils/route';
import { useTheme } from './composables/useTheme';
import type { StatusData } from './types';

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

// naive-ui 的深色算法主题跟随解析结果;CSS 变量层由 useTheme 挂在 <html data-theme> 上,
// 两套必须同源切换 —— 否则出现「naive 弹窗深色、页面卡片还是浅色」的拼接。
const { resolved } = useTheme();
const naiveTheme = computed(() => (resolved.value === 'dark' ? darkTheme : null));

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
  <n-config-provider :theme="naiveTheme" :theme-overrides="themeOverrides">
    <!-- 路由优先于状态页:/compare/<folderId> 直接渲染双栏对比页,其余走状态页 -->
    <ComparePage
      v-if="status && route.name === 'compare' && route.folderId"
      :status="status"
      :folder-id="route.folderId"
      :device="route.device"
    />
    <StatusPage v-else-if="status" :status="status" />
    <LoginForm v-else-if="authError" />
    <div v-else class="loading">加载中…</div>
  </n-config-provider>
</template>
