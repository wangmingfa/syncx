<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NEmpty, NSpin } from 'naive-ui';
import { apiJson, errText } from '../utils/api';
import type { GitCommitEntry, GitLogData } from '../types';
import ModalShell from './ModalShell.vue';
import CommitList from './CommitList.vue';

/**
 * 「Git 提交历史」弹窗:仓库最近 20 条提交(目录卡动作条「提交历史」打开)。
 *
 * 数据现跑 git log(见 git-monitor.listRecentCommits),不做缓存:打开那一刻即准。
 * 提交行的展示与展开(正文 + 文件清单 + 双击对比)在公共组件 CommitList:
 * 「Git 推送」弹窗用同一份,两处交互口径不漂移。本组件只管数据与弹窗骨架。
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

watch(
  () => props.folder,
  (f) => {
    commits.value = [];
    notARepo.value = false;
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

/** 作者行 tooltip:日期给全(行内只放得下 toLocaleString 的结果,本来就全,这里补提交哈希)。 */
const description = computed(() =>
  notARepo.value ? '' : `最近 ${commits.value.length} 条 · 点提交可展开正文与文件清单,双击文件看对比`,
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
          <CommitList :folder="folder" :commits="commits" />
        </template>
      </n-spin>
    </div>
  </ModalShell>
</template>

<style scoped>
/* 本组件自有的弹窗骨架样式;提交行/文件清单在 CommitList.vue */

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
     条目盖住(玻璃档 --card 只有 0.4 白,由 style.css 皮肤段换成与弹窗表面同色的
     不透明预乘合成,原理与校准见那边规则上方的注释)。 */
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
</style>
