<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { NButton, NTooltip } from 'naive-ui';
import { applyHunk, countChanged, diffText, type DiffHunk } from '../utils/text-diff';
import { formatBytes } from '../utils/bytes';
import { fileIconKind } from '../utils/file-icon';
import type { FileCompareData, FileSideData } from '../types';

/**
 * 文件内容对比弹窗(IDEA 风格的并排差异)。
 *
 * 四个状态各自有明确的降级路径 —— 不做「假装能比」:
 *  - 两侧都是文本 → 逐行并排,每个差异块可单独 ← / → 应用;
 *  - 任一侧是图片(后端按后缀给了 image 字节)→ 并排看图,只提供整文件覆盖
 *    (图片没有「第几行」这回事,挑不出可单独应用的块);
 *  - 任一侧是二进制 / 超过体积上限 → 不回传内容,只提供整文件覆盖;
 *  - 任一侧缺失(文件只在一边存在)→ 只能从存在的那侧覆盖过去。
 */
const props = defineProps<{
  open: boolean;
  path: string;
  data: FileCompareData | null;
  loading: boolean;
  error: string;
  deviceId: string;
}>();

const emit = defineEmits<{
  close: [];
  /** direction:'pull' 写本机,'push' 写对端;content 省略 = 整文件照抄来源侧。 */
  sync: [direction: 'pull' | 'push', content?: string];
}>();

const left = computed<FileSideData>(() => props.data?.local ?? { exists: false });
const right = computed<FileSideData>(() => props.data?.remote ?? { exists: false });

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
  if (!side.exists) return `${role}没有这个文件${side.error ? `（${side.error}）` : ''}`;
  if (side.tooLarge) {
    return `${role}文件过大${side.size !== undefined ? `（${formatBytes(side.size)}）` : ''}`;
  }
  if (side.binary) return `${role}是二进制文件`;
  return `${role}内容不可用`;
}

const blocked = computed<string>(() => {
  if (canDiff.value) return '';
  if (!comparable(left.value)) return reasonOf(left.value, '本机');
  return reasonOf(right.value, '对端');
});

function rowClass(type: string): string {
  return `is-${type}`;
}

/**
 * 整文件覆盖是破坏性操作(直接拿一侧内容替换另一侧),要先二次确认。
 * 逐块同步(apply)是外科手术式的一小块,不算破坏性,不拦。
 */
const overwriteConfirm = ref<'pull' | 'push' | null>(null);
function requestOverwrite(dir: 'pull' | 'push'): void {
  overwriteConfirm.value = dir;
}
function confirmOverwrite(): void {
  const dir = overwriteConfirm.value;
  overwriteConfirm.value = null;
  if (dir) emit('sync', dir);
}

/**
 * 两个整文件覆盖按钮能否点:来源侧要有文件,且两侧不是已经一致 —— 内容相同时覆盖
 * 是纯粹的白跑一趟(还会白写一次对方的磁盘),不如直接禁用。
 */
const pullDisabled = computed<boolean>(() => !right.value.exists || contentIdentical.value);
const pushDisabled = computed<boolean>(() => !left.value.exists || contentIdentical.value);

/**
 * 覆盖按钮的悬停说明(禁用时也要能看):禁用态讲清「为什么不能点」,可用态讲清
 * 「这一下会做什么」。文案与 disabled 条件同源,不会出现「说不能点却能点」。
 */
function overwriteHint(dir: 'pull' | 'push'): string {
  const from = dir === 'pull' ? '对端' : '本机';
  const to = dir === 'pull' ? '本机' : '对端';
  if (contentIdentical.value) return `两侧内容已经一致，无需用${from}覆盖${to}`;
  if (dir === 'pull' ? !right.value.exists : !left.value.exists) {
    return `${from}没有这个文件，无法覆盖${to}`;
  }
  return `用${from}文件内容完全替换${to}文件`;
}
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
    overwriteConfirm.value = null;
    hoverIndex.value = null;
    viewMode.value = 'preview';
    void nextTick(() => {
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
 * 正在等待「整文件覆盖」二次确认时,Esc 先撤掉那一步(等价于点「取消」),不关窗:
 * 那一按键的语义是「打消这次危险操作」,若顺手把弹窗也收了,用户反而丢了上下文。
 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !props.open) return;
  if (overwriteConfirm.value) {
    overwriteConfirm.value = null;
    return;
  }
  emit('close');
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

/**
 * 把某个差异块应用到目标侧。
 * 目标是对端 → 写远端(push);目标是本机 → 写本地(pull)。
 */
function apply(hunk: DiffHunk, target: 'left' | 'right'): void {
  const newText = applyHunk(left.value.text ?? '', right.value.text ?? '', hunk, target);
  emit('sync', target === 'right' ? 'push' : 'pull', newText);
}
</script>

<template>
  <Transition name="guide">
    <div v-if="open" class="modal-overlay" @click.self="emit('close')">
      <div
        class="modal fd-modal"
        :class="{ 'fd-modal--tall': canDiff || canPreview }"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fd-title"
      >
        <n-button quaternary circle class="modal-close" aria-label="关闭" @click="emit('close')">×</n-button>
        <div class="modal-title-row">
          <h2 id="fd-title" class="modal-title">文件内容对比</h2>
          <span class="modal-title-path mono" :title="path">{{ path }}</span>
        </div>

        <div v-if="loading" class="fd-state">正在读取两侧内容…</div>

        <div v-else-if="error" class="diff-error" role="alert">
          <div class="diff-error__msg break">{{ error }}</div>
        </div>

        <template v-else-if="data">
          <div class="fd-legend mono">
            <span class="fd-legend__role">本机</span>
            <span class="fd-legend__id">{{ data.folderPath }}</span>
            <span class="fd-legend__sep">↔</span>
            <span class="fd-legend__role">对端</span>
            <span class="fd-legend__id">{{ deviceId }}</span>
          </div>

          <!-- 对比区。表头(本机 / 中间摘要 / 对端)两种视图共用一份 —— 中间那格换内容,
               免得两套表头各写一遍、宽窄对不齐。 -->
          <div v-if="showText || showImages" class="fd-body">
            <div class="fd-head">
              <span class="fd-head__role">本机</span>
              <span class="fd-head__mid">
                <template v-if="showText">
                  <span v-if="contentIdentical" class="fd-head__clean">两侧内容一致</span>
                  <!-- 逐行看不出差异、但内容确实不同(CRLF vs LF、结尾换行)→ 说清楚,
                       否则用户会以为「一致」却又发现覆盖按钮还能点 -->
                  <span v-else-if="changedCount === 0" class="fd-head__count">行内容相同，换行符或结尾不同</span>
                  <span v-else class="fd-head__count">{{ changedCount }} 行有差异</span>
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
              <span class="fd-head__role">对端（{{ deviceId }}）</span>
            </div>

            <!-- 图片视图:并排各看一张,没有逐块应用(图片没有「第几行」)。
                 透明背景铺棋盘格,不然透明 PNG 两边全白,差异看不出来。 -->
            <div v-if="showImages" class="fd-images">
              <div class="fd-image">
                <div class="fd-image__stage">
                  <img
                    v-if="leftSrc"
                    :src="leftSrc"
                    alt="本机图片预览"
                    @load="onImgLoad('left', $event)"
                  />
                  <span v-else class="fd-image__nil">{{ reasonOf(left, '本机') }}</span>
                </div>
                <div class="fd-image__meta mono">{{ metaOf(left, 'left', leftSrc) }}</div>
              </div>
              <div class="fd-image">
                <div class="fd-image__stage">
                  <img
                    v-if="rightSrc"
                    :src="rightSrc"
                    alt="对端图片预览"
                    @load="onImgLoad('right', $event)"
                  />
                  <span v-else class="fd-image__nil">{{ reasonOf(right, '对端') }}</span>
                </div>
                <div class="fd-image__meta mono">{{ metaOf(right, 'right', rightSrc) }}</div>
              </div>
            </div>

            <!-- 文本视图:左右各一个滚动区,滚动位置由 onPaneScroll 双向同步(横向+纵向):
                 超宽行不会被压到对面行号上,行号(sticky left)与差异块按钮
                 (sticky right)始终钉在各自窗格边上。 -->
            <div v-else class="fd-rows">
              <div
                ref="paneLeftEl"
                class="fd-pane fd-pane--left"
                @scroll.passive="onPaneScroll('left')"
                @mouseleave="hoverIndex = null"
              >
                <div
                  v-for="(row, i) in diff.rows"
                  :key="i"
                  class="fd-row"
                  :class="[rowClass(row.type), { 'is-hover': hoverIndex === i }]"
                  @mouseenter="hoverIndex = i"
                >
                  <span class="fd-no">{{ row.leftNo ?? '' }}</span>
                  <pre class="fd-text">{{ row.leftText ?? '' }}</pre>
                  <span class="fd-gutter">
                    <template v-if="hunkAtStart.get(i)">
                      <button
                        type="button"
                        class="fd-apply"
                        title="把右边的这块应用到本机（拉取覆盖）"
                        @click="apply(hunkAtStart.get(i)!, 'left')"
                      >←</button>
                      <button
                        type="button"
                        class="fd-apply"
                        title="把左边的这块应用到对端（推送覆盖）"
                        @click="apply(hunkAtStart.get(i)!, 'right')"
                      >→</button>
                    </template>
                  </span>
                </div>
              </div>

              <div
                ref="paneRightEl"
                class="fd-pane fd-pane--right"
                @scroll.passive="onPaneScroll('right')"
                @mouseleave="hoverIndex = null"
              >
                <div
                  v-for="(row, i) in diff.rows"
                  :key="i"
                  class="fd-row"
                  :class="[rowClass(row.type), { 'is-hover': hoverIndex === i }]"
                  @mouseenter="hoverIndex = i"
                >
                  <span class="fd-no">{{ row.rightNo ?? '' }}</span>
                  <pre class="fd-text">{{ row.rightText ?? '' }}</pre>
                </div>
              </div>
            </div>
          </div>

          <!-- 降级:既不能逐行比、也没有图片可预览时,至少要能整文件覆盖 -->
          <div v-else class="fd-blocked">
            <p class="fd-blocked__msg">
              {{ blocked }}，{{ looksLikeImage ? '无法预览' : '无法逐行对比' }}。
            </p>
            <p class="fd-blocked__hint">仍可整文件覆盖（以一侧内容为准替换另一侧）。</p>
          </div>

          <div class="modal-actions">
            <template v-if="overwriteConfirm">
              <span class="fd-confirm__msg">
                将用{{ overwriteConfirm === 'pull' ? '对端' : '本机' }}文件完全替换{{ overwriteConfirm === 'pull' ? '本机' : '对端' }}文件，此操作不可撤销。
              </span>
              <n-button size="small" type="error" @click="confirmOverwrite">确认覆盖</n-button>
              <n-button size="small" tertiary @click="overwriteConfirm = null">取消</n-button>
            </template>
            <template v-else>
              <!-- tooltip 直接挂在按钮上就够了 —— 实测 Chromium 对 disabled 按钮**照样**
                   派发 mouseenter(mouseenter 不在被禁用的事件之列)。真正在禁用态静默失效的
                   是**原生 title 属性**,旧写法 title="…" 在按钮不可点时就永远不显示了,
                   这才是这里换成 tooltip 的原因。 -->
              <n-tooltip trigger="hover" :style="{ maxWidth: '320px' }">
                <template #trigger>
                  <n-button
                    size="small"
                    tertiary
                    :disabled="pullDisabled"
                    @click="requestOverwrite('pull')"
                  >← 用对端覆盖本机</n-button>
                </template>
                {{ overwriteHint('pull') }}
              </n-tooltip>
              <n-tooltip trigger="hover" :style="{ maxWidth: '320px' }">
                <template #trigger>
                  <n-button
                    size="small"
                    tertiary
                    :disabled="pushDisabled"
                    @click="requestOverwrite('push')"
                  >用本机覆盖对端 →</n-button>
                </template>
                {{ overwriteHint('push') }}
              </n-tooltip>
            </template>
            <n-button type="primary" @click="emit('close')">关闭</n-button>
          </div>
        </template>
      </div>
    </div>
  </Transition>
</template>
