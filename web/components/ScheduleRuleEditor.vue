<script setup lang="ts">
/**
 * 同步时段规则编辑器(目录设置与全局设置共用一份)。
 *
 * 数据模型见 src/schedule.ts:规则间「满足任一即可」;每条规则 = 日期条件 且 若干时间
 * 窗口(窗口之间也是「或」)。UI 刻意止步于 DNF —— 任意 AND/OR/NOT 嵌套需要条件树编辑器,
 * 而日常场景(仅工作日 9-23、周末 10-20…)用「规则列表」就能表达。
 *
 * 保存语义:两端都填的窗口才有效;某条规则的窗口全空 → 该规则整体丢弃;规则全空 →
 * 整个时段清除(全天同步)。所以「填一半」不会把目录锁死,只是那一半不生效。
 */
import { computed, ref, watch } from 'vue';
import { NButton, NSelect, NTimePicker } from 'naive-ui';
import type { DayPredicate, Schedule, ScheduleRule } from '../types';

const props = defineProps<{
  /** 当前规则列表;undefined/空 = 全天同步。 */
  modelValue: Schedule | undefined;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: Schedule | undefined];
}>();

/** 编辑期的规则形态:时间用毫秒时间戳(naive 的 n-time-picker 口径),保存时折算成分钟。 */
interface EditWindow {
  from: number | null;
  to: number | null;
  /** 打开时两端都空的新窗口;不参与校验提示,只是待填。 */
  fresh?: boolean;
}
interface EditRule {
  daysKind: DayPredicate['kind'];
  days: number[];
  windows: EditWindow[];
}

const DAY_KIND_OPTIONS = [
  { label: '不限日期', value: 'any' },
  { label: '仅工作日', value: 'workday' },
  { label: '仅休息日', value: 'offday' },
  { label: '自选星期', value: 'dow' },
] as const;

/** 自选星期的可点选项(0 = 周日,与 JS getDay 口径一致)。 */
const WEEK_DAYS = [
  { label: '一', value: 1 },
  { label: '二', value: 2 },
  { label: '三', value: 3 },
  { label: '四', value: 4 },
  { label: '五', value: 5 },
  { label: '六', value: 6 },
  { label: '日', value: 0 },
] as const;

const rules = ref<EditRule[]>([]);

function toMs(minutes: number): number {
  return new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).getTime();
}
function toMinutes(ts: number | null): number | null {
  if (ts === null) return null;
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

function fromSchedule(schedule: Schedule | undefined): EditRule[] {
  return (schedule ?? []).map((r) => ({
    daysKind: r.days.kind,
    days: r.days.kind === 'dow' ? [...r.days.days] : [],
    windows: r.windows.map((w) => ({ from: toMs(w.from), to: toMs(w.to) })),
  }));
}

watch(
  () => props.modelValue,
  (v) => {
    rules.value = fromSchedule(v);
  },
  { immediate: true },
);

/** 折算回 modelValue;空规则/空窗口整体丢弃(见文件头的保存语义)。 */
function emitChange(): void {
  const out: Schedule = [];
  for (const r of rules.value) {
    const windows = r.windows
      .map((w) => ({ from: toMinutes(w.from), to: toMinutes(w.to) }))
      .filter((w): w is { from: number; to: number } => w.from !== null && w.to !== null);
    if (windows.length === 0) continue;
    const days: DayPredicate =
      r.daysKind === 'dow' ? { kind: 'dow', days: [...r.days] } : { kind: r.daysKind };
    out.push({ days, windows });
  }
  emit('update:modelValue', out.length > 0 ? out : undefined);
}

function addRule(): void {
  rules.value.push({ daysKind: 'any', days: [], windows: [{ from: null, to: null, fresh: true }] });
  emitChange();
}

function removeRule(index: number): void {
  rules.value.splice(index, 1);
  emitChange();
}

function addWindow(rule: EditRule): void {
  rule.windows.push({ from: null, to: null, fresh: true });
}

function removeWindow(rule: EditRule, index: number): void {
  rule.windows.splice(index, 1);
  emitChange();
}

function onDaysKindChange(rule: EditRule, value: DayPredicate['kind']): void {
  rule.daysKind = value;
  if (value === 'dow' && rule.days.length === 0) rule.days = [1, 2, 3, 4, 5];
  emitChange();
}

function toggleDay(rule: EditRule, day: number): void {
  const i = rule.days.indexOf(day);
  if (i === -1) rule.days.push(day);
  else rule.days.splice(i, 1);
  emitChange();
}

/** 只填一端的窗口:提示但不静默丢弃(用户看得见自己漏填了)。 */
const incompleteCount = computed(
  () => rules.value.reduce((n, r) => n + r.windows.filter((w) => (w.from === null) !== (w.to === null)).length, 0),
);

/** 摘要文案:与后端 formatScheduleSummary 同口径,供调用方在外层展示。 */
const summary = computed(() => {
  if (rules.value.length === 0) return '全天同步';
  const clock = (ts: number | null): string => {
    const m = toMinutes(ts);
    return m === null ? '--:--' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };
  const dayText = (r: EditRule): string => {
    switch (r.daysKind) {
      case 'any':
        return '每天';
      case 'workday':
        return '工作日';
      case 'offday':
        return '休息日';
      case 'dow':
        return r.days.length > 0 ? `周${r.days.map((d) => WEEK_DAYS.find((w) => w.value === d)?.label ?? '?').join('')}` : '每天';
    }
  };
  return rules.value
    .map((r) => {
      const ws = r.windows
        .filter((w) => (w.from === null) !== (w.to === null) || w.from !== null)
        .map((w) => `${clock(w.from)}–${clock(w.to)}`);
      return ws.length > 0 ? `${dayText(r)} ${ws.join('、')}` : dayText(r);
    })
    .join('；');
});

defineExpose({ summary });
</script>

<template>
  <div class="schedule-editor">
    <div v-for="(rule, ri) in rules" :key="ri" class="schedule-rule">
      <div class="schedule-rule__head">
        <n-select
          class="schedule-days"
          size="small"
          :value="rule.daysKind"
          :options="DAY_KIND_OPTIONS as unknown as { label: string; value: string }[]"
          @update:value="(v: DayPredicate['kind']) => onDaysKindChange(rule, v)"
        />
        <div v-if="rule.daysKind === 'dow'" class="schedule-weekdays">
          <button
            v-for="d in WEEK_DAYS"
            :key="d.value"
            type="button"
            class="schedule-weekday"
            :class="{ 'schedule-weekday--on': rule.days.includes(d.value) }"
            @click="toggleDay(rule, d.value)"
          >
            {{ d.label }}
          </button>
        </div>
        <n-button v-if="rules.length > 1" size="tiny" quaternary @click="removeRule(ri)">删除规则</n-button>
      </div>

      <div v-for="(w, wi) in rule.windows" :key="wi" class="schedule-window">
        <n-time-picker
          v-model:value="w.from"
          class="schedule-picker"
          size="small"
          format="HH:mm"
          :minutes="1"
          :clearable="true"
          @update:value="emitChange"
        />
        <span class="schedule-sep">至</span>
        <n-time-picker
          v-model:value="w.to"
          class="schedule-picker"
          size="small"
          format="HH:mm"
          :minutes="1"
          :clearable="true"
          @update:value="emitChange"
        />
        <!-- 跨午夜提示:结束早于开始是合法形态(22:00–08:00),不是错误 -->
        <span v-if="w.from !== null && w.to !== null && new Date(w.to).getHours() * 60 + new Date(w.to).getMinutes() <= new Date(w.from).getHours() * 60 + new Date(w.from).getMinutes()" class="schedule-cross">跨天</span>
        <n-button v-if="rule.windows.length > 1" size="tiny" quaternary @click="removeWindow(rule, wi)">移除</n-button>
      </div>
      <n-button size="tiny" quaternary @click="addWindow(rule)">+ 该规则再加一个时段</n-button>
    </div>

    <div class="schedule-actions">
      <n-button size="small" @click="addRule">+ 添加规则</n-button>
      <span class="schedule-note">规则之间「满足任一即可」；同一条规则内「日期与时段同时满足」才生效</span>
    </div>
    <p v-if="incompleteCount > 0" class="schedule-incomplete">有 {{ incompleteCount }} 个时段只填了一端，保存后会忽略；请补全或清空。</p>
  </div>
</template>

<style scoped>
.schedule-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.schedule-rule {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.schedule-rule__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.schedule-days {
  width: 132px;
  flex: none;
}
.schedule-weekdays {
  display: flex;
  gap: 4px;
}
.schedule-weekday {
  width: 22px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}
.schedule-weekday--on {
  background: var(--selected-bg);
  color: var(--selected-text);
  border-color: transparent;
}
.schedule-window {
  display: flex;
  align-items: center;
  gap: 6px;
}
.schedule-picker {
  width: 96px;
}
.schedule-sep {
  opacity: 0.6;
  font-size: 12px;
}
.schedule-cross {
  font-size: 11px;
  opacity: 0.65;
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 0 4px;
}
.schedule-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.schedule-note {
  font-size: 12px;
  opacity: 0.6;
}
.schedule-incomplete {
  margin: 0;
  font-size: 12px;
  color: var(--warn, #c90);
}
</style>
