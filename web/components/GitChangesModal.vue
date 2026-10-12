<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NEmpty, NSpin } from 'naive-ui';
import { apiJson, errText } from '../utils/api';
import type { DiffPaneData, GitChangeEntry, GitChangesData, GitDiffData } from '../types';
import FileDiffModal from './FileDiffModal.vue';
import ModalShell from './ModalShell.vue';

/**
 * 「Git 改动」弹窗:工作区未提交变更的树形清单(目录卡徽标点开)。
 *
 * 数据现查 git status(徽标计数有一轮扫描的滞后,打开时必须给准的),按目录
 * 分组成树;双击文件打开通用差异弹窗看「HEAD 提交 → 工作区当前」的对比,
 * 复用 /api/folders/file 那套降级口径(缺失/二进制/过大/图片都如实处理)。
 */
const props = defineProps<{
  /** 非空 = 打开该目录的改动清单。 */
  folder: { id?: string; path: string } | null;
}>();
const emit = defineEmits<{ close: [] }>();

const entries = ref<GitChangeEntry[]>([]);
const truncated = ref(false);
const notARepo = ref(false);
const loading = ref(false);
const errorText = ref('');

/** 树节点:目录或文件叶子(文件叶子带变更条目;目录按名字聚合)。 */
interface TreeNode {
  name: string;
  dir: boolean;
  children: Map<string, TreeNode>;
  entry?: GitChangeEntry;
}

/** 扁平化后的可见行(expanded 折叠控制)。 */
interface TreeRow {
  node: TreeNode;
  depth: number;
  key: string;
}

const collapsed = ref<Set<string>>(new Set());

const root = computed<TreeNode>(() => {
  const root: TreeNode = { name: '', dir: true, children: new Map() };
  for (const e of entries.value) {
    const parts = e.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      let next = cur.children.get(seg);
      if (!next) {
        next = { name: seg, dir: true, children: new Map() };
        cur.children.set(seg, next);
      }
      cur = next;
    }
    const name = parts[parts.length - 1]!;
    cur.children.set(name, { name, dir: false, children: new Map(), entry: e });
  }
  return root;
});

/** 目录排前、文件排后,各自按名字排:先目录后文件与文件管理器一致。 */
function sortChildren(children: Map<string, TreeNode>): TreeNode[] {
  return [...children.values()].sort((a, b) =>
    a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
  );
}

/** 可见行:折叠的目录整棵跳过。递归展开,root 的孩子从深度 0 起。 */
const rows = computed<TreeRow[]>(() => {
  const out: TreeRow[] = [];
  const walk = (node: TreeNode, depth: number, prefix: string): void => {
    for (const child of sortChildren(node.children)) {
      const key = prefix ? `${prefix}/${child.name}` : child.name;
      out.push({ node: child, depth, key });
      if (child.dir && !collapsed.value.has(key)) walk(child, depth + 1, key);
    }
  };
  walk(root.value, 0, '');
  return out;
});

/** 分类统计:图例 + 顶部速览。 */
const counts = computed(() => {
  const c = { modified: 0, added: 0, deleted: 0, renamed: 0 };
  for (const e of entries.value) c[e.status]++;
  return c;
});

const statusMeta: Record<GitChangeEntry['status'], { label: string; cls: string }> = {
  modified: { label: '改', cls: 'is-modified' },
  added: { label: '增', cls: 'is-added' },
  deleted: { label: '删', cls: 'is-deleted' },
  renamed: { label: '移', cls: 'is-renamed' },
};

/** 文件行的 tooltip:重命名给出 旧 → 新,普通文件给路径;尾注「已进暂存区」。 */
function fileTitle(e: GitChangeEntry): string {
  const path = e.origPath ? `${e.origPath} → ${e.path}` : e.path;
  return `${path} · 双击查看与 HEAD 提交的对比${e.staged ? '(已进暂存区)' : ''}`;
}

function toggleDir(key: string): void {
  const next = new Set(collapsed.value);
  if (!next.delete(key)) next.add(key);
  collapsed.value = next;
}

/** 该目录行此刻是否处于折叠态(模板表达式里少写一层取反)。 */
function isCollapsed(key: string): boolean {
  return collapsed.value.has(key);
}

watch(
  () => props.folder,
  (f) => {
    entries.value = [];
    truncated.value = false;
    notARepo.value = false;
    collapsed.value = new Set();
    if (f) void load(f.id ?? f.path);
  },
);

async function load(id: string): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    const data = await apiJson<GitChangesData>(
      `/api/folders/git-changes?folderId=${encodeURIComponent(id)}`,
    );
    if (data.gitRepo === false) {
      notARepo.value = true;
    } else {
      entries.value = data.entries ?? [];
      truncated.value = data.truncated === true;
    }
  } catch (e) {
    errorText.value = errText(e, '读取改动清单失败');
  } finally {
    loading.value = false;
  }
}

function refresh(): void {
  const f = props.folder;
  if (f) void load(f.id ?? f.path);
}

/* ---------------- 单文件对比(双击文件) ---------------- */

const diffPath = ref<string | null>(null);
const diffData = ref<GitDiffData | null>(null);
const diffLoading = ref(false);
const diffError = ref('');

async function openDiff(entry: GitChangeEntry): Promise<void> {
  const f = props.folder;
  if (!f) return;
  diffPath.value = entry.path;
  diffData.value = null;
  diffError.value = '';
  diffLoading.value = true;
  try {
    diffData.value = await apiJson<GitDiffData>(
      `/api/folders/git-diff?folderId=${encodeURIComponent(f.id ?? f.path)}&path=${encodeURIComponent(entry.path)}`,
    );
  } catch (e) {
    diffError.value = errText(e, '读取变更对比失败');
  } finally {
    diffLoading.value = false;
  }
}

/** 左右两栏的配置:HEAD 版 vs 盘上当前,复用通用差异弹窗(纯展示引擎)。 */
const diffPanes = computed<{ left: DiffPaneData; right: DiffPaneData } | null>(() => {
  const d = diffData.value;
  if (!d) return null;
  return {
    left: { label: 'HEAD 提交', role: 'HEAD', side: d.head },
    right: { label: '工作区当前', role: '工作区', side: d.worktree },
  };
});
</script>

<template>
  <ModalShell
    :open="!!folder"
    :title="`Git 改动（${folder?.path ?? ''}）`"
    :description="notARepo ? '' : '工作区未提交的变更：双击文件可查看与 HEAD 提交的对比'"
    descriptionMono
    wide
    @close="emit('close')"
  >
    <div class="git-changes">
      <n-spin :show="loading">
        <div v-if="errorText" class="git-changes__error">{{ errorText }}</div>
        <n-empty
          v-else-if="notARepo"
          description="此目录不是 git 仓库（或刚变成非仓库），没有可展示的改动"
        />
        <n-empty v-else-if="!loading && entries.length === 0" description="工作区干净，没有未提交的改动" />
        <template v-else-if="entries.length > 0">
          <div class="git-changes__legend">
            <span class="git-changes__legend-item is-modified">改 {{ counts.modified }}</span>
            <span class="git-changes__legend-item is-added">增 {{ counts.added }}</span>
            <span class="git-changes__legend-item is-deleted">删 {{ counts.deleted }}</span>
            <span v-if="counts.renamed" class="git-changes__legend-item is-renamed">移 {{ counts.renamed }}</span>
            <span class="git-changes__legend-note">
              共 {{ entries.length }} 条{{ truncated ? '（超出上限已截断）' : '' }} · 未提交的改动不会随 Git 提交同步广播
            </span>
            <n-button size="tiny" quaternary class="git-changes__refresh" @click="refresh">刷新</n-button>
          </div>
          <ul class="git-changes__tree">
            <li v-for="row in rows" :key="row.key" class="git-changes__row" :style="{ paddingLeft: `${row.depth * 14}px` }">
              <template v-if="row.node.dir">
                <button type="button" class="git-changes__dir" @click="toggleDir(row.key)">
                  <span class="git-changes__chev" :class="{ 'is-open': !isCollapsed(row.key) }" aria-hidden="true">
                    <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5 8 6l-3.5 3.5" /></svg>
                  </span>
                  {{ row.node.name }}/
                </button>
              </template>
              <template v-else>
                <span
                  class="git-changes__file"
                  :title="fileTitle(row.node.entry!)"
                  tabindex="0"
                  @dblclick="openDiff(row.node.entry!)"
                  @keydown.enter="openDiff(row.node.entry!)"
                >
                  <span class="git-changes__status" :class="statusMeta[row.node.entry!.status].cls">{{ statusMeta[row.node.entry!.status].label }}</span>
                  <span class="git-changes__name">{{ row.node.name }}</span>
                  <span v-if="row.node.entry!.origPath" class="git-changes__orig">← {{ row.node.entry!.origPath }}</span>
                  <span v-if="row.node.entry!.staged" class="git-changes__staged">已暂存</span>
                </span>
              </template>
            </li>
          </ul>
        </template>
      </n-spin>
    </div>
  </ModalShell>

  <!-- 双击文件打开的变更对比:HEAD 提交 vs 工作区当前,复用通用差异弹窗 -->
  <FileDiffModal
    :open="diffPath !== null"
    :path="diffPath ?? ''"
    title="变更对比"
    :left="diffPanes?.left ?? { label: 'HEAD 提交', side: { exists: false } }"
    :right="diffPanes?.right ?? { label: '工作区当前', side: { exists: false } }"
    :loading="diffLoading"
    :error="diffError"
    @close="diffPath = null"
  />
</template>

<style scoped>
/* 本组件自有的清单/树样式;骨架与徽标族在 style.css */
.git-changes {
  min-height: 120px;
  max-height: 60vh;
  overflow-y: auto;
}

.git-changes__error {
  color: #d03050;
  font-size: 12.5px;
  padding: 8px 2px;
}

.git-changes__legend {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 2px 2px 8px;
  font-size: 11.5px;
}

.git-changes__legend-item {
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid transparent;
}

.git-changes__legend-note {
  color: var(--muted);
}

.git-changes__refresh {
  margin-left: auto;
}

.git-changes__tree {
  list-style: none;
  margin: 0;
  padding: 0 2px 8px;
}

.git-changes__row {
  padding-block: 1px;
}

.git-changes__dir {
  /* 与 .conflict-float 同理:button 清掉浏览器默认外观,对齐行内排版 */
  appearance: none;
  background: none;
  border: none;
  font: inherit;
  color: var(--text);
  font-weight: 600;
  font-size: 12.5px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 6px;
}

.git-changes__dir:hover {
  background: var(--card-hi);
}

.git-changes__chev {
  display: inline-block;
  transition: transform 0.15s ease;
  color: var(--muted);
}

.git-changes__chev.is-open {
  transform: rotate(90deg);
}

.git-changes__file {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 6px;
  cursor: default; /* 双击才是对比,单击不承诺任何动作 */
  font-size: 12.5px;
}

.git-changes__file:hover,
.git-changes__file:focus-visible {
  background: var(--card-hi);
  outline: none;
}

.git-changes__status {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 4px;
  color: #fff;
}

/* 四类状态各一色:改=蓝 增=绿 删=红 移=紫,与图例共用类名 */
.git-changes__status.is-modified,
.git-changes__legend-item.is-modified {
  background: rgb(47 111 208 / 0.9);
  border-color: rgb(47 111 208 / 0.9);
}

.git-changes__status.is-added,
.git-changes__legend-item.is-added {
  background: rgb(46 164 79 / 0.9);
  border-color: rgb(46 164 79 / 0.9);
}

.git-changes__status.is-deleted,
.git-changes__legend-item.is-deleted {
  background: rgb(208 48 80 / 0.9);
  border-color: rgb(208 48 80 / 0.9);
}

.git-changes__status.is-renamed,
.git-changes__legend-item.is-renamed {
  background: rgb(134 82 200 / 0.9);
  border-color: rgb(134 82 200 / 0.9);
}

/* 图例的胶囊要文字色而非实底(它是汇总,不是逐条状态) */
.git-changes__legend-item.is-modified,
.git-changes__legend-item.is-added,
.git-changes__legend-item.is-deleted,
.git-changes__legend-item.is-renamed {
  background: none;
  color: var(--text);
}

.git-changes__name {
  word-break: break-all;
}

.git-changes__orig {
  color: var(--muted);
  font-size: 11.5px;
}

.git-changes__staged {
  color: var(--muted);
  font-size: 10.5px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 6px;
}
</style>
