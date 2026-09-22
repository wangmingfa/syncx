<script setup lang="ts">
import { computed } from 'vue';
import { NButton } from 'naive-ui';
import { formatBytes } from '../utils/bytes';
import { useStatusContext } from '../composables/statusContext';
import ModalShell from './ModalShell.vue';

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const { status } = useStatusContext();

const traffic = computed(() => status.value.traffic);

/** 采样窗口宽与环长必须与 daemon 侧 traffic.ts 的常量一致(5min × 288 = 24h)。 */
const WINDOW_MIN = 5;

const sum24h = computed(() => {
  const samples = traffic.value?.samples ?? [];
  return samples.reduce(
    (acc, s) => ({ sent: acc.sent + s.sent, received: acc.received + s.received }),
    { sent: 0, received: 0 },
  );
});

/** 曲线峰值(两种方向同尺度,柱高才可比)。 */
const peak = computed(() => {
  const samples = traffic.value?.samples ?? [];
  let m = 0;
  for (const s of samples) m = Math.max(m, s.sent, s.received);
  return m;
});

const CHART_W = 576;
const HALF_H = 64;

/** 每格样本 → 柱形;时间轴从左(旧)到右(新)。 */
interface Bar { x: number; upH: number; downH: number; at: number; sent: number; received: number }
const bars = computed<Bar[]>(() => {
  const samples = traffic.value?.samples ?? [];
  if (samples.length === 0 || peak.value <= 0) return [];
  const slot = CHART_W / 288; // 环长固定,新样本挤旧样本,格宽不变
  return samples.map((s, i) => ({
    x: i * slot,
    upH: (s.sent / peak.value) * HALF_H,
    downH: (s.received / peak.value) * HALF_H,
    at: s.at,
    sent: s.sent,
    received: s.received,
  }));
});

function fmtWindow(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function rateOf(bytes: number): string {
  return `${formatBytes(bytes / (WINDOW_MIN * 60))}/s`;
}
</script>

<template>
  <ModalShell :open="open" title="传输统计" description="daemon 本次在线期间(重启清零)" wide @close="emit('close')">
    <div v-if="!traffic || (traffic.sent === 0 && traffic.received === 0 && traffic.samples.length === 0)" class="empty">
      还没有传输记录
    </div>
    <template v-else>
      <div class="traffic-summary">
        <div class="traffic-total">
          <span class="traffic-dir up">↑ 发出</span>
          <b>{{ formatBytes(traffic.sent) }}</b>
          <span class="muted">近 24h {{ formatBytes(sum24h.sent) }}</span>
        </div>
        <div class="traffic-total">
          <span class="traffic-dir down">↓ 接收</span>
          <b>{{ formatBytes(traffic.received) }}</b>
          <span class="muted">近 24h {{ formatBytes(sum24h.received) }}</span>
        </div>
      </div>

      <div v-if="bars.length > 0" class="traffic-chart-wrap">
        <svg class="traffic-chart" :viewBox="`0 0 ${CHART_W} ${HALF_H * 2 + 8}`" preserveAspectRatio="none" role="img" aria-label="最近 24 小时逐 5 分钟的传输流量">
          <line :x1="0" :y1="HALF_H + 4" :x2="CHART_W" :y2="HALF_H + 4" stroke="var(--border-strong)" stroke-width="1" />
          <g v-for="(b, i) in bars" :key="i">
            <rect :x="b.x" :y="HALF_H + 4 - b.upH" :width="(CHART_W / 288) * 0.8" :height="b.upH" fill="var(--accent)">
              <title>{{ fmtWindow(b.at) }} · 发出 {{ formatBytes(b.sent) }}(均值 {{ rateOf(b.sent) }})</title>
            </rect>
            <rect :x="b.x" :y="HALF_H + 4" :width="(CHART_W / 288) * 0.8" :height="b.downH" fill="var(--accent-2)">
              <title>{{ fmtWindow(b.at) }} · 接收 {{ formatBytes(b.received) }}(均值 {{ rateOf(b.received) }})</title>
            </rect>
          </g>
        </svg>
        <div class="traffic-axis muted">
          <span>← 较早</span>
          <span>每格 {{ WINDOW_MIN }} 分钟 · 峰值 {{ rateOf(peak) }}</span>
          <span>较近 →</span>
        </div>
      </div>
      <div v-else class="empty">已传输但采样窗口尚未闭合,稍后刷新可见曲线</div>
    </template>

    <template #footer>
      <n-button type="primary" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>
</template>
