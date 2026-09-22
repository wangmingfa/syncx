<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { apiJson, errText } from '../utils/api';
import { formatBytes } from '../utils/bytes';
import ModalShell from './ModalShell.vue';

/** 版本留档条目:file 为版本文件相对版本目录的路径(含 .syncx-v- 时间戳后缀)。 */
interface FolderVersion {
  file: string;
  path: string;
  size: number;
  mtime: number;
}

const props = defineProps<{
  /** 非空 = 打开该目录的版本弹窗并拉取留档列表。 */
  folder: { id?: string; path: string } | null;
  /** 轻提示(父级 useToast 提供)。 */
  notify: (msg: string, kind?: 'info' | 'alert') => void;
  /** 恢复/删除会改动文件,完成后通知父级刷新状态(对端会把恢复当作修改接收)。 */
  changed: () => void;
}>();
const emit = defineEmits<{ close: [] }>();

const versions = ref<FolderVersion[]>([]);
const loading = ref(false);
const lastPath = ref('');
const restoring = ref<string | null>(null);

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
    await load(f.id ?? f.path);
  },
);

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

// 恢复:把旧版本写回原路径(当前内容会先留档一份,操作可逆)。
// 恢复后的旧内容作为「本地修改」沿正常同步路径传播给对端。
async function restore(v: FolderVersion): Promise<void> {
  const f = props.folder;
  if (!f) return;
  restoring.value = v.file;
  try {
    await apiJson('/api/folders/versions/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: f.id ?? f.path, file: v.file }),
    });
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
    await apiJson('/api/folders/versions/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: f.id ?? f.path, file: v.file }),
    });
    versions.value = versions.value.filter((x) => x.file !== v.file);
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
</script>

<template>
  <ModalShell
    :open="!!folder"
    title="文件版本"
    :description="lastPath"
    description-mono
    wide
    @close="emit('close')"
  >
    <p class="modal-lead">文件被对端覆盖修改前,旧内容会自动留档在这里(每路径保留最近 10 份)。恢复后旧内容会作为「本地修改」同步给对端。</p>

    <div v-if="loading" class="history-loading">读取中…</div>
    <div v-else-if="versions.length === 0" class="empty">还没有版本留档</div>
    <ul v-else class="history-list">
      <li v-for="v in versions" :key="v.file" class="history-row">
        <span class="history-time">{{ fmtTime(v.mtime) }}</span>
        <span class="history-path mono break">{{ v.path }}</span>
        <span class="history-size muted">{{ formatBytes(v.size) }}</span>
        <span class="history-ops">
          <n-button size="tiny" type="primary" quaternary :loading="restoring === v.file" @click="restore(v)">
            恢复
          </n-button>
          <n-button size="tiny" type="error" quaternary @click="askDelete(v)">删除</n-button>
        </span>
      </li>
    </ul>

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
</style>
