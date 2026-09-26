<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { apiJson, apiPost, errText } from '../utils/api';
import { formatBytes } from '../utils/bytes';
import { diffText } from '../utils/text-diff';
import ModalShell from './ModalShell.vue';

/** 版本留档条目:file 为版本文件相对版本目录的路径(含 .syncx-v- 时间戳后缀)。 */
interface FolderVersion {
  file: string;
  path: string;
  size: number;
  mtime: number;
}

/** 后端 rollback.ts RollbackPlan 的前端镜像。 */
interface RollbackPlanData {
  targetTs: number;
  restores: Array<{ relPath: string; versionFile: string; versionTs: number }>;
  trashCurrent: Array<{ relPath: string }>;
  fromTrash: Array<{ relPath: string; trashFile: string }>;
  noSnapshot: string[];
  lostDeletes: string[];
  counts: { restores: number; trashCurrent: number; fromTrash: number; noSnapshot: number; lostDeletes: number };
}

const props = defineProps<{
  /** 非空 = 打开该目录的版本弹窗并拉取留档列表。 */
  folder: { id?: string; path: string } | null;
  /** 轻提示(父级 useToast 提供)。 */
  notify: (msg: string, kind?: 'info' | 'alert') => void;
  /** 恢复/删除/回滚会改动文件,完成后通知父级刷新状态(对端会把这些当作修改接收)。 */
  changed: () => void;
}>();
const emit = defineEmits<{ close: [] }>();

const versions = ref<FolderVersion[]>([]);
const loading = ref(false);
const lastPath = ref('');
const restoring = ref<string | null>(null);

function folderId(): string {
  const f = props.folder;
  return f?.id ?? f?.path ?? '';
}

async function load(id: string): Promise<void> {
  loading.value = true;
  try {
    const data = await apiJson<{ versions: FolderVersion[] }>(
      `/api/folders/versions?folderId=${encodeURIComponent(id)}`,
    );
    versions.value = data.versions ?? [];
  } catch (e) {
    props.notify(errText(e, '读取文件版本失败'));
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.folder,
  async (f) => {
    if (!f) return;
    lastPath.value = f.path;
    versions.value = [];
    openPath.value = null;
    picked.value = [];
    pairDiff.value = null;
    plan.value = null;
    rbResult.value = '';
    await load(f.id ?? f.path);
  },
);

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/**
 * 时间轴视图:按原始路径分组(新→旧),点开一组就是该文件的「版本时间机器」。
 * 组排序按各自最近一次留档时间 —— 刚动过的文件排最前,不用翻。
 */
const openPath = ref<string | null>(null);

const groups = computed(() => {
  const byPath = new Map<string, FolderVersion[]>();
  for (const v of versions.value) {
    const list = byPath.get(v.path);
    if (list) list.push(v);
    else byPath.set(v.path, [v]);
  }
  return [...byPath.entries()]
    .map(([path, list]) => ({
      path,
      versions: list.sort((a, b) => b.mtime - a.mtime),
      latest: Math.max(...list.map((v) => v.mtime)),
    }))
    .sort((a, b) => b.latest - a.latest);
});

// —— 任意两版 diff:每组内勾选两个版本(再点第三个自动滚动替换最旧选择) ——

const picked = ref<string[]>([]);

function togglePick(file: string): void {
  const i = picked.value.indexOf(file);
  if (i >= 0) {
    picked.value.splice(i, 1);
    return;
  }
  const next = [...picked.value, file];
  picked.value = next.length > 2 ? next.slice(next.length - 2) : next;
  pairDiff.value = null;
}

interface PairDiffView {
  path: string;
  oldLabel: string;
  newLabel: string;
  lines: Array<{ kind: 'ctx' | 'add' | 'del'; text: string }>;
  note: string;
}

const pairDiff = ref<PairDiffView | null>(null);
const diffLoading = ref(false);

async function comparePair(): Promise<void> {
  if (picked.value.length !== 2) return;
  const [a, b] = picked.value;
  const va = versions.value.find((v) => v.file === a);
  const vb = versions.value.find((v) => v.file === b);
  if (!va || !vb) return;
  const [oldV, newV] = va.mtime <= vb.mtime ? [va, vb] : [vb, va];
  diffLoading.value = true;
  try {
    const q = (file: string) =>
      apiJson<{ exists?: boolean; text?: string; size?: number; binary?: boolean; tooLarge?: boolean }>(
        `/api/folders/versions/content?folderId=${encodeURIComponent(folderId())}&file=${encodeURIComponent(file)}`,
      );
    const [ra, rb] = await Promise.all([q(oldV.file), q(newV.file)]);
    if (ra.binary || rb.binary) {
      pairDiff.value = { path: oldV.path, oldLabel: fmtTime(oldV.mtime), newLabel: fmtTime(newV.mtime), lines: [], note: '存在二进制版本,无法逐行对比(可分别「恢复」后在别处比较)' };
      return;
    }
    if (ra.tooLarge || rb.tooLarge) {
      pairDiff.value = { path: oldV.path, oldLabel: fmtTime(oldV.mtime), newLabel: fmtTime(newV.mtime), lines: [], note: '版本体积过大,只回传了大小' };
      return;
    }
    if (ra.exists === false || rb.exists === false) {
      pairDiff.value = { path: oldV.path, oldLabel: fmtTime(oldV.mtime), newLabel: fmtTime(newV.mtime), lines: [], note: '某个版本文件已不存在,请刷新列表' };
      return;
    }
    const { rows } = diffText(ra.text ?? '', rb.text ?? '');
    const lines: PairDiffView['lines'] = [];
    let changedLines = 0;
    for (const r of rows) {
      if (r.type === 'same') {
        if (lines.length < 2000) lines.push({ kind: 'ctx', text: r.rightText ?? '' });
        continue;
      }
      changedLines += 1;
      if (r.leftText !== undefined && lines.length < 2000) lines.push({ kind: 'del', text: r.leftText });
      if (r.rightText !== undefined && lines.length < 2000) lines.push({ kind: 'add', text: r.rightText });
    }
    pairDiff.value = {
      path: oldV.path,
      oldLabel: fmtTime(oldV.mtime),
      newLabel: fmtTime(newV.mtime),
      lines,
      note: changedLines === 0 ? '两版内容一致' : `共 ${changedLines} 行差异${rows.length > 2000 ? ',展示截断到 2000 行' : ''}`,
    };
  } catch (e) {
    props.notify(errText(e, '读取版本内容失败'), 'alert');
  } finally {
    diffLoading.value = false;
  }
}

// —— 单版本恢复 / 删除 ——

// 恢复:把旧版本写回原路径(当前内容会先留档一份,操作可逆)。
// 恢复后的旧内容作为「本地修改」沿正常同步路径传播给对端。
async function restore(v: FolderVersion): Promise<void> {
  const f = props.folder;
  if (!f) return;
  restoring.value = v.file;
  try {
    await apiPost('/api/folders/versions/restore', { folderId: f.id ?? f.path, file: v.file });
    props.notify(`已把旧版本恢复到 ${v.path},将同步给对端`);
    props.changed();
    await load(f.id ?? f.path);
  } catch (e) {
    props.notify(errText(e, '恢复失败'), 'alert');
  } finally {
    restoring.value = null;
  }
}

// 删除单个留档(不可逆,需二次确认)
async function doDelete(v: FolderVersion): Promise<void> {
  const f = props.folder;
  if (!f) return;
  try {
    await apiPost('/api/folders/versions/delete', { folderId: f.id ?? f.path, file: v.file });
    versions.value = versions.value.filter((x) => x.file !== v.file);
    picked.value = picked.value.filter((x) => x !== v.file);
  } catch (e) {
    props.notify(errText(e, '删除失败'), 'alert');
  }
}

function askDelete(v: FolderVersion): void {
  askConfirmDelete.value = v;
}

const askConfirmDelete = ref<FolderVersion | null>(null);

function confirmDelete(): void {
  const v = askConfirmDelete.value;
  askConfirmDelete.value = null;
  if (v) void doDelete(v);
}

// —— 整目录回滚(时间机器):先出计划(只读),确认后才执行 ——

const rbTime = ref('');
const rbBusy = ref(false);
const plan = ref<RollbackPlanData | null>(null);
const rbConfirm = ref(false);
const rbResult = ref('');

function fmtLocalInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function rbTs(): number {
  if (!rbTime.value) return NaN;
  const t = new Date(rbTime.value).getTime();
  return Number.isFinite(t) ? t : NaN;
}

async function previewRollback(): Promise<void> {
  const f = props.folder;
  const ts = rbTs();
  if (!f || Number.isNaN(ts)) {
    props.notify('先选择要回滚到的时间点', 'alert');
    return;
  }
  if (ts > Date.now()) {
    props.notify('目标时间不能晚于现在', 'alert');
    return;
  }
  rbBusy.value = true;
  rbResult.value = '';
  try {
    const r = await apiPost<{ plan: RollbackPlanData }>('/api/folders/rollback', {
      folderId: f.id ?? f.path,
      ts,
      dryRun: true,
    });
    plan.value = r.plan;
  } catch (e) {
    props.notify(errText(e, '生成回滚计划失败'), 'alert');
  } finally {
    rbBusy.value = false;
  }
}

async function executeRollback(): Promise<void> {
  const f = props.folder;
  const ts = rbTs();
  rbConfirm.value = false;
  if (!f || Number.isNaN(ts)) return;
  rbBusy.value = true;
  try {
    const r = await apiPost<{
      result: { restored: number; trashed: number; fromTrash: number; failed: number };
    }>('/api/folders/rollback', { folderId: f.id ?? f.path, ts, dryRun: false });
    rbResult.value =
      `回滚完成:恢复 ${r.result.restored} 个、回收新增 ${r.result.trashed} 个、找回删除 ${r.result.fromTrash} 个` +
      (r.result.failed > 0 ? `,失败 ${r.result.failed} 个` : '') +
      '。被覆盖/被移除的当前内容都已进版本与回收站,可再反悔。';
    plan.value = null;
    props.notify('整目录已回滚,变更将同步给对端');
    props.changed();
    await load(f.id ?? f.path);
  } catch (e) {
    props.notify(errText(e, '回滚失败'), 'alert');
  } finally {
    rbBusy.value = false;
  }
}

const planEmpty = computed(() => {
  const p = plan.value;
  return (
    !!p &&
    p.counts.restores === 0 &&
    p.counts.trashCurrent === 0 &&
    p.counts.fromTrash === 0 &&
    p.counts.noSnapshot === 0 &&
    p.counts.lostDeletes === 0
  );
});
</script>

<template>
  <ModalShell
    :open="!!folder"
    title="文件时间机器"
    :description="lastPath"
    description-mono
    wide
    @close="emit('close')"
  >
    <p class="modal-lead">
      文件被对端覆盖修改前,旧内容会自动留档在这里。点开文件看它的版本时间轴、任意选两个版本对比差异;
      底部还能把整个目录回滚到某个时刻(先出计划、再执行,当前内容一律先进版本/回收站,可反悔)。
    </p>

    <div v-if="loading" class="history-loading">读取中…</div>
    <div v-else-if="versions.length === 0" class="empty">还没有版本留档</div>
    <div v-else class="tm-groups">
      <div v-for="g in groups" :key="g.path" class="tm-group">
        <div class="history-row tm-group-head" @click="openPath = openPath === g.path ? null : g.path">
          <span class="history-path mono break">{{ g.path }}</span>
          <span class="history-size muted">{{ g.versions.length }} 版 · 最近 {{ fmtTime(g.latest) }}</span>
        </div>
        <ul v-if="openPath === g.path" class="history-list tm-timeline">
          <li v-for="v in g.versions" :key="v.file" class="history-row">
            <input
              type="checkbox"
              class="tm-pick"
              :checked="picked.includes(v.file)"
              :aria-label="`选择版本 ${fmtTime(v.mtime)}`"
              @change="togglePick(v.file)"
            />
            <span class="history-time">{{ fmtTime(v.mtime) }}</span>
            <span class="history-size muted">{{ formatBytes(v.size) }}</span>
            <span class="history-ops">
              <n-button size="tiny" type="primary" quaternary :loading="restoring === v.file" @click="restore(v)">
                恢复
              </n-button>
              <n-button size="tiny" type="error" quaternary @click="askDelete(v)">删除</n-button>
            </span>
          </li>
          <li class="tm-pair-row">
            <n-button size="tiny" :disabled="picked.length !== 2" :loading="diffLoading" @click="comparePair">
              对比所选两版({{ picked.length }}/2)
            </n-button>
            <span class="muted tm-pair-hint">勾选时间轴上的两个版本即可 diff</span>
          </li>
        </ul>
        <pre v-if="pairDiff && openPath === pairDiff.path" class="tm-diff"><span class="tm-diff-meta">{{ pairDiff.path }} · {{ pairDiff.oldLabel }} → {{ pairDiff.newLabel }}{{ pairDiff.note ? ` · ${pairDiff.note}` : '' }}</span>
<template v-for="(l, i) in pairDiff.lines" :key="i"><span :class="`tm-diff-${l.kind}`">{{ l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  ' }}{{ l.text }}</span>
</template></pre>
      </div>
    </div>

    <!-- 整目录回滚 -->
    <div class="edit-section-label tm-rb-title">回滚整个目录到…</div>
    <div class="tm-rb-row">
      <input v-model="rbTime" type="datetime-local" class="tm-rb-input" :disabled="rbBusy" :max="fmtLocalInput(Date.now())" />
      <n-button size="small" :loading="rbBusy" @click="previewRollback">预览计划</n-button>
      <n-button v-if="plan && !planEmpty" size="small" type="error" :disabled="rbBusy" @click="rbConfirm = true">
        执行回滚
      </n-button>
    </div>
    <p class="confirm-note-extra">
      依据版本留档、回收站与同步记录推断目标时刻的内容(启发式,不保证逐字节还原)。
      执行时当前内容先进版本/回收站,动作可逆;结果会同步给对端。
    </p>
    <p v-if="rbResult" class="tm-rb-result">{{ rbResult }}</p>
    <div v-if="plan" class="tm-plan">
      <div v-if="planEmpty" class="muted">计划为空:该时刻前后没有可判定的差异,目录将保持不动。</div>
      <template v-else>
        <div class="tm-plan-head">
          目标 {{ fmtTime(plan.targetTs) }} · 恢复 {{ plan.counts.restores }} · 回收新增 {{ plan.counts.trashCurrent }} ·
          从回收站找回 {{ plan.counts.fromTrash }} · 无快照 {{ plan.counts.noSnapshot }} · 无法找回 {{ plan.counts.lostDeletes }}
        </div>
        <ul class="tm-plan-list">
          <li v-for="r in plan.restores.slice(0, 20)" :key="'r' + r.relPath">
            <span class="mono">{{ r.relPath }}</span>
            <span class="muted">← 快照 {{ fmtTime(r.versionTs) }}</span>
          </li>
          <li v-for="d in plan.trashCurrent.slice(0, 20)" :key="'d' + d.relPath">
            <span class="mono">{{ d.relPath }}</span> <span class="muted">目标时刻后新增 → 进回收站</span>
          </li>
          <li v-for="t in plan.fromTrash.slice(0, 20)" :key="'t' + t.relPath">
            <span class="mono">{{ t.relPath }}</span> <span class="muted">← 从回收站找回</span>
          </li>
          <li v-for="n in plan.noSnapshot.slice(0, 10)" :key="'n' + n" class="tm-plan-warn">
            <span class="mono">{{ n }}</span> <span class="muted">目标时刻后有改动但没有快照,无法恢复</span>
          </li>
          <li v-for="l in plan.lostDeletes.slice(0, 10)" :key="'l' + l" class="tm-plan-warn">
            <span class="mono">{{ l }}</span> <span class="muted">目标时刻后被删且无副本,找不回来</span>
          </li>
        </ul>
        <p v-if="plan.counts.restores > 20 || plan.counts.trashCurrent > 20 || plan.counts.fromTrash > 20" class="muted tm-plan-more">
          明细仅展示前 20 条
        </p>
      </template>
    </div>

    <template #footer>
      <n-button type="primary" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>

  <!-- 删除二次确认(不可逆) -->
  <ModalShell
    :open="!!askConfirmDelete"
    title="删除版本留档"
    :description="askConfirmDelete?.path"
    description-mono
    @close="askConfirmDelete = null"
  >
    <p class="modal-lead">删除后该留档不可恢复。共享目录里的当前文件不受影响。</p>
    <template #footer>
      <n-button @click="askConfirmDelete = null">取消</n-button>
      <n-button type="error" @click="confirmDelete">删除</n-button>
    </template>
  </ModalShell>

  <!-- 回滚二次确认:把「会动什么」完整复述一遍再落刀 -->
  <ModalShell
    :open="rbConfirm"
    title="执行整目录回滚"
    :description="plan ? `目标时刻 ${fmtTime(plan.targetTs)}` : ''"
    @close="rbConfirm = false"
  >
    <p v-if="plan" class="modal-lead">
      将恢复 {{ plan.counts.restores }} 个文件、把 {{ plan.counts.trashCurrent }} 个「目标时刻后新增」移入回收站、
      找回 {{ plan.counts.fromTrash }} 个被删文件。当前内容都会先留档,可再反悔。确定执行?
    </p>
    <template #footer>
      <n-button @click="rbConfirm = false">取消</n-button>
      <n-button type="error" @click="executeRollback">执行回滚</n-button>
    </template>
  </ModalShell>
</template>

<style scoped>
.history-size {
  flex: none;
  font-size: 12px;
}
.history-ops {
  flex: none;
  display: inline-flex;
  gap: 2px;
}
.tm-group-head {
  cursor: pointer;
  user-select: none;
}
.tm-timeline {
  margin: 2px 0 8px 18px;
}
.tm-pick {
  flex: none;
  margin-right: 4px;
  accent-color: #2080f0;
}
.tm-pair-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}
.tm-pair-hint {
  font-size: 12px;
}
.tm-diff {
  max-height: 280px;
  overflow: auto;
  margin: 4px 0 10px 18px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(128, 128, 128, 0.08);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
.tm-diff-meta {
  display: block;
  margin-bottom: 6px;
  opacity: 0.7;
}
.tm-diff-add {
  color: #2e9e4f;
}
.tm-diff-del {
  color: #d03050;
}
.tm-rb-title {
  margin-top: 14px;
}
.tm-rb-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.tm-rb-input {
  padding: 5px 9px;
  border-radius: 6px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  background: transparent;
  color: inherit;
  font: inherit;
}
.tm-rb-result {
  margin: 8px 0 0;
  font-size: 12px;
  color: #2e9e4f;
}
.tm-plan {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(128, 128, 128, 0.25);
  font-size: 12px;
}
.tm-plan-head {
  font-weight: 600;
  margin-bottom: 6px;
}
.tm-plan-list {
  margin: 0;
  padding-left: 18px;
}
.tm-plan-list li {
  margin: 2px 0;
}
.tm-plan-warn {
  color: #e08a3c;
}
.tm-plan-more {
  margin: 6px 0 0;
}
</style>
