<script setup lang="ts">
import { useToast } from '../composables/useToast';

/**
 * 全局 toast 的**渲染器**。
 *
 * toast 状态是模块级单例(见 useToast.ts),但「谁渲染它」是页面级的事 —— 以前只有
 * StatusPage 模板里写了那一段,对比页(ComparePage)触发 showToast 时值有人写、
 * 没人渲染,提示永远不出现(旧版「复制报告」的反馈就是这么静默丢掉的)。
 * 抽成组件让两个页面共用一份标记,新增页面时接一行即可。
 */
const { toast } = useToast();
</script>

<template>
  <div v-if="toast" class="toast" :class="{ 'toast--alert': toast.kind === 'alert' }">
    <svg
      v-if="toast.kind === 'alert'"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
    {{ toast.msg }}
  </div>
</template>
