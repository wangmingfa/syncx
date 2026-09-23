<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { apiJson, errText } from '../utils/api';
import { formatBytes } from '../utils/bytes';
import { useStatusContext } from '../composables/statusContext';
import type { DiffFooterAction, DiffPaneData, FileCompareData } from '../types';
import FileDiffModal from './FileDiffModal.vue';
import ModalShell from './ModalShell.vue';

/** 一条冲突副本(与 src/conflicts.ts 的 ConflictCopy 同形)。 */
interface ConflictCopy {
  copyPath: string;
  originalPath: string;
  deviceId: string;
  size: number;
  mtime: number;
  /** 与原文件的比对: true 无差异 / false 有差异 / null 无法判定(原文件缺失或超上限) */
  identical: boolean | null;
}

const props = defineProps<{
  /** 非空 = 打开该目录的冲突收件箱并实时扫盘。 */
  folder: { id?: string; path: string } | null;
  /** 轻提示(父级 useToast 提供)。 */
  notify: (msg: string, kind?: 'info' | 'alert') => void;
  /** 处理会改动盘面并触发广播,完成后让父级刷新状态。 */
  changed: () => void;
}>();
const emit = defineEmits<{ close: [] }>();
const { askConfirm, status } = useStatusContext();

const conflicts = ref<ConflictCopy[]>([]);
const truncated = ref(false);
const loading = ref(false);
const lastPath = ref('');
const busyPath = ref<string | null>(null);

watch(
  () => props.folder,
  (f) => {
    if (!f) return;
    lastPath.value = f.path;
    conflicts.value = [];
    truncated.value = false;
    void load(f.id ?? f.path);
  },
);

async function load(id: string): Promise<void> {
  loading.value = true;
  try {
    const data = await apiJson<{ conflicts?: ConflictCopy[]; truncated?: boolean }>(
      `/api/folders/conflicts?folderId=${encodeURIComponent(id)}`,
    );
    conflicts.value = data.conflicts ?? [];
    truncated.value = data.truncated === true;
  } catch (e) {
    props.notify(errText(e, '读取冲突列表失败'), 'alert');
  } finally {
    loading.value = false;
  }
}

/** 冲突来源设备:能对上已知设备就标主机名,认不出留 id。 */
function deviceLabel(id: string): string {
  const dev = status.value.devices.find((d) => d.deviceId === id);
  return dev?.hostname ? `${dev.hostname}（${id}）` : id;
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

async function doResolve(c: ConflictCopy, choice: 'keep-local' | 'discard'): Promise<void> {
  const f = props.folder;
  if (!f) return;
  busyPath.value = c.copyPath;
  try {
    await apiJson('/api/folders/conflicts/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: f.id ?? f.path, copyPath: c.copyPath, choice }),
    });
    props.notify(
      choice === 'keep-local'
        ? `已用本地版本覆盖 ${c.originalPath},将同步给对端`
        : '冲突副本已移入回收站',
      'info',
    );
    props.changed();
    await load(f.id ?? f.path);
  } catch (e) {
    props.notify(errText(e, '处理冲突失败'), 'alert');
  } finally {
    busyPath.value = null;
  }
}

// 「保留本地版」有覆盖对端内容的传播力(结果会广播出去),二次确认必须把后果说全
function askKeepLocal(c: ConflictCopy): void {
  askConfirm({
    title: '保留本地版本',
    message: `将用冲突副本覆盖回原文件「${c.originalPath}」,该结果会同步给对端。`,
    detail: c.copyPath,
    confirmText: '用本地版覆盖',
    note: '被覆盖的对端内容会先留档到「文件版本」,可再恢复;冲突副本移入回收站。',
    action: () => doResolve(c, 'keep-local'),
  });
}

function askDiscard(c: ConflictCopy): void {
  askConfirm({
    title: '丢弃冲突副本',
    message: '本地这份冲突副本将移入回收站,原文件(对端版本)保持不变。',
    detail: c.copyPath,
    confirmText: '丢弃',
    note: '回收站在本机配置目录下,不跨设备同步。',
    action: () => doResolve(c, 'discard'),
  });
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

// —— 查看对比(复用通用差异弹窗 FileDiffModal:原文件 ↔ 冲突副本) ——

const diffOpen = ref(false);
const diffCopy = ref<ConflictCopy | null>(null);
const diffData = ref<FileCompareData | null>(null);
const diffLoading = ref(false);
const diffError = ref('');
let diffSeq = 0;

async function openDiff(c: ConflictCopy): Promise<void> {
  const f = props.folder;
  if (!f) return;
  diffCopy.value = c;
  diffOpen.value = true;
  await loadDiff();
}

/** 重新拉取两侧(合并写回后左列要立刻反映新内容;seq 丢弃迟到响应)。 */
async function loadDiff(): Promise<void> {
  const f = props.folder;
  const c = diffCopy.value;
  if (!f || !c) return;
  const mine = ++diffSeq;
  diffLoading.value = true;
  diffError.value = '';
  try {
    const data = await apiJson<FileCompareData>(
      `/api/folders/conflicts/diff?folderId=${encodeURIComponent(f.id ?? f.path)}&copyPath=${encodeURIComponent(c.copyPath)}`,
    );
    if (mine !== diffSeq) return;
    diffData.value = data;
  } catch (e) {
    if (mine !== diffSeq) return;
    diffData.value = null;
    diffError.value = errText(e, '读取对比失败');
  } finally {
    if (mine === diffSeq) diffLoading.value = false;
  }
}

function closeDiff(): void {
  diffOpen.value = false;
  diffSeq += 1; // 关窗后迟到响应不再写入
  diffLoading.value = false;
}

const diffLeft = computed<DiffPaneData>(() => ({
  label: '原文件',
  role: '原文件',
  note: '对端版本',
  side: diffData.value?.local ?? { exists: false },
}));
const diffRight = computed<DiffPaneData>(() => ({
  label: '冲突副本',
  role: '副本',
  note: diffCopy.value ? `${diffCopy.value.deviceId} · 本机旧版` : '本机旧版',
  side: diffData.value?.remote ?? { exists: false },
}));

/** 弹窗内两个整文件动作(与列表行同款语义,确认后走既有 resolve 通道)。 */
const diffActions = computed<DiffFooterAction[]>(() => [
  {
    id: 'keep-local',
    label: '用副本整体覆盖原文件',
    disabled: (ctx) => !ctx.rightExists,
    hint: (ctx) =>
      !ctx.rightExists
        ? '副本已不存在,无法覆盖'
        : ctx.identical
          ? '两侧内容已经一致,无需覆盖,直接丢弃副本即可'
          : '用冲突副本内容完全替换原文件,结果会同步给对端',
    confirm: '将用冲突副本完全替换原文件,该结果会同步给对端(被覆盖的内容会先留档到文件版本)。',
  },
  {
    id: 'discard',
    label: '丢弃副本',
    tone: 'error',
    disabled: (ctx) => !ctx.rightExists,
    hint: () => '副本移入回收站,原文件(对端版本)保持不变',
    confirm: '冲突副本将移入回收站,原文件(对端版本)保持不变。',
  },
]);

async function onDiffAction(id: string): Promise<void> {
  const c = diffCopy.value;
  if (!c) return;
  if (id === 'keep-local' || id === 'discard') {
    closeDiff();
    await doResolve(c, id);
  }
}

/** 逐块合并:组件算好应用后的完整新内容,写回原文件(当前内容自动留档),随后重取两侧。 */
async function onDiffHunk(payload: { dir: 'left' | 'right'; content: string }): Promise<void> {
  const f = props.folder;
  const c = diffCopy.value;
  if (!f || !c || payload.dir !== 'left') return;
  try {
    await apiJson('/api/folders/conflicts/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: f.id ?? f.path, copyPath: c.copyPath, content: payload.content }),
    });
    props.notify('已把该差异块写回原文件,将同步给对端', 'info');
    props.changed();
    await loadDiff();
    await load(f.id ?? f.path);
  } catch (e) {
    props.notify(errText(e, '合并写回失败'), 'alert');
  }
}

// —— 一键清理无差异副本 ——

const identicalCount = computed<number>(() => conflicts.value.filter((c) => c.identical === true).length);

async function doCleanIdentical(): Promise<void> {
  const f = props.folder;
  if (!f) return;
  const data = await apiJson<{ removed?: number }>('/api/folders/conflicts/clean-identical', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId: f.id ?? f.path }),
  });
  props.notify(`已清理 ${data.removed ?? 0} 个无差异副本(移入回收站)`, 'info');
  props.changed();
  await load(f.id ?? f.path);
}

function askCleanIdentical(): void {
  askConfirm({
    title: '清理无差异副本',
    message: `${identicalCount.value} 个冲突副本与原文件逐字节一致,将全部移入回收站。`,
    detail: props.folder?.path,
    confirmText: '清理',
    note: '只清"完全一样"的;有差异与无法判定的副本保持待处理,不受影响。',
    action: doCleanIdentical,
  });
}
</script>

<template>
  <ModalShell
    :open="!!folder"
    title="待处理冲突"
    :description="lastPath"
    description-mono
    wide
    class="conflict-modal"
    @close="emit('close')"
  >
    <p class="modal-lead">两边都改过同一文件时,输的一方被保留成冲突副本(绝不静默丢数据)。可先看差异再决定去留;处理结果会同步给对端。</p>

    <div v-if="loading" class="history-loading">读取中…</div>
    <div v-else-if="conflicts.length === 0" class="empty">
      该目录没有待处理的冲突副本
    </div>
    <template v-else>
      <p v-if="truncated" class="history-scope">冲突条目过多,仅列出前 500 条(按时间倒序)</p>
      <ul class="history-list conflict-list">
        <li v-for="c in conflicts" :key="c.copyPath" class="history-row">
          <span class="history-time">{{ fmtTime(c.mtime) }}</span>
          <span class="history-action act-conflict">冲突</span>
          <div class="conflict-paths">
            <span class="history-path mono break" :title="c.originalPath">原文件:{{ basename(c.originalPath) }}</span>
            <span class="conflict-from muted">
              来源 {{ deviceLabel(c.deviceId) }} · {{ formatBytes(c.size) }} ·
              <span :class="c.identical === true ? 'conflict-state-ok' : c.identical === false ? 'conflict-state-diff' : 'muted'">
                {{ c.identical === true ? '与原文件无差异' : c.identical === false ? '与原文件有差异' : '未比对(原文件缺失或超过 32MB)' }}
              </span>
            </span>
          </div>
          <span class="conflict-ops">
            <n-button v-if="c.identical !== true" size="tiny" quaternary :disabled="busyPath !== null" @click="openDiff(c)">查看对比</n-button>
            <n-button size="tiny" type="primary" quaternary :loading="busyPath === c.copyPath" :disabled="busyPath !== null" @click="askKeepLocal(c)">保留本地版</n-button>
            <n-button size="tiny" type="error" quaternary :disabled="busyPath !== null" @click="askDiscard(c)">丢弃</n-button>
          </span>
        </li>
      </ul>
    </template>

    <template #footer>
      <n-button v-if="identicalCount > 0" :disabled="busyPath !== null" @click="askCleanIdentical">
        一键清理无差异副本({{ identicalCount }})
      </n-button>
      <n-button type="primary" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>

  <!-- 复用通用差异弹窗:原文件(对端版) ↔ 冲突副本(本机旧版),
       逐块写回 + 整文件动作都在弹窗里,列表行上的按钮保持快捷入口 -->
  <FileDiffModal
    :open="diffOpen"
    title="冲突对比"
    :path="diffData?.path ?? diffCopy?.originalPath ?? ''"
    :left="diffLeft"
    :right="diffRight"
    :hunk-apply="{ toLeft: '把副本的这块应用到原文件(写回并广播给对端)' }"
    :footer-actions="diffActions"
    :loading="diffLoading"
    :error="diffError"
    @close="closeDiff"
    @action="onDiffAction"
    @apply-hunk="onDiffHunk"
  />
</template>
