<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NEmpty, NSpin } from 'naive-ui';
import { apiJson, errText } from '../utils/api';
import type { GitCommitEntry, GitLogData } from '../types';
import ModalShell from './ModalShell.vue';

/**
 * 「Git 提交历史」弹窗:仓库最近 20 条提交(目录卡动作条「提交历史」打开)。
 *
 * 每条展示 短哈希 + 主题 + 引用装饰 + 作者/时间;提交**正文**不默认展开 ——
 * 一屏能扫的条目数比正文更重要,展开按需(点行或回车)。有正文的行才可点,
 * 免得点了没反应的「假可点」行。时间用浏览器本地时区格式化(git 给的是 ISO+偏移)。
 *
 * 数据现跑 git log(见 git-monitor.listRecentCommits),不做缓存:打开那一刻即准。
 */
const props = defineProps<{
  /** 非空 = 打开该目录的提交历史。 */
  folder: { id?: string; path: string } | null;
}>();
const emit = defineEmits<{ close: [] }>();

const commits = ref<GitCommitEntry[]>([]);
const notARepo = ref(false);
const loading = ref(false);
const errorText = ref('');
/** 展开正文的行(哈希集合);用替换 Set 触发响应式,与 GitChangesModal 的折叠同款。 */
const expanded = ref<Set<string>>(new Set());

watch(
  () => props.folder,
  (f) => {
    commits.value = [];
    notARepo.value = false;
    expanded.value = new Set();
    if (f) void load(f.id ?? f.path);
  },
);

async function load(id: string): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    const data = await apiJson<GitLogData>(`/api/folders/git-log?folderId=${encodeURIComponent(id)}`);
    if (data.gitRepo === false) {
      notARepo.value = true;
    } else {
      commits.value = data.commits ?? [];
    }
  } catch (e) {
    errorText.value = errText(e, '读取提交历史失败');
  } finally {
    loading.value = false;
  }
}

function refresh(): void {
  const f = props.folder;
  if (f) void load(f.id ?? f.path);
}

function toggleBody(hash: string): void {
  const next = new Set(expanded.value);
  if (!next.delete(hash)) next.add(hash);
  expanded.value = next;
}

function isExpanded(hash: string): boolean {
  return expanded.value.has(hash);
}

/** %D 原样串按 `, ` 拆成引用胶囊(HEAD -> main、tag: v1.0、origin/main …)。 */
function refChips(refs: string): string[] {
  return refs ? refs.split(', ').filter((s) => s !== '') : [];
}

/** ISO 8601 → 本地时区可读;解析失败(不该发生)原样显示。 */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** 作者行 tooltip:日期给全(行内只放得下 toLocaleString 的结果,本来就全,这里补提交哈希)。 */
const description = computed(() =>
  notARepo.value ? '' : `最近 ${commits.value.length} 条 · 点提交可展开正文`,
);
</script>

<template>
  <ModalShell
    :open="!!folder"
    :title="`Git 提交历史（${folder?.path ?? ''}）`"
    :description="description"
    descriptionMono
    wide
    class="git-log-modal"
    @close="emit('close')"
  >
    <div class="git-log">
      <n-spin :show="loading">
        <div v-if="errorText" class="git-log__error">{{ errorText }}</div>
        <n-empty
          v-else-if="notARepo"
          description="此目录不是 git 仓库（或刚变成非仓库），没有提交历史可看"
        />
        <n-empty v-else-if="!loading && commits.length === 0" description="仓库还没有任何提交" />
        <template v-else-if="commits.length > 0">
          <div class="git-log__bar">
            <span class="git-log__bar-note">新 → 旧 · 共 {{ commits.length }} 条</span>
            <n-button size="tiny" quaternary class="git-log__refresh" @click="refresh">刷新</n-button>
          </div>
          <ul class="git-log__list">
            <li
              v-for="c in commits"
              :key="c.hash"
              class="git-log__item"
              :class="{ 'is-expandable': !!c.body }"
              :tabindex="c.body ? 0 : undefined"
              @click="c.body && toggleBody(c.hash)"
              @keydown.enter="c.body && toggleBody(c.hash)"
            >
              <div class="git-log__row">
                <span class="git-log__hash">{{ c.hash }}</span>
                <span class="git-log__subject" :title="c.subject">{{ c.subject }}</span>
                <span
                  v-if="c.body"
                  class="git-log__chev"
                  :class="{ 'is-open': isExpanded(c.hash) }"
                  :title="isExpanded(c.hash) ? '收起正文' : '展开正文'"
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5 8 6l-3.5 3.5" /></svg>
                </span>
              </div>
              <div class="git-log__meta">
                <span v-for="r in refChips(c.refs)" :key="r" class="git-log__ref">{{ r }}</span>
                <span class="git-log__author">{{ c.author }}</span>
                <span class="git-log__date">{{ fmtDate(c.date) }}</span>
              </div>
              <pre v-if="c.body && isExpanded(c.hash)" class="git-log__body">{{ c.body }}</pre>
            </li>
          </ul>
        </template>
      </n-spin>
    </div>
  </ModalShell>
</template>

<style scoped>
/* 本组件自有的提交列表样式;骨架与按钮族在 style.css */

/* naive 的转圈绝对定位在 .n-spin-container 的中线(top:50%),而容器高度=内容高度 ——
   加载中内容为空时容器塌成 0,转圈便贴在正文顶端(实测比空白区中心高 60px,恰是
   这 120 的一半)。给容器垫上与空白区同高的最小高度,50% 才落在空白区中心。
   容器是这里的唯一子节点,它的高度同时就是 .git-log 的高度。:deep 进 naive 容器
   与 TerminalPage 对 xterm 的处理同理(容器由库渲染,不挂本组件的 scope 属性)。 */
.git-log :deep(.n-spin-container) {
  min-height: 120px;
}

.git-log__error {
  color: #d03050;
  font-size: 12.5px;
  padding: 8px 2px;
}

.git-log__bar {
  display: flex;
  align-items: center;
  gap: 8px;
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

.git-log__bar-note {
  color: var(--muted);
  font-size: 11.5px;
}

.git-log__refresh {
  margin-left: auto;
}

.git-log__list {
  list-style: none;
  margin: 0;
  padding: 0 2px 8px;
}

.git-log__item {
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid var(--border);
  margin-bottom: 6px;
  background: var(--card-hi);
}

/* 只有带正文的行可点:悬停/手型跟着「点得动」走,不做假可点 */
.git-log__item.is-expandable {
  cursor: pointer;
}

.git-log__item.is-expandable:hover,
.git-log__item.is-expandable:focus-within {
  border-color: color-mix(in srgb, var(--online) 40%, var(--border));
}

.git-log__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.git-log__hash {
  flex: none;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--muted);
}

.git-log__subject {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-log__chev {
  flex: none;
  color: var(--muted);
  transition: transform 0.15s ease;
}

.git-log__chev.is-open {
  transform: rotate(90deg);
}

.git-log__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--muted);
  flex-wrap: wrap;
}

.git-log__ref {
  border: 1px solid color-mix(in srgb, var(--online) 45%, var(--border));
  color: var(--text);
  border-radius: 999px;
  padding: 0 7px;
  font-size: 10.5px;
  line-height: 16px;
  font-family: var(--mono);
}

.git-log__body {
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
</style>
