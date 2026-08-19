<script setup lang="ts">
import { ref, onMounted } from 'vue';

interface SyncProgressItem {
  folder: string;
  pending: number;
  sending: number;
  receiving: number;
}

interface StatusData {
  deviceId: string;
  entries: number;
  tombstones: number;
  folders: Array<{ path: string; devices: string[] }>;
  peers: Array<{ deviceId: string; online: boolean; url?: string }>;
  syncProgress: SyncProgressItem[];
}

const props = defineProps<{ status: StatusData; message?: string }>();

// 本地响应式状态:SSR 注入的初始 status 作为起点,交互后由 fetch 更新
const status = ref<StatusData>(props.status);
const toast = ref<string | undefined>(props.message);
const busy = ref(false);

function showToast(msg: string): void {
  toast.value = msg;
  // 3 秒后自动消失
  setTimeout(() => {
    if (toast.value === msg) toast.value = undefined;
  }, 3000);
}

/** 拉取最新状态并原地刷新(不整页刷新)。 */
async function refreshStatus(): Promise<void> {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`status ${res.status}`);
    status.value = (await res.json()) as StatusData;
  } catch {
    // 静默失败,保留当前状态
  }
}

/** 调用一个 JSON API 端点,成功后刷新状态并弹 toast。 */
async function post(action: string, body?: Record<string, string>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await fetch(action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${action} ${res.status}`);
    showToast('操作已触发');
    await refreshStatus();
  } catch {
    showToast('操作失败,请重试');
  } finally {
    busy.value = false;
  }
}

function rescan(): void {
  void post('/api/rescan');
}

function reconnect(deviceId: string): void {
  void post(`/api/reconnect?deviceId=${encodeURIComponent(deviceId)}`);
}

async function removeFolder(path: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await fetch(`/api/folders?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`delete ${res.status}`);
    showToast('已移除共享目录');
    await refreshStatus();
  } catch {
    showToast('移除失败,请重试');
  } finally {
    busy.value = false;
  }
}

async function addFolder(): Promise<void> {
  if (busy.value) return;
  const path = newPath.value.trim();
  const devices = newDevices.value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!path) {
    showToast('请填写目录路径');
    return;
  }
  busy.value = true;
  try {
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, devices }),
    });
    if (!res.ok) throw new Error(`add ${res.status}`);
    showToast('已添加共享目录');
    newPath.value = '';
    newDevices.value = '';
    await refreshStatus();
  } catch {
    showToast('添加失败,请重试');
  } finally {
    busy.value = false;
  }
}

const newPath = ref('');
const newDevices = ref('');

// 挂载后立即刷新一次,确保展示最新状态
onMounted(() => {
  void refreshStatus();
});

function progressPercent(p: SyncProgressItem): number {
  const total = p.pending + p.sending + p.receiving;
  return total > 0 ? Math.round((p.receiving / total) * 100) : 0;
}
</script>

<template>
  <div class="container">
    <h1>syncx 状态</h1>
    <div v-if="toast" class="toast">{{ toast }}</div>

    <div class="card">
      <div class="muted">本机设备</div>
      <div class="deviceId">{{ status.deviceId }}</div>
      <div class="stat-row">
        <div class="stat"><b>{{ status.entries }}</b>索引条目</div>
        <div class="stat"><b>{{ status.tombstones }}</b>墓碑</div>
        <div class="stat"><b>{{ status.folders.length }}</b>共享目录</div>
      </div>
      <div class="actions">
        <button type="button" :disabled="busy" @click="rescan">手动扫描</button>
      </div>
    </div>

    <div class="card">
      <div class="muted">对端连接</div>
      <table>
        <thead>
          <tr><th>设备</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-if="status.peers.length === 0">
            <td colspan="3" class="muted">暂无对端</td>
          </tr>
          <tr v-for="p in status.peers" :key="p.deviceId">
            <td><span class="dot" :class="p.online ? 'dot-online' : 'dot-offline'"></span>{{ p.deviceId }}</td>
            <td :class="p.online ? 'online' : 'offline'">{{ p.online ? '在线' : '离线' }}</td>
            <td>
              <button v-if="!p.online" type="button" class="btn-sm" :disabled="busy" @click="reconnect(p.deviceId)">重连</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="muted">同步进度</div>
      <table>
        <thead>
          <tr><th>目录</th><th>待处理</th><th>发送中</th><th>接收中</th><th>进度</th></tr>
        </thead>
        <tbody>
          <tr v-if="status.syncProgress.length === 0">
            <td colspan="5" class="muted">同步中无待处理任务</td>
          </tr>
          <tr v-for="p in status.syncProgress" :key="p.folder">
            <td>{{ p.folder }}</td>
            <td>{{ p.pending }}</td>
            <td>{{ p.sending }}</td>
            <td>{{ p.receiving }}</td>
            <td>
              <div class="progress-bar"><div class="progress-fill" :style="{ width: progressPercent(p) + '%' }"></div></div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="muted">共享目录</div>
      <table>
        <thead>
          <tr><th>路径</th><th>已配对设备</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-if="status.folders.length === 0">
            <td colspan="3" class="muted">暂无共享目录</td>
          </tr>
          <tr v-for="f in status.folders" :key="f.path">
            <td>{{ f.path }}</td>
            <td>{{ f.devices.join(', ') }}</td>
            <td class="actions">
              <button type="button" class="btn-sm" :disabled="busy" @click="removeFolder(f.path)">移除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="muted">添加共享目录</div>
      <form @submit.prevent="addFolder">
        <input v-model="newPath" placeholder="本地目录绝对路径,如 /home/me/Documents">
        <input v-model="newDevices" placeholder="允许的设备 ID,逗号分隔,如 DEV1234567">
        <button type="submit" :disabled="busy">添加</button>
      </form>
    </div>
  </div>
</template>
