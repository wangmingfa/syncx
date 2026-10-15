<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NEmpty, NSpin } from 'naive-ui';
import { apiJson, apiPost, errText } from '../utils/api';
import { useStatusContext } from '../composables/statusContext';
import type { GitUnpushedData, GitUnpushedFolder } from '../types';
import ModalShell from './ModalShell.vue';
import CommitList from './CommitList.vue';

/**
 * 「Git 推送」弹窗:打开时现查各共享目录尚未推送到上游的提交,列出目录 + 每个目录的
 * 未推送提交清单;点「开始推送」后按目录顺序逐个 `git push`,行内状态 推送中 → ✓ / ✗。
 * 入口两处:共享目录栏头「一键推送」(scope='all')与单目录卡动作条「推送」(scope=该目录)。
 *
 * 数据与口径:
 * - 只列「此刻确实有未推送提交」的目录(非仓库/未设置上游/上游已同步都不进列表,
 *   与「未推送 N」徽标同一口径),空态 = 没有需要推送的提交。
 * - 列表是打开那一刻的快照,推送过程中不重查、不设刷新按钮(关掉重开即重查):
 *   推完的目录会凭空从列表消失,打勾状态将无处可看。
 * - 每目录最多列 50 条(后端截断),完整条数由 total 给出。
 * - 推送由前端按目录顺序驱动(逐目录 POST /api/folders/git-push):单目录一个请求,
 *   进度因此天然逐行可见;后端每次调用单目录持重入闸,两个页面同时点推送时后到者
 *   收到「已有推送正在进行」,记为该行失败。
 * - 失败只落行内(不 toast、不写卡片错误横幅):弹窗本身就是反馈面;失败行可再点
 *   「开始推送」重试(已 ✓ 的行跳过)。进行中锁关闭(closeDisabled 同挡 × 与遮罩),
 *   完成后不自动关 —— 打勾结果正是用户要看的。
 */
const props = defineProps<{
  /** null = 关闭;'all' = 全部共享目录(栏头入口);对象 = 只推送该目录(卡片入口)。 */
  scope: 'all' | { id?: string; path: string } | null;
}>();
const emit = defineEmits<{ close: [] }>();
const { refreshStatus } = useStatusContext();

interface PushRow extends GitUnpushedFolder {
  /** idle = 等待推送;ok = 已推送(✓);fail = 推送失败(error 为首行原因)。 */
  status: 'idle' | 'pushing' | 'ok' | 'fail';
  error?: string;
}

const rows = ref<PushRow[]>([]);
const loading = ref(false);
const errorText = ref('');
const pushing = ref(false);

watch(
  () => props.scope,
  (s) => {
    rows.value = [];
    errorText.value = '';
    pushing.value = false;
    if (s) void load(s);
  },
);

async function load(s: 'all' | { id?: string; path: string }): Promise<void> {
  loading.value = true;
  errorText.value = '';
  try {
    const q = s === 'all' ? '' : `?folderId=${encodeURIComponent(s.id ?? s.path)}`;
    const data = await apiJson<GitUnpushedData>(`/api/folders/git-unpushed${q}`);
    rows.value = (data.folders ?? []).map((f) => ({ ...f, status: 'idle' as const }));
  } catch (e) {
    errorText.value = errText(e, '读取未推送提交失败');
  } finally {
    loading.value = false;
  }
}

/** 还没打勾的行(待推送 + 失败)。全部 ✓ 后「开始推送」无事可做,置灰。 */
const pendingRows = computed(() => rows.value.filter((r) => r.status !== 'ok'));
const totalCommits = computed(() => rows.value.reduce((sum, r) => sum + r.total, 0));

const title = computed(() => {
  const s = props.scope;
  return s !== null && s !== 'all' ? `Git 推送（${s.path}）` : 'Git 推送（全部共享目录）';
});

const description = computed(() => {
  if (loading.value || errorText.value || rows.value.length === 0) return '';
  const scopeNote = props.scope === 'all' ? `${rows.value.length} 个目录 · ` : '';
  return `${scopeNote}共 ${totalCommits.value} 个提交待推送`;
});

/** 行头计数:完整条数 + 截断说明(列表最多 50 条,后端 GIT_UNPUSHED_LIMIT)。 */
function folderNote(r: PushRow): string {
  return `共 ${r.total} 条${r.truncated ? '（列表仅列前 50 条）' : ''}`;
}

/** 按目录顺序逐个推送;已 ✓ 的行跳过,失败行随下一次点击重试。 */
async function runPush(): Promise<void> {
  if (pushing.value) return;
  pushing.value = true;
  try {
    for (const row of rows.value) {
      if (row.status === 'ok') continue;
      row.status = 'pushing';
      row.error = undefined;
      try {
        const r = await apiPost<{ ok: boolean; error?: string }>('/api/folders/git-push', { folderId: row.folderId });
        if (r.ok) {
          row.status = 'ok';
        } else {
          row.status = 'fail';
          row.error = r.error ?? '推送失败';
        }
      } catch (e) {
        row.status = 'fail';
        row.error = errText(e, '推送失败');
      }
    }
  } finally {
    pushing.value = false;
    // 一轮结束拉一次状态:后端每次推完已重算计数并推送,这一拉让徽标立即跟上
    void refreshStatus();
  }
}
</script>

<template>
  <ModalShell
    :open="scope !== null"
    :title="title"
    :description="description"
    descriptionMono
    wide
    :close-disabled="pushing"
    class="git-push-modal"
    @close="emit('close')"
  >
    <div class="git-push">
      <n-spin :show="loading">
        <div v-if="errorText" class="git-push__error">{{ errorText }}</div>
        <n-empty
          v-else-if="!loading && rows.length === 0"
          description="没有需要推送的提交（非仓库 / 未设置上游 / 上游已同步的目录都不在此列）"
        />
        <template v-else-if="rows.length > 0">
          <section v-for="r in rows" :key="r.folderId" class="git-push__folder">
            <div class="git-push__head">
              <span class="git-push__path" :title="r.path">{{ r.path }}</span>
              <span class="git-push__count">{{ folderNote(r) }}</span>
              <span v-if="r.status === 'pushing'" class="git-push__state is-pushing">
                <n-spin :size="12" />
                推送中…
              </span>
              <span v-else-if="r.status === 'ok'" class="git-push__state is-ok">✓ 已推送</span>
              <span
                v-else-if="r.status === 'fail'"
                class="git-push__state is-fail"
                :title="r.error"
              >✗ {{ r.error }}</span>
            </div>
            <!-- 提交行与展开(正文/文件清单/双击对比)在公共组件 CommitList:
                 与「Git 提交历史」弹窗同一份交互;本弹窗只管每目录的推送状态与 footer。 -->
            <CommitList :folder="{ id: r.folderId, path: r.path }" :commits="r.commits" />
          </section>
        </template>
      </n-spin>
    </div>
    <template #footer>
      <n-button size="small" :disabled="pushing" @click="emit('close')">关闭</n-button>
      <n-button
        size="small"
        type="primary"
        :disabled="rows.length === 0 || pendingRows.length === 0"
        :loading="pushing"
        @click="runPush"
      >
        开始推送
      </n-button>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 本组件自有的推送列表样式;骨架与按钮族在 style.css */

/* naive 的转圈绝对定位在 .n-spin-container 的中线(top:50%),而容器高度=内容高度 ——
   加载中内容为空时容器塌成 0,转圈便贴在正文顶端。垫上与空白区同高的最小高度,
   50% 才落在空白区中心(与 GitLogModal 同款)。 */
.git-push :deep(.n-spin-container) {
  min-height: 120px;
}

.git-push__error {
  color: #d03050;
  font-size: 12.5px;
  padding: 8px 2px;
}

.git-push__folder {
  padding: 9px 11px;
  border-radius: 10px;
  border: 1px solid var(--border);
  margin-bottom: 8px;
  background: var(--card-hi);
}

.git-push__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.git-push__path {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--mono);
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-push__count {
  flex: none;
  color: var(--muted);
  font-size: 11.5px;
}

/* 行内状态:定住右侧一列,推送中/✓/✗ 切换时行头布局不跳动。
   失败原因可能很长(stderr 首行),截断展示、悬停 title 看全。 */
.git-push__state {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
}

.git-push__state.is-pushing {
  color: var(--muted);
}

.git-push__state.is-ok {
  color: var(--online);
  font-weight: 600;
}

.git-push__state.is-fail {
  color: #d03050;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
