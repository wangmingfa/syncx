<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NEmpty, NSpin } from 'naive-ui';
import { apiJson, errText } from '../utils/api';
import type { WeeklyReportData } from '../types';
import ModalShell from './ModalShell.vue';

/**
 * 同步周报弹窗:近 7 天的变更趋势 / 目录贡献 / 对端活跃度 / 冲突明细。
 * 数据全部来自已持久化的同步记录(历史 JSONL),纯读;打开时取一次,
 * 给一个手动刷新按钮(周报不是要盯的实时视图,不做轮询)。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const report = ref<WeeklyReportData | null>(null);
const loading = ref(false);
const errorText = ref('');

async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  errorText.value = '';
  try {
    report.value = await apiJson<WeeklyReportData>('/api/report/weekly');
  } catch (e) {
    errorText.value = errText(e, '周报读取失败');
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void load();
  },
);

/** 柱图刻度:各天总量最大值(至少 1,除零兜底)。 */
const maxDayTotal = computed(() => {
  const r = report.value;
  if (!r) return 1;
  return Math.max(1, ...r.days.map((d) => d.add + d.update + d.delete + d.conflict));
});

function dayTotal(d: WeeklyReportData['days'][number]): number {
  return d.add + d.update + d.delete + d.conflict;
}

/** 日期键 MM-DD(年份在这里没有信息量)。 */
function shortDay(day: string): string {
  return day.slice(5);
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** 段高度(px):按占最大日总量的比例,0 值不渲染。 */
function segH(n: number): string {
  return n === 0 ? '0px' : `${Math.max(2, Math.round((n / maxDayTotal.value) * 96))}px`;
}
</script>

<template>
  <ModalShell :open="open" title="同步周报" description="近 7 天:变更趋势 / 目录贡献 / 对端活跃度(数据来自同步记录)" wide @close="emit('close')">
    <n-spin :show="loading && !report">
      <p v-if="errorText" class="confirm-note-extra">{{ errorText }}</p>
      <template v-if="report">
        <!-- 总量 chips -->
        <div class="report-chips">
          <span class="report-chip">新增 {{ report.totals.add }}</span>
          <span class="report-chip">更新 {{ report.totals.update }}</span>
          <span class="report-chip">删除 {{ report.totals.delete }}</span>
          <span class="report-chip report-chip-warn">冲突 {{ report.totals.conflict }}</span>
          <span class="report-chip report-chip-mute">共 {{ report.totals.total }} 次变更</span>
        </div>
        <p v-if="report.truncated" class="confirm-note-extra">
          提示:部分目录的记录条数可能已达到保留上限,更早的记录被裁掉,趋势仅供参考。
        </p>

        <!-- 逐日柱图:四种动作堆叠 -->
        <div class="edit-section-label">每日变更</div>
        <div class="report-chart">
          <div v-for="d in report.days" :key="d.day" class="report-col" :title="`${d.day}:新增 ${d.add} / 更新 ${d.update} / 删除 ${d.delete} / 冲突 ${d.conflict}`">
            <div class="report-stack">
              <div class="report-seg report-conflict" :style="{ height: segH(d.conflict) }" />
              <div class="report-seg report-delete" :style="{ height: segH(d.delete) }" />
              <div class="report-seg report-update" :style="{ height: segH(d.update) }" />
              <div class="report-seg report-add" :style="{ height: segH(d.add) }" />
            </div>
            <div class="report-day-label">{{ shortDay(d.day) }}</div>
          </div>
        </div>

        <!-- 目录贡献 -->
        <div class="edit-section-label">目录贡献</div>
        <n-empty v-if="report.folders.length === 0" description="还没有共享目录" size="small" />
        <table v-else class="report-table">
          <tbody>
            <tr v-for="f in report.folders" :key="f.id">
              <td class="report-path" :title="f.path">{{ f.path }}</td>
              <td>{{ f.total }}</td>
              <td class="report-detail">新增 {{ f.add }} · 更新 {{ f.update }} · 删除 {{ f.delete }}<template v-if="f.conflict"> · <span class="report-warn-text">冲突 {{ f.conflict }}</span></template></td>
            </tr>
          </tbody>
        </table>

        <!-- 对端活跃度 -->
        <template v-if="report.activeDevices.length">
          <div class="edit-section-label">对端活跃度(远端推入次数)</div>
          <div class="report-chips">
            <span v-for="d in report.activeDevices.slice(0, 6)" :key="d.deviceId" class="report-chip" :title="d.deviceId">
              {{ d.deviceId.slice(0, 8) }} × {{ d.count }}
            </span>
          </div>
        </template>

        <!-- 冲突明细 -->
        <div class="edit-section-label">冲突明细</div>
        <n-empty v-if="report.conflicts.length === 0" description="本周没有冲突,很好" size="small" />
        <ul v-else class="report-conflicts">
          <li v-for="(c, i) in report.conflicts" :key="i">
            <span class="report-warn-text">{{ c.path }}</span>
            <span class="report-mute">{{ fmtTime(c.ts) }}{{ c.deviceId ? ` · 对端 ${c.deviceId.slice(0, 8)}` : '' }}</span>
          </li>
        </ul>
      </template>
    </n-spin>

    <template #footer>
      <n-button class="modal-cancel" :disabled="loading" @click="load">刷新</n-button>
      <n-button type="primary" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>
</template>

<style scoped>
.report-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 4px 0 8px;
}
.report-chip {
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(128, 128, 128, 0.12);
  font-size: 12px;
  white-space: nowrap;
}
.report-chip-warn {
  background: rgba(240, 138, 41, 0.16);
  color: #e08a3c;
}
.report-chip-mute {
  opacity: 0.75;
}
.report-chart {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  height: 130px;
  padding: 6px 2px 0;
}
.report-col {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}
.report-stack {
  display: flex;
  flex-direction: column-reverse;
  width: 100%;
  max-width: 36px;
}
.report-seg {
  width: 100%;
  border-radius: 2px;
}
.report-add {
  background: #34a853;
}
.report-update {
  background: #4a90d9;
}
.report-delete {
  background: #9e9e9e;
}
.report-conflict {
  background: #f0894a;
}
.report-day-label {
  font-size: 11px;
  opacity: 0.7;
}
.report-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.report-table td {
  padding: 5px 6px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.15);
  vertical-align: top;
}
.report-path {
  width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, ui-monospace, monospace);
}
.report-detail {
  white-space: nowrap;
  opacity: 0.85;
}
.report-warn-text {
  color: #e08a3c;
}
.report-conflicts {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
}
.report-conflicts li {
  margin: 3px 0;
}
.report-mute {
  margin-left: 8px;
  opacity: 0.65;
}
</style>
