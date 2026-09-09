<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, reactive } from 'vue';
import { NButton, NInput, NCheckbox, NCheckboxGroup, NTooltip } from 'naive-ui';

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
  /** 是否遵循 .gitignore 忽略规则;后端缺省 true(未显式关闭都视为开启)。 */
  useGitignore?: boolean;
}

interface DeviceInfo {
  deviceId: string;
  online: boolean;
  url?: string;
  /** 该设备被指派到的目录 id 列表(用于展示「共享 N 个目录」)。 */
  folders: string[];
  /** 对端宣告的「它与本机在同步的目录 id 集合」;undefined=旧版本对端,无法判断已停止共享。 */
  remoteFolders?: string[];
  /** 对端宣告的仍待确认的、来自本机的目录邀请 id 集合(区分「待对方确认」与「已停止共享」)。 */
  remotePendingFolders?: string[];
  /** 对端运行版本;dev 态为 'dev',undefined=旧版本对端未发 hello。 */
  version?: string;
  /** 本机(打包态)版本低于该对端时为 true,UI 提供「从对方升级」入口。 */
  canUpgrade?: boolean;
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

interface FolderErrorItem {
  folder: string;
  message: string;
  ts: number;
}

interface StatusData {
  deviceId: string;
  /** 本机运行版本;dev 态为 'dev'。 */
  version?: string;
  entries: number;
  tombstones: number;
  folders: FolderInfo[];
  devices: DeviceInfo[];
  syncProgress: SyncProgressItem[];
  offers: OfferInfo[];
  folderErrors?: FolderErrorItem[];
  /** npm 检查到的可用更新(打包态且发现更高版本时才有值)。 */
  updateAvailable?: { latest: string; current: string } | null;
}

const props = defineProps<{ status: StatusData; message?: string }>();

// 本地响应式状态:SSR 注入的初始 status 作为起点,交互后由 fetch 更新
const status = ref<StatusData>(props.status);
const toast = ref<string | undefined>(props.message);
const busy = ref(false);

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
  if (e.key !== 'Escape') return;
  if (showGuide.value) closeGuide();
  if (logsOpen.value) closeLogs();
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
  } catch (error) {
    // 失败时保留弹窗,便于取消或重试,不做任何数据假设;后端给的原因(如有)优先展示
    showToast(error instanceof Error && error.message ? error.message : '操作失败,请重试');
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
  showToast(`已更新到 ${data.version},daemon 重启中…`);
  // daemon 即将重启:稍等片刻再刷新,让状态先落回「离线/重启中」
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await refreshStatus();
}

// ---- 按目录指派设备(编辑弹窗:改动需显式保存,避免误触下拉直接生效) ----
const editDevicesOpen = ref(false);

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

/** 正在编辑的目录路径,空串表示弹窗未关联目录。 */
const editDevicesPath = ref('');
const editDevicesValue = ref<string[]>([]);
/** 弹窗内的 .gitignore 忽略开关(随「保存」与设备指派一并提交)。 */
const editGitignore = ref(true);

/** 点目录卡「编辑」:打开弹窗并预填当前指派与忽略开关,不直接改任何数据。 */
function openEditDevices(f: FolderInfo): void {
  editDevicesPath.value = f.path;
  editDevicesValue.value = [...f.devices];
  editGitignore.value = f.useGitignore !== false;
  editDevicesOpen.value = true;
}

function closeEditDevices(): void {
  editDevicesOpen.value = false;
}

/** 弹窗「保存」:设备指派与 .gitignore 开关一起提交,真正的写操作只有这里。 */
async function saveEditDevices(): Promise<void> {
  const path = editDevicesPath.value;
  await commitFolderDevices(path, [...editDevicesValue.value]);
  // refreshStatus 后按最新 folders 找回该目录,开关有变化才额外发一次请求
  const f = status.value.folders.find((x) => x.path === path);
  if (f && (f.useGitignore !== false) !== editGitignore.value) {
    await toggleFolderGitignore(f, editGitignore.value);
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

// ---- 日志弹窗:读取 daemon 日志尾部(仅 --log-file 启动时有日志可看) ----
const logsOpen = ref(false);
const logsLoading = ref(false);
const logsLines = ref<string[]>([]);
const logsError = ref('');
const logsFile = ref('');
const logsTruncated = ref(0);
const logsView = ref<HTMLElement | null>(null);

async function fetchLogs(): Promise<void> {
  logsLoading.value = true;
  logsError.value = '';
  try {
    const res = await fetch('/api/logs?lines=800');
    if (!res.ok) throw new Error(`logs ${res.status}`);
    const data = (await res.json()) as { ok: boolean; error?: string; file?: string; truncated?: number; lines?: string[] };
    if (!data.ok) {
      // 未设置 --log-file 或读取失败:展示原因,引导用户补启动参数
      logsError.value = data.error ?? '读取日志失败';
      logsLines.value = [];
      return;
    }
    logsLines.value = data.lines ?? [];
    logsFile.value = data.file ?? '';
    logsTruncated.value = data.truncated ?? 0;
    // 下一帧滚到底部:日志按时间正序,最新在最后
    requestAnimationFrame(() => {
      const el = logsView.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  } catch {
    logsError.value = '读取日志失败,请重试';
  } finally {
    logsLoading.value = false;
  }
}

async function openLogs(): Promise<void> {
  logsOpen.value = true;
  logsLines.value = [];
  logsError.value = '';
  await fetchLogs();
}

function closeLogs(): void {
  logsOpen.value = false;
}

// ---- npm 更新(后端定时检查,发现新版本经 status.updateAvailable 下发) ----
/** 本会话已点「忽略」的版本号,避免横幅反复出现。 */
const updateDismissed = ref('');
/** 升级进行中:隐藏横幅并防止重复触发。 */
const upgrading = ref(false);

const updateAvailable = computed(() => {
  const u = status.value.updateAvailable;
  if (!u || upgrading.value || u.latest === updateDismissed.value) return null;
  return u;
});

/** 横幅「立即升级」:二次确认后走 npm 自升级,服务重启完成自动刷新页面。 */
function askSelfUpdate(): void {
  const u = updateAvailable.value;
  if (!u) return;
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
  showToast(`已开始升级到 ${latest},服务重启中,请稍候…`);
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
  showToast(body.update ? `发现新版本 ${body.update.latest}` : `已是最新版本 ${status.value.version ?? ''}`);
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

// ---- 登录密码:设置 / 修改 / 清除 ----
const authOpen = ref(false);
const authMode = ref<'token' | 'password'>('token');
const authUsername = ref('');
const authBusy = ref(false);

async function openAuth(): Promise<void> {
  authOpen.value = true;
  authUsername.value = '';
  try {
    const res = await fetch('/api/auth');
    if (!res.ok) throw new Error(`auth ${res.status}`);
    const data = (await res.json()) as { mode?: 'token' | 'password' };
    authMode.value = data.mode === 'password' ? 'password' : 'token';
  } catch {
    authMode.value = 'token';
  }
}

function closeAuth(): void {
  authOpen.value = false;
}

// ---- 退出登录:清会话 cookie 后回到登录页 ----
async function logout(): Promise<void> {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {
    // 网络异常也照走跳转:无凭据时服务端本来就会渲染登录壳
  }
  location.replace('/');
}

const authPassword = ref('');
const authConfirm = ref('');

async function savePassword(): Promise<void> {
  if (authBusy.value) return;
  const u = authUsername.value.trim();
  if (!u) {
    showToast('请填写用户名');
    return;
  }
  if (authPassword.value.length < 6) {
    showToast('密码至少 6 位');
    return;
  }
  if (authPassword.value !== authConfirm.value) {
    showToast('两次输入的密码不一致');
    return;
  }
  authBusy.value = true;
  try {
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: authPassword.value }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `http ${res.status}`);
    }
    authMode.value = 'password';
    authPassword.value = '';
    authConfirm.value = '';
    showToast('登录密码已设置');
    closeAuth();
  } catch (e) {
    showToast(e instanceof Error ? e.message : '设置失败,请重试');
  } finally {
    authBusy.value = false;
  }
}

async function removePassword(): Promise<void> {
  if (authBusy.value) return;
  authBusy.value = true;
  try {
    const res = await fetch('/api/auth/password', { method: 'DELETE' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    authMode.value = 'token';
    authPassword.value = '';
    authConfirm.value = '';
    showToast('已清除登录密码,恢复令牌登录');
    closeAuth();
  } catch {
    showToast('清除失败,请重试');
  } finally {
    authBusy.value = false;
  }
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

      <n-button tertiary :disabled="busy" @click="checkForUpdate">
        <template #icon>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-3-6.7" />
            <path d="M21 3v5h-5" />
          </svg>
        </template>
        检查更新
      </n-button>

      <n-button tertiary @click="openLogs">
        <template #icon>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 5h16" />
            <path d="M4 10h16" />
            <path d="M4 15h10" />
            <path d="M4 20h7" />
          </svg>
        </template>
        日志
      </n-button>

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

      <n-button tertiary @click="openAuth">
        <template #icon>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
            <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
          </svg>
        </template>
        登录密码
      </n-button>

      <n-button tertiary @click="logout">
        <template #icon>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" />
            <path d="M10 8 6 12l4 4" />
            <path d="M6 12h9" />
          </svg>
        </template>
        退出
      </n-button>

      <div class="topbar__spacer"></div>

      <span class="device-chip">
        <span class="dot" :class="status.devices.some((p) => p.online) ? 'dot-online' : 'dot-offline'"></span>
        <span class="mono">{{ status.deviceId }}</span>
      </span>
    </div>

    <!-- 发现新版本横幅:npm 定时检查到更高版本时出现,可忽略(本会话不再提示) -->
    <div v-if="updateAvailable" class="update-banner" role="status">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v10" />
        <path d="m8 9 4 4 4-4" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </svg>
      <span class="update-banner__text">
        发现新版本 <b class="mono">{{ updateAvailable.latest }}</b>(当前 {{ updateAvailable.current }})
      </span>
      <n-button size="tiny" type="primary" :disabled="busy" @click="askSelfUpdate">立即升级</n-button>
      <n-button size="tiny" quaternary @click="updateDismissed = updateAvailable.latest">忽略</n-button>
    </div>

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
        <div class="item-sub">来自 <span class="mono">{{ o.fromDeviceId }}</span></div>
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
          <div class="item-sub">来自 <span class="mono">{{ o.fromDeviceId }}</span></div>
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
          <div v-if="p.url" class="item-addr">
            <span class="addr-label">地址</span><span class="addr-value mono">{{ stripWs(p.url) }}</span>
          </div>
          <div v-if="p.online && p.canUpgrade" class="actions">
            <n-button size="small" type="primary" tertiary :disabled="busy" @click="askUpgrade(p)">升级到 {{ p.version }}</n-button>
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
          <div class="modal-title-row">
            <h2 id="history-title" class="modal-title">同步记录</h2>
            <span class="modal-title-path mono" :title="historyFolderPath">{{ historyFolderPath }}</span>
          </div>

          <div v-if="historyLoading" class="history-loading">读取中…</div>
          <div v-else-if="historyEvents.length === 0" class="empty">还没有同步记录</div>
          <ul v-else class="history-list">
            <li v-for="ev in historyEvents" :key="ev.ts + ev.path + ev.action" class="history-row">
              <span class="history-time">{{ fmtTime(ev.ts) }}</span>
              <span class="history-action" :class="'act-' + ev.action">{{ actionLabel(ev.action) }}</span>
              <span class="history-dir" :class="ev.direction === 'local' ? 'dir-local' : 'dir-remote'">{{ directionLabel(ev.direction) }}{{ ev.direction !== 'local' && ev.deviceId ? `：${ev.deviceId}` : '' }}</span>
              <span class="history-path mono break">{{ ev.path }}</span>
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

    <!-- 目录编辑弹窗:卡片上的指派/开关只读,改动在此确认后一并保存 -->
    <Transition name="guide">
      <div v-if="editDevicesOpen" class="modal-overlay" @click.self="closeEditDevices">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="edit-devices-title">
          <n-button quaternary circle class="modal-close" aria-label="关闭" @click="closeEditDevices">×</n-button>
          <div class="modal-title-row">
            <h2 id="edit-devices-title" class="modal-title">设置</h2>
            <span class="modal-title-path mono" :title="editDevicesPath">{{ editDevicesPath }}</span>
          </div>

          <div class="edit-section-label">同步设备</div>
          <n-checkbox-group v-model:value="editDevicesValue">
            <div v-if="status.devices.length > 0" class="device-checks">
              <n-checkbox v-for="d in status.devices" :key="d.deviceId" :value="d.deviceId" :label="d.deviceId" class="mono" />
            </div>
            <p v-else class="confirm-note-extra confirm-note-extra--flush">还没有已配对的设备,先在「设备」栏添加。</p>
          </n-checkbox-group>
          <p class="confirm-note-extra">保存后,新加入的设备会立即收到共享邀请(在线时),被移除的设备不再同步此目录。</p>

          <div class="edit-section-label">忽略规则</div>
          <n-checkbox v-model:checked="editGitignore" :disabled="busy">忽略 .gitignore 中的文件</n-checkbox>
          <p class="confirm-note-extra">勾选时,该目录内 .gitignore 命中的文件不参与同步(.syncxignore 优先级更高)。</p>

          <div class="modal-actions">
            <n-button class="modal-cancel" :disabled="busy" @click="closeEditDevices">取消</n-button>
            <n-button type="primary" :loading="busy" @click="saveEditDevices">保存</n-button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 登录密码弹窗:设置后可用账号密码登录,无需再记 48 位令牌 -->
    <Transition name="guide">
      <div v-if="authOpen" class="modal-overlay" @click.self="closeAuth">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
          <n-button quaternary circle class="modal-close" aria-label="关闭" @click="closeAuth">×</n-button>
          <h2 id="auth-title" class="modal-title">登录密码</h2>
          <p class="modal-lead">
            <template v-if="authMode === 'password'">
              已启用账号密码登录。修改用户名请在下方一并输入。
            </template>
            <template v-else>
              当前使用 <span class="mono">control.token</span> 登录。设置后可用账号密码登录,不必再记那串令牌。
            </template>
          </p>

          <label class="field">
            <span class="field__label">用户名</span>
            <n-input v-model:value="authUsername" autocomplete="username" placeholder="如 syncx" />
          </label>
          <label class="field">
            <span class="field__label">新密码</span>
            <n-input
              v-model:value="authPassword"
              type="password"
              show-password-on="click"
              autocomplete="new-password"
              placeholder="至少 6 位"
            />
          </label>
          <label class="field">
            <span class="field__label">确认新密码</span>
            <n-input
              v-model:value="authConfirm"
              type="password"
              show-password-on="click"
              autocomplete="new-password"
              placeholder="再输入一次"
            />
          </label>

          <p class="confirm-note-extra">
            令牌始终是恢复通道:忘记密码时用 <span class="mono">control.token</span> 登录进来重设即可。
            修改或清除密码会让所有已登录页面重新登录。
          </p>

          <div class="modal-actions">
            <n-button
              v-if="authMode === 'password'"
              class="modal-cancel"
              :disabled="authBusy"
              @click="removePassword"
            >清除密码</n-button>
            <n-button class="modal-cancel" :disabled="authBusy" @click="closeAuth">取消</n-button>
            <n-button type="primary" :loading="authBusy" @click="savePassword">保存</n-button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 日志弹窗:展示 daemon 日志尾部;仅 --log-file 启动时有日志可看 -->
    <Transition name="guide">
      <div v-if="logsOpen" class="modal-overlay" @click.self="closeLogs">
        <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="logs-title">
          <n-button quaternary circle class="modal-close" aria-label="关闭" @click="closeLogs">×</n-button>
          <h2 id="logs-title" class="modal-title">运行日志</h2>
          <p v-if="logsFile" class="modal-lead mono break">
            {{ logsFile }}<template v-if="logsTruncated > 0"> · 已省略最早 {{ logsTruncated }} 行</template>
          </p>

          <div v-if="logsLoading" class="history-loading">读取中…</div>
          <template v-else-if="logsError">
            <div class="logs-unavailable" role="alert">{{ logsError }}</div>
            <p class="confirm-note-extra">
              在启动 daemon 时加上 <code class="mono">--log-file &lt;路径&gt;</code> 参数(如
              <code class="mono">syncx start --log-file ~/.syncx/syncx.log</code>),日志会同步写入该文件,这里即可查看。
            </p>
          </template>
          <pre v-else ref="logsView" class="logs-view mono">{{ logsLines.join('\n') }}</pre>

          <div class="modal-actions">
            <n-button :loading="logsLoading" @click="fetchLogs">刷新</n-button>
            <n-button type="primary" @click="closeLogs">关闭</n-button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>
