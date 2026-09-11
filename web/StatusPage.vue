<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, reactive } from 'vue';
import { NButton, NInput, NCheckbox, NCheckboxGroup, NTooltip } from 'naive-ui';
import type { ConfirmState, DeviceInfo, FolderErrorItem, FolderInfo, OfferInfo, StatusData, SyncProgressItem } from './types';
import { useToast } from './composables/useToast';
import UpdateBanner from './components/UpdateBanner.vue';
import GuideModal from './components/GuideModal.vue';
import HistoryModal from './components/HistoryModal.vue';
import ConfirmModal from './components/ConfirmModal.vue';
import EditFolderModal from './components/EditFolderModal.vue';
import AuthPasswordModal from './components/AuthPasswordModal.vue';
import LogsModal from './components/LogsModal.vue';

const props = defineProps<{ status: StatusData; message?: string }>();

// 本地响应式状态:SSR 注入的初始 status 作为起点,交互后由 fetch 更新
const status = ref<StatusData>(props.status);
const busy = ref(false);
// 轻提示:邀请链接进页面的提示属重要通知,走 alert 级
const { toast, showToast } = useToast();
if (props.message) showToast(props.message, 'alert');

// 使用指南弹窗
const showGuide = ref(false);
// 端口提示仅开发模式显示:「dev 请访问 5173(HMR)」对终端用户是噪音,
// build 后由 vite 静态替换为 false 并 tree-shake 掉整段 DOM。
const isDev = import.meta.env.DEV;
// 控制端口取当前地址的真实端口,而非硬编码 8384(--port 可改)。
const controlPort = globalThis.location?.port || '8384';
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (showGuide.value) showGuide.value = false;
  if (logsOpen.value) logsOpen.value = false;
}

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

// ---- 二次确认弹窗(移除目录 / 移除设备 / 升级共用;执行在 ConfirmModal 内) ----
const confirmState = ref<ConfirmState | null>(null);

function askConfirm(state: ConfirmState): void {
  if (busy.value) return;
  confirmState.value = state;
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

// 轻量拓扑联动:鼠标悬停目录卡时,目录卡自身与其配对的设备卡同时高亮,
// 形成「源 ↔ 目标」的视觉映射(只有远端高亮会显得像误触发)
const hoverDevices = ref<string[]>([]);
const hoverFolderKey = ref('');

function onFolderEnter(f: { id?: string; path: string; devices: string[] }): void {
  hoverDevices.value = f.devices;
  hoverFolderKey.value = folderKey(f);
}

function onFolderLeave(): void {
  hoverDevices.value = [];
  hoverFolderKey.value = '';
}

// ---- 设备配对(按 ID,默认收起,点按钮展开表单) ----
const addDeviceOpen = ref(false);
const newDeviceId = ref('');
const newDeviceHost = ref('');
const newDevicePort = ref('22000');

function toggleAddDevice(): void {
  addDeviceOpen.value = !addDeviceOpen.value;
}

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
    addDeviceOpen.value = false;
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

// ---- 从对端升级(设备卡版本低于对方时显示;dev↔build 混跑不出现) ----

/** 点设备卡「升级到 x.y.z」:二次确认后从对方拉取产物并自动重启。 */
function askUpgrade(p: DeviceInfo): void {
  askConfirm({
    title: '从该设备升级?',
    message: `将从对方拉取 syncx ${p.version} 替换本机产物,并自动重启服务。重启期间 Web UI 会短暂断开,稍后自动恢复。`,
    detail: p.deviceId,
    confirmText: '升级并重启',
    action: () => upgradeDevice(p.deviceId),
  });
}

async function upgradeDevice(deviceId: string): Promise<void> {
  const res = await fetch('/api/devices/upgrade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; version?: string; error?: string };
  if (!res.ok || !data.ok) throw new Error(data.error ?? `升级失败 (${res.status})`);
  showToast(`已更新到 ${data.version},daemon 重启中…`, 'alert');
  // daemon 即将重启:稍等片刻再刷新,让状态先落回「离线/重启中」
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await refreshStatus();
}

// ---- 按目录指派设备(编辑弹窗:卡片只读展示,弹窗内改动经 save 事件显式保存) ----
const editDevicesOpen = ref(false);
const editFolder = ref<FolderInfo | null>(null);

/** 点目录卡「设置」:打开弹窗并预填当前指派与忽略开关。 */
function openEditDevices(f: FolderInfo): void {
  editFolder.value = f;
  editDevicesOpen.value = true;
}

/** 弹窗「保存」:设备指派与 .gitignore 开关一起提交,真正的写操作只有这里。 */
async function saveEditDevices(payload: { path: string; devices: string[]; gitignore: boolean }): Promise<void> {
  await commitFolderDevices(payload.path, payload.devices);
  // refreshStatus 后按最新 folders 找回该目录,开关有变化才额外发一次请求
  const f = status.value.folders.find((x) => x.path === payload.path);
  if (f && (f.useGitignore !== false) !== payload.gitignore) {
    await toggleFolderGitignore(f, payload.gitignore);
  }
  editDevicesOpen.value = false;
}

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

// ---- .gitignore 忽略开关(在目录编辑弹窗内,缺省勾选) ----

/** 勾选 = 忽略 .gitignore 中的文件(不参与同步);取消勾选 = .gitignore 内文件也同步。 */
async function toggleFolderGitignore(f: FolderInfo, enabled: boolean): Promise<void> {
  const res = await fetch('/api/folders/gitignore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: f.path, enabled }),
  });
  if (!res.ok) {
    showToast(`更新失败 (${res.status})`);
    await refreshStatus(); // 回读后端真实状态,避免勾选框与配置不一致
    return;
  }
  f.useGitignore = enabled;
  showToast(enabled ? '已开启:.gitignore 中的文件将不再同步' : '已关闭:.gitignore 中的文件也会同步');
}

// ---- 添加共享目录(默认收起,点按钮展开表单) ----
const addFolderOpen = ref(false);
const newPath = ref('');
const newFolderId = ref('');
const newFolderDevices = ref<string[]>([]);

function toggleAddFolder(): void {
  addFolderOpen.value = !addFolderOpen.value;
}

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
    const data = (await res.json()) as { created?: boolean };
    showToast(data.created ? '已添加共享目录(原路径不存在,已自动创建)' : '已添加共享目录');
    newPath.value = '';
    newFolderId.value = '';
    newFolderDevices.value = [];
    addFolderOpen.value = false;
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
    showToast(offer.kind === 'folder' ? '已接受目录共享,开始同步' : '已接受配对', 'alert');
    await refreshStatus();
  } catch {
    showToast('确认失败,请重试');
  } finally {
    busy.value = false;
  }
}

async function declineOffer(offer: OfferInfo): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await fetch(`/api/offers/${encodeURIComponent(offer.id)}/decline`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`decline ${res.status}`);
    showToast('已忽略该请求(可在下方「已忽略」中恢复)');
    await refreshStatus();
  } catch {
    showToast('操作失败,请重试');
  } finally {
    busy.value = false;
  }
}

/** 手误忽略的兜底:把已忽略的待确认项恢复为 pending,重新出现在确认列表。 */
async function restoreOffer(offer: OfferInfo): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await fetch(`/api/offers/${encodeURIComponent(offer.id)}/restore`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`restore ${res.status}`);
    showToast('已恢复,请重新确认');
    await refreshStatus();
  } catch {
    showToast('恢复失败,请重试');
  } finally {
    busy.value = false;
  }
}

// 待确认区分两组:pending 可确认/忽略;declined 灰显仅供恢复(默认收起,点按钮展开)
const pendingOffers = computed(() => status.value.offers.filter((o) => o.status !== 'declined'));
const declinedOffers = computed(() => status.value.offers.filter((o) => o.status === 'declined'));
const declinedOpen = ref(false);

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

// 该目录最近一次同步错误(目录卡上的红色横幅;下一轮扫描干净后自动消失)
function folderErrorOf(f: { id?: string; path: string }): FolderErrorItem | undefined {
  const key = folderKey(f);
  return status.value.folderErrors?.find((e) => e.folder === key);
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

// 某设备被指派到的目录数量
function deviceFolderCount(deviceId: string): number {
  return status.value.folders.filter((f) => f.devices.includes(deviceId)).length;
}

// 设备卡里展示对端地址时去掉 ws:// 前缀,只留 host:port
function stripWs(url: string): string {
  return url.startsWith('ws://') ? url.slice(5) : url;
}

// 地址(host:port)与主机名合并到一行,避免纵向多占一行;两者都可能缺失
function deviceAddrLine(p: DeviceInfo): string {
  return [p.url ? stripWs(p.url) : '', p.hostname].filter(Boolean).join(' · ');
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

/** 目录卡设备标签的四态:同步中 / 待对方确认 / 对方已停止共享 / 设备离线。 */
type DeviceTagStatus = 'syncing' | 'pending' | 'stopped' | 'offline';

/**
 * 依据设备在线状态与其宣告的目录清单(folder-sync-list)判定标签状态:
 * - 离线:设备连接断开;
 * - 待对方确认:设备在线,其宣告的清单里没有本目录,但它的待确认项里有本目录(共享邀请已送达、尚未确认);
 * - 已停止:设备在线,清单里没有本目录且无待确认(旧版本对端无清单,退化为「同步中」);
 * - 同步中:设备在线且清单包含本目录。
 */
function deviceTagStatus(f: FolderInfo, deviceId: string): { key: DeviceTagStatus; label: string } {
  const dev = status.value.devices.find((x) => x.deviceId === deviceId);
  if (!dev?.online) return { key: 'offline', label: '离线' };
  const fid = f.id ?? f.path;
  if (dev.remoteFolders === undefined) return { key: 'syncing', label: '同步中' };
  if (dev.remoteFolders.includes(fid)) return { key: 'syncing', label: '同步中' };
  return (dev.remotePendingFolders ?? []).includes(fid)
    ? { key: 'pending', label: '待对方确认' }
    : { key: 'stopped', label: '对方已停止共享' };
}

/** 悬停设备标签时的 tooltip 文案:一句话说清当前状态与接下来会发生什么。 */
function deviceTagTip(f: FolderInfo, deviceId: string): string {
  const s = deviceTagStatus(f, deviceId);
  switch (s.key) {
    case 'syncing':
      return '同步中:对方已接受共享且在线,变更会双向同步';
    case 'pending':
      return '待对方确认:共享邀请已送达,对方确认后开始同步';
    case 'stopped':
      return '对方未共享此目录:可能拒绝了邀请或已停止共享';
    case 'offline':
      return '设备离线:对方上线后会自动继续同步';
  }
}

// 同步记录弹窗:非空 = 打开该目录的记录(拉取与展示在 HistoryModal 内)
const historyFolder = ref<FolderInfo | null>(null);

function openHistory(f: FolderInfo): void {
  historyFolder.value = f;
}

// ---- 日志弹窗(拉取与展示在 LogsModal 内) ----
const logsOpen = ref(false);

// ---- npm 更新(检查/横幅/升级流程;横幅本体在 UpdateBanner 组件) ----
/** 升级进行中:隐藏横幅并防止重复触发。 */
const upgrading = ref(false);

/** 横幅「立即升级」:二次确认后走 npm 自升级,服务重启完成自动刷新页面。 */
function askSelfUpdate(u: { latest: string; current: string }): void {
  askConfirm({
    title: `升级到 ${u.latest}?`,
    message: `将从 npm 下载官方安装包,校验通过后自动重启服务(当前 ${u.current})。重启期间页面会短暂失去连接,完成后自动刷新。`,
    confirmText: '开始升级',
    action: () => doSelfUpdate(u.latest),
  });
}

async function doSelfUpdate(latest: string): Promise<void> {
  upgrading.value = true;
  const res = await fetch('/api/self-update', { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `self-update ${res.status}`);
  showToast(`已开始升级到 ${latest},服务重启中,请稍候…`, 'alert');
  await waitForRestart();
  // 新 daemon 已在同一端口就绪:整页刷新加载新版本前端
  window.location.reload();
}

/** 轮询 /health(免认证)直到服务回来;超时抛错由确认弹窗展示。 */
async function waitForRestart(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch('/health', { cache: 'no-store' });
      if (res.ok) return;
    } catch {
      // 还没起来,继续等
    }
  }
  throw new Error('服务重启超时,请到终端确认 daemon 状态');
}

/** 顶栏「检查更新」:立即查一次 registry 并刷新状态。 */
async function checkForUpdate(): Promise<void> {
  const res = await fetch('/api/self-update/check', { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    update?: { latest: string } | null;
  };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `check ${res.status}`);
  await refreshStatus();
  showToast(
    body.update ? `发现新版本 ${body.update.latest}` : `已是最新版本 ${status.value.version ?? ''}`,
    body.update ? 'alert' : 'info',
  );
}

// ---- 登录密码弹窗(设置/修改/清除逻辑在 AuthPasswordModal 内) ----
const authOpen = ref(false);

// ---- 退出登录:清会话 cookie 后回到登录页 ----
async function logout(): Promise<void> {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {
    // 网络异常也照走跳转:无凭据时服务端本来就会渲染登录壳
  }
  location.replace('/');
}
</script>

<template>
  <div class="container">
    <div v-if="toast" class="toast" :class="{ 'toast--alert': toast.kind === 'alert' }">
      <svg v-if="toast.kind === 'alert'" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
      {{ toast.msg }}
    </div>

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

      <n-button tertiary :disabled="busy" @click="checkForUpdate">
        <template #icon>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-3-6.7" />
            <path d="M21 3v5h-5" />
          </svg>
        </template>
        检查更新
      </n-button>

      <n-button tertiary @click="logsOpen = true">
        <template #icon>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 5h16" />
            <path d="M4 12h16" />
            <path d="M4 19h10" />
          </svg>
        </template>
        日志
      </n-button>

      <n-button tertiary @click="showGuide = true">使用指南</n-button>
      <n-button tertiary @click="authOpen = true">登录密码</n-button>
      <n-button tertiary @click="logout">退出</n-button>

      <div class="topbar__spacer"></div>

      <span class="device-chip">
        <span class="dot" :class="status.devices.some((p) => p.online) ? 'dot-online' : 'dot-offline'"></span>
        <span class="mono">{{ status.deviceId }}</span>
        <span v-if="status.version" class="chip-version">{{ status.version === 'dev' ? status.version : `v${status.version}` }}</span>
      </span>
    </div>

    <!-- 发现新版本横幅(npm 定时检查;忽略/升级交互在组件内) -->
    <UpdateBanner
      :update="upgrading ? null : (status.updateAvailable ?? null)"
      :busy="busy"
      @upgrade="askSelfUpdate"
    />

    <!-- 概览胶囊 -->
    <div class="stat-pills">
      <span class="stat-pill-item"><b>{{ status.entries }}</b><span>索引条目</span></span>
      <span class="stat-pill-item"><b>{{ status.tombstones }}</b><span>墓碑</span></span>
      <span class="stat-pill-item"><b>{{ status.folders.length }}</b><span>共享目录</span></span>
      <span class="stat-pill-item"><b>{{ status.devices.length }}</b><span>已配对设备</span></span>
    </div>

    <!-- 待确认:对方推送的配对 / 目录共享邀请(pending 可操作;declined 灰显供恢复) -->
    <div v-if="status.offers && status.offers.length" class="offers">
      <div class="col-head">
        <span>待确认</span>
        <span class="badge">{{ pendingOffers.length }}</span>
      </div>
      <div
        v-for="o in pendingOffers"
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
        <div class="item-sub">来自 <span class="mono">{{ o.fromDeviceId }}</span><span v-if="o.fromIp || o.fromHostname" class="muted"> · <template v-if="o.fromIp">{{ o.fromIp }}</template><template v-if="o.fromHostname">{{ o.fromIp ? ' · ' : '' }}{{ o.fromHostname }}</template></span></div>
        <div v-if="o.kind === 'folder'" class="offer-path">
          <n-input v-model:value="offerPaths[o.id]" placeholder="本机目录绝对路径,如 /home/me/Documents" />
          <p class="form-hint">目录不存在时会自动创建</p>
        </div>
        <div class="actions">
          <n-button size="small" type="primary" :disabled="busy" @click="acceptOffer(o)">确认</n-button>
          <n-button size="small" tertiary :disabled="busy" @click="declineOffer(o)">忽略</n-button>
        </div>
      </div>

      <!-- 已忽略:手误忽略的兜底。默认收起,点按钮展开;已接受的不展示 -->
      <div v-if="declinedOffers.length" class="declined-toggle">
        <n-button size="tiny" quaternary :disabled="busy" @click="declinedOpen = !declinedOpen">
          {{ declinedOpen ? '▾ 收起已忽略' : `▸ 已忽略 (${declinedOffers.length})` }}
        </n-button>
      </div>
      <template v-if="declinedOpen">
        <div
          v-for="o in declinedOffers"
          :key="o.id"
          class="item-card offer-card is-declined"
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
            <span class="declined-flag">已忽略</span>
          </div>
          <div class="item-sub">来自 <span class="mono">{{ o.fromDeviceId }}</span><span v-if="o.fromIp || o.fromHostname" class="muted"> · <template v-if="o.fromIp">{{ o.fromIp }}</template><template v-if="o.fromHostname">{{ o.fromIp ? ' · ' : '' }}{{ o.fromHostname }}</template></span></div>
          <div class="actions">
            <n-button size="small" tertiary :disabled="busy" @click="restoreOffer(o)">恢复</n-button>
          </div>
        </div>
      </template>
    </div>

    <!-- 主体:左右两栏(左=共享目录,右=设备) -->
    <div class="layout">
      <!-- 左栏:共享目录 -->
      <section class="col col--folders">
        <div class="col-head">
          <span>共享目录</span>
          <span class="badge">{{ status.folders.length }}</span>
          <n-button :disabled="busy" @click="rescan">扫描全部</n-button>
          <n-button v-if="status.folders.length > 0" class="add-toggle" :class="{ 'is-invisible': addFolderOpen }" :disabled="busy" :tabindex="addFolderOpen ? -1 : 0" @click="toggleAddFolder">＋ 添加</n-button>
        </div>

        <!-- 添加共享目录:头部按钮触发展开;列表为空时表单常显 -->
        <form v-if="addFolderOpen || status.folders.length === 0" class="add-form" @submit.prevent="addFolder">
          <n-input v-model:value="newPath" placeholder="本地目录绝对路径,如 /home/me/Documents" />
          <p class="form-hint">目录不存在时会自动创建</p>
          <n-input v-model:value="newFolderId" placeholder="目录 ID(留空自动生成;跨机同步需与对方一致)" />
          <n-checkbox-group v-model:value="newFolderDevices">
            <div v-if="status.devices.length > 0" class="device-checks">
              <n-checkbox v-for="d in status.devices" :key="d.deviceId" :value="d.deviceId" :label="d.deviceId" class="mono" />
            </div>
            <p v-else class="confirm-note-extra confirm-note-extra--flush">还没有已配对的设备,可先添加目录,稍后在卡片上指派。</p>
          </n-checkbox-group>
          <div class="add-form-actions">
            <n-button quaternary :disabled="busy" @click="toggleAddFolder">取消</n-button>
            <n-button type="primary" attr-type="submit" :disabled="busy">添加</n-button>
          </div>
        </form>

        <div v-if="status.folders.length === 0" class="empty">还没有共享目录 · 在上方添加第一个</div>
        <div
          v-for="f in status.folders"
          :key="folderKey(f)"
          class="item-card"
          :class="{ 'is-linked': hoverFolderKey === folderKey(f) }"
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

          <!-- 同步错误横幅:该目录最近一次同步失败的原因(扫描干净后自动消失) -->
          <div v-if="folderErrorOf(f)" class="folder-error" role="alert">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="folder-error__icon">
              <path d="M12 3 2.5 20h19z" />
              <line x1="12" y1="10" x2="12" y2="14" />
              <line x1="12" y1="17" x2="12" y2="17.1" />
            </svg>
            <div class="folder-error__body">
              <div class="folder-error__msg break">{{ folderErrorOf(f)!.message }}</div>
              <div class="folder-error__time">{{ fmtTime(folderErrorOf(f)!.ts) }} · 下一轮扫描成功后自动清除</div>
            </div>
          </div>

          <!-- 按目录指派可同步的设备:卡片上只读展示,点「编辑」弹窗修改后显式保存 -->
          <div class="fid-devices">
            <div class="device-tags">
              <n-tooltip v-for="d in f.devices" :key="d" trigger="hover" :style="{ maxWidth: '280px' }">
                <template #trigger>
                  <span class="device-tag mono" :class="`is-${deviceTagStatus(f, d).key}`">{{ d }}</span>
                </template>
                {{ deviceTagTip(f, d) }}
              </n-tooltip>
              <span v-if="f.devices.length === 0" class="device-tag device-tag-empty">未指派设备</span>
            </div>
            <n-button size="small" tertiary :disabled="busy" @click="openEditDevices(f)">设置</n-button>
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
      </section>

      <!-- 右栏:设备 -->
      <section class="col col--devices">
        <div class="col-head">
          <span>设备</span>
          <span class="badge">{{ status.devices.length }}</span>
          <n-button v-if="status.devices.length > 0" class="add-toggle" :class="{ 'is-invisible': addDeviceOpen }" :disabled="busy" :tabindex="addDeviceOpen ? -1 : 0" @click="toggleAddDevice">＋ 添加</n-button>
        </div>

        <!-- 粘贴对方设备 ID 即可配对(双方各加一次,mutual)。跨网段/无 mDNS 时填对方地址:ws://(前缀) + IP + :端口(默认 22000) -->
        <form v-if="addDeviceOpen || status.devices.length === 0" class="add-device" @submit.prevent="addDevice">
          <n-input v-model:value="newDeviceId" placeholder="粘贴对方设备 ID" />
          <div class="addr-group">
            <n-input v-model:value="newDeviceHost" placeholder="对方 IP" class="device-host">
              <template #prefix>ws://</template>
            </n-input>
            <span class="addr-colon">:</span>
            <n-input v-model:value="newDevicePort" placeholder="22000" class="device-port" />
          </div>
          <div class="add-form-actions">
            <n-button quaternary :disabled="busy" @click="toggleAddDevice">取消</n-button>
            <n-button type="primary" attr-type="submit" :disabled="busy">添加</n-button>
          </div>
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
          <div class="item-addr">
            <span class="addr-label">版本</span><span class="addr-value mono">{{ p.version ?? '未知' }}</span>
          </div>
          <div v-if="p.url || p.hostname" class="item-addr">
            <span class="addr-label">{{ p.url ? '地址' : '主机名' }}</span><span class="addr-value mono">{{ deviceAddrLine(p) }}</span>
          </div>
          <div v-if="p.online && p.canUpgrade" class="actions">
            <n-button size="small" type="warning" :disabled="busy" class="btn-upgrade" @click="askUpgrade(p)">
              <template #icon>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </template>
              升级到 {{ p.version }}
            </n-button>
          </div>
          <div v-if="!p.online" class="actions">
            <n-button size="small" tertiary :disabled="busy" @click="reconnect(p.deviceId)">重连</n-button>
          </div>
        </div>
      </section>
    </div>

    <!-- 使用指南弹窗 -->
    <GuideModal :open="showGuide" :is-dev="isDev" :control-port="controlPort" @close="showGuide = false" />

    <!-- 同步记录弹窗 -->
    <HistoryModal :folder="historyFolder" :notify="showToast" @close="historyFolder = null" />

    <!-- 通用二次确认弹窗 -->
    <ConfirmModal :state="confirmState" :notify="showToast" @closed="confirmState = null" />

    <!-- 目录编辑弹窗 -->
    <EditFolderModal
      :open="editDevicesOpen"
      :folder="editFolder"
      :devices="status.devices"
      :busy="busy"
      @close="editDevicesOpen = false"
      @save="saveEditDevices"
    />

    <!-- 登录密码弹窗 -->
    <AuthPasswordModal :open="authOpen" :notify="showToast" @close="authOpen = false" />

    <!-- 日志弹窗 -->
    <LogsModal :open="logsOpen" @close="logsOpen = false" />
  </div>
</template>
