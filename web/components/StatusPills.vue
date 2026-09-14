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
