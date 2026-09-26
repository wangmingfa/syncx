<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { NConfigProvider, darkTheme, dateZhCN, zhCN, type GlobalThemeOverrides } from 'naive-ui';
import StatusPage from './StatusPage.vue';
import LoginForm from './LoginForm.vue';
import ComparePage from './ComparePage.vue';
import TerminalPage from './TerminalPage.vue';
import FileManagerPage from './FileManagerPage.vue';
import FleetPage from './FleetPage.vue';
import TrashPage from './TrashPage.vue';
import { route } from './utils/route';
import { useTheme } from './composables/useTheme';
import { useSkin } from './composables/useSkin';
import type { StatusData } from './types';

// 让 naive-ui 控件沿用品牌色与圆角,与现有卡片/面板视觉统一。
// 玻璃档下浮层(弹层/下拉)要跟着磨砂 —— naive 的主题变量以**内联自定义属性**注入,
// CSS 覆盖不动,只能走 themeOverrides 这条正门;透明度的底在这里给,backdrop-filter
// 由 style.css 的玻璃段补(它管不着 filter)。深浅 × 玻璃是两个维度,四组取值在这里汇成一份。
const { resolved } = useTheme();
const { mode: skinMode } = useSkin();

const themeOverrides = computed<GlobalThemeOverrides>(() => {
  const base: GlobalThemeOverrides = {
    common: {
      primaryColor: '#4a7fc0',
      primaryColorHover: '#5e8ecb',
      primaryColorPressed: '#3f6ea8',
      primaryColorSuppl: '#5e8ecb',
      borderRadius: '9px',
      fontSize: '14px',
    },
  };
  if (skinMode.value !== 'glass') return base;
  const dark = resolved.value === 'dark';
  return {
    ...base,
    Popover: { color: dark ? 'rgba(27, 33, 44, 0.72)' : 'rgba(255, 255, 255, 0.72)' },
    Dropdown: { color: dark ? 'rgba(27, 33, 44, 0.8)' : 'rgba(255, 255, 255, 0.8)' },
  };
});

// naive-ui 的深色算法主题跟随解析结果;CSS 变量层由 useTheme 挂在 <html data-theme> 上,
// 两套必须同源切换 —— 否则出现「naive 弹窗深色、页面卡片还是浅色」的拼接。
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
  <n-config-provider :theme="naiveTheme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <!-- 路由优先于状态页:终端页/文件管理器页不依赖本页 status(各自拉取,401 自行处理) -->
    <TerminalPage v-if="route.name === 'terminal'" />
    <FileManagerPage v-else-if="route.name === 'files'" />
    <FleetPage v-else-if="route.name === 'fleet'" />
    <TrashPage v-else-if="route.name === 'trash'" />
    <ComparePage
      v-else-if="status && route.name === 'compare' && route.folderId"
      :status="status"
      :folder-id="route.folderId"
      :device="route.device"
    />
    <StatusPage v-else-if="status" :status="status" />
    <LoginForm v-else-if="authError" />
    <div v-else class="loading">加载中…</div>
  </n-config-provider>
</template>
