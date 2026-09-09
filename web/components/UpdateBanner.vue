<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton } from 'naive-ui';

const props = defineProps<{
  /** npm 定时检查到的可用更新;null/undefined = 无。 */
  update: { latest: string; current: string } | null | undefined;
  busy: boolean;
}>();
/** 「立即升级」交给父级走二次确认 → npm 自升级流程。 */
const emit = defineEmits<{ upgrade: [update: { latest: string; current: string }] }>();

/** 本会话已点「忽略」的版本号,避免横幅反复出现。 */
const dismissed = ref('');

const visible = computed(() => {
  const u = props.update;
  if (!u || u.latest === dismissed.value) return null;
  return u;
});
</script>

<template>
  <div v-if="visible" class="update-banner" role="status">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3v10" />
      <path d="m8 9 4 4 4-4" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
    <span class="update-banner__text">
      发现新版本 <b class="mono">{{ visible.latest }}</b>(当前 {{ visible.current }})
    </span>
    <n-button size="tiny" type="primary" :disabled="busy" @click="emit('upgrade', visible)">立即升级</n-button>
    <n-button size="tiny" quaternary @click="dismissed = visible.latest">忽略</n-button>
  </div>
</template>
