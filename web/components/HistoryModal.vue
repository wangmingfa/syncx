<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { NButton, NInput } from 'naive-ui';
import type { SyncEventItem, SyncHistoryData } from '../types';
import { apiJson, errText } from '../utils/api';
import { copyText } from '../utils/clipboard';
import { useStatusContext } from '../composables/statusContext';
import ModalShell from './ModalShell.vue';

const props = defineProps<{
  /** 非空 = 打开该目录的记录弹窗并拉取历史。 */
  folder: { id?: string; path: string } | null;
  /** 轻提示(父级 useToast 提供)。 */
  notify: (msg: string, kind?: 'info' | 'alert') => void;
}>();
const emit = defineEmits<{ close: [] }>();
const { askConfirm, status } = useStatusContext();

/** 本机设备 id。记录里的方向标着「本地 / 对端：<id>」,不给本机 id 的话,
 *  一串 id 里认不出哪台是自己(与设备卡同源:都取 status.deviceId)。 */
const deviceId = computed<string>(() => status.value.deviceId);

/** 首次/筛选后的默认拉取条数;「加载更多」沿阶梯递增到后端保留上限。 */
const FIRST_LIMIT = 200;
const LIMIT_STEPS = [200, 500, 1000, 2000];

const events = ref<SyncEventItem[]>([]);
const loading = ref(false);
const loadingMore = ref(false);
const lastPath = ref('');
const lastFolderId = ref('');

// 统计口径(全部来自后端:默认只拉 200 条时,前端靠自己数不出「共 N 条」)
const total = ref(0);
const matched = ref(0);
const oldestTs = ref<number | null>(null);
const maxRetention = ref(2000);
const limit = ref(FIRST_LIMIT);

// 筛选状态:选项即发请求(服务端筛选);搜索框防抖 350ms 后才进 appliedQuery
const filterDir = ref<'all' | 'local' | 'remote'>('all');
const filterDevice = ref('all');
const filterAction = ref<'all' | 'add' | 'update' | 'delete' | 'conflict'>('all');
const filterQuery = ref('');
const appliedQuery = ref('');
let queryTimer: ReturnType<typeof setTimeout> | undefined;

/** 已加载记录里出现过的对端设备 id(累积,不因筛选结果变窄而丢候选)。 */
const seenDevices = ref<string[]>([]);

/** 是否处于任一筛选下 —— 决定提示行说「共 N 条」还是「筛选出 X / 共 N」。
 *  设备筛选只在方向=对端时出现,方向那一票已经涵盖了它,不必单列。 */
const hasFilter = computed(
  () => filterDir.value !== 'all' || filterAction.value !== 'all' || appliedQuery.value !== '',
);

/** 设备下拉候选:已加载记录里出现过的 ∪ 该目录已指派的已知设备
 *  (后者让「设备在列但还没有记录」也能被筛出来确认,而不是凭空消失)。 */
const deviceOptions = computed<string[]>(() => {
  const ids = new Set(seenDevices.value);
  for (const d of status.value.devices) {
    if (d.folders.includes(lastFolderId.value)) ids.add(d.deviceId);
  }
  return [...ids].sort();
});

/** 设备展示名:status 里有主机名就标「主机名（id）」,一串裸 id 太难认。 */
function deviceLabel(id: string): string {
  const dev = status.value.devices.find((d) => d.deviceId === id);
  return dev?.hostname ? `${dev.hostname}（${id}）` : id;
}

watch(
  filterQuery,
  (v) => {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => {
      const q = v.trim();
      if (q === appliedQuery.value) return; // 清空/复原不重复打扰后端
      appliedQuery.value = q;
      void fetchHistory(FIRST_LIMIT, false);
    }, 350);
  },
);
onBeforeUnmount(() => clearTimeout(queryTimer));

watch(
  () => props.folder,
  (f) => {
    if (!f) return;
    lastPath.value = f.path;
    lastFolderId.value = f.id ?? f.path;
    // 换目录 = 换上下文:筛选、防抖、统计全部归零,不带旧目录的条件去查新目录
    clearTimeout(queryTimer);
    filterDir.value = 'all';
    filterDevice.value = 'all';
    filterAction.value = 'all';
    filterQuery.value = '';
    appliedQuery.value = '';
    seenDevices.value = [];
    events.value = [];
    total.value = 0;
    matched.value = 0;
    oldestTs.value = null;
    limit.value = FIRST_LIMIT;
    void fetchHistory(FIRST_LIMIT, false);
  },
);

/** 请求代次守卫:连点目录/快改筛选时,旧请求的响应晚到会覆盖新结果,必须认号收货。 */
let requestSeq = 0;

async function fetchHistory(lim: number, append: boolean): Promise<void> {
  const seq = ++requestSeq;
  if (append) loadingMore.value = true;
  else loading.value = true;
  try {
    const params = new URLSearchParams({ folderId: lastFolderId.value, limit: String(lim) });
    if (filterDir.value !== 'all') params.set('direction', filterDir.value);
    if (filterDir.value === 'remote' && filterDevice.value !== 'all') params.set('device', filterDevice.value);
    if (filterAction.value !== 'all') params.set('action', filterAction.value);
    if (appliedQuery.value) params.set('q', appliedQuery.value);
    const data = await apiJson<SyncHistoryData>(`/api/folders/history?${params.toString()}`);
    if (seq !== requestSeq) return;
    events.value = data.events ?? [];
    total.value = data.total ?? events.value.length;
    matched.value = data.matched ?? events.value.length;
    oldestTs.value = data.oldestTs ?? null;
    maxRetention.value = data.maxRetention ?? maxRetention.value;
    limit.value = lim;
    rememberDevices(events.value);
  } catch (e) {
    if (seq !== requestSeq) return;
    props.notify(errText(e, '读取同步记录失败'));
    if (!append) events.value = [];
  } finally {
    if (seq === requestSeq) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function rememberDevices(list: SyncEventItem[]): void {
  for (const ev of list) {
    if (ev.direction !== 'local' && ev.deviceId && !seenDevices.value.includes(ev.deviceId)) {
      seenDevices.value.push(ev.deviceId);
    }
  }
}

/** 任一筛选条件变化:回到默认窗口重查(带上守卫语义,append=false)。 */
function applyFilter(): void {
  void fetchHistory(FIRST_LIMIT, false);
}

function onDirChange(): void {
  if (filterDir.value !== 'remote') filterDevice.value = 'all';
  applyFilter();
}

/** 还能不能往下拿:已加载 < 命中数(加载更多是 limit 递增 + 全量替换)。
 *  不含 loadingMore —— 点击后按钮要留在原位显示「加载中…」,而不是瞬间消失。 */
const canLoadMore = computed(
  () => !loading.value && events.value.length > 0 && events.value.length < matched.value,
);

function nextLimitStep(): number {
  for (const s of LIMIT_STEPS) {
    if (limit.value < s && s <= maxRetention.value) return s;
  }
  return maxRetention.value;
}

function loadMore(): void {
  if (loadingMore.value) return;
  const next = nextLimitStep();
  if (next <= limit.value) return;
  void fetchHistory(next, true);
}

function actionLabel(a: string): string {
  return ({ add: '新增', update: '修改', delete: '删除', conflict: '冲突' } as Record<string, string>)[a] ?? a;
}

function directionLabel(d: string): string {
  return d === 'local' ? '本地' : '对端';
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

// 复制当前展示的全部同步记录到剪贴板(首行带上与弹窗一致的本机 id 说明,
// 否则粘贴出去的一串「对端：<id>」照样认不出哪台是自己)
async function copyHistory(): Promise<void> {
  if (events.value.length === 0) return;
  const rows = events.value
    .map((ev) => {
      const dir =
        directionLabel(ev.direction) +
        (ev.direction !== 'local' && ev.deviceId ? `：${ev.deviceId}` : '');
      return `${fmtTime(ev.ts)}\t${actionLabel(ev.action)}\t${dir}\t${ev.path}`;
    });
  const text = `本机 ${deviceId.value} · 记录里的「本地」即本机，「对端」标注了来源设备 id\n\n${rows.join('\n')}`;
  const ok = await copyText(text);
  if (ok) {
    props.notify('已复制全部同步记录到剪贴板', 'info');
  } else {
    props.notify('复制失败，请手动选择记录复制', 'alert');
  }
}

// —— CSV 导出(当前筛选 + 已加载的结果;报障时直接贴表格/日志) ——

function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function historyCsv(rows: SyncEventItem[]): string {
  const header = ['时间', '动作', '方向', '设备ID', '路径'];
  const lines = rows.map((ev) =>
    [fmtTime(ev.ts), actionLabel(ev.action), directionLabel(ev.direction), ev.deviceId || deviceId.value, ev.path]
      .map(csvEscape)
      .join(','),
  );
  // BOM + CRLF:Excel 缺 BOM 会把 UTF-8 中文当本地码页(乱码),CRLF 兼容记事本
  return '\uFEFF' + [header.join(','), ...lines].join('\r\n') + '\r\n';
}

async function copyCsv(): Promise<void> {
  if (events.value.length === 0) {
    props.notify('当前筛选结果为空,没有可导出的记录', 'info');
    return;
  }
  const ok = await copyText(historyCsv(events.value));
  props.notify(ok ? '已复制当前记录为 CSV' : '复制失败,请改用下载', ok ? 'info' : 'alert');
}

function downloadCsv(): void {
  if (events.value.length === 0) return;
  const safeId = lastFolderId.value.replace(/[^A-Za-z0-9._-]/g, '_');
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const blob = new Blob([historyCsv(events.value)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `syncx-history-${safeId}-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// 清空当前目录的全部同步记录(不可逆,需二次确认)
async function clearHistory(): Promise<void> {
  await apiJson('/api/folders/history/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId: lastFolderId.value }),
  });
  events.value = [];
  total.value = 0;
  matched.value = 0;
  oldestTs.value = null;
}

// 触发二次确认弹窗(复用全局 ConfirmModal,防误删)
function askClearHistory(): void {
  const f = props.folder;
  if (!f) return;
  askConfirm({
    title: '清空同步记录',
    message: '将删除该目录的全部同步记录,此操作不可恢复。',
    detail: f.path,
    confirmText: '清空',
    note: '清空后仅移除历史条目,之后的新同步仍会正常记录。',
    action: clearHistory,
  });
}
</script>

<template>
  <!-- 打开条件本来就是 folder 非空,这里把它投影成外壳要的布尔(emit 的语义不变) -->
  <ModalShell
    :open="!!folder"
    title="同步记录"
    :description="lastPath"
    description-mono
    wide
    @close="emit('close')"
  >
    <!-- 方向列的「本地 / 对端」与本机 id 成对出现:只标「对端：<id>」而不给本机 id,
         一串 id 里认不出哪台是自己。id 从注入的 status 取,与设备卡同源。 -->
    <p class="modal-lead">本机 <code class="mono">{{ deviceId }}</code> · 记录里的「本地」即本机，「对端」标注了来源设备 id</p>

    <!-- 筛选工具栏:条件是请求参数(服务端筛),改动即重查;搜索防抖 350ms。
         设备下拉**常驻**、非对端时禁用置灰 —— 动态插拔会撑出工具栏换行,
         每切一次方向弹窗高度抖一截,常驻则占位恒定。 -->
    <div class="history-filters">
      <label class="history-filter">
        方向
        <select v-model="filterDir" @change="onDirChange">
          <option value="all">全部</option>
          <option value="local">本机</option>
          <option value="remote">对端</option>
        </select>
      </label>
      <label class="history-filter" :class="{ 'history-filter-off': filterDir !== 'remote' }">
        设备
        <select v-model="filterDevice" :disabled="filterDir !== 'remote'" @change="applyFilter">
          <option value="all">全部设备</option>
          <option v-for="id in deviceOptions" :key="id" :value="id">{{ deviceLabel(id) }}</option>
        </select>
      </label>
      <label class="history-filter">
        动作
        <select v-model="filterAction" @change="applyFilter">
          <option value="all">全部</option>
          <option value="add">新增</option>
          <option value="update">修改</option>
          <option value="delete">删除</option>
          <option value="conflict">冲突</option>
        </select>
      </label>
      <n-input
        v-model:value="filterQuery"
        size="small"
        clearable
        placeholder="搜索路径关键词"
        class="history-search"
      />
    </div>

    <!-- 记录范围提示:看到的只是保留窗口内的历史,窗口大小/最早时间都来自后端统计。
         不再挂 !loading —— 筛选刷新期间数字短暂是旧的,换来少一次整行拆装的高度跳变。 -->
    <p v-if="total > 0" class="history-scope">
      <template v-if="hasFilter">筛选出 {{ matched }} 条 · 窗口内共 {{ total }} 条</template>
      <template v-else>共 {{ total }} 条</template>
      · 仅保留最近 {{ maxRetention }} 条<template v-if="oldestTs !== null"> · 最早记录 {{ fmtTime(oldestTs) }}</template>
    </p>

    <!-- 高度防抖:「读取中…」只挡首次加载;已有数据时旧列表原地变暗(is-refreshing),
         响应到达才整体换页 —— 弹窗高度不再随每次输入筛选塌一截再弹回。 -->
    <div v-if="loading && events.length === 0" class="history-loading">读取中…</div>
    <div v-else-if="events.length === 0" class="empty history-empty">
      {{ hasFilter ? '当前筛选条件下没有记录(服务端已检索保留窗口内全部记录,清空筛选即可看回)' : '还没有同步记录' }}
    </div>
    <ul v-else class="history-list" :class="{ 'is-refreshing': loading }" :aria-busy="loading || undefined">
      <li
        v-for="ev in events"
        :key="`${ev.ts}|${ev.path}|${ev.action}|${ev.deviceId ?? ''}`"
        class="history-row"
        :class="{ 'row-conflict': ev.action === 'conflict' }"
      >
        <span class="history-time">{{ fmtTime(ev.ts) }}</span>
        <span class="history-action" :class="'act-' + ev.action">{{ actionLabel(ev.action) }}</span>
        <span class="history-dir" :class="ev.direction === 'local' ? 'dir-local' : 'dir-remote'">{{ directionLabel(ev.direction) }}{{ ev.direction !== 'local' && ev.deviceId ? `：${ev.deviceId}` : '' }}</span>
        <span class="history-path mono break">{{ ev.path }}</span>
      </li>
    </ul>

    <!-- 加载更多区:刷新期用 visibility 保位而非拆走,避免又一处高度跳变 -->
    <div v-if="events.length > 0" class="history-more" :class="{ 'is-busy': loading }">
      <n-button v-if="canLoadMore" size="small" :disabled="loadingMore" @click="loadMore">
        {{ loadingMore ? '加载中…' : `加载更多(已显示 ${events.length} / ${matched})` }}
      </n-button>
      <span v-else-if="matched > FIRST_LIMIT" class="history-more-done">已显示全部 {{ matched }} 条</span>
    </div>

    <template #footer>
      <n-button :disabled="events.length === 0" @click="copyHistory">复制记录</n-button>
      <n-button :disabled="events.length === 0" @click="copyCsv">复制 CSV</n-button>
      <n-button :disabled="events.length === 0" @click="downloadCsv">下载 CSV</n-button>
      <n-button :disabled="events.length === 0" @click="askClearHistory">清空记录</n-button>
      <n-button type="primary" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>
</template>
