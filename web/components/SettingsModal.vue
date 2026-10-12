<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NCheckbox, NDatePicker, NInput, NInputNumber, NSelect } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';
import { apiPost, errText } from '../utils/api';
import CalendarModal from './CalendarModal.vue';
import ModalShell from './ModalShell.vue';
import ScheduleRuleEditor from './ScheduleRuleEditor.vue';
import type { Schedule } from '../types';

/**
 * 全局设置弹窗:发送带宽上限(全局兜底)、每路径版本份数、历史记录保留上限、
 * 同步事件 Webhook(完成/冲突/错误外推通知,飞书机器人地址自动适配格式)、
 * 全局同步时段(硬闸门)、节假日日历(「工作日」判定的数据源)、
 * 电源守卫(计费网络/低电量自动挂起,仅 Windows 探测启用)。
 * 数值项都是「留空 = 回默认」的语义(后端 null 清除配置,走内置默认值);
 * 保存走 POST /api/settings,后端落盘并按需热生效(重建限速通道 / 执行器)。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { status, busy, refreshStatus, showToast } = useStatusContext();

// 三项都以 null 表示「未设置/回默认」;NInputNumber 清空输入后 value 即为 null
const maxSendKbps = ref<number | null>(null);
const versionsPerPath = ref<number | null>(null);
const historyMaxEvents = ref<number | null>(null);

// Webhook:地址 '' = 关闭;密钥留空 = 保持已存值不变(清空需点「清除密钥」)
const webhookUrl = ref('');
const webhookSecret = ref('');
const secretCleared = ref(false);
const secretAlreadySet = ref(false);
const testingWebhook = ref(false);

// 电源守卫(Windows):两个开关 + 低电量阈值;非 Windows 后端不探测,开关无实际作用
const pauseOnMeteredNetwork = ref(false);
const pauseOnLowBattery = ref(false);
const batteryPauseThreshold = ref<number | null>(null);

// 分享链接总开关(默认关):开=允许在文件管理器为单文件生成免登录限时下载链接
const shareEnabled = ref(false);

// 全局同步时段(硬闸门):undefined = 全天
const syncSchedule = ref<Schedule | undefined>(undefined);

// 节假日日历:自动拉取开关 + 源地址;手动覆盖走独立入口即时保存(不进「保存」按钮)
const holidayAutoFetch = ref(true);
const holidaySourceUrl = ref('');
const holidaySourceDefault = ref('');
/** 手动覆盖面板是低频操作,默认收起,不占常驻空间 */
const overridesOpen = ref(false);
const overrideDate = ref<number | null>(null);
const overrideType = ref<'workday' | 'holiday'>('holiday');
/** 全年日历预览弹窗:只读标注,编辑仍走下面的手动覆盖面板 */
const calViewOpen = ref(false);
const CAL_TYPE_OPTIONS = [
  { label: '休息日(不上班)', value: 'holiday' },
  { label: '工作日(要上班)', value: 'workday' },
] as const;

const DEFAULT_VERSIONS = 10;
const DEFAULT_HISTORY = 2000;
const DEFAULT_BATTERY_THRESHOLD = 20;

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const s = status.value.settings;
    maxSendKbps.value = s?.maxSendKbps ?? null;
    versionsPerPath.value = s?.versionsPerPath ?? null;
    historyMaxEvents.value = s?.historyMaxEvents ?? null;
    webhookUrl.value = s?.webhookUrl ?? '';
    webhookSecret.value = '';
    secretCleared.value = false;
    secretAlreadySet.value = s?.webhookSecretSet === true;
    pauseOnMeteredNetwork.value = s?.pauseOnMeteredNetwork === true;
    pauseOnLowBattery.value = s?.pauseOnLowBattery === true;
    batteryPauseThreshold.value = s?.batteryPauseThreshold ?? null;
    shareEnabled.value = s?.shareEnabled === true;
    syncSchedule.value = s?.syncSchedule;
    holidayAutoFetch.value = s?.holidayAutoFetch !== false;
    holidaySourceUrl.value = s?.holidaySourceUrl ?? '';
    holidaySourceDefault.value = s?.holidaySourceDefault ?? '';
    overridesOpen.value = false;
    overrideDate.value = null;
  },
);

/** 手动日历覆盖(日期 → 身份),用于面板里列出已改的天并可撤销。 */
const calendarOverrides = computed(
  () => Object.entries(status.value.settings?.calendarOverrides ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
);

/** 一句话讲清日历现在靠不靠得住(判定永远可用,这里只说数据新鲜度)。 */
const calendarSummary = computed(() => {
  const c = status.value.calendarStatus;
  if (!c) return '未知';
  if (c.fetched) {
    const when = c.fetchedAt ? new Date(c.fetchedAt).toLocaleDateString() : '';
    return `${c.year} 年数据已缓存${when ? `(${when} 拉取)` : ''}${c.overrideCount ? `、${c.overrideCount} 天被手动改过` : ''}`;
  }
  return holidayAutoFetch.value
    ? `${c.year} 年数据尚未取到,当前按星期几判定${c.lastError ? `(上次失败:${c.lastError})` : ''}`
    : `已关闭自动拉取,当前按星期几 + 手动覆盖判定${c.overrideCount ? `(${c.overrideCount} 天已改)` : ''}`;
});

/** 新增/修改某天覆盖:即时写盘(低频、逐条动作,不搭「保存」按钮的车)。 */
async function addOverride(): Promise<void> {
  if (overrideDate.value === null || busy.value) return;
  const d = new Date(overrideDate.value);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  try {
    await apiPost('/api/calendar/override', { date, type: overrideType.value });
    showToast(`已把 ${date} 标为${overrideType.value === 'holiday' ? '休息日' : '工作日'}`);
    overrideDate.value = null;
    await refreshStatus();
  } catch (e) {
    showToast(errText(e, '日历覆盖失败'), 'alert');
  }
}

/** 撤销某天覆盖:交回自动拉取的数据(或按星期几退化)。 */
async function clearOverride(date: string): Promise<void> {
  if (busy.value) return;
  try {
    await apiPost('/api/calendar/override', { date, type: null });
    await refreshStatus();
  } catch (e) {
    showToast(errText(e, '撤销失败'), 'alert');
  }
}

async function onSave(): Promise<void> {
  if (busy.value) return;
  const body: Record<string, unknown> = {
    maxSendKbps: maxSendKbps.value,
    versionsPerPath: versionsPerPath.value,
    historyMaxEvents: historyMaxEvents.value,
    webhookUrl: webhookUrl.value.trim() || null,
    // 开关:关 = 传 null 清除(false 与缺省同义,后端不留 false 值)
    pauseOnMeteredNetwork: pauseOnMeteredNetwork.value ? true : null,
    pauseOnLowBattery: pauseOnLowBattery.value ? true : null,
    batteryPauseThreshold: batteryPauseThreshold.value,
    // 开关:关 = 传 null 清除(后端不留 false 值,并连带清空在册分享 —— 关即全断)
    shareEnabled: shareEnabled.value ? true : null,
    // 全局时段:空数组/undefined = 清除(全天);后端 normalizeSchedule 统一清洗规则
    syncSchedule: syncSchedule.value?.length ? syncSchedule.value : null,
    holidayAutoFetch: holidayAutoFetch.value ? null : false,
    // 源地址:填了须含 {year} 且 https(后端校验并 400);空串 = 回默认源
    holidaySourceUrl: holidaySourceUrl.value.trim() || null,
  };
  // 密钥三态:填了新值就覆盖;点了「清除」传 null;否则整个键不传 = 保持已存值
  const secret = webhookSecret.value.trim();
  if (secret) body.webhookSecret = secret;
  else if (secretCleared.value) body.webhookSecret = null;
  try {
    await apiPost('/api/settings', body);
    showToast('设置已保存');
    await refreshStatus();
    emit('close');
  } catch (e) {
    showToast(errText(e, '保存失败,请重试'), 'alert');
  }
}

async function onTestWebhook(): Promise<void> {
  if (testingWebhook.value) return;
  testingWebhook.value = true;
  try {
    const res = await apiPost<{ ok?: boolean; error?: string }>('/api/settings/webhook-test', {});
    if (res.ok) showToast('测试消息已送达');
    else showToast(res.error ?? '测试失败', 'alert');
  } catch (e) {
    showToast(errText(e, '测试失败'), 'alert');
  } finally {
    testingWebhook.value = false;
  }
}
</script>

<template>
  <!-- 布局:弹窗加宽到 720 后,八个设置段重组为「三组两列 + 两个通栏」以压缩高度。
       配对原则是按段高就近平衡:三个数值项 + 分享链接都是「单控件 + 说明」的短段,
       两两成对;电源守卫与节假日日历同为「开关 + 输入 + 说明」的感知类设置,配成一对;
       Webhook(成对输入)与同步时段(排程编辑器)控件宽,保持通栏。
       分享链接从弹窗末尾上移与历史记录配对,同步时段保持通栏、位置仅在 Webhook 之后。 -->
  <ModalShell :open="open" title="全局设置" description="对所有共享目录生效;目录级设置优先于这里的默认值" class="settings-modal" @close="emit('close')">
    <div class="settings-pair">
      <section class="settings-sec">
        <div class="edit-section-label">发送带宽上限</div>
        <n-input-number
          v-model:value="maxSendKbps"
          class="settings-input"
          :min="0"
          :step="512"
          placeholder="不限速"
          :disabled="busy"
        >
          <template #suffix>KB/s</template>
        </n-input-number>
        <p class="confirm-note-extra">
          每个对端的发送速率上限(目录单独配置「maxBandwidthKbps」时不走这里)。
          大文件同步占满 LAN 带宽时用它兜底;留空 = 不限速。
        </p>
      </section>
      <section class="settings-sec">
        <div class="edit-section-label">每路径版本份数</div>
        <n-input-number
          v-model:value="versionsPerPath"
          class="settings-input"
          :min="1"
          :step="1"
          :placeholder="`默认 ${DEFAULT_VERSIONS}`"
          :disabled="busy"
        >
          <template #suffix>份</template>
        </n-input-number>
        <p class="confirm-note-extra">
          本机文件被对端覆盖前,旧内容会自动留档;同一路径超过这个份数时删最旧的。
          留空 = 默认 {{ DEFAULT_VERSIONS }} 份。
        </p>
      </section>
    </div>

    <div class="settings-pair">
      <section class="settings-sec">
        <div class="edit-section-label">历史记录保留上限</div>
        <n-input-number
          v-model:value="historyMaxEvents"
          class="settings-input"
          :min="1"
          :step="500"
          :placeholder="`默认 ${DEFAULT_HISTORY}`"
          :disabled="busy"
        >
          <template #suffix>条 / 目录</template>
        </n-input-number>
        <p class="confirm-note-extra">每个目录最多保留多少条同步记录,超出后丢弃最旧的。留空 = 默认 {{ DEFAULT_HISTORY }} 条。</p>
      </section>
      <section class="settings-sec">
        <div class="edit-section-label">分享链接</div>
        <n-checkbox v-model:checked="shareEnabled" class="settings-checkbox" :disabled="busy">允许生成免登录的限时文件下载链接</n-checkbox>
        <p class="confirm-note-extra">
          开启后可在文件管理器为单个文件生成分享链接:对方无需账户即可下载,限时(最长 30 天)、只读、
          不能浏览目录里的其他文件,随时可撤销。默认关闭;关闭开关会让全部在外的链接立即失效。
          每次匿名下载都会记入 daemon 日志。
        </p>
      </section>
    </div>

    <section class="settings-sec">
      <div class="edit-section-label">同步事件 Webhook</div>
      <n-input
        v-model:value="webhookUrl"
        class="settings-input"
        placeholder="https://… 留空 = 关闭通知"
        :disabled="busy"
        clearable
      />
      <n-input
        v-model:value="webhookSecret"
        class="settings-input"
        :placeholder="secretAlreadySet && !secretCleared ? '已设置(留空保持不变)' : '可选:签名密钥'"
        type="password"
        show-password-on="click"
        :disabled="busy"
      />
      <p class="confirm-note-extra">
        同步完成、出现冲突、目录持续出错时向该地址推送一条通知;飞书机器人地址自动按其格式发送,其余地址为 JSON。
        目录出错只在错误内容变化时推送一次,不会每轮重复打扰。
        <template v-if="secretAlreadySet && !secretCleared">
          密钥已保存,不回显;输入新值可覆盖,或
          <button type="button" class="settings-link" @click="secretCleared = true; webhookSecret = ''">清除已存密钥</button>。
        </template>
        <template v-else-if="secretCleared">密钥将被清除。</template>
      </p>
      <n-button size="small" :loading="testingWebhook" :disabled="busy" @click="onTestWebhook">发送测试消息</n-button>
    </section>

    <section class="settings-sec">
      <div class="edit-section-label">同步时段(全局)</div>
      <ScheduleRuleEditor v-model:model-value="syncSchedule" />
      <p class="confirm-note-extra">
        这是这台机器的<b>硬闸门</b>:与目录级时段取交集 —— 两边都允许才同步,目录设置只能在全局窗口内再收窄,
        不能反向放宽(动机是省电与省流量)。留空 = 全天。时段外数据面停摆(不扫描、不广播、不接收),
        到点自动恢复;连接、配对、目录清单不受影响。
        时段外的提示与「临时放行」在状态页顶部的横幅上。
      </p>
    </section>

    <div class="settings-pair">
      <section class="settings-sec">
        <div class="edit-section-label">计费网络 / 电池感知(仅 Windows)</div>
        <n-checkbox v-model:checked="pauseOnMeteredNetwork" class="settings-checkbox" :disabled="busy">检测到计费网络时自动挂起同步</n-checkbox>
        <n-checkbox v-model:checked="pauseOnLowBattery" :disabled="busy" class="settings-checkbox">用电池且电量过低时自动挂起同步</n-checkbox>
        <n-input-number
          v-model:value="batteryPauseThreshold"
          class="settings-input"
          :min="1"
          :max="99"
          :step="5"
          :placeholder="`默认 ${DEFAULT_BATTERY_THRESHOLD}`"
          :disabled="busy || !pauseOnLowBattery"
        >
          <template #suffix>%</template>
        </n-input-number>
        <p class="confirm-note-extra">
          daemon 每分钟探测一次联网成本与电池状态,命中条件时所有目录的数据面自动挂起(连接与配对照常),
          条件解除自动恢复;与手动暂停互不覆盖。挂起期间目录栏会显示原因徽标。非 Windows 机器不启用探测。
          阈值留空 = 默认 {{ DEFAULT_BATTERY_THRESHOLD }}%。
        </p>
      </section>
      <section class="settings-sec">
        <!-- 标签行右侧的「查看日历」入口:打开全年月历预览(只读),编辑仍走本段的手动覆盖面板 -->
        <div class="edit-section-label cal-label-row">
          <span>节假日日历</span>
          <button type="button" class="settings-link" @click="calViewOpen = true">查看日历</button>
        </div>
        <n-checkbox v-model:checked="holidayAutoFetch" class="settings-checkbox" :disabled="busy">
          自动拉取法定节假日(决定「工作日 / 休息日」怎么判)
        </n-checkbox>
        <n-input
          v-model:value="holidaySourceUrl"
          class="settings-input"
          :placeholder="holidaySourceDefault || 'https://…/{year}.json'"
          :disabled="busy || !holidayAutoFetch"
          clearable
        />
        <p class="confirm-note-extra">
          地址需含 <code>{year}</code> 占位;留空 = 默认源。拉取只在后台发生,判定时只读本地缓存,
          <b>无网或拉取失败都不会挡住同步</b> —— 那时退化为「按星期几判」,并在下方标注数据缺失。
          当前状态:{{ calendarSummary }}
        </p>
        <button type="button" class="settings-link" @click="overridesOpen = !overridesOpen">
          {{ overridesOpen ? '收起' : '手动设置哪天是假期 / 补班' }}{{ calendarOverrides.length ? `(${calendarOverrides.length} 天已改)` : '' }}
        </button>
        <div v-if="overridesOpen" class="cal-panel">
          <div class="cal-panel__row">
            <n-date-picker v-model:value="overrideDate" type="date" size="small" :update-value-on-close="true" style="width: 140px" />
            <n-select
              v-model:value="overrideType"
              size="small"
              class="cal-type"
              :options="CAL_TYPE_OPTIONS as unknown as { label: string; value: string }[]"
            />
            <n-button size="small" :disabled="busy || overrideDate === null" @click="addOverride">添加</n-button>
          </div>
          <ul v-if="calendarOverrides.length" class="cal-overrides">
            <li v-for="[date, type] in calendarOverrides" :key="date">
              <span class="cal-overrides__date">{{ date }}</span>
              <span class="cal-overrides__type">{{ type === 'holiday' ? '休息日' : '工作日' }}</span>
              <button type="button" class="settings-link" @click="clearOverride(date)">撤销</button>
            </li>
          </ul>
          <p v-else class="confirm-note-extra">还没有手动覆盖的日期。</p>
          <p class="confirm-note-extra">
            公司放假与法定不一致时用这里:覆盖优先于自动拉取的数据。撤销后该日交回日历数据(或按星期几)判定。
          </p>
        </div>
        <!-- 全年日历预览:嵌套渲染即叠加(ModalShell 无 Teleport,遮罩 fixed 定位脱离格子布局,
             DOM 顺序在本弹窗内容之后,自然盖在上面 —— 先例见 HistoryModal 的二次确认弹窗) -->
        <CalendarModal :open="calViewOpen" @close="calViewOpen = false" />
      </section>
    </div>

    <template #footer>
      <n-button class="modal-cancel" :disabled="busy" @click="emit('close')">取消</n-button>
      <n-button type="primary" :loading="busy" @click="onSave">保存</n-button>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 两列布局:弹窗加宽到 720 后,把短设置段左右排布以压缩弹窗高度。
   .settings-pair / .settings-sec 仅本组件使用,故 scoped(口径同 AGENTS.md「组件自有的
   样式写在自己文件里」);.settings-input / .settings-checkbox / .settings-link 是跨弹窗
   共用的皮肤,仍留在 style.css。
   段间距沿用 .edit-section-label 自带的 18px 上边距:grid item 的 margin 不塌缩,
   格内间距由它提供;容器落在 .modal-body 块流里,通栏段的 18px 照常塌缩传出 ——
   两列与通栏的纵向节奏一致,不需要额外 gap。 */
.settings-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: 28px;
}
/* 窄屏(口径同 style.css 既有 600px 断点):两列说明文字挤成瘦长条,退回单列 */
@media (max-width: 600px) {
  .settings-pair {
    grid-template-columns: 1fr;
  }
}
/* 「节假日日历」标签行:右侧挂「查看日历」入口(打开全年月历预览弹窗 CalendarModal)。
   仅本组件使用,故 scoped;.settings-link 是跨弹窗共用皮肤,仍在 style.css ——
   这里只调它在标签行内的位置与字号(font: inherit 会继承标签行的 600 字重)。 */
.cal-label-row {
  display: flex;
  align-items: center;
}
.cal-label-row .settings-link {
  margin-left: auto;
  font-size: 12px;
}
/* 节假日日历面板:仅本组件使用的类,故 scoped(口径同 AGENTS.md「组件自有的样式写在自己文件里」)。
   .settings-input / .settings-checkbox / .settings-link 是跨弹窗共用的皮肤,仍留在 style.css。 */
.cal-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.cal-panel__row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.cal-type {
  width: 140px;
  flex: none;
}
.cal-overrides {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}
.cal-overrides li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cal-overrides__date {
  font-variant-numeric: tabular-nums;
}
.cal-overrides__type {
  opacity: 0.7;
}
</style>
