<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { NButton } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';
import { apiJson, errText } from '../utils/api';
import { formatBytes } from '../utils/bytes';
import type { FolderDirEntry, FolderDirListing } from '../types';
import ModalShell from './ModalShell.vue';

/**
 * 浏览器内文件管理器:浏览共享目录的真实文件(不走索引,所见即盘面),
 * 支持进入子目录、下载单个文件、删除文件/整个子目录。
 *
 * 删除是真实删除:下一轮扫描会把它作为本地删除传播给对端 —— 所以走全局
 * 二次确认弹窗,并在文案里写明影响面。目录列举超上限时提示截断。
 */
const props = defineProps<{ folder: { id?: string; path: string } | null }>();
const emit = defineEmits<{ close: [] }>();

const { busy, askConfirm, fmtTime, showToast } = useStatusContext();

const loading = ref(false);
const error = ref('');
const relPath = ref('');
const listing = ref<FolderDirListing | null>(null);

const folderId = computed(() => props.folder?.id ?? props.folder?.path ?? '');

/** 面包屑段:根目录 + 逐级子目录,点击回跳。 */
const crumbs = computed<Array<{ name: string; path: string }>>(() => {
  const parts = relPath.value ? relPath.value.split('/') : [];
  const segs: Array<{ name: string; path: string }> = [{ name: props.folder?.path ?? '', path: '' }];
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

watch(
  () => props.folder,
  (f) => {
    if (!f) return;
    relPath.value = '';
    listing.value = null;
    void load();
  },
);

function enter(entry: FolderDirEntry): void {
  if (!entry.dir) return;
  relPath.value = entry.path;
  void load();
}

/** 下载单个文件:走鉴权 fetch(会话 cookie)拿 blob,再借 <a download> 触发保存。 */
async function download(entry: FolderDirEntry): Promise<void> {
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
  }
}

function askDelete(entry: FolderDirEntry): void {
  askConfirm({
    title: '删除?',
    message: entry.dir
      ? '将删除整个子目录(含其中所有文件)。删除会同步给所有共享该目录的设备。'
      : '将删除该文件,并同步给所有共享该目录的设备。',
    detail: entry.path,
    confirmText: '删除',
    action: () => doDelete(entry),
  });
}

async function doDelete(entry: FolderDirEntry): Promise<void> {
  await apiJson(
    `/api/folder-files?folderId=${encodeURIComponent(folderId.value)}&path=${encodeURIComponent(entry.path)}`,
    { method: 'DELETE' },
  );
  showToast(`已删除 ${entry.name}`);
  await load();
}
</script>

<template>
  <ModalShell
    :open="folder !== null"
    title="文件管理器"
    :description="folder?.path ?? ''"
    description-mono
    wide
    @close="emit('close')"
  >
    <div class="files-crumbs">
      <template v-for="(c, i) in crumbs" :key="c.path">
        <span v-if="i > 0" class="files-crumb-sep">/</span>
        <button
          type="button"
          class="files-crumb mono"
          :class="{ 'is-current': i === crumbs.length - 1 }"
          :title="c.path"
          @click="relPath = c.path; load()"
        >{{ c.name }}</button>
      </template>
    </div>

    <div v-if="loading" class="files-state">读取中…</div>
    <div v-else-if="error" class="files-state is-error">{{ error }}</div>
    <div v-else-if="!listing || listing.entries.length === 0" class="files-state">目录为空</div>
    <template v-else>
      <div v-if="listing.truncated" class="files-state is-note">条目过多,仅显示前 {{ listing.entries.length }} 项</div>
      <div class="files-rows">
        <div v-for="entry in listing.entries" :key="entry.path" class="files-row">
          <button
            type="button"
            class="files-name"
            :title="entry.dir ? '打开目录' : entry.name"
            @click="entry.dir ? enter(entry) : download(entry)"
          >
            <svg v-if="entry.dir" class="files-icon is-dir" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17Z" />
            </svg>
            <svg v-else class="files-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5Z" />
              <path d="M14 3.5V8h4" />
            </svg>
            <span class="mono">{{ entry.name }}</span>
          </button>
          <span class="files-meta">{{ entry.dir ? '目录' : formatBytes(entry.size) }}</span>
          <span class="files-meta files-time">{{ fmtTime(entry.mtime) }}</span>
          <span class="files-actions">
            <n-button v-if="!entry.dir" size="tiny" tertiary :disabled="busy" @click="download(entry)">下载</n-button>
            <n-button size="tiny" tertiary type="error" :disabled="busy" @click="askDelete(entry)">删除</n-button>
          </span>
        </div>
      </div>
    </template>

    <template #footer>
      <n-button class="modal-cancel" :disabled="busy" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>
</template>
