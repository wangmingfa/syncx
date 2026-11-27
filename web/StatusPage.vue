<script setup lang="ts">
import { provide, ref, computed, watchEffect, onMounted, onUnmounted } from 'vue';
import type { OfferInfo, StatusData } from './types';
import { useToast } from './composables/useToast';
import { StatusContextKey, type CoreDeps } from './composables/statusContext';
import { useStatus } from './composables/useStatus';
import { useConfirm } from './composables/useConfirm';
import { useDevices } from './composables/useDevices';
import { useFolders } from './composables/useFolders';
import { useOffers } from './composables/useOffers';
import { useFolderDiff } from './composables/useFolderDiff';
import { useSelfUpdate } from './composables/useSelfUpdate';
import { useFormat } from './composables/useFormat';
import { useNotifications } from './composables/useNotifications';
import { useDirect } from './composables/useDirect';
import {
  folderKey,
  monogram,
  fmtTime,
  stripWs,
  progressPercent,
  isActive,
  progressText,
  deviceAddrLine,
} from './utils/format';
import UpdateBanner from './components/UpdateBanner.vue';
import GuideModal from './components/GuideModal.vue';
import HistoryModal from './components/HistoryModal.vue';
import VersionsModal from './components/VersionsModal.vue';
import IgnoreModal from './components/IgnoreModal.vue';
import E2EModal from './components/E2EModal.vue';
import ConflictModal from './components/ConflictModal.vue';
import TrafficModal from './components/TrafficModal.vue';
import ConfirmModal from './components/ConfirmModal.vue';
import EditFolderModal from './components/EditFolderModal.vue';
import EditDeviceModal from './components/EditDeviceModal.vue';
import AuthPasswordModal from './components/AuthPasswordModal.vue';
import LogsModal from './components/LogsModal.vue';
import TopologyModal from './components/TopologyModal.vue';
import UploadUpdateModal from './components/UploadUpdateModal.vue';
import DropOverlay from './components/DropOverlay.vue';
import ToastView from './components/ToastView.vue';
import SettingsModal from './components/SettingsModal.vue';
import ElevateGateModal from './components/ElevateGateModal.vue';
import StatusTopbar from './components/StatusTopbar.vue';
import ScheduleBanner from './components/ScheduleBanner.vue';
import StatusPills from './components/StatusPills.vue';
import OffersPanel from './components/OffersPanel.vue';
import FolderList from './components/FolderList.vue';
import DeviceList from './components/DeviceList.vue';
import FolderDiffModal from './components/FolderDiffModal.vue';
import SendModal from './components/SendModal.vue';
import InboxModal from './components/InboxModal.vue';

const props = defineProps<{ status: StatusData; message?: string }>();

// 核心状态 + 基础设施(status 本地持有、周期轮询、post/copy)
const core = useStatus(props);
const { status, busy, isDev, controlPort, refreshStatus, post, copy } = core;

/** 小屏两栏改 tab 后的当前栏;宽屏无 tab,该值不参与渲染(见模板 .layout--* 类)。 */
const mobileCol = ref<'folders' | 'devices'>('folders');

/** 收件箱待处理条数:设备栏在小屏被 tab 藏起来时,数量提示跟着「设备」tab 走。 */
const inboxPending = computed(() => status.value.direct?.pending.length ?? 0);

// 通用二次确认弹窗(移除目录 / 移除设备 / 升级 / 自更新共用)
const { confirmState, askConfirm } = useConfirm(busy);

// 各业务 composable 共享的核心依赖
const deps: CoreDeps = { status, busy, isDev, refreshStatus, post, askConfirm };
const devices = useDevices(deps);
// 设备编辑弹窗:挂载点在本页模板,状态(编辑目标/关闭/保存)来自 useDevices
const { editDeviceTarget, closeEditDevice, saveDeviceAddress } = devices;
const folders = useFolders(deps);
const offers = useOffers(deps);
// 目录级差异弹窗(Mac 端功能):状态经 provide 展开进 context,FolderDiffModal 自取
const folderDiff = useFolderDiff(deps);
const selfUpdate = useSelfUpdate(deps);
const fmt = useFormat(status);
// 桌面通知 + favicon 角标:内部 watch 注意力计数(邀请/冲突/目录错误),边沿触发通知
const notifications = useNotifications(status);
// 设备间直发:发送弹窗 / 收件箱挂在页面级,状态公用 status.direct(WS 推送)
const direct = useDirect({ ...deps, copy });

// 标签页标题:默认「SYNCX · 主机名 · IPv4」;有待确认邀请时改为该邀请的标题
// (与 OffersPanel 卡片标题同语义),确认/忽略后 status 推送刷新、pending 清空即恢复默认。
// 放在本页而非 App.vue:App 只在挂载时拉一次 status,不随 WS 推送更新。
const pendingOffers = computed<OfferInfo[]>(() => status.value.offers.filter((o) => o.status === 'pending'));
function offerTitle(o: OfferInfo): string {
  return o.kind === 'folder' ? `目录共享邀请 · ${o.folderName ?? o.folderId ?? ''}` : '配对请求';
}
watchEffect(() => {
  const base = ['SYNCX', status.value.hostname, status.value.localAddresses?.[0]].filter(Boolean).join(' · ');
  const pending = pendingOffers.value;
  if (pending.length === 0) {
    document.title = base;
    return;
  }
  const head = offerTitle(pending[0]!);
  document.title = pending.length > 1 ? `${head} 等 ${pending.length} 条邀请` : head;
});

// 需要本页模板双向绑定的模态状态:必须提到顶层,否则 <script setup> 模板不会自动拆包 Ref
const { historyFolder, historyGlobal, versionsFolder, ignoreFolder, e2eFolder, conflictsFolder, editDevicesOpen, editFolder, saveEditDevices } = folders;
const { upgrading, askSelfUpdate, uploadOpen, openUpload, selectUploadFile } = selfUpdate;
const { showToast } = useToast();

// 本页 overlay 模态开关(子组件通过 openXxx 触发)
const showGuide = ref(false);
const logsOpen = ref(false);
const topoOpen = ref(false);
const trafficOpen = ref(false);
const authOpen = ref(false);
const settingsOpen = ref(false);
// 浏览器内终端:独立全屏页(完整 PTY + xterm.js),验证门在终端页内部。
// 新开标签页 —— 终端是长驻工作区,不该顶掉正在看的状态页。
function openTerminal(): void {
  window.open('/terminal', '_blank');
}
// 多实例集中管理:独立页(本机 daemon 代理探测远端),同样新开标签,
// 不顶掉当前状态页。
function openFleet(): void {
  window.open('/fleet', '_blank');
}
function openGuide(): void {
  showGuide.value = true;
}
function openLogs(): void {
  logsOpen.value = true;
}
function openTopology(): void {
  topoOpen.value = true;
}
function openTraffic(): void {
  trafficOpen.value = true;
}
function openAuth(): void {
  authOpen.value = true;
}
function openSettings(): void {
  settingsOpen.value = true;
}

/**
 * 页面任意处拖入安装包并松在中间投放区:打开弹窗并立刻送去预检。
 * 先 openUpload(会把上一轮的选包状态清干净)再选包,顺序不能颠倒。
 */
function onPackageDrop(file: File): void {
  // dev / rust 形态统一在 openUpload 内拦截并弹 toast,这里只看是否放行
  if (!openUpload()) return;
  void selectUploadFile(file);
}

/** 关同步记录弹窗:目录模式与全局模式一起复位(两入口互斥,关闭也一并清)。 */
function closeHistoryModal(): void {
  historyFolder.value = null;
  historyGlobal.value = false;
}

// 向整棵子树注入共享上下文,子组件用 useStatusContext() 取用,无需层层 props 透传
provide(StatusContextKey, {
  status,
  busy,
  isDev,
  controlPort,
  refreshStatus,
  post,
  showToast,
  askConfirm,
  copy,
  ...devices,
  direct,
  ...folders,
  ...offers,
  ...folderDiff,
  ...selfUpdate,
  ...fmt,
  folderKey,
  monogram,
  fmtTime,
  stripWs,
  progressPercent,
  isActive,
  progressText,
  deviceAddrLine,
  showGuide,
  logsOpen,
  topoOpen,
  trafficOpen,
  openGuide,
  openLogs,
  openTopology,
  openTraffic,
  openAuth,
  authOpen,
  settingsOpen,
  openSettings,
  openTerminal,
  openFleet,
  notifSupported: notifications.notifSupported,
  notifEnabled: notifications.notifEnabled,
  toggleNotifications: notifications.toggleNotifications,
});
</script>

<template>
  <div class="container">
    <ToastView />

    <!-- 顶部:品牌条 + 操作 -->
    <StatusTopbar />

    <!-- 发现新版本横幅(npm 定时检查;忽略/升级交互在组件内) -->
    <UpdateBanner
      :update="upgrading ? null : (status.updateAvailable ?? null)"
      :busy="busy"
      @upgrade="askSelfUpdate"
    />

    <!-- 同步时段横幅:此刻因时段而不演示同步时出现(含恢复时刻与临时放行入口) -->
    <ScheduleBanner />

    <!-- 概览胶囊 -->
    <StatusPills :status="status" />

    <!-- 待确认:对方推送的配对 / 目录共享邀请 -->
    <OffersPanel />

    <!-- 小屏:两栏改为左右切换(宽屏隐藏). 宽屏仍是并排两栏 -->
    <div class="mobile-tabs" role="group" aria-label="共享目录与设备">
      <button
        type="button"
        class="mobile-tab mobile-tab--folders"
        :class="{ 'is-active': mobileCol === 'folders' }"
        :aria-pressed="mobileCol === 'folders'"
        @click="mobileCol = 'folders'"
      >
        共享目录<span v-if="status.powerGuard || status.paused" class="float-badge paused-badge mobile-tab__flag" :title="status.powerGuard ? `${status.powerGuard}:电源守卫已自动挂起所有目录同步` : '全局已暂停:所有目录不扫描、不广播、不接收'">{{ status.powerGuard ? '挂起' : '暂停' }}</span><span class="badge">{{ status.folders.length }}</span>
      </button>
      <button
        type="button"
        class="mobile-tab mobile-tab--devices"
        :class="{ 'is-active': mobileCol === 'devices' }"
        :aria-pressed="mobileCol === 'devices'"
        @click="mobileCol = 'devices'"
      >
        设备<span v-if="inboxPending > 0" class="float-badge mobile-tab__flag mobile-tab__flag--inbox" :title="`收件箱有 ${inboxPending} 条待处理的直发内容`">收件 {{ inboxPending }}</span><span class="badge">{{ status.devices.length }}</span>
      </button>
    </div>

    <!-- 主体:左右两栏(左=共享目录,右=设备);小屏按 tab 只展示其中一栏 -->
    <div class="layout" :class="`layout--${mobileCol}`">
      <FolderList />
      <DeviceList />
    </div>

    <!-- 使用指南弹窗 -->
    <GuideModal :open="showGuide" :is-dev="isDev" :control-port="controlPort" @close="showGuide = false" />

    <!-- 同步记录弹窗 -->
    <HistoryModal :folder="historyFolder" :global="historyGlobal" :notify="showToast" @close="closeHistoryModal" />

    <!-- 文件版本弹窗 -->
    <VersionsModal :folder="versionsFolder" :notify="showToast" :changed="refreshStatus" @close="versionsFolder = null" />

    <!-- 忽略规则编辑器弹窗 -->
    <IgnoreModal :folder="ignoreFolder" :notify="showToast" :changed="refreshStatus" @close="ignoreFolder = null" />

    <!-- 端到端加密设置弹窗 -->
    <E2EModal :folder="e2eFolder" :notify="showToast" :changed="refreshStatus" @close="e2eFolder = null" />

    <!-- 冲突收件箱弹窗 -->
    <ConflictModal :folder="conflictsFolder" :notify="showToast" :changed="refreshStatus" @close="conflictsFolder = null" />

    <!-- 传输统计弹窗 -->
    <TrafficModal :open="trafficOpen" @close="trafficOpen = false" />

    <!-- 目录级差异弹窗(状态全部走 context,无 props) -->
    <FolderDiffModal />

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

    <!-- 设备编辑弹窗:只改对端 IP/端口,设备 ID 只读 -->
    <EditDeviceModal
      :open="!!editDeviceTarget"
      :device="editDeviceTarget"
      :busy="busy"
      @close="closeEditDevice"
      @save="saveDeviceAddress"
    />

    <!-- 设备间直发:文本/文件发送弹窗 + 收件箱(确认入站文件、查看已收内容) -->
    <SendModal
      :open="!!direct.sendTarget.value"
      :device="direct.sendTarget.value"
      :direct="direct"
      :busy="busy"
      :zip-supported="status.direct?.zip === true"
      @close="direct.closeSend()"
    />
    <InboxModal
      :open="direct.inboxOpen.value"
      :status="status"
      :direct="direct"
      :busy="busy"
      @close="direct.inboxOpen.value = false"
    />

    <!-- 登录密码弹窗 -->
    <AuthPasswordModal :open="authOpen" :notify="showToast" @close="authOpen = false" />

    <!-- 全局设置弹窗(带宽兜底 / 版本份数 / 历史上限) -->
    <SettingsModal :open="settingsOpen" @close="settingsOpen = false" />

    <!-- 敏感操作验证门(终端/文件管理器共用的提权弹窗,状态在 utils/elevation) -->
    <ElevateGateModal />

    <!-- 日志弹窗 -->
    <LogsModal :open="logsOpen" @close="logsOpen = false" />

    <!-- 设备同步拓扑弹窗 -->
    <TopologyModal :open="topoOpen" :status="status" @close="topoOpen = false" />

    <!-- 上传本地安装包升级(入口在顶栏「上传升级」，或把文件拖到页面中间) -->
    <UploadUpdateModal :open="uploadOpen" @close="uploadOpen = false" />

    <!-- 页面级拖入安装包:遮罩常驻挂在这里,只有拖文件进页面时才显示 -->
    <DropOverlay @package="onPackageDrop" />
  </div>
</template>

<style scoped>
/* 小屏 tab 条:宽屏两栏并排时整条隐藏(display:none),不占位。
   颜色跟随两栏各自的强调色(左蓝 / 右青),一眼对上要切去哪一栏。 */
.mobile-tabs {
  display: none;
  gap: 6px;
  padding: 4px;
  margin-bottom: 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  box-shadow: var(--shadow);
  align-self: flex-start;
  flex: none;
}

@media (max-width: 860px) {
  .mobile-tabs {
    display: inline-flex;
  }
}

.mobile-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.mobile-tab .badge {
  min-width: 20px;
  height: 18px;
  font-size: 11px;
  /* 计数徽标跟着 tab 的状态色走:未选中灰、选中各自栏的强调色 */
  color: inherit;
  background: color-mix(in srgb, currentColor 12%, transparent);
}

.mobile-tab--folders.is-active {
  color: var(--accent);
  background: var(--accent-soft);
}

.mobile-tab--devices.is-active {
  color: var(--accent-2);
  background: rgb(43 182 172 / 0.12);
}

/* 栏内徽标搬上 tab:全局暂停(橙,复用 .paused-badge 配色)与收件箱待处理(红)。
   徽标本身不接管点击(点它照样冒泡到 tab 按钮),但保留 title 悬停说明。 */
.mobile-tab__flag--inbox {
  color: var(--offline);
  border-color: color-mix(in srgb, var(--offline) 55%, transparent);
}
</style>
