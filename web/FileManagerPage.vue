<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { NButton, NSelect } from 'naive-ui';
import ElevateGateModal from './components/ElevateGateModal.vue';
import ToastView from './components/ToastView.vue';
import { useToast } from './composables/useToast';
import { apiJson, errText } from './utils/api';
import { formatBytes } from './utils/bytes';
import { fmtTime } from './utils/format';
import { ensureElevated } from './utils/elevation';
import { navigate, route } from './utils/route';
import type { FolderDirEntry, FolderDirListing, FolderInfo, StatusData } from './types';

/**
 * 浏览器内文件管理器页(路由 /files):浏览共享目录的真实文件(不走索引,
 * 所见即盘面),支持进入子目录、下载单个文件、删除文件/整个子目录。
 *
 * 鉴权分两档(与后端 src/api/routes/files.ts 对应):
 * - 浏览/下载是只读操作,登录会话即可,进页面/翻页不再弹验证门;
 * - 删除会真实变更文件系统,并作为本地删除在下一轮扫描传播给对端 —— 敏感操作,
 *   点击后经二次确认 + ensureElevated 提权门(终端同一条门,10 分钟窗口、
 *   滑动续期等频率逻辑与之前完全一致)才真正提交。
 *
 * 未登录时 apiJson 统一 401 → 跳 /login,本页无需自渲染登录态。
 */

const { showToast } = useToast();

const folders = ref<FolderInfo[]>([]);
/** 当前浏览的共享目录 id(= FolderInfo.id ?? path,与 API 的 folderId 同形)。 */
const folderId = ref('');
const relPath = ref('');
const listing = ref<FolderDirListing | null>(null);
const loading = ref(false);
const error = ref('');
/** 行级操作进行中(下载/删除),禁用按钮避免连点。 */
const busy = ref(false);

const currentFolder = computed(() => folders.value.find((f) => (f.id ?? f.path) === folderId.value) ?? null);

const folderOptions = computed(() =>
  folders.value.map((f) => {
    const id = f.id ?? f.path;
    return { label: f.id ? `${f.id} — ${f.path}` : f.path, value: id };
  }),
);

/** 面包屑段:共享目录根 + 逐级子目录,点击回跳。 */
const crumbs = computed<Array<{ name: string; path: string }>>(() => {
  const parts = relPath.value ? relPath.value.split('/') : [];
  const segs: Array<{ name: string; path: string }> = [{ name: currentFolder.value?.path ?? '/', path: '' }];
  let acc = '';
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    segs.push({ name: p, path: acc });
  }
  return segs;
});

async function load(): Promise<void> {
  if (!folderId.value) return;
  loading.value = true;
  error.value = '';
  try {
    listing.value = await apiJson<FolderDirListing>(
      `/api/folder-files?folderId=${encodeURIComponent(folderId.value)}&path=${encodeURIComponent(relPath.value)}`,
    );
  } catch (e) {
    error.value = errText(e, '读取目录失败');
    listing.value = null;
  } finally {
    loading.value = false;
  }
}

/** 切换目录:回到该目录根,并把 ?folder= 写进地址栏(链接可分享/刷新保持)。 */
function selectFolder(id: string): void {
  folderId.value = id;
  relPath.value = '';
  listing.value = null;
  navigate(`/files?folder=${encodeURIComponent(id)}`);
  void load();
}

function enter(entry: FolderDirEntry): void {
  if (!entry.dir) return;
  relPath.value = entry.path;
  void load();
}

/** 下载单个文件:走鉴权 fetch(会话 cookie)拿 blob,再借 <a download> 触发保存。 */
async function download(entry: FolderDirEntry): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await fetch(
      `/api/folder-files/download?folderId=${encodeURIComponent(folderId.value)}&path=${encodeURIComponent(entry.path)}`,
    );
    if (!res.ok) throw new Error(`下载失败 (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = entry.name;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast(errText(e, '下载失败'), 'alert');
  } finally {
    busy.value = false;
  }
}

/**
 * 按需同步的占位文件「下载」:POST /api/folders/materialize 让 daemon 经既有块
 * 管线向在线对端拉取,收齐后自动落地(本接口返回只代表「已开始拉取」)。
 * 拉完前该行仍是「未下载」,故 3s 后自动刷新一次列表兜底,不跟传输状态较真。
 */
async function materialize(entry: FolderDirEntry): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await apiJson('/api/folders/materialize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: folderId.value, path: entry.path }),
    });
    showToast(`正在下载「${entry.name}」,完成后本行自动消失`);
    setTimeout(() => void load(), 3000);
  } catch (e) {
    showToast(errText(e, '下载请求失败'), 'alert');
  } finally {
    busy.value = false;
  }
}

/**
 * 单文件暂停/继续:POST /api/folders/pause-file 切换该路径的双向冻结。
 * 暂停后本机改动不外推、对端改动(含删除)不落地,但文件仍在索引与盘上;
 * 恢复后下一轮索引交换自然收敛。仅需登录会话(非敏感:不改盘上内容),不过提权门。
 */
async function togglePause(entry: FolderDirEntry): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const next = !entry.paused;
  try {
    await apiJson('/api/folders/pause-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: folderId.value, path: entry.path, paused: next }),
    });
    entry.paused = next;
    showToast(next ? `已暂停「${entry.name}」的同步` : `已恢复「${entry.name}」的同步`);
  } catch (e) {
    showToast(errText(e, '设置单文件暂停失败'), 'alert');
  } finally {
    busy.value = false;
  }
}

/**
 * 删除入口:先落二次确认卡(写明会同步传播给对端),确认后再过提权门 ——
 * 顺序刻意如此:取消确认就不该白弹一次验证。提权通过与后端 DELETE 403 门对应。
 */
function askDelete(entry: FolderDirEntry): void {
  pendingDelete.value = entry;
}

/** 确认卡「确认删除」:关门 → ensureElevated(终端同一条门)→ 真正提交。 */
function confirmDelete(): void {
  const entry = pendingDelete.value;
  if (!entry) return;
  pendingDelete.value = null;
  void ensureElevated(`删除${entry.dir ? '目录' : '文件'} ${entry.path}`, () => {
    void doDelete(entry);
  });
}

/** 二次确认待删除项(非空 = 显示确认条)。 */
const pendingDelete = ref<FolderDirEntry | null>(null);

async function doDelete(entry: FolderDirEntry): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await apiJson(
      `/api/folder-files?folderId=${encodeURIComponent(folderId.value)}&path=${encodeURIComponent(entry.path)}`,
      { method: 'DELETE' },
    );
    showToast(`已删除 ${entry.name}`);
    await load();
  } catch (e) {
    showToast(errText(e, '删除失败'), 'alert');
  } finally {
    busy.value = false;
  }
}

// 地址栏直达(?folder=)/ 后退到别的页再回来时,同步选中目录
watch(
  () => route.value,
  (r) => {
    if (r.name !== 'files') return;
    const target = r.folderId ?? '';
    if (target && target !== folderId.value && folders.value.some((f) => (f.id ?? f.path) === target)) {
      folderId.value = target;
      relPath.value = '';
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
  <div class="fm-page">
    <ToastView />

    <header class="fm-top">
      <a class="fm-back" href="/" title="返回状态页">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        <span>状态页</span>
      </a>
      <h1 class="fm-title">文件管理器</h1>
      <div class="fm-folder-pick">
        <n-select
          size="small"
          :value="folderId || null"
          :options="folderOptions"
          placeholder="选择共享目录"
          :disabled="!folderOptions.length"
          @update:value="selectFolder"
        />
        <n-button size="small" tertiary :disabled="!folderId || loading" @click="load()">刷新</n-button>
      </div>
    </header>

    <main class="fm-main">
      <div v-if="!folderOptions.length" class="fm-state">
        还没有共享目录。先在<a href="/">状态页</a>添加或接受一个共享邀请。
      </div>

      <div v-else-if="!folderId" class="fm-empty-pick">
        <p class="fm-state">请选择要浏览的共享目录:</p>
        <div class="fm-folder-grid">
          <button
            v-for="f in folders"
            :key="f.id ?? f.path"
            type="button"
            class="fm-folder-card"
            @click="selectFolder(f.id ?? f.path)"
          >
            <svg class="fm-icon is-dir" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17Z" />
            </svg>
            <span class="fm-folder-name mono">{{ f.id ?? f.path }}</span>
            <span class="fm-folder-path mono" :title="f.path">{{ f.path }}</span>
          </button>
        </div>
      </div>

      <template v-else>
        <nav class="fm-crumbs">
          <span v-for="(c, i) in crumbs" :key="c.path" class="fm-crumb-wrap">
            <span v-if="i > 0" class="fm-crumb-sep">/</span>
            <button
              type="button"
              class="fm-crumb mono"
              :class="{ 'is-current': i === crumbs.length - 1 }"
              :title="c.path"
              @click="relPath = c.path; load()"
            >{{ c.name }}</button>
          </span>
        </nav>

        <div v-if="loading" class="fm-state">读取中…</div>
        <div v-else-if="error" class="fm-state is-error">{{ error }}</div>
        <div v-else-if="!listing || listing.entries.length === 0" class="fm-state">目录为空</div>
        <template v-else>
          <div v-if="listing.truncated" class="fm-state is-note">条目过多,仅显示前 {{ listing.entries.length }} 项</div>
          <div class="fm-head">
            <span class="fm-col-name">名称</span>
            <span class="fm-col-meta">大小</span>
            <span class="fm-col-meta">修改时间</span>
            <span class="fm-col-ops">操作</span>
          </div>
          <div class="fm-rows">
            <div v-for="entry in listing.entries" :key="entry.path" class="fm-row" :class="{ 'is-paused': entry.paused }">
              <button
                type="button"
                class="fm-col-name fm-name"
                :title="entry.dir ? '打开目录' : entry.paused ? '已暂停同步(双向冻结)' : entry.placeholder ? '未下载(按需同步占位),点击开始拉取' : entry.name"
                @click="entry.dir ? enter(entry) : entry.placeholder ? materialize(entry) : download(entry)"
              >
                <svg v-if="entry.dir" class="fm-icon is-dir" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17Z" />
                </svg>
                <svg v-else class="fm-icon" :class="{ 'is-placeholder': entry.placeholder }" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5Z" />
                  <path d="M14 3.5V8h4" />
                </svg>
                <span class="mono">{{ entry.name }}</span>
                <span v-if="entry.paused" class="fm-badge-paused">已暂停</span>
                <span v-else-if="entry.placeholder" class="fm-badge-unloaded">未下载</span>
              </button>
              <span class="fm-col-meta fm-meta-txt">{{ entry.dir ? '—' : formatBytes(entry.size) }}</span>
              <span class="fm-col-meta fm-meta-txt fm-time">{{ entry.placeholder ? '—' : fmtTime(entry.mtime) }}</span>
              <span class="fm-col-ops">
                <n-button v-if="entry.placeholder" size="tiny" tertiary :disabled="busy" @click="materialize(entry)">下载</n-button>
                <n-button v-else-if="!entry.dir" size="tiny" tertiary :disabled="busy" @click="download(entry)">下载</n-button>
                <n-button v-if="!entry.dir" size="tiny" tertiary :disabled="busy" @click="togglePause(entry)">{{ entry.paused ? '继续同步' : '暂停同步' }}</n-button>
                <n-button v-if="!entry.placeholder" size="tiny" tertiary type="error" :disabled="busy" @click="askDelete(entry)">删除</n-button>
              </span>
            </div>
          </div>
        </template>
      </template>
    </main>

    <!-- 删除二次确认:提权门通过后先落到这里,确认才真正删除 -->
    <div v-if="pendingDelete" class="fm-confirm-scrim" @click.self="pendingDelete = null">
      <div class="fm-confirm-card" role="alertdialog" aria-modal="true">
        <h2 class="fm-confirm-title">删除{{ pendingDelete.dir ? '目录' : '文件' }}?</h2>
        <p class="fm-confirm-msg">
          {{ pendingDelete.dir
            ? '将删除整个子目录(含其中所有文件)。删除会同步给所有共享该目录的设备。'
            : '将删除该文件,并同步给所有共享该目录的设备。' }}
        </p>
        <p class="fm-confirm-detail mono">{{ pendingDelete.path }}</p>
        <div class="fm-confirm-ops">
          <n-button size="small" :disabled="busy" @click="pendingDelete = null">取消</n-button>
          <n-button size="small" type="error" :disabled="busy" @click="confirmDelete">确认删除</n-button>
        </div>
      </div>
    </div>

    <!-- 提权验证门(与终端共用):ensureElevated 拦下时在此弹出 -->
    <ElevateGateModal />
  </div>
</template>

<style scoped>
.fm-page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
}

.fm-top {
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

.fm-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted-strong);
  text-decoration: none;
  font-size: 13px;
  white-space: nowrap;
}
.fm-back:hover { color: var(--accent); }

.fm-title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  white-space: nowrap;
}

.fm-folder-pick {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 320px;
  max-width: 560px;
}

.fm-main {
  flex: 1;
  width: 100%;
  max-width: 1100px;
  margin: 0 auto;
  padding: 16px 18px 40px;
}

.fm-state {
  padding: 26px 4px;
  color: var(--muted);
  font-size: 13.5px;
  text-align: center;
}
.fm-state.is-error { color: var(--offline); }
.fm-state.is-note { color: var(--muted-strong); padding: 10px 4px; text-align: left; }
.fm-state a { color: var(--accent); }

.fm-empty-pick { padding-top: 18px; }

.fm-folder-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.fm-folder-card {
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
.fm-folder-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow);
}
.fm-folder-name { font-size: 13.5px; font-weight: 600; word-break: break-all; }
.fm-folder-path { font-size: 11.5px; color: var(--muted); word-break: break-all; }

.fm-crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  margin-bottom: 10px;
}
.fm-crumb-wrap { display: inline-flex; align-items: center; gap: 2px; }
.fm-crumb-sep { color: var(--muted); }
.fm-crumb {
  border: none;
  background: none;
  color: var(--muted-strong);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  padding: 3px 6px;
  border-radius: 6px;
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fm-crumb:hover { background: var(--accent-soft); color: var(--accent); }
.fm-crumb.is-current { color: var(--text); font-weight: 600; cursor: default; }
.fm-crumb.is-current:hover { background: none; color: var(--text); }

.fm-head,
.fm-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 84px 140px 210px;
  align-items: center;
  gap: 10px;
}

.fm-head {
  padding: 6px 12px;
  font-size: 11.5px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}

.fm-rows {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.fm-row {
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
}
.fm-row:last-child { border-bottom: none; }
.fm-row:hover { background: var(--bg-soft); }

.fm-name {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  padding: 0;
  min-width: 0;
  text-align: left;
}
.fm-name span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fm-name:hover { color: var(--accent); }

.fm-icon { color: var(--muted); flex: none; }
.fm-icon.is-dir { color: var(--accent); }
.fm-icon.is-placeholder { color: var(--muted); opacity: 0.6; }

.fm-badge-unloaded {
  flex: none;
  font-size: 10.5px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 999px;
  color: var(--muted-strong);
  background: var(--bg-soft);
  border: 1px solid var(--border);
}

.fm-badge-paused {
  flex: none;
  font-size: 10.5px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 999px;
  color: #b8860b;
  background: rgb(184 134 11 / 0.12);
  border: 1px solid rgb(184 134 11 / 0.4);
}

/* 已暂停行:名称淡出,提示该路径双向冻结 */
.fm-row.is-paused .fm-name span.mono { opacity: 0.5; }
.fm-row.is-paused .fm-meta-txt { opacity: 0.6; }

.fm-meta-txt {
  font-size: 12px;
  color: var(--muted-strong);
}
.fm-time { white-space: nowrap; }

.fm-col-meta { text-align: left; }
.fm-col-ops { display: flex; justify-content: flex-end; gap: 6px; }

.fm-confirm-scrim {
  position: fixed;
  inset: 0;
  background: rgb(10 16 26 / 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
  padding: 20px;
}
.fm-confirm-card {
  width: min(420px, 100%);
  background: var(--card);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  padding: 18px;
}
.fm-confirm-title { margin: 0 0 8px; font-size: 15px; }
.fm-confirm-msg { margin: 0 0 8px; font-size: 13px; color: var(--muted-strong); line-height: 1.6; }
.fm-confirm-detail {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--muted);
  word-break: break-all;
  background: var(--bg-soft);
  border-radius: 8px;
  padding: 7px 9px;
}
.fm-confirm-ops { display: flex; justify-content: flex-end; gap: 8px; }
</style>
