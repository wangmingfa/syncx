<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';
import { apiJson, errText } from '../utils/api';
import ModalShell from './ModalShell.vue';

/**
 * 节假日日历预览弹窗:月历视图,标注全年哪些日期休息。
 *
 * 数据源是既有接口 GET /api/calendar?year=YYYY(自动拉取的节假日数据 + 手动覆盖),
 * 前端只做渲染,判定口径与后端 HolidayStore 一致:**手动覆盖 > 拉取数据 > 按星期几退化**
 * (无数据的周一~周五算工作日,周六周日算休息日)。
 *
 * 徽标语义(对齐中文日历应用的习惯):
 *  - 「休」:被数据或手动覆盖明确标为休息日(法定假、调休连休、手动改的假)
 *  - 「班」:周末却被明确标为工作日 —— 即调休补班,这是法定数据里最值得看的信息
 *  - 圆点:手动改过的日期(覆盖优先于拉取数据,预览里要能看出来源)
 *  - 其余日期无徽标:按星期几判,周末淡红底示意休息
 *
 * 只读预览:标注日历身份的编辑走设置弹窗里的「手动设置哪天是假期 / 补班」面板,
 * 这里不重复一套编辑入口。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { showToast } = useStatusContext();

/** 后端 GET /api/calendar 的返回结构(见 api/deps.ts 的 getCalendar)。 */
interface CalData {
  year: number;
  days: Record<string, 'workday' | 'holiday'>;
  overrides: Record<string, 'workday' | 'holiday'>;
  fetched: boolean;
}

const now = new Date();
const year = ref(now.getFullYear());
const month = ref(now.getMonth());
const cal = ref<CalData | undefined>();
const loading = ref(false);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    // 打开即回到「今年今月」:预览是低频动作,每次都从当前位置起步比记住上次更符合直觉
    year.value = now.getFullYear();
    month.value = now.getMonth();
    void load();
  },
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    cal.value = await apiJson<CalData>(`/api/calendar?year=${year.value}`);
  } catch (e) {
    showToast(errText(e, '读取日历失败'), 'alert');
  } finally {
    loading.value = false;
  }
}

function dateKey(day: number): string {
  const m = String(month.value + 1).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year.value}-${m}-${d}`;
}

/** 单日标注:覆盖 > 拉取数据 > 按星期几退化(口径同后端 HolidayStore.dayType/isWorkday)。 */
function markOf(key: string, weekday: number): { type: 'holiday' | 'workday'; explicit: boolean; source: 'override' | 'data' | 'fallback' } {
  const ov = cal.value?.overrides[key];
  if (ov) return { type: ov, explicit: true, source: 'override' };
  const d = cal.value?.days[key];
  if (d) return { type: d, explicit: true, source: 'data' };
  const weekend = weekday === 0 || weekday === 6;
  return { type: weekend ? 'holiday' : 'workday', explicit: false, source: 'fallback' };
}

interface DayCell {
  day: number;
  weekday: number;
  type: 'holiday' | 'workday';
  explicit: boolean;
  source: 'override' | 'data' | 'fallback';
  badge?: '休' | '班';
  isToday: boolean;
}

/** 周一打头的月历格子;前导空格补齐 1 号前的位置(中文日历的通用排法)。 */
const cells = computed<(DayCell | undefined)[]>(() => {
  const lead = (new Date(year.value, month.value, 1).getDay() + 6) % 7;
  const total = new Date(year.value, month.value + 1, 0).getDate();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const out: (DayCell | undefined)[] = Array(lead).fill(undefined);
  for (let d = 1; d <= total; d++) {
    const weekday = new Date(year.value, month.value, d).getDay();
    const key = dateKey(d);
    const m = markOf(key, weekday);
    // 「班」只在周末被明确标为工作日时出示(调休补班);工作日本来就是班,不重复标注
    const badge = m.explicit ? (m.type === 'holiday' ? '休' : weekday === 0 || weekday === 6 ? '班' : undefined) : undefined;
    out.push({ day: d, weekday, type: m.type, explicit: m.explicit, source: m.source, badge, isToday: key === todayKey });
  }
  return out;
});

const monthLabel = computed(() => `${year.value} 年 ${month.value + 1} 月`);

/** 翻月跨年:一月往前从 12 月接到上一年,十二月往后从 1 月接到下一年,并重拉当年数据。 */
function shiftMonth(d: number): void {
  const m = month.value + d;
  if (m < 0) {
    month.value = 11;
    year.value -= 1;
    void load();
  } else if (m > 11) {
    month.value = 0;
    year.value += 1;
    void load();
  } else {
    month.value = m;
  }
}

/** 翻年与接口同界(1970~2100,见 GET /api/calendar 的入参校验)。 */
function shiftYear(d: number): void {
  const y = year.value + d;
  if (y < 1970 || y > 2100) return;
  year.value = y;
  void load();
}
</script>

<template>
  <ModalShell :open="open" title="节假日日历预览" description="休息日按数据与手动覆盖标注" class="cal-modal" @close="emit('close')">
    <div class="cal-head">
      <button type="button" class="settings-link" :disabled="year <= 1970" @click="shiftYear(-1)">‹</button>
      <span class="cal-head__year">{{ year }} 年</span>
      <button type="button" class="settings-link" :disabled="year >= 2100" @click="shiftYear(1)">›</button>
      <span class="cal-head__state">
        {{ loading ? '加载中…' : cal?.fetched ? '数据已缓存' : '今年数据未拉取,所有日期按星期几判' }}
      </span>
    </div>

    <div class="cal-nav">
      <button type="button" class="settings-link" @click="shiftMonth(-1)">‹ 上月</button>
      <span class="cal-nav__month">{{ monthLabel }}</span>
      <button type="button" class="settings-link" @click="shiftMonth(1)">下月 ›</button>
    </div>

    <div class="cal-grid">
      <span v-for="w in ['一', '二', '三', '四', '五', '六', '日']" :key="w" class="cal-grid__head">{{ w }}</span>
      <template v-for="(c, i) in cells" :key="i">
        <span v-if="!c" class="cal-cell cal-cell--blank" />
        <span
          v-else
          class="cal-cell"
          :class="{
            'is-rest': c.type === 'holiday',
            'is-override': c.source === 'override',
            'is-today': c.isToday,
          }"
        >
          <span class="cal-cell__num">{{ c.day }}</span>
          <span v-if="c.badge" class="cal-badge" :class="c.badge === '休' ? 'cal-badge--rest' : 'cal-badge--work'">{{ c.badge }}</span>
        </span>
      </template>
    </div>

    <p class="cal-legend">
      「休」= 休息日(按节假日数据或手动覆盖标注);「班」= 周末调休补班。<br />
      带圆点的日期被手动改过(覆盖优先于拉取数据);无徽标的日期按星期几判(周末休息)。
    </p>

    <template #footer>
      <NButton @click="emit('close')">关闭</NButton>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 日历预览:仅本组件使用的类,故 scoped(口径同 AGENTS.md「组件自有的样式写在自己文件里」)。
   .settings-link(行内链接按钮)是跨弹窗共用皮肤,仍在 style.css。
   休息日红调沿用项目既有危险色(#c0392b / 深色 #f0796f,同 .conflict-float 的口径)。 */
.cal-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cal-head__year {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.cal-head__state {
  margin-left: auto;
  font-size: 12px;
  color: var(--muted);
}
.cal-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 16px;
}
.cal-nav__month {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
  margin-top: 10px;
}
.cal-grid__head {
  text-align: center;
  font-size: 12px;
  color: var(--muted);
  padding: 4px 0;
}
.cal-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 0 7px;
  min-height: 46px;
}
.cal-cell--blank {
  border: none;
}
.cal-cell__num {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.cal-cell.is-rest .cal-cell__num {
  color: #c0392b;
}
html[data-theme='dark'] .cal-cell.is-rest .cal-cell__num {
  color: #f0796f;
}
.cal-cell.is-rest {
  background: rgb(192 57 43 / 0.05);
}
html[data-theme='dark'] .cal-cell.is-rest {
  background: rgb(240 121 111 / 0.08);
}
/* 今天描边:在「今天到底落在哪个格子」上一眼可辨,别的日子不加 */
.cal-cell.is-today {
  border-color: var(--accent);
}
/* 手动改过的日期:右上角圆点(accent-2 青绿,区别于休息日的红) */
.cal-cell.is-override::after {
  content: '';
  position: absolute;
  top: 5px;
  right: 5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent-2);
}
.cal-badge {
  font-size: 10px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 4px;
  margin-top: 3px;
}
.cal-badge--rest {
  color: #c0392b;
  background: rgb(192 57 43 / 0.1);
}
html[data-theme='dark'] .cal-badge--rest {
  color: #f0796f;
  background: rgb(240 121 111 / 0.12);
}
.cal-badge--work {
  color: var(--accent);
  background: var(--accent-soft);
}
.cal-legend {
  margin-top: 14px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--muted);
}
</style>
