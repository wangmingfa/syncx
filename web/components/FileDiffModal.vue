<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { NButton, NTooltip } from 'naive-ui';
import { applyHunk, countChanged, diffText, type DiffHunk } from '../utils/text-diff';
import { formatBytes } from '../utils/bytes';
import { fileIconKind } from '../utils/file-icon';
import { escapeHtml, highlightLines, languageFor } from '../utils/syntax';
import { useToast } from '../composables/useToast';
import type { DiffActionCtx, DiffFooterAction, DiffHunkApply, DiffPaneData, FileSideData } from '../types';
import ModalShell from './ModalShell.vue';

/**
 * 通用文件差异弹窗(IDEA 风格并排对比)—— 纯展示引擎,不含业务语义。
 *
 * 「两侧是什么、能做什么」全部由调用方经 props 定义(见 types.ts 的 DiffPaneData /
 * DiffFooterAction / DiffHunkApply):对比页传 本机↔对端 + 拉/推覆盖;冲突收件箱传
 * 原文件↔冲突副本 + 合并写回。组件只认「侧配置 + 动作清单」,连二次确认都是通用机制。
 *
 * 四个展示状态各有明确的降级路径 —— 不做「假装能比」:
 *  - 两侧都是文本 → 逐行并排,可按配置出逐块应用按钮;
 *  - 任一侧是图片 → 并排看图,没有逐块(图片没有「第几行」);
 *  - 任一侧二进制 / 超限 → 只报原因,动作交给 footerActions;
 *  - 任一侧缺失 → 只能从存在的那侧覆盖过去。
 */
const props = defineProps<{
  open: boolean;
  /** 被对比文件的相对路径(标题与描述)。 */
  path: string;
  /** 标题覆写:对比页默认「文件内容对比」,冲突场景传「冲突对比」。 */
  title?: string;
  left: DiffPaneData;
  right: DiffPaneData;
  /** 逐块应用按钮:哪个方向给了 tooltip 就出哪个按钮;省略 = 正文无按钮。 */
  hunkApply?: DiffHunkApply;
  /** footer 动作按钮(渲染 + 禁用 + 内联二次确认由组件通用处理,点击回传 id)。 */
  footerActions?: DiffFooterAction[];
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  close: [];
  /** footer 动作确认后的回传(语义由调用方解释)。 */
  action: [id: string];
  /** 逐块应用:组件算好「应用该块后的完整新内容」,dir = 写入目标侧。 */
  applyHunk: [payload: { dir: 'left' | 'right'; content: string }];
}>();

const left = computed<FileSideData>(() => props.left.side);
const right = computed<FileSideData>(() => props.right.side);
/** 组句角色名:role 缺省取 label(「本机」/「对端」/「原文件」…)。 */
function roleOf(pane: DiffPaneData): string {
  return pane.role ?? pane.label;
}

/**
 * 正文(以及底部动作按钮)是否展示。加载中/出错时不显示动作按钮 ——
 * 拿不到两侧数据时按钮全是禁用态,摆在那里只会让人以为能点。
 * 正文与 footer 共用这一处判定,避免二者分叉。
 */
const showData = computed<boolean>(() => !props.loading && !props.error);

/** 一侧能否用于逐行对比:存在、有文本、且不是二进制/过大。 */
function comparable(side: FileSideData): boolean {
  return side.exists && typeof side.text === 'string' && !side.binary && !side.tooLarge;
}

const canDiff = computed<boolean>(() => comparable(left.value) && comparable(right.value));

const diff = computed(() =>
  canDiff.value ? diffText(left.value.text ?? '', right.value.text ?? '') : { rows: [], hunks: [] },
);

/**
 * 图片预览:任一(可预览的)侧有 image 字节就切到看图视图。
 *
 * 只要**一侧**是图片就够 —— 另一侧缺失(文件只在一边存在)时,那半边的图恰恰是用户
 * 这趟想看的;对端离线也一样,至少能确认本机这张是什么。
 */
const canPreview = computed<boolean>(() => !!(left.value.image || right.value.image));

/**
 * 视图模式。默认预览:今天只有 `.svg` 会两种视图都可用(既是图片又是可读文本),
 * 那种文件先看「长什么样」通常比先看「哪一行改了」更符合直觉,要逐行再切。
 * 换文件/关窗时重置回预览。
 */
const viewMode = ref<'preview' | 'text'>('preview');
const showImages = computed<boolean>(
  () => canPreview.value && (viewMode.value === 'preview' || !canDiff.value),
);
const showText = computed<boolean>(() => canDiff.value && !showImages.value);
/** 两种视图都可用时才给切换按钮(今天只会出现在 svg 上)。 */
const canSwitchView = computed<boolean>(() => canPreview.value && canDiff.value);

/**
 * data URL 一律走 computed、不在模板里拼:`props.data` 没变时的重渲染(悬停换行、
 * 滚动同步都在触发)不该每次重新拼一个几 MB 的字符串。
 */
function toDataUrl(side: FileSideData): string {
  return side.image ? `data:${side.image.mime};base64,${side.image.data}` : '';
}
const leftSrc = computed<string>(() => toDataUrl(left.value));
const rightSrc = computed<string>(() => toDataUrl(right.value));

/**
 * 图片原始像素尺寸:由 <img> 解码后回填(后端不去解析图片头,那是浏览器的活)。
 *
 * 每侧记着「这个尺寸是哪个 src 解出来的」:内容一变(同步后重取、切到另一个文件),
 * 旧尺寸立刻失效 —— 否则一张图不在了,它那行还留着上一张的 120×90。
 * 不能靠「数据变了就清空」——同 src 时不会再有 load 事件,清了就再也填不回来。
 */
const dims = ref<{ left: { src: string; text: string }; right: { src: string; text: string } }>({
  left: { src: '', text: '' },
  right: { src: '', text: '' },
});
function onImgLoad(which: 'left' | 'right', e: Event): void {
  const el = e.target as HTMLImageElement;
  dims.value[which] = {
    src: el.currentSrc || el.src,
    text: `${el.naturalWidth}×${el.naturalHeight}`,
  };
}

/** 一侧图片下方的单行说明:尺寸 · 大小(尺寸要等图解码完才有,先只显示大小)。 */
function metaOf(side: FileSideData, which: 'left' | 'right', src: string): string {
  const parts: string[] = [];
  const dim = dims.value[which];
  if (dim.src !== '' && dim.src === src) parts.push(dim.text);
  if (side.size !== undefined) parts.push(formatBytes(side.size));
  return parts.join(' · ');
}

/** 两侧图片字节是否逐字节相同(看的是内容,不是版本 —— 标签也就写「图片一致」)。 */
const imagesIdentical = computed<boolean>(
  () => !!left.value.image && !!right.value.image && left.value.image.data === right.value.image.data,
);

/** 只有一侧有可预览的图(另一侧缺失 / 超限 / 不是图片)。 */
const oneSided = computed<boolean>(() => !!left.value.image !== !!right.value.image);

/** 按后缀看这是不是图片:降级态据此说「无法预览」而不是「无法逐行对比」。 */
const looksLikeImage = computed<boolean>(() => fileIconKind(props.path) === 'image');

/** 每个差异块的首行下标 → 块,用于在该行渲染 ← / → 按钮。 */
const hunkAtStart = computed<Map<number, DiffHunk>>(() => {
  const map = new Map<number, DiffHunk>();
  for (const h of diff.value.hunks) map.set(h.start, h);
  return map;
});

const changedCount = computed<number>(() => countChanged(diff.value.rows));

const { showToast } = useToast();

// ---------- 虚拟滚动 ----------
//
// 5 万行(2MiB 文本上限的最坏档)全量渲染要 ~3s、滚动同步跟不上,所以正文只渲染
// 视口附近的窗口,其余高度用垫片撑出来。成立的前提(改动前先读这段):
//
//  **行高必须恒定**。靠的是 `.fd-text` 的 `white-space: pre`(长行不换行)与
//  `.fd-row` 的 `min-height: calc(1.55 * 1em)`(与行盒同高)—— 每行严格一行高。
//  若有人改成可换行,「第 n 行的偏移 = n × 行高」的算术定位全部失效,垫片也会
//  把滚动条撑错,这里必须回退成全量渲染,不能带病窗口化。

/**
 * 行高(px)。初始值镜像 .fd-rows 的 CSS 决定值(12px × 1.55 数值行高,与字体无关;
 * 浏览器缩放同倍作用于 scrollTop,恒成立),保证**第一帧**的窗口就是对的;
 * 每次进入逐行视图后都在真实行上复测(见 measureRowH),之后一直用实测值 ——
 * 将来字号/行高改了这里自动跟上。
 */
const ROW_H_FROM_CSS = 12 * 1.55;
const rowH = ref(ROW_H_FROM_CSS);

/** 视口外的渲染余量:上下各多画这些行,滚动时边缘不露白、小步滚动不闪。 */
const OVERSCAN = 20;

/** 用户当前纵向滚动位置。两窗格被 onPaneScroll 锁死同步,记一份即可,驱动窗口重算。 */
const scrollTopY = ref(0);

/** 窗格可视高度(不含横向滚动条)。窗口下沿 = scrollTopY + paneH。 */
const paneH = ref(0);

const winStart = computed<number>(() => {
  if (rowH.value <= 0) return 0;
  const raw = Math.floor(scrollTopY.value / rowH.value) - OVERSCAN;
  return Math.max(0, Math.min(diff.value.rows.length, raw));
});

const winEnd = computed<number>(() => {
  const n = diff.value.rows.length;
  if (rowH.value <= 0) return n;
  return Math.min(n, Math.ceil((scrollTopY.value + paneH.value) / rowH.value) + OVERSCAN);
});

/** 窗口切片(带全量行下标):模板与 hunkAtStart / hoverIndex 都只认全量行号。 */
const winRows = computed(() =>
  diff.value.rows.slice(winStart.value, winEnd.value).map((row, i) => ({ row, i: winStart.value + i })),
);

const spacerTop = computed<number>(() => winStart.value * rowH.value);
const spacerBottom = computed<number>(() =>
  Math.max(0, (diff.value.rows.length - winEnd.value) * rowH.value),
);

/**
 * 进入逐行视图时窗格才存在:量视口高、并在真实行上复测行高(首次渲染后、绘制前,
 * nextTick 是微任务,来得及在首帧前把窗口修正)。
 */
watch(showText, (v) => {
  if (!v) return;
  scrollTopY.value = 0;
  void nextTick(() => {
    measurePane();
    measureRowH();
  });
});

function measurePane(): void {
  const el = paneLeftEl.value;
  if (el) paneH.value = el.clientHeight;
}

/**
 * 实测行高。取计算样式的 line-height(单行 + 不换行时行盒就是它,.fd-row 的
 * min-height 与之同源)—— 用**布局坐标**而不是 getBoundingClientRect:两者在正常
 * 浏览器里相等,但滚动算术要和 scrollTop/scrollHeight 同一坐标系,line-height 的
 * 计算值天然就是,不留坐标系歧义。
 */
function measureRowH(): void {
  const el = paneLeftEl.value?.querySelector('.fd-row');
  if (!el) return;
  const lh = Number.parseFloat(getComputedStyle(el).lineHeight);
  if (Number.isFinite(lh) && lh > 0) rowH.value = lh;
  else {
    const h = el.getBoundingClientRect().height;
    if (h > 0) rowH.value = h;
  }
}

/**
 * ↑/↓ 差异块跳转:在差异块(hunk)之间滚动定位。
 *
 * 锚点取「第一条还没完全滚出窗格顶部」的差异块(= 视线当前所在的块);若它已贴着
 * 窗格顶(说明正看着它),↓ 就取下一块、↑ 取上一块 —— 连按会逐块走,不会卡在同一块上。
 * 到头了给 toast,不禁用:禁用态没法表达「再按一下就到头」。
 *
 * 虚拟滚动后行是窗口切片,没有稳定的「第 n 个子节点」,锚点与落点全靠算术定位:
 * 行高恒定(见虚拟滚动段的前提),h.start × rowH 就是该行顶边在内容顶下的偏移。
 * 只滚左窗格即可:programmatic scrollTop 变化会触发 scroll 事件,由既有的
 * onPaneScroll 双向同步把右窗格带到同一行。
 */
const hunkCursor = ref(0);

/** 依据滚动位置重算当前差异块(驱动 n/m 计数):第一条底边还没完全滚出顶部的块。 */
function syncHunkCursor(y: number): void {
  const hs = diff.value.hunks;
  if (hs.length === 0) {
    hunkCursor.value = 0;
    return;
  }
  // 底边 = (h.start + 1) 行的下边缘,超过 y+1 就是还没完全滚出顶部(部分可见也算「还在看」)
  const idx = hs.findIndex((h) => (h.start + 1) * rowH.value > y + 1);
  hunkCursor.value = idx < 0 ? hs.length - 1 : idx;
}

function jumpHunk(dir: 1 | -1): void {
  const pane = paneLeftEl.value;
  const hs = diff.value.hunks;
  if (!pane || hs.length === 0) return;
  const y = pane.scrollTop;
  // 是否已滚到窗格底部:底部钳制下差异块永远到不了顶,「贴顶」按成立处理,↓ 才能继续前进
  const atBottom = y >= pane.scrollHeight - pane.clientHeight - 1;
  // 贴顶判定容差 6px:scrollTop 赋值会被取整,落点带亚像素偏差(~0.1px),太紧会把
  // 「已贴顶」误判成「还没到」,连按 ↓ 就会原地不动。落点定格为顶下 4px(TOP_PAD)。
  const TOP_PAD = 4;
  const NEAR = 6;
  // 锚点:第一条底边还没完全滚出顶部的差异块
  const idx = hs.findIndex((h) => (h.start + 1) * rowH.value > y + 1);
  const topOf = (h: (typeof hs)[number]): number => h.start * rowH.value;
  let target = -1;
  if (dir > 0) {
    if (idx < 0) { showToast('已经是最后一个差异'); return; }
    if (atBottom || topOf(hs[idx]!) <= y + NEAR) target = idx + 1;
    else target = idx;
    if (target >= hs.length) { showToast('已经是最后一个差异'); return; }
  } else {
    if (idx < 0) target = hs.length - 1; // 差异块全在顶部上方:回到最后一块
    else if (topOf(hs[idx]!) <= y + NEAR) {
      if (idx === 0) { showToast('已经是第一个差异'); return; }
      target = idx - 1;
    } else target = idx;
  }
  // 差异块首行顶边停在窗格顶往下 4px;滚左窗格,右窗格由 scroll 同步跟上
  pane.scrollTop = Math.max(0, topOf(hs[target]!) - TOP_PAD);
  hunkCursor.value = target;
}

/**
 * 整份文本按 diffText 同一套规格化规则切成行(CRLF→LF、剥结尾换行,见 text-diff 的
 * prepare),行号才与差异行的 leftNo/rightNo 同源。缓存住:窗口随滚动重算时不再重切。
 */
function splitLines(text: string): string[] {
  const norm = text.replace(/\r\n?/g, '\n');
  return (norm.endsWith('\n') ? norm.slice(0, -1) : norm).split('\n');
}

const leftLinesCache = computed<string[] | null>(() =>
  typeof left.value.text === 'string' ? splitLines(left.value.text) : null,
);
const rightLinesCache = computed<string[] | null>(() =>
  typeof right.value.text === 'string' ? splitLines(right.value.text) : null,
);

/**
 * 语法高亮(窗口化):只染当前窗口内出现的那些行。
 *
 * `null` = 不着色,是**预期路径不是错误**:扩展名没有对应语言(.log/.txt/.bat…)、
 * 或者高亮本身抛错,都应静默退回纯文本 —— 染色是锦上添花,绝不能因为它的失败
 * 让对比本身看不了。
 *
 * 窗口按**行号**切而不是按下标:纯增/纯删行只在一边有行号,同一窗口行里两侧的
 * 行号范围并不相同,各切各的。窗口内部的行整段送 highlightLines,跨行结构
 * (块注释、多行字符串)仍然正确;只有恰好跨窗口边界的 token 会丢着色 ——
 * 窗口带 OVERSCAN 余量,边界在屏幕外,丢的也是看不见的行。
 */
const hl = computed<{
  left: { arr: string[]; base: number } | null;
  right: { arr: string[]; base: number } | null;
}>(() => {
  if (!showText.value) return { left: null, right: null };
  const ls = leftLinesCache.value;
  const rs = rightLinesCache.value;
  if (ls === null && rs === null) return { left: null, right: null };
  const rows = diff.value.rows;
  const s = winStart.value;
  const e = Math.min(rows.length, winEnd.value);
  if (s >= e) return { left: null, right: null };
  let lLo = Number.POSITIVE_INFINITY;
  let lHi = 0;
  let rLo = Number.POSITIVE_INFINITY;
  let rHi = 0;
  for (let i = s; i < e; i++) {
    const row = rows[i]!;
    if (row.leftNo !== undefined) {
      if (row.leftNo - 1 < lLo) lLo = row.leftNo - 1;
      if (row.leftNo > lHi) lHi = row.leftNo;
    }
    if (row.rightNo !== undefined) {
      if (row.rightNo - 1 < rLo) rLo = row.rightNo - 1;
      if (row.rightNo > rHi) rHi = row.rightNo;
    }
  }
  const lang = languageFor(props.path);
  const windowOf = (
    lines: string[] | null,
    lo: number,
    hi: number,
  ): { arr: string[]; base: number } | null => {
    if (lines === null) return null;
    const from = Math.max(0, lo);
    const to = Math.min(lines.length, hi);
    if (from >= to) return null;
    const arr = highlightLines(lines.slice(from, to), lang);
    return arr === null ? null : { arr, base: from };
  };
  return { left: windowOf(ls, lLo, lHi), right: windowOf(rs, rLo, rHi) };
});

/**
 * 一行的渲染内容(HTML 字符串)。有高亮时按**行号**取,而不是按文本匹配 ——
 * 行号由 diff 给出、与对面那一栏天然对齐,重复行也不会取错;高亮数组是窗口切片,
 * `base` 是它的首行行号,索引 = 行号 - base。
 *
 * ⚠️ 模板里用的是 `v-html`,所以这里**必须自己保证内容已转义**,两种情况分别兜住:
 *  - 有高亮:内容是 hljs 的输出,它会把 `&` `<` `>` 转义成实体;
 *  - 不着色 / 行号不在窗口切片里:走 escapeHtml()。
 * 少兜一处就等于把「被对比的那个文件」当成 HTML 执行 —— 文件内容来自对端设备,不可信。
 */
function cell(
  hlSide: { arr: string[]; base: number } | null,
  no: number | undefined,
  text: string | undefined,
): string {
  const raw = text ?? '';
  if (hlSide === null || no === undefined) return escapeHtml(raw);
  return hlSide.arr[no - 1 - hlSide.base] ?? escapeHtml(raw);
}

/**
 * 两侧内容是否**真的**一模一样 —— 整文件覆盖按钮据此禁用。
 *
 * 注意不能拿「0 行差异」当判据:`diffText` 会先把 `\r\n` 规格化成 `\n`、并把结尾
 * 换行剥掉再比行(`prepare`),所以「CRLF vs LF」「结尾多一个空行」这类差异在逐行
 * 视图里是**看不见的 0 行差异**,而文件确实不同。跨 macOS/Windows/Linux 同步时这
 * 恰恰常见 —— 若据此禁用覆盖,用户就被锁死在「明明不一样却点不了」的死角。
 * 所以文本按**原始字符串**逐字比,图片按字节比。
 *
 * 降级态(二进制 / 超限 / 一侧缺失)看不到内容:同样大小不等于同样字节,
 * 一律不判「一致」,覆盖按钮照旧可用。
 */
const contentIdentical = computed<boolean>(() => {
  if (showText.value) return left.value.text === right.value.text;
  if (showImages.value) return imagesIdentical.value;
  return false;
});

/**
 * 二进制 / 过大 / 取不到时,说明为什么看不了内容。
 *
 * 过大一律带上实际大小:上限按类型分档(图片 8 MiB / 文本 2 MiB),写死一个数字
 * 迟早与现实不符,而「这张图 12.4 MB」才是用户要的信息。
 */
function reasonOf(side: FileSideData, role: string): string {
  // 带 error 的「取不到」不能写成「没有这个文件」:闸门拒绝 / 路径越界 / 读失败时文件
  // 就在盘上,谎报缺失会把人支去查一个不存在的问题(冲突副本对比曾因此整块失灵)。
  if (!side.exists) {
    return side.error ? `${role}内容不可用（${side.error}）` : `${role}没有这个文件`;
  }
  if (side.tooLarge) {
    return `${role}文件过大${side.size !== undefined ? `（${formatBytes(side.size)}）` : ''}`;
  }
  if (side.binary) return `${role}是二进制文件`;
  return `${role}内容不可用`;
}

const blocked = computed<string>(() => {
  if (canDiff.value) return '';
  if (!comparable(left.value)) return reasonOf(left.value, roleOf(props.left));
  return reasonOf(right.value, roleOf(props.right));
});

function rowClass(type: string): string {
  return `is-${type}`;
}

/**
 * 通用动作机制:footerActions 若带 confirm 文案,点击先进入内联二次确认条
 * (破坏性操作的拦截留在组件里,文案与语义留在调用方);逐块应用不拦 ——
 * 外科手术式的一小块,不算破坏性。
 */
const pendingAction = ref<DiffFooterAction | null>(null);
function requestAction(a: DiffFooterAction): void {
  if (a.confirm) pendingAction.value = a;
  else emit('action', a.id);
}
function confirmAction(): void {
  const a = pendingAction.value;
  pendingAction.value = null;
  if (a) emit('action', a.id);
}

/** 传给动作 disabled/hint 判定函数的实况:内容一致性与两侧存在性。 */
const actionCtx = computed<DiffActionCtx>(() => ({
  identical: contentIdentical.value,
  leftExists: left.value.exists,
  rightExists: right.value.exists,
}));
/**
 * 左右是两个独立滚动区,但滚动位置必须锁死:同一行左右两块要水平对齐,否则
 * 对比失去意义 —— 纵向如此,横向同理(两栏是同一份内容的两侧,横向错开就没法
 * 逐字符比对)。
 *
 * 两排行数/行高完全一致(每个 row 左右两侧各占一格),滚动位置可以精确同步。
 * 防回环用 `lockSource` 记住「正被我们程序化滚动的窗格」,忽略它随后的那个
 * scroll 事件 —— 比布尔锁稳:布尔锁在 rAF 解锁前会把同源的连续滚动事件一并吞掉。
 */
const paneLeftEl = ref<HTMLElement | null>(null);
const paneRightEl = ref<HTMLElement | null>(null);
/** 正在被程序化滚动的窗格;它随之触发的 scroll 事件要忽略(否则两边互推成环)。 */
let lockSource: HTMLElement | null = null;

function onPaneScroll(which: 'left' | 'right'): void {
  const src = which === 'left' ? paneLeftEl.value : paneRightEl.value;
  const dst = which === 'left' ? paneRightEl.value : paneLeftEl.value;
  if (!src || !dst) return;
  // 窗口锚与光标(当前差异块)只由实际滚动位置决定,与同步锁无关 —— 先于锁检查更新,
  // 否则「右窗格滚动带动左窗格」的那次联动会被锁吞掉、窗口和计数停在旧位置
  scrollTopY.value = src.scrollTop;
  syncHunkCursor(src.scrollTop);
  if (lockSource === src) return; // 这是上一步同步带给 src 的联动事件,不是用户滚动
  lockSource = dst;
  dst.scrollTop = src.scrollTop;
  dst.scrollLeft = src.scrollLeft;
  requestAnimationFrame(() => {
    lockSource = null;
  });
}

/**
 * 鼠标悬停的行下标。两个窗格共用它,所以停在任意一侧都能同时点亮两侧的同一行 ——
 * 看长行/对齐差异时不用来回找「刚才看的是哪一行」。
 * 靠 mouseleave 挂在窗格上(而不是每一行上)清空:行与行之间、以及左右窗格之间
 * 移动时不会闪一下。
 */
const hoverIndex = ref<number | null>(null);

// 关窗或换文件时,清掉进行中的覆盖确认、回到预览视图,并把两个窗格滚回左上角
// (图片尺寸不用在这里清:它按 src 记账,内容一变就自动失效)
watch(
  () => [props.open, props.path],
  () => {
    pendingAction.value = null;
    hoverIndex.value = null;
    viewMode.value = 'preview';
    scrollTopY.value = 0;
    // 双击文件行打开本弹窗时,浏览器会顺手选中那一行文字;不清掉,选区会残留到
    // 新渲染的对比文本上,整屏看起来像被全选。打开时清一次选区。
    if (props.open) window.getSelection()?.removeAllRanges();
    void nextTick(() => {
      hunkCursor.value = 0;
      measurePane();
      measureRowH();
      for (const el of [paneLeftEl.value, paneRightEl.value]) {
        if (!el) continue;
        el.scrollTop = 0;
        el.scrollLeft = 0;
      }
    });
  },
);

/**
 * Esc 关窗。挂在 window 而不是弹窗元素上:焦点通常在窗格里的滚动区,或者压根没进过
 * 弹窗(点遮罩打开后直接按键),挂元素上会漏掉。
 *
 * 正在等待某个动作的二次确认时,Esc 先撤掉那一步(等价于点「取消」),不关窗:
 * 那一按键的语义是「打消这次危险操作」,若顺手把弹窗也收了,用户反而丢了上下文。
 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !props.open) return;
  if (pendingAction.value) {
    pendingAction.value = null;
    return;
  }
  emit('close');
}
// 窗格高度随弹窗(即视口)尺寸走:窗口下沿 = scrollTopY + paneH,尺寸变了要跟着量
function onResize(): void {
  measurePane();
}
onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onResize);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onResize);
});

/**
 * 把某个差异块应用到目标侧:算好应用后的完整新内容再抛给调用方
 * (组件不关心目标是本机还是对端,写回路径由调用方解释)。
 */
function apply(hunk: DiffHunk, target: 'left' | 'right'): void {
  const newText = applyHunk(left.value.text ?? '', right.value.text ?? '', hunk, target);
  emit('applyHunk', { dir: target, content: newText });
}
</script>

<template>
  <!-- fd-modal 是宽度类(96% 宽):外壳设了 inheritAttrs:false,调用方写的 class 会落到
       dialog(.modal)自己身上,而不是外层遮罩。fd-modal--tall 仍按「任一视图可用」加高。 -->
  <ModalShell
    :open="open"
    :title="title ?? '文件内容对比'"
    :description="path"
    description-mono
    :class="['fd-modal', { 'fd-modal--tall': canDiff || canPreview }]"
    @close="emit('close')"
  >

    <div v-if="loading" class="fd-state">正在读取两侧内容…</div>

    <div v-else-if="error" class="diff-error" role="alert">
      <div class="diff-error__msg break">{{ error }}</div>
    </div>

    <template v-if="showData">
      <!-- 模板里裸 left/right 解析到的是局部 computed(侧数据),pane 配置必须走 props.* -->
      <div class="fd-legend mono">
        <span class="fd-legend__role">{{ props.left.label }}</span>
        <span v-if="props.left.note" class="fd-legend__id">{{ props.left.note }}</span>
        <span class="fd-legend__sep">↔</span>
        <span class="fd-legend__role">{{ props.right.label }}</span>
        <span v-if="props.right.note" class="fd-legend__id">{{ props.right.note }}</span>
      </div>

      <!-- 对比区。表头(左角色 / 中间摘要 / 右角色)两种视图共用一份 —— 中间那格换内容,
           免得两套表头各写一遍、宽窄对不齐。 -->
      <div v-if="showText || showImages" class="fd-body">
        <div class="fd-head">
          <span class="fd-head__role">{{ props.left.label }}</span>
          <span class="fd-head__mid">
            <template v-if="showText">
              <span v-if="contentIdentical" class="fd-head__clean">两侧内容一致</span>
              <!-- 逐行看不出差异、但内容确实不同(CRLF vs LF、结尾换行)→ 说清楚,
                   否则用户会以为「一致」却又发现覆盖按钮还能点 -->
              <span v-else-if="changedCount === 0" class="fd-head__count">行内容相同，换行符或结尾不同</span>
              <span v-else class="fd-head__count">{{ changedCount }} 行有差异</span>
              <!-- ↑/↓ 在差异块之间跳;n/m 计数随滚动更新,给出「看第几处 / 共几处」的位置感 -->
              <span v-if="diff.hunks.length > 0" class="fd-jump">
                <button
                  type="button"
                  class="fd-jump__btn"
                  title="跳到下一处差异"
                  aria-label="跳到下一处差异"
                  @click="jumpHunk(1)"
                >
                  <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v8M2.5 6.5 6 10l3.5-3.5" /></svg>
                </button>
                <span class="fd-jump__pos mono">{{ hunkCursor + 1 }}/{{ diff.hunks.length }}</span>
                <button
                  type="button"
                  class="fd-jump__btn"
                  title="跳到上一处差异"
                  aria-label="跳到上一处差异"
                  @click="jumpHunk(-1)"
                >
                  <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" /></svg>
                </button>
              </span>
            </template>
            <template v-else>
              <span v-if="oneSided" class="fd-head__count">仅一侧有图片</span>
              <span v-else-if="imagesIdentical" class="fd-head__clean">两侧图片一致</span>
              <span v-else class="fd-head__count">两侧图片不同</span>
            </template>
            <!-- 两种视图都可用(今天只有 svg:既是图片又是文本)时才出现 -->
            <span v-if="canSwitchView" class="fd-view">
              <button
                type="button"
                class="fd-view__tab"
                :class="{ 'is-active': showImages }"
                :aria-pressed="showImages"
                @click="viewMode = 'preview'"
              >预览</button>
              <button
                type="button"
                class="fd-view__tab"
                :class="{ 'is-active': showText }"
                :aria-pressed="showText"
                @click="viewMode = 'text'"
              >逐行</button>
            </span>
          </span>
          <span class="fd-head__role">{{ props.right.label }}{{ props.right.note ? `（${props.right.note}）` : '' }}</span>
        </div>

        <!-- 图片视图:并排各看一张,没有逐块应用(图片没有「第几行」)。
             透明背景铺棋盘格,不然透明 PNG 两边全白,差异看不出来。 -->
        <div v-if="showImages" class="fd-images">
          <div class="fd-image">
            <div class="fd-image__stage">
              <img
                v-if="leftSrc"
                :src="leftSrc"
                :alt="props.left.label + '图片预览'"
                @load="onImgLoad('left', $event)"
              />
              <span v-else class="fd-image__nil">{{ reasonOf(left, roleOf(props.left)) }}</span>
            </div>
            <div class="fd-image__meta mono">{{ metaOf(left, 'left', leftSrc) }}</div>
          </div>
          <div class="fd-image">
            <div class="fd-image__stage">
              <img
                v-if="rightSrc"
                :src="rightSrc"
                :alt="props.right.label + '图片预览'"
                @load="onImgLoad('right', $event)"
              />
              <span v-else class="fd-image__nil">{{ reasonOf(right, roleOf(props.right)) }}</span>
            </div>
            <div class="fd-image__meta mono">{{ metaOf(right, 'right', rightSrc) }}</div>
          </div>
        </div>

        <!-- 文本视图:左右各一个滚动区,滚动位置由 onPaneScroll 双向同步(横向+纵向):
             超宽行不会被压到对面行号上,行号(sticky left)与差异块按钮
             (sticky right)始终钉在各自窗格边上。
             正文是虚拟滚动的窗口切片:上下垫片按「行数 × 行高」撑出未渲染行的总高,
             滚动条长度与滚动位置始终代表整个文件;行 key 用全量行号,切片平移时
             已渲染的行原地复用。 -->
        <div v-else class="fd-rows">
          <div
            ref="paneLeftEl"
            class="fd-pane fd-pane--left"
            @scroll.passive="onPaneScroll('left')"
            @mouseleave="hoverIndex = null"
          >
            <div class="fd-spacer" :style="{ height: `${spacerTop}px` }"></div>
            <div
              v-for="{ row, i } in winRows"
              :key="i"
              class="fd-row"
              :class="[rowClass(row.type), { 'is-hover': hoverIndex === i }]"
              @mouseenter="hoverIndex = i"
            >
              <span class="fd-no">{{ row.leftNo ?? '' }}</span>
              <!-- 语法高亮:内容是 hljs 的输出或 escapeHtml 过的纯文本(见 cell 的说明),
                   走 v-html 而不是插值。行号仍由 .fd-no 这一格负责。 -->
              <pre class="fd-text" v-html="cell(hl.left, row.leftNo, row.leftText)"></pre>
              <span class="fd-gutter">
                <!-- 逐块按钮由调用方配置方向与文案(hunkApply):对比页两个方向都给,
                     冲突收件箱只给「应用到原文件」(←),另一侧没有写回路径就不出按钮。 -->
                <template v-if="hunkAtStart.get(i)">
                  <button
                    v-if="hunkApply?.toLeft"
                    type="button"
                    class="fd-apply"
                    :title="hunkApply.toLeft"
                    @click="apply(hunkAtStart.get(i)!, 'left')"
                  >←</button>
                  <button
                    v-if="hunkApply?.toRight"
                    type="button"
                    class="fd-apply"
                    :title="hunkApply.toRight"
                    @click="apply(hunkAtStart.get(i)!, 'right')"
                  >→</button>
                </template>
              </span>
            </div>
            <div class="fd-spacer" :style="{ height: `${spacerBottom}px` }"></div>
          </div>

          <div
            ref="paneRightEl"
            class="fd-pane fd-pane--right"
            @scroll.passive="onPaneScroll('right')"
            @mouseleave="hoverIndex = null"
          >
            <div class="fd-spacer" :style="{ height: `${spacerTop}px` }"></div>
            <div
              v-for="{ row, i } in winRows"
              :key="i"
              class="fd-row"
              :class="[rowClass(row.type), { 'is-hover': hoverIndex === i }]"
              @mouseenter="hoverIndex = i"
            >
              <span class="fd-no">{{ row.rightNo ?? '' }}</span>
              <pre class="fd-text" v-html="cell(hl.right, row.rightNo, row.rightText)"></pre>
            </div>
            <div class="fd-spacer" :style="{ height: `${spacerBottom}px` }"></div>
          </div>
        </div>
      </div>

      <!-- 降级:既不能逐行比、也没有图片可预览时,提示原因;有动作按钮才补一句「仍可覆盖」 -->
      <div v-else class="fd-blocked">
        <p class="fd-blocked__msg">
          {{ blocked }}，{{ looksLikeImage ? '无法预览' : '无法逐行对比' }}。
        </p>
        <p v-if="footerActions?.length" class="fd-blocked__hint">仍可整文件覆盖（以一侧内容为准替换另一侧）。</p>
      </div>
    </template>

    <template v-if="showData" #footer>
      <template v-if="pendingAction">
        <span class="fd-confirm__msg">{{ pendingAction.confirm }}</span>
        <n-button type="error" @click="confirmAction">确认</n-button>
        <n-button tertiary @click="pendingAction = null">取消</n-button>
      </template>
      <template v-else>
        <!-- tooltip 直接挂在按钮上就够了 —— 实测 Chromium 对 disabled 按钮**照样**
             派发 mouseenter(mouseenter 不在被禁用的事件之列)。真正在禁用态静默失效的
             是**原生 title 属性**,旧写法 title="…" 在按钮不可点时就永远不显示了,
             这才是这里换成 tooltip 的原因。 -->
        <n-tooltip
          v-for="a in footerActions ?? []"
          :key="a.id"
          trigger="hover"
          :style="{ maxWidth: '320px' }"
        >
          <template #trigger>
            <n-button
              :tertiary="!a.tone || a.tone === 'default'"
              :type="a.tone === 'error' ? 'error' : a.tone === 'primary' ? 'primary' : 'default'"
              :disabled="a.disabled?.(actionCtx)"
              @click="requestAction(a)"
            >{{ a.label }}</n-button>
          </template>
          {{ a.hint?.(actionCtx) ?? a.label }}
        </n-tooltip>
      </template>
      <n-button type="primary" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>
</template>
