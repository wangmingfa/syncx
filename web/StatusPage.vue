<script setup lang="ts">
import { ref, onMounted, onUnmounted, reactive, computed } from 'vue';
import { NButton, NInput, NSelect } from 'naive-ui';

interface SyncProgressItem {
  folder: string;
  pending: number;
  sending: number;
  receiving: number;
}

interface FolderInfo {
  id?: string;
  path: string;
  devices: string[];
}

interface DeviceInfo {
  deviceId: string;
  online: boolean;
  url?: string;
  /** 该设备被指派到的目录 id 列表(用于展示「共享 N 个目录」)。 */
  folders: string[];
}

interface OfferInfo {
  id: string;
  kind: 'pairing' | 'folder';
  fromDeviceId: string;
  folderId?: string;
  folderName?: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: number;
}

interface StatusData {
  deviceId: string;
  entries: number;
  tombstones: number;
  folders: FolderInfo[];
  devices: DeviceInfo[];
  syncProgress: SyncProgressItem[];
  offers: OfferInfo[];
}

const props = defineProps<{ status: StatusData; message?: string }>();

// 本地响应式状态:SSR 注入的初始 status 作为起点,交互后由 fetch 更新
const status = ref<StatusData>(props.status);
const toast = ref<string | undefined>(props.message);
const busy = ref(false);

// 每个目录的设备多选本地镜像(提交时写回服务端)
const folderSel = reactive<Record<string, string[]>>({});
function syncFolderSel(): void {
  for (const f of status.value.folders) folderSel[f.path] = [...f.devices];
}

// 使用指南弹窗
const showGuide = ref(false);
// 端口提示仅开发模式显示:「dev 请访问 5173(HMR)」对终端用户是噪音,
// build 后由 vite 静态替换为 false 并 tree-shake 掉整段 DOM。
const isDev = import.meta.env.DEV;
// 控制端口取当前地址的真实端口,而非硬编码 8384(--port 可改)。
const controlPort = globalThis.location?.port || '8384';
function openGuide(): void {
  showGuide.value = true;
}
function closeGuide(): void {
  showGuide.value = false;
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && showGuide.value) closeGuide();
}

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
    syncFolderSel();
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

// ---- 二次确认弹窗(移除目录 / 移除设备共用) ----
interface ConfirmState {
  title: string;
  message: string;
  /** 被操作对象(目录路径 / 设备 ID),等宽展示便于核对。 */
  detail?: string;
  /** 受影响的共享目录(移除设备时列出);others = 移除后该目录还剩几个设备。 */
  folders?: Array<{ path: string; others: number }>;
  /** 补充提醒(如「对方仍需自行移除一次」)。 */
  note?: string;
  confirmText: string;
  action: () => Promise<void>;
}

const confirmState = ref<ConfirmState | null>(null);
const confirmBusy = ref(false);

function askConfirm(state: ConfirmState): void {
  if (busy.value || confirmBusy.value) return;
  confirmState.value = state;
}

function closeConfirm(): void {
  if (confirmBusy.value) return;
  confirmState.value = null;
}

async function runConfirm(): Promise<void> {
  const state = confirmState.value;
  if (!state || confirmBusy.value) return;
  confirmBusy.value = true;
  busy.value = true;
  try {
    await state.action();
    confirmState.value = null;
  } catch {
    // 失败时保留弹窗,便于取消或重试,不做任何数据假设
    showToast('操作失败,请重试');
  } finally {
    confirmBusy.value = false;
    busy.value = false;
  }
}

/** 点目录卡「移除」:先二次确认,再真正删除(确认前不动任何数据)。 */
function askRemoveFolder(path: string): void {
  askConfirm({
    title: '移除共享目录?',
    message: '移除后本机不再同步该目录,对端也会停止同步它。磁盘上的文件不会被删除。',
    detail: path,
    confirmText: '确认移除',
    action: () => doRemoveFolder(path),
  });
}

async function doRemoveFolder(path: string): Promise<void> {
  const res = await fetch(`/api/folders?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`delete ${res.status}`);
  showToast('已移除共享目录');
  await refreshStatus();
}

// 轻量拓扑联动:鼠标悬停左栏目录卡时,记录其配对设备,用于高亮右栏对应设备卡
const hoverDevices = ref<string[]>([]);

function onFolderEnter(f: { devices: string[] }): void {
  hoverDevices.value = f.devices;
}

function onFolderLeave(): void {
  hoverDevices.value = [];
}

// 设备下拉选项(来自已知设备 + 已被指派的设备)
const deviceOptions = computed(() =>
  status.value.devices.map((d) => ({ label: d.deviceId, value: d.deviceId })),
);

// ---- 设备配对(按 ID) ----
const newDeviceId = ref('');
const newDeviceHost = ref('');
const newDevicePort = ref('22000');

async function addDevice(): Promise<void> {
  const id = newDeviceId.value.trim();
  if (!id) {
    showToast('请填写设备 ID');
    return;
  }
  if (busy.value) return;
  // 地址为可选项:仅跨网段/无 mDNS 时需要。由 ws://(前缀) + 主机 + :端口(默认 22000) 拼成
  const host = newDeviceHost.value.trim();
  let address: string | undefined;
  if (host) {
    const port = newDevicePort.value.trim() || '22000';
    address = `ws://${host}:${port}`;
  }
  busy.value = true;
  try {
    const res = await fetch('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: id, address }),
    });
    if (!res.ok) throw new Error(`add device ${res.status}`);
    showToast(address ? '已添加设备并发起直连' : '已添加设备');
    newDeviceId.value = '';
    newDeviceHost.value = '';
    newDevicePort.value = '22000';
    await refreshStatus();
  } catch {
    showToast('添加失败,请重试');
  } finally {
    busy.value = false;
  }
}

/** 点设备卡「移除」:列出会从哪些共享目录里摘掉它(目录本身保留),确认后才执行。 */
function askRemoveDevice(deviceId: string): void {
  // 受影响的目录 = devices 里含该设备的目录;others 用于区分「仅共享给它」的目录
  // (旧配置的 devices 字段可能缺失,统一兜底为空数组)
  const affected = status.value.folders
    .filter((f) => (f.devices ?? []).includes(deviceId))
    .map((f) => ({ path: f.path, others: (f.devices ?? []).filter((d) => d !== deviceId).length }));

  askConfirm({
    title: '移除设备?',
    message: '将与该设备取消配对并断开连接。共享目录与磁盘文件都会保留,只是不再向它同步。',
    detail: deviceId,
    folders: affected,
    note: '对方仍保留自己的配置,需要对方也移除一次才会彻底断开。',
    confirmText: '确认移除',
    action: () => doRemoveDevice(deviceId),
  });
}

async function doRemoveDevice(deviceId: string): Promise<void> {
  const res = await fetch(`/api/devices?deviceId=${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`remove device ${res.status}`);
  showToast('已移除设备');
  await refreshStatus();
}

// ---- 按目录指派设备 ----
async function commitFolderDevices(path: string, devices: string[]): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await fetch('/api/folders/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, devices }),
    });
    if (!res.ok) throw new Error(`update folder devices ${res.status}`);
    showToast('已更新目录设备');
    await refreshStatus();
  } catch {
    showToast('更新失败,请重试');
  } finally {
    busy.value = false;
  }
}

// ---- 添加共享目录 ----
const newPath = ref('');
const newFolderId = ref('');
const newFolderDevices = ref<string[]>([]);

async function addFolder(): Promise<void> {
  const path = newPath.value.trim();
  if (!path) {
    showToast('请填写目录路径');
    return;
  }
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path,
        devices: newFolderDevices.value,
        id: newFolderId.value.trim() || undefined,
      }),
    });
    if (!res.ok) throw new Error(`add folder ${res.status}`);
    showToast('已添加共享目录');
    newPath.value = '';
    newFolderId.value = '';
    newFolderDevices.value = [];
    await refreshStatus();
  } catch {
    showToast('添加失败,请重试');
  } finally {
    busy.value = false;
  }
}

/** 复制文本到剪贴板,并轻提示。 */
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  } catch {
    showToast('复制失败,请手动选择');
  }
}

// ---- 待确认项(对方推送的配对 / 目录共享邀请) ----
// 目录共享邀请需要本机落地路径,按 offer id 暂存输入框内容
const offerPaths = reactive<Record<string, string>>({});

async function acceptOffer(offer: OfferInfo): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const localPath = offer.kind === 'folder' ? offerPaths[offer.id]?.trim() : undefined;
    if (offer.kind === 'folder' && !localPath) {
      showToast('请填写本机目录路径');
      busy.value = false;
      return;
    }
    const res = await fetch(`/api/offers/${encodeURIComponent(offer.id)}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localPath }),
    });
    if (!res.ok) throw new Error(`accept ${res.status}`);
    showToast(offer.kind === 'folder' ? '已接受目录共享,开始同步' : '已接受配对');
    await refreshStatus();
  } catch {
    showToast('确认失败,请重试');
  } finally {
    busy.value = false;
  }
}

async function declineOffer(offer: OfferInfo): Promise<void> {
  if (busy.value) return;
  busy.value = false;
  try {
    const res = await fetch(`/api/offers/${encodeURIComponent(offer.id)}/decline`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`decline ${res.status}`);
    showToast('已忽略该请求');
    await refreshStatus();
  } catch {
    showToast('操作失败,请重试');
  } finally {
    busy.value = false;
  }
}

// 挂载后立即刷新一次,并确保展示最新状态;之后周期轮询,
// 让对方推送过来的配对 / 共享邀请(待确认项)能及时在页面上弹出。
let pollTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void refreshStatus();
  window.addEventListener('keydown', onKeydown);
  pollTimer = setInterval(() => void refreshStatus(), 4000);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  if (pollTimer) clearInterval(pollTimer);
});

// 目录稳定标识(与后端 folderIdFor 一致:id 优先,回退 path),用作列表 key 与进度匹配
function folderKey(f: { id?: string; path: string }): string {
  return f.id ?? f.path;
}

// 设备首字母徽标(浅色主题里替代纯文字,增强可读性)
function monogram(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '··';
}

// 该目录的同步进度(按 folderId 匹配)
function progressOf(f: { id?: string; path: string }): SyncProgressItem | undefined {
  const key = folderKey(f);
  return status.value.syncProgress.find((p) => p.folder === key);
}

// 某设备被指派到的目录数量
function deviceFolderCount(deviceId: string): number {
  return status.value.folders.filter((f) => f.devices.includes(deviceId)).length;
}

// 设备卡里展示对端地址时去掉 ws:// 前缀,只留 host:port
function stripWs(url: string): string {
  return url.startsWith('ws://') ? url.slice(5) : url;
}

function progressPercent(p: SyncProgressItem): number {
  const total = p.pending + p.sending + p.receiving;
  return total > 0 ? Math.round((p.receiving / total) * 100) : 0;
}

/** 是否正在传输(有发送或接收活动)。 */
function isActive(p: SyncProgressItem): boolean {
  return p.sending + p.receiving > 0;
}

/** 进度区文案:用用户能看懂的语言,而非 pending/sending/receiving 系统术语。 */
function progressText(p: SyncProgressItem): string {
  if (isActive(p)) return `传输中 · 发送 ${p.sending} · 接收 ${p.receiving}`;
  if (p.pending > 0) return `已排队 ${p.pending} 项,等待同步`;
  return '已同步';
}

// 同步记录弹窗:展示某目录的变更历史(新增/修改/删除/冲突,含方向与对端)
const historyOpen = ref(false);
const historyFolderId = ref('');
const historyFolderPath = ref('');
const historyEvents = ref<SyncEventItem[]>([]);
const historyLoading = ref(false);

interface SyncEventItem {
  ts: number;
  folderId: string;
  path: string;
  action: 'add' | 'update' | 'delete' | 'conflict';
  direction: 'local' | 'remote';
  deviceId?: string;
}

async function openHistory(f: FolderInfo): Promise<void> {
  historyFolderId.value = f.id ?? f.path;
  historyFolderPath.value = f.path;
  historyOpen.value = true;
  historyLoading.value = true;
  historyEvents.value = [];
  try {
    const res = await fetch(`/api/folders/history?folderId=${encodeURIComponent(historyFolderId.value)}`);
    if (!res.ok) throw new Error(`history ${res.status}`);
    const data = (await res.json()) as { events: SyncEventItem[] };
    historyEvents.value = data.events ?? [];
  } catch {
    showToast('读取同步记录失败');
  } finally {
    historyLoading.value = false;
  }
}

function closeHistory(): void {
  historyOpen.value = false;
}

function actionLabel(a: string): string {
  return ({ add: '新增', update: '修改', delete: '删除', conflict: '冲突' } as Record<string, string>)[a] ?? a;
}

function directionLabel(d: string): string {
  return d === 'local' ? '本地' : '对端';
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}
</script>

<template>
  <div class="container">
    <div v-if="toast" class="toast">{{ toast }}</div>

    <!-- 顶部:品牌条 -->
    <div class="topbar">
      <div class="brand">
        <svg class="brand__mark" viewBox="0 0 32 32" aria-hidden="true">
          <defs>
            <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#4a7fc0" />
              <stop offset="1" stop-color="#2bb6ac" />
            </linearGradient>
          </defs>
          <rect width="32" height="32" rx="9" fill="url(#lg)" />
          <g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round">
            <path d="M8.5 13H20" />
            <path d="M24 19H12" />
          </g>
          <path d="M20 10.5 24.5 13 20 15.5Z" fill="#fff" />
          <path d="M12 16.5 7.5 19 12 21.5Z" fill="#fff" />
        </svg>
        <div class="brand__text">
          <div class="brand__name">SYNCX</div>
          <div class="brand__sub">P2P LAN SYNC</div>
        </div>
      </div>

      <n-button tertiary @click="openGuide">
        <template #icon>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M9.2 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.8 2.8-2.8 2.8" />
            <line x1="12" y1="16.5" x2="12" y2="16.6" />
          </svg>
        </template>
        使用指南
      </n-button>

      <div class="topbar__spacer"></div>

      <span class="device-chip">
        <span class="dot" :class="status.devices.some((p) => p.online) ? 'dot-online' : 'dot-offline'"></span>
        <span class="mono">{{ status.deviceId }}</span>
      </span>
    </div>

    <!-- 概览胶囊 -->
    <div class="stat-pills">
      <span class="stat-pill-item"><b>{{ status.entries }}</b><span>索引条目</span></span>
      <span class="stat-pill-item"><b>{{ status.tombstones }}</b><span>墓碑</span></span>
      <span class="stat-pill-item"><b>{{ status.folders.length }}</b><span>共享目录</span></span>
      <span class="stat-pill-item"><b>{{ status.devices.length }}</b><span>已配对设备</span></span>
    </div>

    <!-- 待确认:对方推送的配对 / 目录共享邀请 -->
    <div v-if="status.offers && status.offers.length" class="offers">
      <div class="col-head">
        <span>待确认</span>
        <span class="badge">{{ status.offers.length }}</span>
      </div>
      <div
        v-for="o in status.offers"
        :key="o.id"
        class="item-card offer-card"
      >
        <div class="item-top">
          <span class="avatar" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3v18M3 12h18" />
            </svg>
          </span>
          <span class="item-title">
            <template v-if="o.kind === 'folder'">目录共享邀请 · {{ o.folderName }}</template>
            <template v-else>配对请求</template>
          </span>
        </div>
        <div class="item-sub">来自 <span class="mono">{{ o.fromDeviceId }}</span></div>
        <div v-if="o.kind === 'folder'" class="offer-path">
          <n-input v-model:value="offerPaths[o.id]" placeholder="本机目录绝对路径,如 /home/me/Documents" />
        </div>
        <div class="actions">
          <n-button size="small" type="primary" :disabled="busy" @click="acceptOffer(o)">确认</n-button>
          <n-button size="small" tertiary :disabled="busy" @click="declineOffer(o)">忽略</n-button>
        </div>
      </div>
    </div>

    <!-- 主体:左右两栏(左=共享目录,右=设备) -->
    <div class="layout">
      <!-- 左栏:共享目录 -->
      <section class="col col--folders">
        <div class="col-head">
          <span>共享目录</span>
          <span class="badge">{{ status.folders.length }}</span>
          <n-button :disabled="busy" @click="rescan">扫描全部</n-button>
        </div>

        <div v-if="status.folders.length === 0" class="empty">还没有共享目录 · 在下方添加第一个</div>
        <div
          v-for="f in status.folders"
          :key="folderKey(f)"
          class="item-card"
          @mouseenter="onFolderEnter(f)"
          @mouseleave="onFolderLeave"
        >
          <div class="item-top">
            <span class="avatar" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
            </span>
            <span class="item-title">{{ f.path }}</span>
            <n-button size="small" tertiary :disabled="busy" @click="openHistory(f)">记录</n-button>
            <n-button
              size="small"
              type="error"
              tertiary
              :disabled="busy"
              @click="askRemoveFolder(f.path)"
            >移除</n-button>
          </div>

          <!-- 目录 ID:跨机同步需两边配置同一 ID 才能对上 -->
          <div class="fid-row">
            <span class="fid-label">目录 ID</span>
            <code class="fid-code break">{{ f.id ?? f.path }}</code>
            <n-button size="small" tertiary @click="copy(f.id ?? f.path)">复制</n-button>
          </div>

          <!-- 按目录指派可同步的设备 -->
          <div class="fid-devices">
            <n-select
              multiple
              :options="deviceOptions"
              placeholder="选择可同步此目录的设备"
              v-model:value="folderSel[f.path]"
              @update:value="(v) => commitFolderDevices(f.path, v)"
            />
          </div>

          <div v-if="progressOf(f)" class="item-progress">
            <div class="progress-bar">
              <div
                class="progress-fill"
                :class="{ 'is-flowing': isActive(progressOf(f)!) }"
                :style="isActive(progressOf(f)!) ? '' : 'width:100%'"
              ></div>
            </div>
            <div class="item-sub">{{ progressText(progressOf(f)!) }}</div>
          </div>
        </div>

        <form class="add-form" @submit.prevent="addFolder">
          <n-input v-model:value="newPath" placeholder="本地目录绝对路径,如 /home/me/Documents" />
          <n-input v-model:value="newFolderId" placeholder="目录 ID(留空自动生成;跨机同步需与对方一致)" />
          <n-select
            multiple
            :options="deviceOptions"
            placeholder="允许同步此目录的设备(可留空,稍后在目录卡上指派)"
            v-model:value="newFolderDevices"
          />
          <n-button type="primary" attr-type="submit" :disabled="busy" block>添加共享目录</n-button>
        </form>
      </section>

      <!-- 右栏:设备 -->
      <section class="col col--devices">
        <div class="col-head">
          <span>设备</span>
          <span class="badge">{{ status.devices.length }}</span>
        </div>

        <!-- 粘贴对方设备 ID 即可配对(双方各加一次,mutual)。跨网段/无 mDNS 时填对方地址:ws://(前缀) + IP + :端口(默认 22000) -->
        <form class="add-device" @submit.prevent="addDevice">
          <n-input v-model:value="newDeviceId" placeholder="粘贴对方设备 ID" />
          <div class="addr-group">
            <n-input v-model:value="newDeviceHost" placeholder="对方 IP" class="device-host">
              <template #prefix>ws://</template>
            </n-input>
            <span class="addr-colon">:</span>
            <n-input v-model:value="newDevicePort" placeholder="22000" class="device-port" />
          </div>
          <n-button type="primary" attr-type="submit" :disabled="busy">添加设备</n-button>
        </form>

        <div v-if="status.devices.length === 0" class="empty">还没有设备 · 在上方粘贴对方设备 ID 添加</div>
        <div
          v-for="p in status.devices"
          :key="p.deviceId"
          class="item-card"
          :class="{ 'is-linked': hoverDevices.includes(p.deviceId) }"
        >
          <div class="item-top">
            <span class="avatar" :class="p.online ? 'online' : 'offline'">{{ monogram(p.deviceId) }}</span>
            <span class="item-title mono">{{ p.deviceId }}</span>
            <span class="status-pill" :class="p.online ? 'pill-online' : 'pill-offline'">
              {{ p.online ? '在线' : '离线' }}
            </span>
            <n-button size="small" type="error" tertiary :disabled="busy" @click="askRemoveDevice(p.deviceId)">移除</n-button>
          </div>
          <div class="item-sub">
            共享 {{ deviceFolderCount(p.deviceId) }} 个目录
          </div>
          <div v-if="p.url" class="item-addr">
            <span class="addr-label">地址</span><span class="addr-value mono">{{ stripWs(p.url) }}</span>
          </div>
          <div v-if="!p.online" class="actions">
            <n-button size="small" tertiary :disabled="busy" @click="reconnect(p.deviceId)">重连</n-button>
          </div>
        </div>
      </section>
    </div>

    <!-- 使用指南弹窗(开合带动画,由 <Transition> 驱动) -->
    <Transition name="guide">
      <div v-if="showGuide" class="modal-overlay" @click.self="closeGuide">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <n-button quaternary circle class="modal-close" aria-label="关闭" @click="closeGuide">×</n-button>
        <h2 id="guide-title" class="modal-title">首次使用指南</h2>
        <p class="modal-lead">四步把两台设备连起来,开始局域网同步。</p>

        <ol class="guide-steps">
          <li>
            <div class="guide-step-h">① 添加共享目录</div>
            <div class="guide-step-b">
              在左侧「共享目录」填写<strong>本地目录绝对路径</strong>(如
              <code class="mono">/home/me/Documents</code>)。目录 ID 留空会自动生成,
              但<strong>跨机同步时对方须用同一个目录 ID</strong>(可点目录卡上的「复制」发给对方)。
            </div>
          </li>
          <li>
            <div class="guide-step-h">② 添加对方设备</div>
            <div class="guide-step-b">
              在右侧「设备」粘贴对方的<strong>设备 ID</strong>(对方网页顶部那串字符),点「添加设备」。
              对方网页会立刻弹出<strong>配对请求</strong>,点「确认」即完成双向配对。
            </div>
          </li>
          <li>
            <div class="guide-step-h">③ 指派目录给设备</div>
            <div class="guide-step-b">
              在左侧目录卡上的「选择可同步此目录的设备」里勾选刚添加的设备。
              对方网页会弹出<strong>目录共享邀请</strong>,点「确认」并选好本机路径,目录即开始双向同步。
            </div>
          </li>
          <li>
            <div class="guide-step-h">④ 等待同步</div>
            <div class="guide-step-b">
              配对成功后,该目录会出现在双方设备上。状态显示为「在线 / 传输中 / 已同步」;进度条流动代表正在传数据。
            </div>
          </li>
        </ol>

        <div v-if="isDev" class="guide-note">
          开发提示:本界面当前由控制端口 <code class="mono">{{ controlPort }}</code> 提供;dev 模式请访问
          <code class="mono">5173</code>(HMR 实时热更新)。
        </div>

        <n-button type="primary" block class="modal-ok" @click="closeGuide">我知道了</n-button>
      </div>
    </div>
    </Transition>

    <!-- 同步记录弹窗 -->
    <Transition name="guide">
      <div v-if="historyOpen" class="modal-overlay" @click.self="closeHistory">
        <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="history-title">
          <n-button quaternary circle class="modal-close" aria-label="关闭" @click="closeHistory">×</n-button>
          <h2 id="history-title" class="modal-title">同步记录</h2>
          <p class="modal-lead mono break">{{ historyFolderPath }}</p>

          <div v-if="historyLoading" class="history-loading">读取中…</div>
          <div v-else-if="historyEvents.length === 0" class="empty">还没有同步记录</div>
          <ul v-else class="history-list">
            <li v-for="ev in historyEvents" :key="ev.ts + ev.path + ev.action" class="history-row">
              <span class="history-time">{{ fmtTime(ev.ts) }}</span>
              <span class="history-action" :class="'act-' + ev.action">{{ actionLabel(ev.action) }}</span>
              <span class="history-dir" :class="ev.direction === 'local' ? 'dir-local' : 'dir-remote'">{{ directionLabel(ev.direction) }}</span>
              <span class="history-path mono break">{{ ev.path }}</span>
              <span v-if="ev.deviceId" class="history-dev mono">{{ ev.deviceId }}</span>
            </li>
          </ul>
        </div>
      </div>
    </Transition>

    <!-- 通用二次确认弹窗:移除共享目录 / 移除设备共用,确认前不触碰任何数据 -->
    <Transition name="guide">
      <div v-if="confirmState" class="modal-overlay" @click.self="closeConfirm">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <n-button quaternary circle class="modal-close" aria-label="关闭" @click="closeConfirm">×</n-button>
          <h2 id="confirm-title" class="modal-title">{{ confirmState.title }}</h2>
          <p class="modal-lead">{{ confirmState.message }}</p>
          <div v-if="confirmState.detail" class="confirm-detail mono break">{{ confirmState.detail }}</div>

          <template v-if="confirmState.folders && confirmState.folders.length > 0">
            <p class="confirm-sub">将从以下 {{ confirmState.folders.length }} 个共享目录中移除它</p>
            <div class="confirm-list">
              <div v-for="fd in confirmState.folders" :key="fd.path" class="confirm-row">
                <div class="confirm-row-main">
                  <span class="confirm-path mono break">{{ fd.path }}</span>
                  <span class="confirm-note">
                    {{ fd.others > 0 ? `还有 ${fd.others} 个设备 · 其他设备不受影响` : '仅共享给它 · 之后不再同步给任何设备' }}
                  </span>
                </div>
                <span v-if="fd.others === 0" class="confirm-tag">变空闲</span>
              </div>
            </div>
          </template>

          <p v-if="confirmState.note" class="confirm-note-extra">{{ confirmState.note }}</p>
          <div class="modal-actions">
            <n-button class="modal-cancel" :disabled="confirmBusy" @click="closeConfirm">取消</n-button>
            <n-button type="error" class="modal-danger" :loading="confirmBusy" @click="runConfirm">
              {{ confirmState.confirmText }}
            </n-button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>
