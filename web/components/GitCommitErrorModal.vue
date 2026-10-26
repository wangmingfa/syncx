<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NSpin } from 'naive-ui';
import { apiJson, apiPost, errText } from '../utils/api';
import { useStatusContext } from '../composables/statusContext';
import { useToast } from '../composables/useToast';
import type { GitAutoCommitRetryData, GitAutoCommitStatus, GitIndexLockDeleteData } from '../types';
import ModalShell from './ModalShell.vue';

/**
 * 「自动提交失败」弹窗:目录卡「提交失败」徽标点开。
 *
 * 背景:对端提交的内容经数据面落盘后,本机要把它定格成一笔镜像提交;git 失败
 * (最常见的是被杀掉的 git 进程留下 index.lock)时通知不会丢,但工作树会一直脏着。
 * 弹窗给出三件事:失败原因全文、自动重试进度、残留锁的现况与处理入口。
 *
 * 数据每次打开 / 每次操作后**现查**(/api/folders/git-commit-status):锁在盘上
 * 随时可能被别的进程创建或清掉,拿状态推送里的旧快照会误导用户。
 * - 「删除残留锁」:二次确认后只删 git 自己指认的 index.lock,不碰内容文件;
 * - 「立即提交」:清零退避后立刻结算,仍走完整闸门(在途接收 / 索引交换 / 暂停)——
 *   半套文件被定格正是那些闸门要防的事,用户点按钮也不该绕开。
 */
const props = defineProps<{
  /** 非空 = 打开该目录的自动提交失败详情。 */
  folder: { id?: string; path: string } | null;
}>();
const emit = defineEmits<{ close: [] }>();

const { refreshStatus, askConfirm, fmtTime } = useStatusContext();
const { showToast } = useToast();

const data = ref<GitAutoCommitStatus | null>(null);
const loading = ref(false);
const loadError = ref('');
const retrying = ref(false);

function folderKeyOf(f: { id?: string; path: string }): string {
  return f.id ?? f.path;
}

watch(
  () => props.folder,
  (f) => {
    data.value = null;
    loadError.value = '';
    retrying.value = false;
    if (f) void load(f);
  },
);

async function load(f: { id?: string; path: string }): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    data.value = await apiJson<GitAutoCommitStatus>(
      `/api/folders/git-commit-status?folderId=${encodeURIComponent(folderKeyOf(f))}`,
    );
  } catch (e) {
    loadError.value = errText(e, '读取自动提交状态失败');
  } finally {
    loading.value = false;
  }
}

function refresh(): void {
  const f = props.folder;
  if (f) void load(f);
}

/** 锁文件存在时长:分钟以内报「不到 1 分钟」,再往上按小时 / 天。 */
function ageText(mtimeMs: number): string {
  const mins = Math.floor((Date.now() - mtimeMs) / 60_000);
  if (mins < 1) return '不到 1 分钟';
  if (mins < 60) return `约 ${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `约 ${hours} 小时`;
  return `约 ${Math.floor(hours / 24)} 天`;
}

function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** 重试进度一句话:排定时刻 / 已放弃 / 下一轮扫描就试。 */
const retryLine = computed(() => {
  const d = data.value;
  if (!d || !d.pending) return '';
  if (d.givenUp) return `已自动尝试 ${d.attempts} 次后停止,可点「立即提交」手动重试`;
  if (d.attempts > 0) {
    return d.retryAt
      ? `第 ${d.attempts}/${d.maxAttempts} 次失败,下次自动重试 ${clockOf(d.retryAt)}`
      : `第 ${d.attempts}/${d.maxAttempts} 次失败`;
  }
  return '等待下一轮扫描自动尝试';
});

/**
 * 失败原因是否指向 index.lock。用于「锁已经不在」的说明:错误横幅是失败那一刻
 * 的快照,而锁可能刚被用户/别的进程删掉,此时不该再给一个点了会失败的删除按钮。
 */
const errorMentionsLock = computed(() =>
  /index\.lock|Unable to create .*: File exists/.test(data.value?.error?.message ?? ''),
);

function askDeleteLock(): void {
  const d = data.value;
  const f = props.folder;
  if (!d?.lock || !f) return;
  const lock = d.lock;
  askConfirm({
    title: '删除残留的 git 锁文件',
    message: '只删除 git 自己指认的 index.lock,不会碰任何文件内容。请先确认此刻没有其它 git 进程正在操作这个仓库。',
    detail: `${lock.path}\n已存在${ageText(lock.mtimeMs)} · ${lock.size} 字节`,
    confirmText: '删除锁文件',
    note: '删除后不会自动提交:点「立即提交」补上这一笔,或等下一轮自动重试。',
    action: () => deleteLock(f),
  });
}

async function deleteLock(f: { id?: string; path: string }): Promise<void> {
  try {
    const r = await apiPost<GitIndexLockDeleteData>('/api/folders/git-index-lock/delete', {
      folderId: folderKeyOf(f),
    });
    if (!r.ok) {
      showToast(r.error ?? '删除锁文件失败', 'alert');
      return;
    }
    showToast(r.removed === false ? '锁文件已经不存在' : '已删除残留的锁文件');
  } catch (e) {
    showToast(errText(e, '删除锁文件失败'), 'alert');
  } finally {
    refresh();
    void refreshStatus();
  }
}

async function retry(): Promise<void> {
  const f = props.folder;
  if (!f || !data.value?.pending || retrying.value) return;
  retrying.value = true;
  try {
    const r = await apiPost<GitAutoCommitRetryData>('/api/folders/git-commit-retry', {
      folderId: folderKeyOf(f),
    });
    if (r.ok) {
      showToast(r.hash ? `已提交 ${r.hash.slice(0, 8)}` : '工作树已干净,无需提交');
    } else {
      showToast(r.error ?? '自动提交仍未完成', 'alert');
    }
  } catch (e) {
    showToast(errText(e, '重试自动提交失败'), 'alert');
  } finally {
    retrying.value = false;
    refresh();
    void refreshStatus();
  }
}
</script>

<template>
  <ModalShell
    :open="!!folder"
    :title="`自动提交失败（${folder?.path ?? ''}）`"
    description="内容已同步到本机,但镜像提交没有成功;通知会保留,修好原因后可立即重试"
    class="git-commit-error-modal"
    @close="emit('close')"
  >
    <div class="git-commit-error">
      <n-spin :show="loading">
        <div v-if="loadError" class="git-commit-error__load">{{ loadError }}</div>
        <template v-else-if="data">
          <!-- 失败原因原样展示:git 的 stderr 与那句锁文件提示都在里面,
               保留换行比压成一行好读(路径与命令行都很长)。 -->
          <section v-if="data.error" class="git-commit-error__reason">
            <div class="git-commit-error__label">失败原因</div>
            <div class="git-commit-error__message break">{{ data.error.message }}</div>
            <div class="git-commit-error__time">{{ fmtTime(data.error.ts) }}</div>
          </section>

          <section class="git-commit-error__facts">
            <div class="git-commit-error__row">
              <span class="git-commit-error__label">待结算通知</span>
              <span v-if="data.pending" class="git-commit-error__value break">
                {{ data.commitMessage || '(提交信息为空)' }}
                <span v-if="data.changedFiles.length" class="git-commit-error__muted">
                  · {{ data.changedFiles.length }} 个文件
                </span>
              </span>
              <span v-else class="git-commit-error__value git-commit-error__muted">没有待结算的通知</span>
            </div>
            <div v-if="retryLine" class="git-commit-error__row">
              <span class="git-commit-error__label">自动重试</span>
              <span class="git-commit-error__value">{{ retryLine }}</span>
            </div>
          </section>

          <!-- 残留锁:现查结果。有锁 → 给删除入口;错误曾提到锁但此刻已不在 →
               说明清楚,免得用户以为按钮坏了。 -->
          <section v-if="data.lock" class="git-commit-error__lock">
            <div class="git-commit-error__lock-head">
              <span class="git-commit-error__label">残留锁文件</span>
              <n-button size="tiny" type="error" class="git-commit-error__delete" @click="askDeleteLock">
                删除残留锁
              </n-button>
            </div>
            <div class="git-commit-error__lock-path mono break">{{ data.lock.path }}</div>
            <div class="git-commit-error__time">
              已存在{{ ageText(data.lock.mtimeMs) }} · {{ data.lock.size }} 字节 · 没有其它 git 进程操作时可安全删除
            </div>
          </section>
          <section v-else-if="errorMentionsLock" class="git-commit-error__lock is-gone">
            <div class="git-commit-error__label">残留锁文件</div>
            <div class="git-commit-error__time">锁文件已不在(可能已被清理),可直接点「立即提交」重试。</div>
          </section>
        </template>
      </n-spin>
    </div>
    <template #footer>
      <n-button size="small" :disabled="retrying" @click="emit('close')">关闭</n-button>
      <n-button
        size="small"
        type="primary"
        :disabled="!data?.pending || retrying"
        :loading="retrying"
        @click="retry"
      >
        立即提交
      </n-button>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 本组件自有的详情排版;骨架与按钮族在 style.css */

/* 转圈绝对定位在 .n-spin-container 中线,内容为空时容器塌成 0 —— 垫最小高度
   (与 GitPushModal / EmptyDirsModal 同款)。 */
.git-commit-error :deep(.n-spin-container) {
  min-height: 120px;
}

.git-commit-error__load {
  color: #d03050;
  font-size: 12.5px;
  padding: 8px 2px;
}

.git-commit-error__reason {
  padding: 9px 11px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, #d03050 35%, var(--border));
  background: color-mix(in srgb, #d03050 6%, transparent);
  margin-bottom: 10px;
}

.git-commit-error__label {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--muted);
}

.git-commit-error__message {
  margin-top: 5px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
}

.git-commit-error__time {
  margin-top: 5px;
  color: var(--muted);
  font-size: 11.5px;
}

.git-commit-error__facts {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-bottom: 10px;
}

.git-commit-error__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.git-commit-error__row .git-commit-error__label {
  flex: none;
  min-width: 72px;
}

.git-commit-error__value {
  font-size: 12.5px;
}

.git-commit-error__muted {
  color: var(--muted);
}

.git-commit-error__lock {
  padding: 9px 11px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--card-hi);
}

.git-commit-error__lock.is-gone {
  background: none;
}

.git-commit-error__lock-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.git-commit-error__lock-path {
  margin-top: 5px;
  font-size: 12px;
}
</style>
