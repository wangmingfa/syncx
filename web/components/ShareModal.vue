<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NInput, NSelect } from 'naive-ui';
import ModalShell from './ModalShell.vue';
import { apiJson, apiPost, errText } from '../utils/api';
import { copyText } from '../utils/clipboard';
import { fmtTime } from '../utils/format';
import { ensureElevated } from '../utils/elevation';
import { useToast } from '../composables/useToast';

/**
 * 分享链接弹窗(文件管理器行操作「分享」)。
 *
 * 后端域:src/api/routes/share.ts —— GET /api/shares 列在册分享与开关状态;
 * POST /api/shares/create 需提权(对外开放匿名读一道门,与删除文件同一条门);
 * POST /api/shares/revoke 登录即可(撤销是收紧权限,不该被验证挡住)。
 * 生成的链接形如 http://host:port/s/<id>.<过期时间戳>.<签名>:免登录、限时、
 * 单文件只读;撤销或到期即刻 404,关掉全局开关则全部链接立即失效。
 */
const props = defineProps<{
  open: boolean;
  folderId: string;
  /** 被分享文件在目录内的相对路径。 */
  path: string;
  /** 展示用文件名。 */
  name: string;
}>();
const emit = defineEmits<{ close: [] }>();

const { showToast } = useToast();

interface ShareRow {
  id: string;
  folderId: string;
  path: string;
  createdAt: number;
  expiresAt: number;
  downloads?: number;
}

const enabled = ref(false);
const shares = ref<ShareRow[]>([]);
const loading = ref(false);
const busy = ref(false);
const ttlHours = ref(24);
/** 刚创建的链接(展示 + 复制);换文件/重开弹窗时清空。 */
const createdUrl = ref('');

const TTL_OPTIONS = [
  { label: '1 小时', value: 1 },
  { label: '24 小时', value: 24 },
  { label: '7 天', value: 168 },
  { label: '30 天', value: 720 },
];

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    createdUrl.value = '';
    void refresh();
  },
);

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    const r = await apiJson<{ enabled: boolean; shares: ShareRow[] }>('/api/shares');
    enabled.value = r.enabled === true;
    shares.value = r.shares ?? [];
  } catch (e) {
    showToast(errText(e, '读取分享列表失败'), 'alert');
  } finally {
    loading.value = false;
  }
}

/** 创建:确认文件后过提权门(与删除同一条门),成功即展示可复制的完整链接。 */
function createLink(): void {
  if (busy.value) return;
  void ensureElevated(`为 ${props.path} 创建免登录分享链接`, () => {
    void doCreate();
  });
}

async function doCreate(): Promise<void> {
  busy.value = true;
  try {
    const r = await apiPost<{ urlToken: string; expiresAt: number }>('/api/shares/create', {
      folderId: props.folderId,
      path: props.path,
      ttlHours: ttlHours.value,
    });
    createdUrl.value = `${window.location.origin}/s/${r.urlToken}`;
    showToast('分享链接已创建');
    await refresh();
  } catch (e) {
    showToast(errText(e, '创建分享失败'), 'alert');
  } finally {
    busy.value = false;
  }
}

async function copyLink(): Promise<void> {
  if (!createdUrl.value) return;
  if (await copyText(createdUrl.value)) showToast('链接已复制');
  else showToast('复制失败,请手动选中复制', 'alert');
}

async function revoke(row: ShareRow): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await apiPost('/api/shares/revoke', { id: row.id });
    showToast('分享已撤销,链接立即失效');
    if (createdUrl.value.includes(`/s/${row.id}.`)) createdUrl.value = '';
    await refresh();
  } catch (e) {
    showToast(errText(e, '撤销失败'), 'alert');
  } finally {
    busy.value = false;
  }
}

function fmtLeft(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return '已过期';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 24) return `剩 ${Math.floor(h / 24)} 天`;
  if (h >= 1) return `剩 ${h} 小时`;
  return `剩 ${Math.max(1, Math.floor(ms / 60_000))} 分钟`;
}
</script>

<template>
  <ModalShell :open="open" title="分享链接" description="免登录、限时、单文件只读;撤销或到期立即失效" @close="emit('close')">
    <template v-if="!enabled">
      <p class="confirm-note-extra">
        分享功能当前<strong>未启用</strong>。这是默认状态:开启后可为单个文件生成免登录的限时下载链接,
        拿到链接的人不需要账户,也不能浏览目录里的其他文件。
        请在顶栏「设置 → 分享链接」中打开开关;关闭开关会让全部在外的链接立即失效。
      </p>
    </template>
    <template v-else>
      <div class="edit-section-label">为「{{ name }}」创建链接</div>
      <div class="share-create-row">
        <n-select v-model:value="ttlHours" :options="TTL_OPTIONS" class="share-ttl" :disabled="busy || loading" />
        <n-button type="primary" size="small" :loading="busy" :disabled="loading" @click="createLink">创建链接</n-button>
      </div>
      <div v-if="createdUrl" class="share-created">
        <n-input :value="createdUrl" readonly size="small" />
        <n-button size="small" tertiary @click="copyLink">复制</n-button>
      </div>
      <p class="confirm-note-extra">
        链接有效期最长 30 天;每次匿名下载都会记入下方计数并写入 daemon 日志(审计)。
      </p>

      <div class="edit-section-label">在册分享({{ shares.length }})</div>
      <p v-if="loading" class="confirm-note-extra">读取中…</p>
      <p v-else-if="shares.length === 0" class="confirm-note-extra">暂无有效分享。</p>
      <table v-else class="share-table">
        <thead>
          <tr><th>文件</th><th>到期</th><th>下载</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="s in shares" :key="s.id">
            <td class="share-td-path" :title="`${s.folderId}/${s.path}`">{{ s.folderId }}/{{ s.path }}</td>
            <td :title="`到期:${fmtTime(s.expiresAt)}`">{{ fmtLeft(s.expiresAt) }}</td>
            <td>{{ s.downloads ?? 0 }}</td>
            <td><n-button size="tiny" tertiary type="error" :disabled="busy" @click="revoke(s)">撤销</n-button></td>
          </tr>
        </tbody>
      </table>
    </template>

    <template #footer>
      <n-button class="modal-cancel" :disabled="busy" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>
</template>

<style scoped>
.share-create-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.share-ttl {
  width: 140px;
}
.share-created {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.share-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.share-table th,
.share-table td {
  text-align: left;
  padding: 4px 6px;
  border-bottom: 1px solid var(--line, rgba(128, 128, 128, 0.18));
  white-space: nowrap;
}
.share-td-path {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
