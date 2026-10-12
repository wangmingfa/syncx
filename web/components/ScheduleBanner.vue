<script setup lang="ts">
/**
 * 顶部横幅:此刻因「同步时段」而不进行同步时出现,一句话回答三件事 ——
 * 为什么不同步、什么时候自动恢复、能不能马上破例。
 *
 * 刻意只在「没有任何目录在同步且原因确实是时段」时出现(判据在后端
 * scheduleBannerState):多目录机器上「部分目录在时段外」是常态,常驻横幅就成了噪音。
 * 临时放行生效期间横幅也要留着(带倒计时与一键取消),否则用户会以为放行没生效。
 *
 * 时长选择收在展开面板里(低频操作不占常驻空间)。
 */
import { computed, ref } from 'vue';
import { NButton, NInputNumber } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';

const { status, busy, setScheduleOverride } = useStatusContext();
const panelOpen = ref(false);
const minutes = ref(60);

const QUICK = [15, 30, 60, 240];

const banner = computed(() => status.value.scheduleBanner);
/** 放行中:横幅必须留着让用户看见倒计时,并能一键取消。 */
const overriding = computed(() => (banner.value?.overrideUntil ?? 0) > Date.now());
const shown = computed(() => {
  const b = banner.value;
  return !!b && (b.visible || overriding.value);
});

/** 恢复时刻文案:今天内的边界给 HH:MM,跨天的带日期。 */
const resumeText = computed(() => {
  const at = banner.value?.nextChangeAt;
  if (!at) return '到点自动恢复';
  const d = new Date(at);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `${time} 自动恢复` : `${d.getMonth() + 1}月${d.getDate()}日 ${time} 自动恢复`;
});

/** 放行剩余时间(mm:ss / h:mm:ss)。 */
const remainText = computed(() => {
  const until = banner.value?.overrideUntil ?? 0;
  const left = Math.max(0, Math.floor((until - Date.now()) / 1000));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
});

async function applyOverride(value: number): Promise<void> {
  await setScheduleOverride(value);
  panelOpen.value = false;
}
</script>

<template>
  <div v-if="shown" class="sched-banner" :class="{ 'sched-banner--live': overriding }">
    <div class="sched-banner__row">
      <span class="sched-banner__text">
        <template v-if="overriding">
          临时放行中,剩余 {{ remainText }} —— 到时按同步时段自动暂停
        </template>
        <template v-else>
          当前不在同步时段内,{{ banner!.blockedBySchedule }} / {{ banner!.total }} 个目录暂停同步 · {{ resumeText }}
        </template>
      </span>

      <span class="sched-banner__actions">
        <n-button v-if="overriding" size="tiny" quaternary :disabled="busy" @click="applyOverride(0)">取消放行</n-button>
        <n-button v-else size="tiny" :disabled="busy" @click="panelOpen = !panelOpen">
          {{ panelOpen ? '收起' : '临时开启同步' }}
        </n-button>
      </span>
    </div>

    <!-- 时长收在展开面板:低频,不该常驻占位 -->
    <div v-if="panelOpen && !overriding" class="sched-banner__panel">
      <span class="sched-banner__hint">放行时长</span>
      <n-button v-for="q in QUICK" :key="q" size="tiny" :disabled="busy" @click="applyOverride(q)">
        {{ q < 60 ? `${q} 分钟` : `${q / 60} 小时` }}
      </n-button>
      <n-input-number v-model:value="minutes" size="tiny" class="sched-banner__minutes" :min="1" :max="1440" :show-button="false" :disabled="busy" />
      <span class="sched-banner__hint">分钟</span>
      <n-button size="tiny" type="primary" :disabled="busy || !minutes" @click="applyOverride(minutes ?? 60)">开始</n-button>
      <p class="sched-banner__note">
        只解除时段限制,不会解除你手动暂停的目录,也不会绕过计费网络 / 低电量的自动挂起。
      </p>
    </div>
  </div>
</template>

<style scoped>
/* 仅本组件使用的类,故 scoped(口径同 AGENTS.md)。 */
.sched-banner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface, rgba(127, 127, 127, 0.08));
  font-size: 13px;
}
.sched-banner--live {
  border-color: var(--selected-bg);
}
.sched-banner__row {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
  flex-wrap: wrap;
}
.sched-banner__text {
  min-width: 0;
}
.sched-banner__actions {
  flex: none;
}
.sched-banner__panel {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.sched-banner__hint {
  opacity: 0.7;
  font-size: 12px;
}
.sched-banner__minutes {
  width: 62px;
}
.sched-banner__note {
  flex-basis: 100%;
  margin: 2px 0 0;
  font-size: 12px;
  opacity: 0.65;
}
</style>
