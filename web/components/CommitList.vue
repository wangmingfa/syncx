<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { apiJson, errText } from '../utils/api';
import type { GitCommitDiffData, GitCommitEntry, GitCommitFileEntry, GitCommitFilesData } from '../types';
import FileDiffModal from './FileDiffModal.vue';

/**
 * 提交清单(公共组件)——「Git 提交历史」与「Git 推送」两个弹窗共用的提交列表。
 *
 * 「列表怎么来」由调用方负责(git log / git unpushed 数据源不同),本组件只认
 * 「一组提交 + 它们属于哪个目录」,负责逐行的:展开(正文 + 该笔提交动了哪些文件)、
 * 文件清单懒加载(按哈希缓存,失败不缓存可重试)与双击文件的「上一版(父提交) →
 * 该提交」对比弹窗。两处交互口径从此只有一份。
 *
 * 后端:GET /api/folders/git-commit-files(清单)、GET /api/folders/git-commit-diff
 * (对比,左=首父、右=该提交;根提交没有父,左栏如实「不存在」)。
 */
const props = defineProps<{
  /** 提交所属目录(展开清单 / 对比请求的 folderId);null = 宿主弹窗关闭中,行不会渲染。 */
  folder: { id?: string; path: string } | null;
  /** 提交列表(新→旧),调用方加载好传入。 */
  commits: GitCommitEntry[];
}>();

/** 展开着的提交(哈希集合);用替换 Set 触发响应式,与 GitChangesModal 的折叠同款。 */
const expanded = ref<Set<string>>(new Set());

interface FilesState {
  loading: boolean;
  error: string;
  files: GitCommitFileEntry[] | null;
}

/** 每笔提交的文件清单状态(按哈希):加载中 / 失败(可重试)/ 已缓存。 */
const filesBy = ref<Record<string, FilesState>>({});

// 宿主弹窗换目录或重查时整块重置:展开状态与清单缓存属于「那次打开」的上下文。
watch(
  () => [props.folder, props.commits] as const,
  () => {
    expanded.value = new Set();
    filesBy.value = {};
  },
);

function isExpanded(hash: string): boolean {
  return expanded.value.has(hash);
}

function toggle(c: GitCommitEntry): void {
  const next = new Set(expanded.value);
  if (!next.delete(c.hash)) {
    next.add(c.hash);
    void ensureFiles(c.hash);
  }
  expanded.value = next;
}

async function ensureFiles(hash: string): Promise<void> {
  const f = props.folder;
  if (!f) return;
  // 已有清单的不再重查(缓存);失败(files=null)的允许重试。
  const cur = filesBy.value[hash];
  if (cur && cur.files !== null) return;
  filesBy.value = { ...filesBy.value, [hash]: { loading: true, error: '', files: null } };
  try {
    const data = await apiJson<GitCommitFilesData>(
      `/api/folders/git-commit-files?folderId=${encodeURIComponent(f.id ?? f.path)}&hash=${encodeURIComponent(hash)}`,
    );
    // 展开状态可能已被人又点了一下收起,但清单照常入缓存:下次展开即得。
    filesBy.value = { ...filesBy.value, [hash]: { loading: false, error: '', files: data.files ?? [] } };
  } catch (e) {
    // 失败不缓存清单:files 保持 null,下次点开重试;错误文案留给本次展示。
    filesBy.value = {
      ...filesBy.value,
      [hash]: { loading: false, error: errText(e, '读取提交文件清单失败'), files: null },
    };
  }
}

/** 模板用的取值器:未加载 / 失败 / 空清单都归一成可判定的三态。 */
function filesOf(hash: string): { loading: boolean; error: string; files: GitCommitFileEntry[] } {
  const st = filesBy.value[hash];
  return { loading: st?.loading ?? false, error: st?.error ?? '', files: st?.files ?? [] };
}

/* ---------------- 状态胶囊 ---------------- */

/** git name-status 首字母 → 胶囊;相似度后缀(R100/C75)不影响语义。 */
const STATUS_META: Record<string, { label: string; cls: string }> = {
  M: { label: '改', cls: 'is-modified' },
  A: { label: '增', cls: 'is-added' },
  D: { label: '删', cls: 'is-deleted' },
  R: { label: '移', cls: 'is-renamed' },
  C: { label: '复', cls: 'is-copied' },
  T: { label: '型', cls: 'is-typed' },
};

function statusOf(status: string): { label: string; cls: string } {
  return STATUS_META[status[0] ?? ''] ?? { label: status[0] ?? '?', cls: 'is-unknown' };
}

/** 文件行 tooltip:改名给出 旧 → 新;尾注操作提示。 */
function fileTitle(e: GitCommitFileEntry): string {
  const p = e.origPath ? `${e.origPath} → ${e.path}` : e.path;
  return `${p} · 双击查看与上一版（父提交）的对比`;
}

/* ---------------- 单文件对比(双击文件) ---------------- */

const diffPath = ref<string | null>(null);
const diffData = ref<GitCommitDiffData | null>(null);
const diffLoading = ref(false);
const diffError = ref('');

async function openDiff(c: GitCommitEntry, e: GitCommitFileEntry): Promise<void> {
  const f = props.folder;
  if (!f) return;
  diffPath.value = e.path;
  diffData.value = null;
  diffError.value = '';
  diffLoading.value = true;
  try {
    const q = new URLSearchParams({ folderId: f.id ?? f.path, hash: c.hash, path: e.path });
    // 改名文件:父提交里是旧路径,不带 origPath 左栏会谎报「上一版没有这个文件」。
    if (e.origPath) q.set('origPath', e.origPath);
    diffData.value = await apiJson<GitCommitDiffData>(`/api/folders/git-commit-diff?${q.toString()}`);
  } catch (err) {
    diffError.value = errText(err, '读取提交对比失败');
  } finally {
    diffLoading.value = false;
  }
}

/** 左右两栏配置:父提交版 vs 该提交版,复用通用差异弹窗(纯展示引擎)。 */
const diffPanes = computed<{ left: { label: string; role: string; side: GitCommitDiffData['parent'] }; right: { label: string; role: string; side: GitCommitDiffData['commit'] } } | null>(() => {
  const d = diffData.value;
  if (!d) return null;
  return {
    left: { label: '上一版（父提交）', role: '父提交', side: d.parent },
    right: { label: '该提交', role: '该提交', side: d.commit },
  };
});

/* ---------------- 行展示 ---------------- */

/** %D 原样串按 `, ` 拆成引用胶囊(HEAD -> main、tag: v1.0、origin/main …)。 */
function refChips(refs: string): string[] {
  return refs ? refs.split(', ').filter((s) => s !== '') : [];
}

/** ISO 8601 → 本地时区可读;解析失败(不该发生)原样显示。 */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
</script>

<template>
  <ul class="commit-list">
    <li
      v-for="c in commits"
      :key="c.hash"
      class="commit-list__item is-expandable"
      :tabindex="0"
      @click="toggle(c)"
      @keydown.enter="toggle(c)"
    >
      <div class="commit-list__row">
        <span class="commit-list__hash">{{ c.hash }}</span>
        <span class="commit-list__subject" :title="c.subject">{{ c.subject }}</span>
        <span class="commit-list__chev" :class="{ 'is-open': isExpanded(c.hash) }" :title="isExpanded(c.hash) ? '收起' : '展开正文与文件清单'" aria-hidden="true">
          <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5 8 6l-3.5 3.5" /></svg>
        </span>
      </div>
      <div class="commit-list__meta">
        <span v-for="r in refChips(c.refs)" :key="r" class="commit-list__ref">{{ r }}</span>
        <span class="commit-list__author">{{ c.author }}</span>
        <span class="commit-list__date">{{ fmtDate(c.date) }}</span>
      </div>
      <template v-if="isExpanded(c.hash)">
        <pre v-if="c.body" class="commit-list__body">{{ c.body }}</pre>
        <div class="commit-list__files" @click.stop @keydown.enter.stop>
          <div v-if="filesOf(c.hash).loading" class="commit-list__files-note">读取文件清单中…</div>
          <div v-else-if="filesOf(c.hash).error" class="commit-list__files-note is-error">
            {{ filesOf(c.hash).error }}（再点一次这条提交可重试）
          </div>
          <template v-else-if="filesOf(c.hash).files.length === 0">
            <div class="commit-list__files-note">这笔提交没有文件改动（典型的干净合并：相对两个父提交都没有独立变更）</div>
          </template>
          <template v-else>
            <div class="commit-list__files-head">双击文件查看与上一版（父提交）的对比</div>
            <ul class="commit-list__files-list">
              <li
                v-for="e in filesOf(c.hash).files"
                :key="e.path"
                class="commit-list__file"
                :title="fileTitle(e)"
                :tabindex="0"
                @dblclick.stop="openDiff(c, e)"
                @keydown.enter.stop="openDiff(c, e)"
              >
                <span class="commit-list__status" :class="statusOf(e.status).cls">{{ statusOf(e.status).label }}</span>
                <span class="commit-list__file-name">{{ e.path }}</span>
                <span v-if="e.origPath" class="commit-list__file-orig">← {{ e.origPath }}</span>
              </li>
            </ul>
          </template>
        </div>
      </template>
    </li>
  </ul>

  <!-- 双击文件打开的提交对比:上一版(父提交) vs 该提交,复用通用差异弹窗 -->
  <FileDiffModal
    :open="diffPath !== null"
    :path="diffPath ?? ''"
    title="提交对比"
    :left="diffPanes?.left ?? { label: '上一版（父提交）', side: { exists: false } }"
    :right="diffPanes?.right ?? { label: '该提交', side: { exists: false } }"
    :loading="diffLoading"
    :error="diffError"
    @close="diffPath = null"
  />
</template>

<style scoped>
/* 本组件自有的提交行/文件清单样式;骨架与按钮族在 style.css。
   行样式从 GitLogModal 整体迁入(git-log__* → commit-list__*),两弹窗共用一份。 */

.commit-list {
  list-style: none;
  margin: 0;
  padding: 0 2px 8px;
}

.commit-list__item {
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid var(--border);
  margin-bottom: 6px;
  background: var(--card-hi);
}

.commit-list__item.is-expandable {
  cursor: pointer;
}

.commit-list__item.is-expandable:hover,
.commit-list__item.is-expandable:focus-within {
  border-color: color-mix(in srgb, var(--online) 40%, var(--border));
}

.commit-list__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.commit-list__hash {
  flex: none;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--muted);
}

.commit-list__subject {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-list__chev {
  flex: none;
  color: var(--muted);
  transition: transform 0.15s ease;
}

.commit-list__chev.is-open {
  transform: rotate(90deg);
}

.commit-list__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--muted);
  flex-wrap: wrap;
}

.commit-list__ref {
  border: 1px solid color-mix(in srgb, var(--online) 45%, var(--border));
  color: var(--text);
  border-radius: 999px;
  padding: 0 7px;
  font-size: 10.5px;
  line-height: 16px;
  font-family: var(--mono);
}

.commit-list__body {
  margin: 7px 0 1px;
  padding: 7px 9px;
  border-radius: 6px;
  background: var(--bg-soft);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}

/* 文件清单区:提示行与清单都点不动外层的展开(点击/回车 .stop 挡在容器上) */
.commit-list__files {
  margin: 7px 0 1px;
  border-top: 1px dashed var(--border);
  padding-top: 6px;
}

.commit-list__files-note {
  font-size: 12px;
  color: var(--muted);
  padding: 2px 0;
}

.commit-list__files-note.is-error {
  color: #d03050;
}

.commit-list__files-head {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 4px;
}

.commit-list__files-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.commit-list__file {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 5px;
  border-radius: 6px;
  font-size: 12.5px;
  cursor: pointer;
  min-width: 0;
}

.commit-list__file:hover,
.commit-list__file:focus-visible {
  background: color-mix(in srgb, var(--online) 8%, transparent);
}

.commit-list__status {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 4px;
  color: #fff;
}

/* 状态各一色:与 GitChangesModal 的图例同一套语义(改=蓝 增=绿 删=红 移/复=紫);型=琥珀 */
.commit-list__status.is-modified {
  background: rgb(47 111 208 / 0.9);
}

.commit-list__status.is-added {
  background: rgb(46 164 79 / 0.9);
}

.commit-list__status.is-deleted {
  background: rgb(208 48 80 / 0.9);
}

.commit-list__status.is-renamed,
.commit-list__status.is-copied {
  background: rgb(134 82 200 / 0.9);
}

.commit-list__status.is-typed {
  background: rgb(191 135 0 / 0.9);
}

.commit-list__status.is-unknown {
  background: var(--muted);
}

.commit-list__file-name {
  min-width: 0;
  font-family: var(--mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-list__file-orig {
  flex: none;
  color: var(--muted);
  font-size: 11.5px;
}
</style>
