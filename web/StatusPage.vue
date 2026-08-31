<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

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

// 轻量拓扑联动:鼠标悬停左栏目录卡时,记录其配对设备,用于高亮右栏对应设备卡
const hoverDevices = ref<string[]>([]);

function onFolderEnter(f: { devices: string[] }): void {
  hoverDevices.value = f.devices;
}

function onFolderLeave(): void {
  hoverDevices.value = [];
}

const newPath = ref('');
const newDevices = ref('');

// ---- 设备配对(邀请码) ----
const inviteFolder = ref('');
const inviteCode = ref('');
const joinCode = ref('');
const joinPath = ref('');
const joinResult = ref<{ deviceId: string; reciprocalCode: string } | undefined>();

/** 复制文本到剪贴板,并轻提示。 */
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  } catch {
    showToast('复制失败,请手动选择');
  }
}

/** 为本机某共享目录生成一次性配对邀请码。 */
async function generateInvite(): Promise<void> {
  if (!inviteFolder.value || busy.value) return;
  busy.value = true;
  try {
    const res = await fetch(`/api/invite?folder=${encodeURIComponent(inviteFolder.value)}`);
    const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
    if (!res.ok || !data.code) throw new Error(data.error ?? '生成邀请码失败');
    inviteCode.value = data.code;
    showToast('邀请码已生成');
  } catch (e) {
    showToast(e instanceof Error ? e.message : '生成邀请码失败');
  } finally {
    busy.value = false;
  }
}

/** 接受对方邀请码:把对方加入白名单,并取回回邀码用于双向配对。 */
async function doJoin(): Promise<void> {
  if (busy.value) return;
  if (!joinCode.value.trim() || !joinPath.value.trim()) {
    showToast('请填写邀请码与本地目录');
    return;
  }
  busy.value = true;
  try {
    const res = await fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: joinCode.value.trim(), localPath: joinPath.value.trim() }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      deviceId?: string;
      reciprocalCode?: string;
      error?: string;
    };
    if (!res.ok || !data.deviceId || !data.reciprocalCode) {
      throw new Error(data.error ?? '加入失败');
    }
    joinResult.value = { deviceId: data.deviceId, reciprocalCode: data.reciprocalCode };
    showToast(`已与 ${data.deviceId} 配对`);
    await refreshStatus();
  } catch (e) {
    showToast(e instanceof Error ? e.message : '加入失败');
  } finally {
    busy.value = false;
  }
}

// 挂载后立即刷新一次,确保展示最新状态
onMounted(() => {
  void refreshStatus();
  window.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
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

// 某设备参与共享的目录数量(反向映射)
function deviceFolderCount(deviceId: string): number {
  return status.value.folders.filter((f) => f.devices.includes(deviceId)).length;
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

      <button type="button" class="help-btn" @click="openGuide">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.2 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.8 2.8-2.8 2.8" />
          <line x1="12" y1="16.5" x2="12" y2="16.6" />
        </svg>
        使用指南
      </button>

      <div class="topbar__spacer"></div>

      <span class="device-chip">
        <span class="dot" :class="status.peers.some((p) => p.online) ? 'dot-online' : 'dot-offline'"></span>
        <span class="mono">{{ status.deviceId }}</span>
      </span>
    </div>

    <!-- 概览胶囊 -->
    <div class="stat-pills">
      <span class="stat-pill-item"><b>{{ status.entries }}</b><span>索引条目</span></span>
      <span class="stat-pill-item"><b>{{ status.tombstones }}</b><span>墓碑</span></span>
      <span class="stat-pill-item"><b>{{ status.folders.length }}</b><span>共享目录</span></span>
      <span class="stat-pill-item"><b>{{ status.peers.length }}</b><span>已配对设备</span></span>
    </div>

    <!-- 主体:左右两栏(左=共享目录,右=设备配对 + 已配对设备) -->
    <div class="layout">
      <!-- 左栏:共享目录 -->
      <section class="col col--folders">
        <div class="col-head">
          <span>共享目录</span>
          <span class="badge">{{ status.folders.length }}</span>
          <button type="button" class="scan-btn" :disabled="busy" @click="rescan">扫描全部</button>
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
          <input v-model="newPath" placeholder="本地目录绝对路径,如 /home/me/Documents">
          <input v-model="newDevices" placeholder="允许的设备 ID,逗号分隔,如 DEV1234567">
          <button type="submit" :disabled="busy">添加共享目录</button>
        </form>
      </section>

      <!-- 右栏:设备配对 + 已配对设备 -->
      <section class="col col--devices">
        <!-- 邀请码配对 -->
        <div class="card pair-card">
          <div class="eyebrow">设备配对</div>
          <div class="pair-id">
            <span class="muted">本机 ID</span>
            <code class="mono">{{ status.deviceId }}</code>
            <button type="button" class="btn-sm" @click="copy(status.deviceId)">复制</button>
          </div>

          <div v-if="status.folders.length === 0" class="pair-hint">
            先添加共享目录,才能生成邀请码
          </div>

          <template v-else>
            <div class="pair-block">
              <div class="pair-label">① 生成邀请码</div>
              <div class="pair-row">
                <select v-model="inviteFolder" class="pair-select">
                  <option v-for="f in status.folders" :key="folderKey(f)" :value="f.path">{{ f.path }}</option>
                </select>
                <button type="button" class="btn-sm" :disabled="!inviteFolder || busy" @click="generateInvite">生成</button>
              </div>
              <div v-if="inviteCode" class="pair-code">
                <code class="mono break">{{ inviteCode }}</code>
                <button type="button" class="btn-sm" @click="copy(inviteCode)">复制邀请码</button>
                <div class="item-sub">有效期 1 小时 · 发给对方,对方在「②」粘贴</div>
              </div>
            </div>

            <div class="pair-block">
              <div class="pair-label">② 加入对方设备</div>
              <div class="pair-row col">
                <input v-model="joinCode" class="pair-input" placeholder="粘贴对方邀请码">
                <input v-model="joinPath" class="pair-input" placeholder="本机对应的本地目录绝对路径">
                <button type="button" class="btn-sm" :disabled="!joinCode || !joinPath || busy" @click="doJoin">加入并配对</button>
              </div>
              <div v-if="joinResult" class="pair-code">
                <div class="item-sub">已与 <b class="mono">{{ joinResult.deviceId }}</b> 配对</div>
                <div class="item-sub">把下面回邀码发给对方,对方粘贴后即双向连通:</div>
                <code class="mono break">{{ joinResult.reciprocalCode }}</code>
                <button type="button" class="btn-sm" @click="copy(joinResult.reciprocalCode)">复制回邀码</button>
              </div>
            </div>
          </template>
        </div>

        <div class="col-head">
          <span>已配对设备</span>
          <span class="badge">{{ status.peers.length }}</span>
        </div>

        <div v-if="status.peers.length === 0" class="empty">还没有已配对设备 · 在「共享目录」中填写允许的设备 ID 即可配对</div>
        <div
          v-for="p in status.peers"
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

    <!-- 使用指南弹窗(开合带动画,由 <Transition> 驱动) -->
    <Transition name="guide">
      <div v-if="showGuide" class="modal-overlay" @click.self="closeGuide">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <button type="button" class="modal-close" aria-label="关闭" @click="closeGuide">×</button>
        <h2 id="guide-title" class="modal-title">首次使用指南</h2>
        <p class="modal-lead">四步把一台设备连起来,开始局域网同步。</p>

        <ol class="guide-steps">
          <li>
            <div class="guide-step-h">① 添加共享目录</div>
            <div class="guide-step-b">
              在左侧「共享目录」填写<strong>本地目录绝对路径</strong>(如
              <code class="mono">/home/me/Documents</code>),可选填允许访问的设备 ID,点「添加共享目录」。
            </div>
          </li>
          <li>
            <div class="guide-step-h">② 设备配对</div>
            <div class="guide-step-b">
              在右侧「设备配对」里二选一:选目录点「生成」拿到<strong>邀请码</strong>发给对方;或粘贴对方邀请码 +
              本机目录完成「加入并配对」。配对基于局域网自动发现(mDNS)互连。
            </div>
          </li>
          <li>
            <div class="guide-step-h">③ 等待同步</div>
            <div class="guide-step-b">
              配对成功后,该目录会出现在双方设备上。状态显示为「在线 / 传输中 / 已同步」;进度条流动代表正在传数据。
            </div>
          </li>
          <li>
            <div class="guide-step-h">④ 需要时重新索引</div>
            <div class="guide-step-b">
              改了目录里的文件却没立即同步,点左侧「扫描全部」让本机重新建立索引并推送变更。
            </div>
          </li>
        </ol>

        <div v-if="isDev" class="guide-note">
          开发提示:本界面当前由控制端口 <code class="mono">{{ controlPort }}</code> 提供;dev 模式请访问
          <code class="mono">5173</code>(HMR 实时热更新)。
        </div>

        <button type="button" class="modal-ok" @click="closeGuide">我知道了</button>
      </div>
    </div>
    </Transition>
  </div>
</template>
