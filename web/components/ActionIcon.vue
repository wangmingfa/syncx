<script setup lang="ts">
/**
 * 动作图标集:内联 SVG(项目无图标库,与 FileIcon.vue / OsIcon.vue 同一条路)。
 *
 * 为什么把图标集中到这一处而不是留在各调用点:一排按钮抽成 ActionRail 后,按钮是以
 * **数据数组**传进组件的,原先那种「在模板里内联一段 svg」没有落脚的地方 —— 只能给
 * 每个动作起个名字,由组件按名渲染。代价是新增动作要多改这一处;换来的是目录卡那
 * 115 行近似重复的 n-tooltip > span > n-button > svg 塌成 6 行配置。
 *
 * 画法约定:一律 24 视框、描边 currentColor、不写死颜色 —— 颜色由按钮自己的
 * type(default / primary / error)决定,禁用态与危险态因此自动跟随。
 */
import type { ActionIconName } from '../utils/action-rail';

defineProps<{ name: ActionIconName }>();
</script>

<template>
  <!-- 与调用点原来的 svg 完全同尺寸(14px)同线宽,迁移后视觉不应有任何位移 -->
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <!-- 暂停 -->
    <template v-if="name === 'pause'">
      <line x1="9" y1="5.5" x2="9" y2="18.5" />
      <line x1="15" y1="5.5" x2="15" y2="18.5" />
    </template>

    <!-- 恢复(播放) -->
    <template v-else-if="name === 'play'">
      <path d="M8 5.5 18 12 8 18.5Z" />
    </template>

    <!-- 双栏对比 -->
    <template v-else-if="name === 'compare'">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <line x1="12" y1="4.5" x2="12" y2="19.5" />
    </template>

    <!-- 差异报告:放大镜 + 两行文字 -->
    <template v-else-if="name === 'diff'">
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
      <path d="M8 8.5h5M8 12h3" />
    </template>

    <!-- 同步记录:时钟 -->
    <template v-else-if="name === 'history'">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </template>

    <!-- 版本留档:三层叠片 -->
    <template v-else-if="name === 'versions'">
      <path d="M4 8.5 12 4.5l8 4" />
      <path d="M4 13 12 9l8 4" />
      <path d="M4 17.5 12 13.5l8 4" />
    </template>

    <!-- 移除:垃圾桶 -->
    <template v-else-if="name === 'trash'">
      <path d="M4.5 7h15" />
      <path d="M9.5 7V4.5h5V7" />
      <path d="M6.5 7l.8 12a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8l.8-12" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </template>

    <!-- 更多(收起态占位):三个点。刻意不用「⚙/滑块」那类图标 —— 占位图标只负责
         说「这里还有东西」,不该长得像某个具体动作,否则会被读成「这是一个设置按钮」。 -->
    <template v-else>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </template>
  </svg>
</template>
