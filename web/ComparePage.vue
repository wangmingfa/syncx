<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, toRef, watch } from 'vue';
import { NButton } from 'naive-ui';
import { useCompare } from './composables/useCompare';
import { useToast } from './composables/useToast';
import { diffReportText } from './utils/diff-report';
import { fmtTime, stripWs } from './utils/format';
import type { StatusData } from './types';
import FileDiffModal from './components/FileDiffModal.vue';
import ReportModal from './components/ReportModal.vue';
import ToastView from './components/ToastView.vue';
import FileIcon from './components/FileIcon.vue';

const props = defineProps<{
  status: StatusData;
  folderId: string;
  /** 路由上预选的对比设备。 */
  device?: string;
}>();

// props.status 在 script 里是解包后的值,但仍随父级 ref 变化;toRef 还原成 ref 交给 composable
const statusRef = toRef(props, 'status');
const {
  folder, devices, device, data, loading, error, rows, counts,
  selectDevice, reload,
  fileOpen, filePath, fileData, fileLoading, fileError,
  openFile, closeFile, syncFile,
} = useCompare(statusRef, props.folderId, props.device);

/** 只看差异:目录大时全量树会很长,这个开关是主要的浏览方式。 */
const onlyDiff = ref(false);

/** 折叠状态:存「被收起的目录路径」集合。默认全部收起(见下方 watch),逐层展开看子树。 */
const collapsed = ref<Set<string>>(new Set());

/** onlyDiff 先裁一遍:只留差异行(目录若含差异会被保留,且祖先目录也一并保留)。 */
const baseRows = computed(() =>
  onlyDiff.value ? rows.value.filter((r) => r.status !== 'same') : rows.value,
);
/** 当前可见树里所有目录路径(用于判断某个祖先是否算「目录节点」)。 */
const dirPaths = computed(() => new Set(baseRows.value.filter((r) => r.isDir).map((r) => r.path)));
/** 折叠过滤:某行的任一祖先目录处于收起态,则该行不可见。 */
const visibleRows = computed(() =>
  baseRows.value.filter((r) => {
    const parts = r.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      // 祖先若是目录且处于收起态,整条子树隐藏
      if (dirPaths.value.has(p) && collapsed.value.has(p)) return false;
    }
    return true;
  }),
);

/** 完整树里的所有目录路径(用于「全部收起」)。 */
function allDirPaths(): string[] {
  return rows.value.filter((r) => r.isDir).map((r) => r.path);
}
// 新数据(换设备 / 重跑 / 首次进入)一律默认收起,避免一长串全展开把差异淹没
watch(rows, () => { collapsed.value = new Set(allDirPaths()); }, { immediate: true });

function toggleDir(path: string): void {
  const next = new Set(collapsed.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsed.value = next;
}
/** 一键展开:清空收起集合,整棵树铺开。 */
function expandAll(): void {
  collapsed.value = new Set();
}
/** 一键收起:把所有目录重新收起(恢复默认)。 */
function collapseAll(): void {
  collapsed.value = new Set(allDirPaths());
}

const { showToast } = useToast();

/**
 * ↑/↓ 差异跳转:在**当前可见**的差异行(含「里面有差异」的目录行)之间滚动定位。
 *
 * 目录默认折叠,差异往往藏在收起的目录里 —— 这时可见的差异行正是那些目录行,
 * 跳到目录行、展开、再按 ↓ 到具体文件,是这条导航链路的预期用法。
 *
 * 锚点取「第一条还没完全滚到表头上方」的差异行(= 视线当前所在的差异行);
 * 若它已贴着表头(说明正看着它),↓ 就取下一条、↑ 取上一条 —— 连按会逐条走,
 * 不会卡在同一条上。到头了给 toast,按钮不禁用:禁用态没法表达「再按一下就到头」。
 */
const tableEl = ref<HTMLElement | null>(null);
/** 当前视图里有没有可跳的差异行(决定箭头按钮是否禁用)。 */
const hasDiffTargets = computed<boolean>(() =>
  visibleRows.value.some((r) => r.status !== 'same'),
);
/** 跳转落点行的路径:短暂高亮,让用户看清「落在了哪一行」。 */
const jumpFlash = ref<string | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * 上一次跳转的目标行路径。底部钳制等多条差异同屏时,光靠滚动位置推不出
 * 「上一次跳到哪」—— 锚点会反复停在同一条上,↓ 永远走不完、也永远提示不了
 * 「到最后」。有了记忆,连按就按目标序列一步步走。
 *
 * 记忆在**按压时**验证:目标行还在可见差异行里、且仍在视口内(展开收起、重新
 * 对比、手动滚远都会让它失效)→ 从它继续;否则退回「从滚动位置推导锚点」。
 * 所以不需要 watch 去主动清它 —— 失效的记忆只是不被采用。
 */
const cursorPath = ref<string | null>(null);

/** 表格滚动位置:计数「n/m」要随滚动实时跟手,滚动事件里记一下(passive 监听)。 */
const tableY = ref(0);
function onTableScroll(): void {
  tableY.value = tableEl.value?.scrollTop ?? 0;
}

/** 当前可见的差异行,与 DOM 里带 [data-diff] 的行一一对应、同序(模板按 visibleRows 渲染)。 */
const diffRows = computed(() => visibleRows.value.filter((r) => r.status !== 'same'));

/**
 * 跳转计数「n / m」:n = 当前视线所在的差异行序号。
 * 有有效的跳转记忆(目标行还在视口里)用记忆;否则按滚动位置推导锚点 ——
 * 锚点规则与 jumpDiff 完全一致(第一条底边还没滚到表头上方的差异行),所以
 * 手动滚动时计数也实时跟手,按 ↓ 之后立刻反映「走到了第几条」。
 */
const diffPos = computed(() => {
  const total = diffRows.value.length;
  const el = tableEl.value;
  if (total === 0 || !el) return 0;
  const y = tableY.value;
  const head = el.querySelector<HTMLElement>('.cmp-thead');
  const headH = head ? head.offsetHeight : 0;
  const rows = Array.from(el.querySelectorAll<HTMLElement>('.cmp-row[data-diff]'));
  if (rows.length !== total) return 1; // 渲染中途行数没对上:先给个不吓人的值
  const base = el.getBoundingClientRect().top;
  const tops = rows.map((r) => r.getBoundingClientRect().top - base + y);
  const heights = rows.map((r) => r.offsetHeight);
  if (cursorPath.value) {
    const i = diffRows.value.findIndex((r) => r.path === cursorPath.value);
    // 与 jumpDiff 的 rememberedVisible 同判据:记忆行还在视口里才算「当前在这条」
    if (i >= 0 && tops[i]! + heights[i]! > y + headH - 1 && tops[i]! < y + el.clientHeight) return i + 1;
  }
  const idx = tops.findIndex((t, j) => t + heights[j]! > y + headH - 1);
  return idx < 0 ? total : idx + 1;
});

function scrollToDiffRow(el: HTMLElement, top: number, headH: number, path: string): void {
  // 目标行顶边停在表头下沿往下 2px:sticky 表头不遮行名,又给行一点呼吸感
  el.scrollTo({ top: Math.max(0, top - headH - 2), behavior: 'smooth' });
  jumpFlash.value = path;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { jumpFlash.value = null; }, 1400);
}

function jumpDiff(dir: 1 | -1): void {
  const el = tableEl.value;
  if (!el) return;
  // .cmp-row 的 DOM 顺序 = v-for 的顺序 = visibleRows 的顺序;先取全量行再筛出差异行,
  // 保留下标映射,跳转后才能用下标回查 visibleRows 里的 path(做落点高亮)
  const all = Array.from(el.querySelectorAll<HTMLElement>('.cmp-row'));
  const diffIdx: number[] = [];
  all.forEach((r, i) => { if (r.hasAttribute('data-diff')) diffIdx.push(i); });
  if (diffIdx.length === 0) return;
  const base = el.getBoundingClientRect().top;
  // 行顶边相对表格内容顶部的坐标:不依赖 offsetParent(行的定位祖先是页面不是表格)
  const tops = all.map((r) => r.getBoundingClientRect().top - base + el.scrollTop);
  const heights = all.map((r) => r.offsetHeight);
  const head = el.querySelector<HTMLElement>('.cmp-thead');
  const headH = head ? head.offsetHeight : 0;
  const y = el.scrollTop;
  // 贴顶判定容差 6px:平滑滚动落点带亚像素/取整偏差(实测 ~0.5px),太紧会把
  // 「已贴顶」误判成「还没到」,连按 ↓ 就会原地不动
  const NEAR = 6;

  let target = -1;
  const remembered = cursorPath.value === null
    ? -1
    : diffIdx.findIndex((i) => visibleRows.value[i]?.path === cursorPath.value);
  const rememberedVisible = remembered >= 0
    && tops[diffIdx[remembered]!]! + heights[diffIdx[remembered]!]! > y + headH - 1
    && tops[diffIdx[remembered]!]! < y + el.clientHeight;
  if (rememberedVisible) {
    // 上一次跳转的目标行还在视口里:从它继续按序走。底部钳制等多条差异同屏时,
    // 光靠滚动位置推不出「上一次跳到哪」,必须靠这份记忆。
    target = remembered + dir;
    if (target < 0) { showToast('已经是第一个差异'); return; }
    if (target >= diffIdx.length) { showToast('已经是最后一个差异'); return; }
  } else {
    // 锚点:第一条底边还没被滚到表头上方的差异行(部分可见也算「还在看」)
    let idx = diffIdx.findIndex((i) => tops[i]! + heights[i]! > y + headH - 1);
    if (dir > 0) {
      if (idx < 0) { showToast('已经是最后一个差异'); return; }
      // 底部钳制下差异行永远到不了顶,「贴顶」按成立处理,↓ 才能继续前进
      const atBottom = y >= el.scrollHeight - el.clientHeight - 1;
      if (atBottom || tops[diffIdx[idx]!]! <= y + headH + NEAR) idx += 1;
      if (idx >= diffIdx.length) { showToast('已经是最后一个差异'); return; }
      target = idx;
    } else {
      if (idx < 0) target = diffIdx.length - 1; // 差异行全在表头上方:回到最后一条
      else if (tops[diffIdx[idx]!]! <= y + headH + NEAR) {
        if (idx === 0) { showToast('已经是第一个差异'); return; }
        target = idx - 1;
      } else target = idx;
    }
  }
  const rowIdx = diffIdx[target]!;
  const path = visibleRows.value[rowIdx]?.path ?? '';
  cursorPath.value = path;
  scrollToDiffRow(el, tops[rowIdx]!, headH, path);
}

/** 新窗口里没有「上一页」可退时直接关窗,避免在空白页里打转。 */
function onBack(): void {
  if (window.history.length > 1) window.history.back();
  else window.close();
}

onUnmounted(() => clearTimeout(flashTimer));

// 目录刚加载(或刚从路由进来)时拉一次;设备为空(未指派)时不发请求,页面直接提示
watch(
  () => [props.folderId, device.value] as const,
  () => {
    if (device.value) void reload();
  },
  { immediate: true },
);

/** 本机 / 对端的身份行:与对比弹窗同源(主机名 + IP),缺项就少一项不占位。 */
const localWhere = computed<string>(() => {
  const d = data.value;
  if (!d) return '';
  return [d.localHostname, ...d.localAddresses].filter(Boolean).join(' · ');
});

const remoteWhere = computed<string>(() => {
  const d = data.value;
  if (!d) return '';
  return [
    d.deviceHostname ?? '',
    d.deviceUrl ? stripWs(d.deviceUrl) : '',
    d.deviceVersion ? `syncx ${d.deviceVersion}` : '',
  ].filter(Boolean).join(' · ');
});

/** 设备按钮的悬停提示:设备 id 本身不好认,补上主机名与地址。 */
function deviceTip(id: string): string {
  const dev = props.status.devices.find((d) => d.deviceId === id);
  return [dev?.hostname, dev?.url ? stripWs(dev.url) : ''].filter(Boolean).join(' · ') || id;
}

function rowClass(row: { status: string }): string {
  return `is-${row.status}`;
}

/** 一侧的单元格内容摘要(悬停可见):大小 + 内容摘要前 8 位。 */
function sideTitle(entry?: { size: number; digest: string; deleted: boolean }): string {
  if (!entry) return '';
  if (entry.deleted) return '已删除（墓碑）';
  return `${entry.size} B · ${entry.digest ? entry.digest.slice(0, 8) : '—'}`;
}

/** 双击任意一侧的文件行:打开内容对比弹窗(目录没有内容可比)。 */
function onRowDblClick(row: { isDir: boolean; path: string }): void {
  if (row.isDir) return;
  void openFile(row.path);
}

/** 报告弹窗。原先页头直接放「复制报告」一点就进剪贴板,用户对要复制的东西没有预期;
 *  现在先弹窗里看全文,再在弹窗里自己复制(与运行日志弹窗同一交互模式)。 */
const reportOpen = ref(false);
/** 报告正文:data 一变就重算,弹窗开着时后台重新对比也能看到最新内容。 */
const reportText = computed<string>(() => {
  const d = data.value;
  return d ? diffReportText(d, props.status.deviceId) : '';
});
</script>

<template>
  <div class="cmp-page">
    <!-- toast 渲染器:toast 是全局单例,旧版只有状态页渲染它 —— 对比页上的
         showToast(同步成功/复制报告)全都静默丢掉,这就是根因修复。 -->
    <ToastView />
    <header class="cmp-head">
      <div class="cmp-head__left">
        <n-button size="small" tertiary @click="onBack()">← 返回</n-button>
        <h1 class="cmp-title">目录对比</h1>
        <code v-if="folder" class="cmp-path mono break" :title="folder.path">{{ folder.path }}</code>
      </div>
      <div class="cmp-head__right">
        <n-button
          size="small"
          :tertiary="!onlyDiff"
          :type="onlyDiff ? 'primary' : 'default'"
          :disabled="!data"
          @click="onlyDiff = !onlyDiff"
        >只看差异</n-button>
        <n-button size="small" tertiary :disabled="loading || !device" @click="reload">重新对比</n-button>
        <n-button size="small" tertiary :disabled="!data" @click="reportOpen = true">查看报告</n-button>
      </div>
    </header>

    <!-- 目录 id 不存在:路由带了个本机没有的目录,直接给错误页而不是空表格 -->
    <div v-if="!folder" class="cmp-error" role="alert">
      <h2 class="cmp-error__title">目录不存在</h2>
      <p class="cmp-error__msg">
        本机没有 id 为 <code class="mono break">{{ folderId }}</code> 的共享目录，可能已被移除，或链接来自另一台机器。
      </p>
      <n-button size="small" tertiary @click="onBack()">← 返回</n-button>
    </div>

    <template v-else>
      <div class="cmp-bar">
        <span class="cmp-bar__label">对比设备</span>
        <n-button
          v-for="d in devices"
          :key="d"
          size="small"
          class="mono"
          :type="d === device ? 'primary' : 'default'"
          :tertiary="d !== device"
          :disabled="loading"
          :title="deviceTip(d)"
          @click="selectDevice(d)"
        >{{ d }}</n-button>
        <span v-if="devices.length === 0" class="cmp-bar__empty">该目录还没有指派设备</span>
      </div>

      <div v-if="loading" class="cmp-state">正在取对端的索引快照…</div>

      <div v-else-if="error" class="cmp-error" role="alert">
        <div class="cmp-error__msg break">{{ error }}</div>
        <n-button size="small" tertiary :disabled="loading" @click="reload">重试</n-button>
      </div>

      <template v-else-if="data">
        <div class="cmp-meta">
          对端快照取自 {{ fmtTime(data.remoteAt) }} · 本机索引 {{ data.diff.localTotal }} 条 ·
          对端 {{ data.diff.remoteTotal }} 条 · 一致 {{ data.diff.counts['in-sync'] }} 条 ·
          差异行 {{ counts.diff + counts['only-local'] + counts['only-remote'] }}
        </div>

        <div class="cmp-legend mono">
          <div class="cmp-legend__col">
            <span class="cmp-legend__role">本机</span>
            <span class="cmp-legend__id">{{ status.deviceId }}</span>
            <span v-if="localWhere" class="cmp-legend__where">{{ localWhere }}</span>
          </div>
          <div class="cmp-legend__col">
            <span class="cmp-legend__role">对端</span>
            <span class="cmp-legend__id">{{ data.deviceId }}</span>
            <span v-if="remoteWhere" class="cmp-legend__where">{{ remoteWhere }}</span>
          </div>
        </div>

        <div class="cmp-treebar">
          <n-button size="small" tertiary :disabled="!data" @click="expandAll">展开全部</n-button>
          <n-button size="small" tertiary :disabled="!data" @click="collapseAll">折叠全部</n-button>
          <span class="cmp-treebar__sep" aria-hidden="true"></span>
          <n-button size="small" tertiary :disabled="!hasDiffTargets" title="滚动到下一个有差异的文件" @click="jumpDiff(1)">
            <span class="cmp-nav-arrow" aria-hidden="true">
              <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v8M2.5 6.5 6 10l3.5-3.5" /></svg>
            </span>
            下一个差异
          </n-button>
          <span v-if="hasDiffTargets" class="cmp-nav-count mono">{{ diffPos }}/{{ diffRows.length }}</span>
          <n-button size="small" tertiary :disabled="!hasDiffTargets" title="滚动到上一个有差异的文件" @click="jumpDiff(-1)">
            <span class="cmp-nav-arrow" aria-hidden="true">
              <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" /></svg>
            </span>
            上一个差异
          </n-button>
          <span class="cmp-treebar__hint">默认折叠，点目录行可单独展开 / 收起</span>
        </div>

        <div ref="tableEl" class="cmp-table" role="table" @scroll.passive="onTableScroll">
          <div class="cmp-thead" role="row">
            <div class="cmp-th" role="columnheader">本机目录结构</div>
            <div class="cmp-th" role="columnheader">对端目录结构</div>
          </div>

          <div v-if="visibleRows.length === 0" class="cmp-state">
            {{ onlyDiff ? '没有差异' : '两边都没有文件' }}
          </div>

          <div
            v-for="row in visibleRows"
            :key="row.path"
            class="cmp-row"
            :class="[rowClass(row), { 'is-dir': row.isDir, 'is-jump': jumpFlash === row.path }]"
            :data-diff="row.status !== 'same' ? '1' : undefined"
            role="row"
            @click="row.isDir && toggleDir(row.path)"
          >
            <div
              class="cmp-cell"
              :title="sideTitle(row.left)"
              @dblclick="onRowDblClick(row)"
            >
              <template v-if="row.left || row.isDir">
                <span class="cmp-pad" :style="{ width: `${row.depth * 14}px` }" aria-hidden="true"></span>
                <FileIcon :name="row.name" :is-dir="row.isDir" :collapsed="collapsed.has(row.path)" />
                <span class="cmp-name break">{{ row.name }}</span>
                <span v-if="row.left?.deleted" class="cmp-tag">已删除</span>
              </template>
            </div>
            <div
              class="cmp-cell"
              :title="sideTitle(row.right)"
              @dblclick="onRowDblClick(row)"
            >
              <template v-if="row.right || row.isDir">
                <span class="cmp-pad" :style="{ width: `${row.depth * 14}px` }" aria-hidden="true"></span>
                <FileIcon :name="row.name" :is-dir="row.isDir" :collapsed="collapsed.has(row.path)" />
                <span class="cmp-name break">{{ row.name }}</span>
                <span v-if="row.right?.deleted" class="cmp-tag">已删除</span>
              </template>
            </div>
          </div>
        </div>

        <p class="cmp-hint">双击任意一侧的文件行，打开两侧内容对比（文本文件可逐块同步）</p>
      </template>
    </template>

    <FileDiffModal
      v-if="data"
      :open="fileOpen"
      :path="filePath"
      :data="fileData"
      :loading="fileLoading"
      :error="fileError"
      :device-id="data.deviceId"
      @close="closeFile"
      @sync="syncFile"
    />

    <ReportModal
      :open="reportOpen"
      :report="reportText"
      :folder-path="folder?.path ?? ''"
      @close="reportOpen = false"
    />
  </div>
</template>
