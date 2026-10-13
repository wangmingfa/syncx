<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NCheckbox, NEmpty, NSpin } from 'naive-ui';
import { apiJson, apiPost, errText } from '../utils/api';
import { useToast } from '../composables/useToast';
import { useStatusContext } from '../composables/statusContext';
import type { EmptyDirsData, EmptyDirsDeleteData } from '../types';
import ModalShell from './ModalShell.vue';

/**
 * 「空文件夹」弹窗:盘点共享目录里不含任何文件的文件夹(忽略规则决定范围),
 * 树形展示、勾选后确认删除(目录卡动作条「空文件夹」打开)。
 *
 * 交互要点:
 * - 默认全选 —— 空壳目录基本没有保留价值,全选 + 取消少量是更省事的路径。
 * - 级联:勾选父级 = 连带全部后代(删父必删子,物理上挡不住);取消子级 =
 *   连带全部祖先(保子就不能删父)。父级半选态用 indeterminate 显示。
 * - 删除只是本机 rmdir(目录不是同步实体,不广播、不触发扫描,见后端
 *   src/empty-dirs.ts);确认框里写明「只 rmdir、绝不删文件」,消解「删了会不会
 *   连带文件/对端」的顾虑。
 * 树是从扁平的 dirs 数组现推的,不需要后端传嵌套结构。注意祖先**不一定**也在清单里:
 * 后端只列「整棵子树无文件」的目录(src/empty-dirs.ts),examples/ 里别处有文件时,
 * examples/counter-native-macos 为空却带不出 examples —— 缺失的祖先由前端补成
 * 不可勾选的「上下文行」,层级才可见(否则只剩一条无从定位的缩进叶子行)。
 */
const props = defineProps<{
  /** 非空 = 打开该目录的空文件夹盘点。 */
  folder: { id?: string; path: string } | null;
}>();
const emit = defineEmits<{ close: [] }>();
const { askConfirm } = useStatusContext();
const { showToast } = useToast();

const dirs = ref<string[]>([]);
const truncated = ref(false);
const loading = ref(false);
const errorText = ref('');
const busy = ref(false);
/** 勾选的目录(相对路径)。默认全选,每次重新加载后重置为全选。 */
const selected = ref<Set<string>>(new Set());
/** 折叠的目录(相对路径);默认全展开 —— 空目录树通常不大,收起的收益低于看清全貌。 */
const collapsed = ref<Set<string>>(new Set());

watch(
  () => props.folder,
  (f) => {
    dirs.value = [];
    truncated.value = false;
    errorText.value = '';
    selected.value = new Set();
    collapsed.value = new Set();
    if (f) void load(f.id ?? f.path);
  },
);

async function load(id: string): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    const data = await apiJson<EmptyDirsData>(`/api/folders/empty-dirs?folderId=${encodeURIComponent(id)}`);
    dirs.value = data.dirs ?? [];
    truncated.value = data.truncated === true;
    selected.value = new Set(dirs.value);
  } catch (e) {
    errorText.value = errText(e, '盘点空文件夹失败');
  } finally {
    loading.value = false;
  }
}

function refresh(): void {
  const f = props.folder;
  if (f) void load(f.id ?? f.path);
}

interface DirRow {
  path: string;
  name: string;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  /** 在空目录清单里(可勾选)。false = 层级锚点:目录自身不空,只为把空目录挂回树上。 */
  isEmpty: boolean;
}

/**
 * 路径逐段比较,保证先序(父在前、整棵子树连续)。不能直接用整串字符序:后端 dirs.sort()
 * 就是整串序,而 '/' 的码位(0x2F)大于 '-' 等字符,'examples-old' 会排到 'examples/…'
 * 之前,照单渲染会让同一父的子行被兄弟目录隔开。
 */
function cmpTreePath(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const x = as[i] ?? '';
    const y = bs[i] ?? '';
    if (x !== y) return x < y ? -1 : 1;
  }
  return as.length - bs.length;
}

/**
 * 扁平清单 → 可见行。节点集 = 清单里的空目录 + 它们缺失的祖先(纯层级锚点,见文件头)。
 * 被折叠祖先遮住的整枝不渲染(与 GitChangesModal 的折叠同思路)。
 */
const rows = computed<DirRow[]>(() => {
  const empty = new Set(dirs.value);
  const nodes = new Set<string>();
  /** 有子节点的节点(锚点也算),决定 chevron。 */
  const withChildren = new Set<string>();
  for (const p of dirs.value) {
    nodes.add(p);
    let slash = p.lastIndexOf('/');
    while (slash > 0) {
      const parent = p.slice(0, slash);
      nodes.add(parent);
      withChildren.add(parent);
      slash = parent.lastIndexOf('/');
    }
  }
  const out: DirRow[] = [];
  for (const p of [...nodes].sort(cmpTreePath)) {
    // 祖先链上任何一层被折叠 → 整行跳过
    let hidden = false;
    let slash = p.lastIndexOf('/');
    while (slash > 0) {
      if (collapsed.value.has(p.slice(0, slash))) {
        hidden = true;
        break;
      }
      slash = p.slice(0, slash).lastIndexOf('/');
    }
    if (hidden) continue;
    const idx = p.lastIndexOf('/');
    out.push({
      path: p,
      name: idx >= 0 ? p.slice(idx + 1) : p,
      depth: idx >= 0 ? p.split('/').length - 1 : 0,
      hasChildren: withChildren.has(p),
      isCollapsed: collapsed.value.has(p),
      isEmpty: empty.has(p),
    });
  }
  return out;
});

/** 半选集合:是某个勾选项的祖先、且自身未被直接勾选。 */
const partial = computed<Set<string>>(() => {
  const all = new Set(dirs.value);
  const out = new Set<string>();
  for (const p of selected.value) {
    let slash = p.lastIndexOf('/');
    while (slash > 0) {
      const parent = p.slice(0, slash);
      if (all.has(parent) && !selected.value.has(parent)) out.add(parent);
      slash = parent.lastIndexOf('/');
    }
  }
  return out;
});

/** 勾选:自身 + 全部后代(删除父级必然带走后代,勾选语义必须对齐)。 */
function select(p: string): void {
  const next = new Set(selected.value);
  next.add(p);
  const prefix = p + '/';
  for (const d of dirs.value) if (d.startsWith(prefix)) next.add(d);
  selected.value = next;
}

/** 取消:自身 + 全部后代 + 全部祖先(要在删父的同时保子,物理上做不到)。 */
function deselect(p: string): void {
  const next = new Set(selected.value);
  next.delete(p);
  const prefix = p + '/';
  for (const d of dirs.value) if (d.startsWith(prefix)) next.delete(d);
  let slash = p.lastIndexOf('/');
  while (slash > 0) {
    next.delete(p.slice(0, slash));
    slash = p.slice(0, slash).lastIndexOf('/');
  }
  selected.value = next;
}

function toggleSelect(p: string): void {
  if (selected.value.has(p)) deselect(p);
  else select(p);
}

function toggleCollapse(p: string): void {
  const next = new Set(collapsed.value);
  if (!next.delete(p)) next.add(p);
  collapsed.value = next;
}

function selectAll(): void {
  selected.value = new Set(dirs.value);
}

function selectNone(): void {
  selected.value = new Set();
}

/** 确认框明细:列出前 12 条,超出折叠计数。 */
function detailText(paths: string[]): string {
  const head = paths.slice(0, 12);
  const more = paths.length - head.length;
  return more > 0 ? `${head.join('\n')}\n…等共 ${paths.length} 个` : head.join('\n');
}

function askDelete(): void {
  const paths = dirs.value.filter((d) => selected.value.has(d));
  if (paths.length === 0 || busy.value) return;
  askConfirm({
    title: `删除 ${paths.length} 个空文件夹`,
    message: '仅删除本机磁盘上的空文件夹:只做 rmdir,绝不会删除任何文件;删除前会逐个重新核验,期间有新内容出现则跳过。',
    detail: detailText(paths),
    confirmText: '删除',
    note: '目录不参与同步:此操作不广播、不影响对端,对端各自的空目录需在对端处理。',
    action: () => doDelete(paths),
  });
}

async function doDelete(paths: string[]): Promise<void> {
  const f = props.folder;
  if (!f) return;
  busy.value = true;
  try {
    const data = await apiPost<EmptyDirsDeleteData>('/api/folders/empty-dirs/delete', {
      folderId: f.id ?? f.path,
      paths,
    });
    const results = data.results ?? [];
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      showToast(`已删除 ${ok} 个空文件夹`);
    } else if (ok === 0) {
      showToast(`未删除任何文件夹:${failed[0]?.reason ?? '原因未知'}`, 'alert');
    } else {
      showToast(`已删除 ${ok} 个;${failed.length} 个未删除:${failed[0]?.reason ?? '原因未知'}`, 'alert');
    }
  } catch (e) {
    showToast(errText(e, '删除失败'), 'alert');
  } finally {
    busy.value = false;
    // 无论成败都重新盘点:竞态下部分成功时,列表要反映盘上真实状态
    void load(f.id ?? f.path);
  }
}

const description = computed(() =>
  truncated.value
    ? '不含任何文件的文件夹;被忽略的目录不在其列(已超出盘点上限,仅显示一部分)'
    : '不含任何文件的文件夹;被忽略的目录不在其列',
);
</script>

<template>
  <ModalShell
    :open="!!folder"
    :title="`空文件夹（${folder?.path ?? ''}）`"
    :description="description"
    descriptionMono
    class="empty-dirs-modal"
    @close="emit('close')"
  >
    <div class="empty-dirs">
      <n-spin :show="loading">
        <div v-if="errorText" class="empty-dirs__error">{{ errorText }}</div>
        <template v-else>
          <!-- 首屏盘点还没回来且没有任何数据时不渲染工具条:全选/计数都无对象,一排死
               按钮还会把转圈的居中基准往上拽(见样式里 .n-spin-container 的说明)。
               刷新带旧数据、或盘点完成(含空结果)后,工具条照常出现。 -->
          <div v-if="dirs.length > 0 || !loading" class="empty-dirs__bar">
            <n-button size="tiny" quaternary :disabled="dirs.length === 0" @click="selectAll">全选</n-button>
            <n-button size="tiny" quaternary :disabled="selected.size === 0" @click="selectNone">全不选</n-button>
            <span class="empty-dirs__count">
              <template v-if="dirs.length > 0">共 {{ dirs.length }} 个 · 已选 {{ selected.size }}{{ truncated ? '（已截断）' : '' }}</template>
            </span>
            <n-button size="tiny" quaternary class="empty-dirs__refresh" @click="refresh">刷新</n-button>
          </div>
          <n-empty v-if="!loading && dirs.length === 0" description="没有发现空文件夹;点「刷新」可重新盘点" />
          <ul v-else-if="dirs.length > 0" class="empty-dirs__list">
            <li
              v-for="r in rows"
              :key="r.path"
              class="empty-dirs__item"
              :class="{ 'is-context': !r.isEmpty }"
              :style="{ paddingLeft: 8 + r.depth * 18 + 'px' }"
            >
              <button
                v-if="r.hasChildren"
                type="button"
                class="empty-dirs__chev"
                :class="{ 'is-collapsed': r.isCollapsed }"
                :title="r.isCollapsed ? '展开' : '收起'"
                :aria-expanded="!r.isCollapsed"
                @click="toggleCollapse(r.path)"
              >
                <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
              </button>
              <span v-else class="empty-dirs__chev empty-dirs__chev--leaf" aria-hidden="true"></span>
              <n-checkbox
                v-if="r.isEmpty"
                :checked="selected.has(r.path)"
                :indeterminate="partial.has(r.path)"
                @update:checked="toggleSelect(r.path)"
              />
              <span
                class="empty-dirs__name"
                :title="r.isEmpty ? r.path : `${r.path}（该目录不空，仅随空目录展示层级）`"
              >{{ r.name }}</span>
            </li>
          </ul>
        </template>
      </n-spin>
    </div>
    <template #footer>
      <n-button size="small" @click="emit('close')">关闭</n-button>
      <n-button
        size="small"
        type="error"
        :disabled="selected.size === 0 || busy"
        :loading="busy"
        @click="askDelete"
      >
        删除选中的 {{ selected.size }} 个
      </n-button>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 本组件自有的树形列表样式;骨架与按钮族在 style.css */

/* naive 的转圈绝对定位在 .n-spin-container 的中线(top:50%),而容器高度=内容高度。
   盘点期间内容为空(工具条也不渲染,见模板),要给容器垫上 120 的最小高度,转圈才
   落在首屏空白区的中心;容器是这里的唯一子节点,它的高度同时就是 .empty-dirs 的
   高度。:deep 进 naive 容器与 TerminalPage 对 xterm 的处理同理。 */
.empty-dirs :deep(.n-spin-container) {
  min-height: 120px;
}

.empty-dirs__error {
  color: #d03050;
  font-size: 12.5px;
  padding: 8px 2px;
}

.empty-dirs__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 2px 8px;
  /* 滚动只发生在外壳的 .modal-body(本弹窗不再自带滚动容器,见 ModalShell 头注释):
     工具栏钉在滚动视口顶端、不参与滚动;背景默认档取实色 --card,把穿过底下的列表
     条目盖住(玻璃档 --card 只有 0.4 白,由 style.css 皮肤段换刷成弹窗同款的
     --glass-raised)。 */
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--card);
}

.empty-dirs__count {
  color: var(--muted);
  font-size: 11.5px;
  margin-left: 4px;
}

.empty-dirs__refresh {
  margin-left: auto;
}

.empty-dirs__list {
  list-style: none;
  margin: 0;
  padding: 0 2px 8px;
}

.empty-dirs__item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 6px;
}

.empty-dirs__item:hover {
  background: var(--card-hi);
}

/* 上下文行(目录自身不空,只为把空目录挂回树上):灰字、无勾选框 —— 名字紧跟折叠
   箭头,不预留勾选框列。预留(16px 占位 + 两侧 6px 间隙)会让箭头和名字之间空 28px,
   在真机上很难看;代价是上下文行名字与同深度可选行的**名字**不再同列(与它们的
   勾选框同列),层级靠缩进与灰字表达。 */
.empty-dirs__item.is-context .empty-dirs__name {
  color: var(--muted);
}

.empty-dirs__chev {
  flex: none;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  transition: transform 0.15s ease;
}

.empty-dirs__chev.is-collapsed {
  transform: rotate(-90deg);
}

.empty-dirs__chev--leaf {
  cursor: default;
}

.empty-dirs__name {
  min-width: 0;
  font-size: 13px;
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-dirs__name::after {
  content: '/';
  color: var(--muted);
  margin-left: 1px;
}
</style>
