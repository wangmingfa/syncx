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
  folders: Array<{ id?: string; path: string; devices: string[] }>;
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

// 目录稳定标识(与后端 folderIdFor 一致:id 优先,回退 path),用作列表 key 与进度匹配
function folderKey(f: { id?: string; path: string }): string {
  return f.id ?? f.path;
}

// 该目录的同步进度(按 folderId 匹配)
function progressOf(f: { id?: string; path: string }): SyncProgressItem | undefined {
  const key = folderKey(f);
  return status.value.syncProgress.find((p) => p.folder === key);
}

// 某设备参与共享的目录数量(反向映射)
function deviceFolderCount(deviceId: string): number {
  return status.value.folders.filter((f) => f.devices.includes(deviceId)).length;
}

function progressPercent(p: SyncProgressItem): number {
  const total = p.pending + p.sending + p.receiving;
  return total > 0 ? Math.round((p.receiving / total) * 100) : 0;
}
</script>

<template>
  <div class="container">
    <h1>syncx</h1>
    <div v-if="toast" class="toast">{{ toast }}</div>

    <!-- 顶部:本机设备 + 概览 -->
    <div class="card header-card">
      <div class="muted">本机设备</div>
      <div class="deviceId">{{ status.deviceId }}</div>
      <div class="stat-row">
        <div class="stat"><b>{{ status.entries }}</b>索引条目</div>
        <div class="stat"><b>{{ status.tombstones }}</b>墓碑</div>
        <div class="stat"><b>{{ status.folders.length }}</b>共享目录</div>
        <div class="stat"><b>{{ status.peers.length }}</b>已配对设备</div>
      </div>
      <div class="actions">
        <button type="button" :disabled="busy" @click="rescan">手动扫描</button>
      </div>
    </div>

    <!-- 主体:左右两栏(左=共享目录,右=已配对设备) -->
    <div class="layout">
      <!-- 左栏:共享目录 -->
      <section class="col">
        <div class="col-head">
          <span>共享目录</span>
          <span class="badge">{{ status.folders.length }}</span>
        </div>

        <div v-if="status.folders.length === 0" class="empty">暂无共享目录</div>
        <div v-for="f in status.folders" :key="folderKey(f)" class="item-card">
          <div class="item-top">
            <span class="item-title">{{ f.path }}</span>
            <button
              type="button"
              class="btn-sm btn-danger"
              :disabled="busy"
              @click="removeFolder(f.path)"
            >移除</button>
          </div>
          <div class="item-sub">
            已配对 {{ f.devices.length }} 台设备
            <span v-if="f.devices.length"> · {{ f.devices.join(', ') }}</span>
          </div>
          <div v-if="progressOf(f)" class="item-progress">
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: progressPercent(progressOf(f)!) + '%' }"></div>
            </div>
            <div class="item-sub">
              待处理 {{ progressOf(f)!.pending }} · 发送 {{ progressOf(f)!.sending }} · 接收 {{ progressOf(f)!.receiving }}
            </div>
          </div>
        </div>

        <form class="add-form" @submit.prevent="addFolder">
          <input v-model="newPath" placeholder="本地目录绝对路径,如 /home/me/Documents">
          <input v-model="newDevices" placeholder="允许的设备 ID,逗号分隔,如 DEV1234567">
          <button type="submit" :disabled="busy">添加共享目录</button>
        </form>
      </section>

      <!-- 右栏:已配对设备 -->
      <section class="col">
        <div class="col-head">
          <span>已配对设备</span>
          <span class="badge">{{ status.peers.length }}</span>
        </div>

        <div v-if="status.peers.length === 0" class="empty">暂无已配对设备</div>
        <div v-for="p in status.peers" :key="p.deviceId" class="item-card">
          <div class="item-top">
            <span class="dot" :class="p.online ? 'dot-online' : 'dot-offline'"></span>
            <span class="item-title mono">{{ p.deviceId }}</span>
            <span class="status-pill" :class="p.online ? 'pill-online' : 'pill-offline'">
              {{ p.online ? '在线' : '离线' }}
            </span>
          </div>
          <div class="item-sub">
            共享 {{ deviceFolderCount(p.deviceId) }} 个目录
            <span v-if="p.url"> · {{ p.url }}</span>
          </div>
          <div v-if="!p.online" class="actions">
            <button type="button" class="btn-sm" :disabled="busy" @click="reconnect(p.deviceId)">重连</button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
