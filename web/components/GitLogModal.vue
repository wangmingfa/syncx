<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NEmpty, NSpin } from 'naive-ui';
import { apiJson, errText } from '../utils/api';
import type { GitCommitEntry, GitLogData } from '../types';
import ModalShell from './ModalShell.vue';
import CommitList from './CommitList.vue';

/**
 * 「Git 提交历史」弹窗:仓库最近提交,一页 20 条(目录卡动作条「提交历史」打开)。
 *
 * 数据现跑 git log(见 git-monitor.listRecentCommits),不做缓存:打开那一刻即准。
 * 提交行的展示与展开(正文 + 文件清单 + 双击对比)在公共组件 CommitList:
 * 「Git 推送」弹窗用同一份,两处交互口径不漂移。本组件只管数据与弹窗骨架。
 *
 * 分页是**续读**而不是翻页:一页装满 20 条就在底部给「查看更多」,点了往后追加
 * 20 条(后端按 skip 让 git log 只读这一段)。不做的两件事:
 *  - 不预先查总数再决定显不显示按钮:那要额外跑一次 git rev-list。
 *    判据取「这一页恰好装满了」—— 装不满就是到底了,装满则再点一次会得到空页,
 *    那时按钮自然消失(多一次点击,换来打开弹窗时少一次 git 调用)。
 *  - 不清空已加载的条目:续读不能把用户滚到的位置和展开状态冲掉(CommitList 的
 *    展开/清单缓存跟着 commits 变化会重置,见那边 watch —— 所以只在真的换目录
 *    或刷新时把列表整个换掉,续读走追加)。
 */
const props = defineProps<{
  /** 非空 = 打开该目录的提交历史。 */
  folder: { id?: string; path: string } | null;
}>();
const emit = defineEmits<{ close: [] }>();

/** 一页的条数:与后端 GIT_LOG_LIMIT 同一口径(接口默认值也是它)。 */
const PAGE = 20;

const commits = ref<GitCommitEntry[]>([]);
const notARepo = ref(false);
const loading = ref(false);
/** 「查看更多」正在进行:与首次加载分开,避免续读时把整块列表换成转圈。 */
const loadingMore = ref(false);
/** 还有下一页?见头注释:满页即认为可能还有。 */
const hasMore = ref(false);
const errorText = ref('');
/** 续读失败只落在按钮旁(已经读出来的条目不该被一条错误遮住)。 */
const moreError = ref('');
/**
 * 首屏与续读各一个请求序号:异步回来时对不上就整条丢弃(打开 A 又迅速切到 B、
 * 或者续读途中点了刷新)。分成两个而不是共用一个,是因为「刷新」必须作废在途的
 * 续读、却不该被在途续读的收尾反过来清掉自己的状态 —— 共用一个序号时,续读的
 * finally 会因为序号已变而跳过收尾,`loadingMore` 就此永久为 true,按钮卡住。
 */
let firstSeq = 0;
let moreSeq = 0;

watch(
  () => props.folder,
  (f) => {
    firstSeq += 1;
    moreSeq += 1;
    commits.value = [];
    notARepo.value = false;
    hasMore.value = false;
    errorText.value = '';
    moreError.value = '';
    loading.value = false;
    loadingMore.value = false;
    if (f) void load(f.id ?? f.path);
  },
);

/** 拉一页;skip 为 0 时是首屏/刷新,否则是续读并追加。 */
async function load(id: string, skip = 0): Promise<void> {
  const more = skip > 0;
  const gen = more ? ++moreSeq : ++firstSeq;
  if (more) {
    loadingMore.value = true;
    moreError.value = '';
  } else {
    // 刷新作废在途的续读:它回来时序号已对不上,不会把旧页追加进来
    moreSeq += 1;
    loadingMore.value = false;
    moreError.value = '';
    loading.value = true;
    errorText.value = '';
  }
  try {
    const q = new URLSearchParams({ folderId: id, limit: String(PAGE), skip: String(skip) });
    const data = await apiJson<GitLogData>(`/api/folders/git-log?${q.toString()}`);
    if (gen !== (more ? moreSeq : firstSeq)) return;
    if (data.gitRepo === false) {
      notARepo.value = true;
      commits.value = [];
      hasMore.value = false;
    } else {
      const page = data.commits ?? [];
      // 续读只追加:已加载的条目(连同展开状态)必须留在原位
      commits.value = more ? [...commits.value, ...page] : page;
      hasMore.value = page.length >= PAGE;
    }
  } catch (e) {
    if (gen !== (more ? moreSeq : firstSeq)) return;
    if (more) moreError.value = errText(e, '读取更多提交失败');
    else errorText.value = errText(e, '读取提交历史失败');
  } finally {
    if (gen === (more ? moreSeq : firstSeq)) {
      if (more) loadingMore.value = false;
      else loading.value = false;
    }
  }
}

function refresh(): void {
  const f = props.folder;
  if (f) void load(f.id ?? f.path);
}

/** 「查看更多」:从已加载条数处继续往后读一页。 */
function loadMore(): void {
  const f = props.folder;
  if (f && !loadingMore.value) void load(f.id ?? f.path, commits.value.length);
}

/** 作者行 tooltip:日期给全(行内只放得下 toLocaleString 的结果,本来就全,这里补提交哈希)。 */
const description = computed(() =>
  notARepo.value ? '' : '点提交可展开正文与文件清单,双击文件看对比',
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
            <span class="git-log__bar-note">新 → 旧 · 已加载 {{ commits.length }} 条</span>
            <n-button size="tiny" quaternary class="git-log__refresh" @click="refresh">刷新</n-button>
          </div>
          <CommitList :folder="folder" :commits="commits" />
          <div v-if="hasMore || loadingMore || moreError" class="git-log__more">
            <n-button size="small" :loading="loadingMore" :disabled="loadingMore" @click="loadMore">
              查看更多
            </n-button>
            <div v-if="moreError" class="git-log__more-error">{{ moreError }}</div>
          </div>
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

/* 「查看更多」:条目的续读入口,居中放在列表末尾(不 sticky —— 它属于列表结尾,
   跟着滚走才表示「到这里为止了」)。 */
.git-log__more {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 0 4px;
}

.git-log__more-error {
  color: #d03050;
  font-size: 12px;
}
</style>
