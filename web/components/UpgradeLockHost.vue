<script setup lang="ts">
import { computed, ref } from 'vue';
import UpgradeRequiredModal from './UpgradeRequiredModal.vue';
import { useStatusFeed } from '../composables/useStatusFeed';
import { useUpgrade } from '../composables/useUpgrade';
import type { StatusData } from '../types';

/**
 * 版本一致锁的宿主 —— 挂在 `App.vue` 最外层,所以**每一条路由**都盖得到:
 * 状态页、对比页、终端页、文件页、回收站、多实例。
 *
 * 为什么不各页自己挂:锁的语义是「这台机器的版本不对,别用」,与你在看哪个页面无关。
 * 逐页挂载的结局是总有一天某一页忘了挂,而「为什么 /terminal 能照常操作」这种问题
 * 没人会当成 bug 去查(见 ADR-0018)。
 *
 * 它自带一条 `/api/status` 订阅(useStatusFeed),不依赖任何页面把 status 传进来 ——
 * 终端页 / 文件页各自拉自己的数据,压根没有共享的 status 实例可接。多这一条连接的代价
 * 近乎为零:推送是差异驱动的,状态没变就一帧都不发(ADR-0011)。
 *
 * 判定依旧只认 daemon 算好的 `canUpgrade`:这里不出现版本比较,也不因为「看起来更短」
 * 而自行判断 dev 运行态。
 */
const status = ref<StatusData | null>(null);
const { refresh } = useStatusFeed((next) => {
  status.value = next;
});
const { upgradeFromDevice } = useUpgrade(refresh);

/** 列表交给弹窗自己筛(在线 && canUpgrade):筛法只该有一份,宿主只负责供给。 */
const devices = computed(() => status.value?.devices ?? []);
</script>

<template>
  <UpgradeRequiredModal
    :devices="devices"
    :local-version="status?.version"
    :on-upgrade="upgradeFromDevice"
  />
</template>
