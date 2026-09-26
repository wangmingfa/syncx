<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { NButton, NSelect } from 'naive-ui';
import ElevateGateModal from './components/ElevateGateModal.vue';
import ToastView from './components/ToastView.vue';
import { useToast } from './composables/useToast';
import { apiJson, apiPost, errText } from './utils/api';
import { formatBytes } from './utils/bytes';
import { fmtTime } from './utils/format';
import { ensureElevated } from './utils/elevation';
import { navigate, route } from './utils/route';
import type { FolderInfo, StatusData, TrashEntry, TrashListing } from './types';

/**
 * Web 回收站页(路由 /trash):浏览某共享目录里被删除文件的本地副本,支持还原与彻底删除。
 *
 * 数据来源是删除时 executor 落到 <configDir>/trash/<目录哈希>/ 的副本 —— 只读文件名反解
 * 出「原相对路径 + 删除时刻」,不落额外元数据。所以这里看到的都是**本机**删过的东西,
 * 与「对端删除」无关(对端删除不会在本机留副本)。
 *
 * 鉴权分两档(与后端 src/api/routes/files.ts 的 tryTrashRoutes 对应):
 * - 列回收站是只读操作,登录会话即可,进页面/切目录不弹验证门;
 * - 还原 / 彻底删除会真实改动文件系统,属敏感操作 —— 彻底删除先落二次确认卡,
 *   还原与删除都经 ensureElevated 提权门(与文件管理器/终端同一条门)才提交。
 *
 * 还原:把副本 renameSync 回原相对路径(若同名文件已在,先把它挪进回收站,不丢数据),
 * 随后 daemon 触发一次扫描,把「文件复活」作为新版本广播给对端。
 * 彻底删除:单个删副本;「清空回收站」删整个目录(不可逆,确认卡里写明)。
 */

const { showToast } = useToast();

const folders = ref<FolderInfo[]>([]);
/** 当前查看的共享目录 id(= FolderInfo.id ?? path,与 API 的 folderId 同形)。 */
const folderId = ref('');
const entries = ref<TrashEntry[]>([]);
const loading = ref(false);
const error = ref('');
/** 行级操作进行中(还原/删除),禁用按钮避免连点。 */
const busy = ref(false);
/** 待二次确认的彻底删除:entry = 删单个副本;'all' = 清空整个目录;null = 无。 */
const pendingPurge = ref<TrashEntry | 'all' | null>(null);

const folderOptions = computed(() =>
  folders.value.map((f) => {
    const id = f.id ?? f.path;
    return { label: f.id ? `${f.id} — ${f.path}` : f.path, value: id };
  }),
);

const currentFolder = computed(() => folders.value.find((f) => (f.id ?? f.path) === folderId.value) ?? null);

async function load(): Promise<void> {
  if (!folderId.value) {
    entries.value = [];
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const data = await apiJson<TrashListing>(`/api/trash?folderId=${encodeURIComponent(folderId.value)}`);
    entries.value = data.entries ?? [];
  } catch (e) {
    error.value = errText(e, '读取回收站失败');
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

/** 切换目录:回到该目录回收站,并把 ?folder= 写进地址栏(链接可分享/刷新保持)。 */
function selectFolder(id: string): void {
  folderId.value = id;
  entries.value = [];
  navigate(`/trash?folder=${encodeURIComponent(id)}`);
  void load();
}

/** 还原单个副本:先过提权门(会改文件系统),放行后提交并刷新。 */
function restore(entry: TrashEntry): void {
  if (busy.value) return;
  void ensureElevated(`还原 ${entry.path}`, () => {
    void doRestore(entry);
  });
}

async function doRestore(entry: TrashEntry): Promise<void> {
  busy.value = true;
  try {
    await apiPost('/api/trash/restore', { folderId: folderId.value, file: entry.file });
    showToast(`已还原「${entry.path}」,正在同步给对端`);
    await load();
  } catch (e) {
    showToast(errText(e, '还原失败'), 'alert');
  } finally {
    busy.value = false;
  }
}

/** 彻底删除入口:先落二次确认卡(不可逆),确认后再过提权门。 */
function askPurge(entry: TrashEntry): void {
  pendingPurge.value = entry;
}

function askPurgeAll(): void {
  pendingPurge.value = 'all';
}

function confirmPurge(): void {
  const target = pendingPurge.value;
  if (!target) return;
  pendingPurge.value = null;
  const all = target === 'all';
  void ensureElevated(all ? '清空回收站' : `彻底删除 ${target.path}`, () => {
    void doPurge(all ? undefined : target);
  });
}

async function doPurge(entry: TrashEntry | undefined): Promise<void> {
  busy.value = true;
  try {
    const body: { folderId: string; file?: string } = { folderId: folderId.value };
    if (entry) body.file = entry.file;
    await apiPost('/api/trash/purge', body);
    showToast(entry ? `已彻底删除「${entry.path}」的副本` : '已清空该目录的回收站');
    await load();
  } catch (e) {
    showToast(errText(e, '删除失败'), 'alert');
  } finally {
    busy.value = false;
  }
}

// 地址栏直达(?folder=)/ 从别的页再回来时,同步选中目录
watch(
  () => route.value,
  (r) => {
    if (r.name !== 'trash') return;
    const target = r.folderId ?? '';
    if (target && target !== folderId.value && folders.value.some((f) => (f.id ?? f.path) === target)) {
      folderId.value = target;
      void load();
    }
  },
);

onMounted(async () => {
  try {
    const data = await apiJson<StatusData>('/api/status');
    folders.value = data.folders ?? [];
  } catch {
    // 401 已被 apiJson 统一跳转 /login;其余错误列不出目录,页面显示空态
    folders.value = [];
  }
  const target = route.value.folderId ?? '';
  if (target && folders.value.some((f) => (f.id ?? f.path) === target)) {
    folderId.value = target;
    await load();
  }
});
</script>

<template>
  <div class="tp-page">
    <ToastView />

    <header class="tp-top">
      <a class="tp-back" href="/" title="返回状态页">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        <span>状态页</span>
      </a>
      <h1 class="tp-title">回收站</h1>
      <div class="tp-folder-pick">
        <n-select
          size="small"
          :value="folderId || null"
          :options="folderOptions"
          placeholder="选择共享目录"
          :disabled="!folderOptions.length"
          @update:value="selectFolder"
        />
        <n-button size="small" tertiary :disabled="!folderId || loading || busy" @click="load()">刷新</n-button>
        <n-button
          size="small"
          tertiary
          type="error"
          :disabled="!folderId || loading || busy || entries.length === 0"
          @click="askPurgeAll"
        >清空回收站</n-button>
      </div>
    </header>

    <main class="tp-main">
      <div v-if="!folderOptions.length" class="tp-state">
        还没有共享目录。先在<a href="/">状态页</a>添加或接受一个共享邀请。
      </div>

      <div v-else-if="!folderId" class="tp-empty-pick">
        <p class="tp-state">请选择要查看回收站的共享目录:</p>
        <div class="tp-folder-grid">
          <button
            v-for="f in folders"
            :key="f.id ?? f.path"
            type="button"
            class="tp-folder-card"
            @click="selectFolder(f.id ?? f.path)"
          >
            <svg class="tp-icon is-dir" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17Z" />
            </svg>
            <span class="tp-folder-name mono">{{ f.id ?? f.path }}</span>
            <span class="tp-folder-path mono" :title="f.path">{{ f.path }}</span>
          </button>
        </div>
      </div>

      <template v-else>
        <p class="tp-note">
          显示的是本机在「{{ currentFolder?.path ?? folderId }}」里删除过的文件副本。还原会放回原路径并同步给对端;彻底删除不可逆。
        </p>

        <div v-if="loading" class="tp-state">读取中…</div>
        <div v-else-if="error" class="tp-state is-error">{{ error }}</div>
        <div v-else-if="entries.length === 0" class="tp-state">回收站是空的。</div>
        <template v-else>
          <div class="tp-head">
            <span class="tp-col-path">原路径</span>
            <span class="tp-col-meta">大小</span>
            <span class="tp-col-meta">删除时间</span>
            <span class="tp-col-ops">操作</span>
          </div>
          <div class="tp-rows">
            <div v-for="entry in entries" :key="entry.file" class="tp-row">
              <span class="tp-col-path tp-path mono" :title="entry.path">{{ entry.path }}</span>
              <span class="tp-col-meta tp-meta-txt">{{ formatBytes(entry.size) }}</span>
              <span class="tp-col-meta tp-meta-txt tp-time">{{ fmtTime(entry.ts) }}</span>
              <span class="tp-col-ops">
                <n-button size="tiny" tertiary :disabled="busy" @click="restore(entry)">还原</n-button>
                <n-button size="tiny" tertiary type="error" :disabled="busy" @click="askPurge(entry)">彻底删除</n-button>
              </span>
            </div>
          </div>
        </template>
      </template>
    </main>

    <!-- 彻底删除二次确认:不可逆,先讲清楚再落提权门 -->
    <div v-if="pendingPurge" class="tp-confirm-scrim" @click.self="pendingPurge = null">
      <div class="tp-confirm-card" role="alertdialog" aria-modal="true">
        <h2 class="tp-confirm-title">{{ pendingPurge === 'all' ? '清空回收站?' : '彻底删除该副本?' }}</h2>
        <p class="tp-confirm-msg">
          {{ pendingPurge === 'all'
            ? '将永久删除本目录回收站里的所有副本。这些副本将无法再还原(共享目录里的原文件不受影响)。'
            : '将永久删除这条回收站副本,之后无法再还原(共享目录里的原文件不受影响)。' }}
        </p>
        <p v-if="pendingPurge !== 'all'" class="tp-confirm-detail mono">{{ pendingPurge.path }}</p>
        <div class="tp-confirm-ops">
          <n-button size="small" :disabled="busy" @click="pendingPurge = null">取消</n-button>
          <n-button size="small" type="error" :disabled="busy" @click="confirmPurge">确认删除</n-button>
        </div>
      </div>
    </div>

    <!-- 提权验证门(与文件管理器 / 终端共用):ensureElevated 拦下时在此弹出 -->
    <ElevateGateModal />
  </div>
</template>

<style scoped>
.tp-page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
}

.tp-top {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 18px;
  background: var(--card);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 10;
}

.tp-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted-strong);
  text-decoration: none;
  font-size: 13px;
  white-space: nowrap;
}
.tp-back:hover { color: var(--accent); }

.tp-title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  white-space: nowrap;
}

.tp-folder-pick {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 320px;
  max-width: 620px;
}

.tp-main {
  flex: 1;
  width: 100%;
  max-width: 1100px;
  margin: 0 auto;
  padding: 16px 18px 40px;
}

.tp-state {
  padding: 26px 4px;
  color: var(--muted);
  font-size: 13.5px;
  text-align: center;
}
.tp-state.is-error { color: var(--offline); }
.tp-state a { color: var(--accent); }

.tp-note {
  margin: 0 0 12px;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.6;
}

.tp-empty-pick { padding-top: 18px; }

.tp-folder-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.tp-folder-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 14px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  color: var(--text);
  text-align: left;
}
.tp-folder-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow);
}
.tp-folder-name { font-size: 13.5px; font-weight: 600; word-break: break-all; }
.tp-folder-path { font-size: 11.5px; color: var(--muted); word-break: break-all; }

.tp-head,
.tp-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 90px 150px 160px;
  align-items: center;
  gap: 10px;
}

.tp-head {
  padding: 6px 12px;
  font-size: 11.5px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}

.tp-rows {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.tp-row {
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
}
.tp-row:last-child { border-bottom: none; }
.tp-row:hover { background: var(--bg-soft); }

.tp-path {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-icon { color: var(--muted); flex: none; }
.tp-icon.is-dir { color: var(--accent); }

.tp-meta-txt {
  font-size: 12px;
  color: var(--muted-strong);
}
.tp-time { white-space: nowrap; }

.tp-col-meta { text-align: left; }
.tp-col-ops { display: flex; justify-content: flex-end; gap: 6px; }

.tp-confirm-scrim {
  position: fixed;
  inset: 0;
  background: rgb(10 16 26 / 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
  padding: 20px;
}
.tp-confirm-card {
  width: min(420px, 100%);
  background: var(--card);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  padding: 18px;
}
.tp-confirm-title { margin: 0 0 8px; font-size: 15px; }
.tp-confirm-msg { margin: 0 0 8px; font-size: 13px; color: var(--muted-strong); line-height: 1.6; }
.tp-confirm-detail {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--muted);
  word-break: break-all;
  background: var(--bg-soft);
  border-radius: 8px;
  padding: 7px 9px;
}
.tp-confirm-ops { display: flex; justify-content: flex-end; gap: 8px; }
</style>
