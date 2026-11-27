<script setup lang="ts">
import type { StatusData } from '../types';

defineProps<{ status: StatusData }>();
</script>

<template>
  <div class="stat-pills">
    <span class="stat-pill-item"><b>{{ status.entries }}</b><span>索引条目</span></span>
    <span class="stat-pill-item"><b>{{ status.tombstones }}</b><span>墓碑</span></span>
    <span class="stat-pill-item"><b>{{ status.folders.length }}</b><span>共享目录</span></span>
    <span class="stat-pill-item"><b>{{ status.devices.length }}</b><span>已配对设备</span></span>
  </div>
</template>

<style scoped>
/* 小屏把四张统计卡排成一行「小方块」:数字在上、标签在下,高度从约 140px
   降到约 40。只改几何,不碰皮肤 —— 底色、描边、圆角沿用 style.css 的
   `.stat-pill-item`,玻璃档的磨砂与切面高光也由皮肤规则原样接住,
   所以这里不需要跟 `html[data-skin='glass'] .stat-pill-item` 抢特异度。
   四列等分(minmax(0,1fr))而不是按内容挤:窄到 320 也整行放得下,
   标签超宽时以省略号收尾,不会把方块撑破或折行。 */
@media (max-width: 600px) {
  .stat-pills {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
    margin-bottom: 10px;
  }

  .stat-pill-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
    min-width: 0;
    padding: 5px 8px;
    border-radius: 8px;
    line-height: 1.25;
  }

  .stat-pill-item b {
    font-size: 13px;
    line-height: 1.2;
  }

  .stat-pill-item span {
    max-width: 100%;
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>