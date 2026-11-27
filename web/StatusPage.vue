<script setup lang="ts">
import { provide, ref, computed, watch, watchEffect, onMounted, onUnmounted } from 'vue';
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

/**
 * 小屏 tab 的选中滑块:两颗 tab 的宽度不相等 —— 计数从 9 变 10、目录栏亮起「挂起」、
 * 设备栏亮起「收件 N」都会改变轨迹。所以滑块的位置和宽度跟着**选中那颗 tab 的实测盒**
 * 走,而不是写死 50%;测量挂在 ResizeObserver 上,旗标出现、字号加载完成都能跟上。
 */
const tabsEl = ref<HTMLElement | null>(null);
const folderTabEl = ref<HTMLButtonElement | null>(null);
const deviceTabEl = ref<HTMLButtonElement | null>(null);
const tabThumb = ref({ left: 0, top: 0, width: 0, height: 0 });
/** 首帧先摆位、下一帧才允许过渡:否则挂载时滑块会从 0 宽「长」到标签宽度。 */
const thumbReady = ref(false);
let thumbFrame = 0;

function measureTabThumb(): void {
  const box = tabsEl.value;
  const btn = (mobileCol.value === 'folders' ? folderTabEl : deviceTabEl).value;
  if (!box || !btn) return;
  const b = btn.getBoundingClientRect();
  // 宽屏下整条 display:none,量出来是 0;不写进滑块,等 ResizeObserver 在显示后重算
  if (!b.width) return;
  const c = box.getBoundingClientRect();
  // 滑块是 .mobile-tabs 的绝对定位子元素,坐标系原点是 padding box,减掉边框宽度对齐
  tabThumb.value = {
    left: b.left - c.left - box.clientLeft,
    top: b.top - c.top - box.clientTop,
    width: b.width,
    height: b.height,
  };
  if (!thumbReady.value && !thumbFrame) {
    thumbFrame = requestAnimationFrame(() => {
      thumbReady.value = true;
    });
  }
}

let tabRo: ResizeObserver | undefined;
onMounted(() => {
  if (tabsEl.value) {
    tabRo = new ResizeObserver(() => measureTabThumb());
    tabRo.observe(tabsEl.value);
    if (folderTabEl.value) tabRo.observe(folderTabEl.value);
    if (deviceTabEl.value) tabRo.observe(deviceTabEl.value);
  }
  measureTabThumb();
});
onUnmounted(() => {
  tabRo?.disconnect();
  if (thumbFrame) cancelAnimationFrame(thumbFrame);
});

// 切换 tab 不改变按钮几何,但滑块的「目标盒」变了:立刻按新选中那颗重测
watch(mobileCol, () => measureTabThumb());

/** 收件箱待处理条数:设备栏在小屏被 tab 藏起来时,数量提示跟着「设备」tab 走。
    与设备列表角标同口径:待确认文件 + 未读内容;只有未读才脉冲。 */
const inboxPending = computed(() => (status.value.direct?.pending.length ?? 0) + (status.value.direct?.unread ?? 0));
const inboxUnread = computed(() => status.value.direct?.unread ?? 0);

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
    <div ref="tabsEl" class="mobile-tabs" role="group" aria-label="共享目录与设备">
      <!-- 选中滑块:装饰层,位置/宽度跟着选中那颗 tab 的实测盒走(见 measureTabThumb)。
           选中的底色由它承载,切换时从一颗 tab 滑到另一颗;按钮自己不再画底色。 -->
      <span
        class="mobile-tab__thumb"
        :class="[mobileCol === 'folders' ? 'is-folders' : 'is-devices', { 'is-ready': thumbReady }]"
        :style="{
          transform: `translateX(${tabThumb.left}px)`,
          top: `${tabThumb.top}px`,
          width: `${tabThumb.width}px`,
          height: `${tabThumb.height}px`,
        }"
        aria-hidden="true"
      />
      <button
        ref="folderTabEl"
        type="button"
        class="mobile-tab mobile-tab--folders"
        :class="{ 'is-active': mobileCol === 'folders' }"
        :aria-pressed="mobileCol === 'folders'"
        @click="mobileCol = 'folders'"
      >
        共享目录<span v-if="status.powerGuard || status.paused" class="float-badge paused-badge mobile-tab__flag" :title="status.powerGuard ? `${status.powerGuard}:电源守卫已自动挂起所有目录同步` : '全局已暂停:所有目录不扫描、不广播、不接收'">{{ status.powerGuard ? '挂起' : '暂停' }}</span><span class="badge">{{ status.folders.length }}</span>
      </button>
      <button
        ref="deviceTabEl"
        type="button"
        class="mobile-tab mobile-tab--devices"
        :class="{ 'is-active': mobileCol === 'devices' }"
        :aria-pressed="mobileCol === 'devices'"
        @click="mobileCol = 'devices'"
      >
        设备<span v-if="inboxPending > 0" class="float-badge mobile-tab__flag mobile-tab__flag--inbox" :class="{ 'is-unread': inboxUnread > 0 }" :title="`收件箱有 ${inboxPending} 条待确认或未读的直发内容`">收件 {{ inboxPending }}</span><span class="badge">{{ status.devices.length }}</span>
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

    <!-- 通用二次确认弹窗:排在所有弹窗之后 —— 遮罩同 z-index,画在最上层的是挂到 body
         最晚的那个(见 ModalShell 的 Teleport 注释),所以它必须最后一个挂,才能从任何
         弹窗里(收件箱清空 / 同步记录清理 / 冲突处理)弹在对方上面。 -->
    <ConfirmModal :state="confirmState" :notify="showToast" @closed="confirmState = null" />

    <!-- 页面级拖入安装包:遮罩常驻挂在这里,只有拖文件进页面时才显示 -->
    <DropOverlay @package="onPackageDrop" />
  </div>
</template>

<style scoped>
/* 小屏 tab 条:宽屏两栏并排时整条隐藏(display:none),不占位。
   颜色跟随两栏各自的强调色(左蓝 / 右青),一眼对上要切去哪一栏。
   position: relative 是给选中滑块(.mobile-tab__thumb)做定位容器 —— 滑块是绝对定位的
   装饰层,坐标由脚本按当前 tab 的实测盒写进 transform/width。 */
.mobile-tabs {
  position: relative;
  /* 自成层叠上下文:按钮的 z-index:1 只在 tab 条内部生效,不会漏到页面上压住别的东西 */
  isolation: isolate;
  display: none;
  gap: 6px;
  padding: 4px;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  box-shadow: var(--shadow);
  align-self: flex-start;
  flex: none;
}

/* 选中滑块:整块选中底色从此只由**一个**元素承载,切换时它平移/伸缩到另一颗 tab 上,
   而不是两块底色各自瞬闪。位置/尺寸全走内联样式(实测盒),这里只管外观与动画;
   颜色按栏区分,背景色跟着 class 渐变过去。
   transition 只挂在 .is-ready 上:首帧先无动画地摆到位,下一帧再开过渡。 */
.mobile-tab__thumb {
  position: absolute;
  left: 0;
  top: 0;
  border-radius: 999px;
  background: var(--accent-soft);
  pointer-events: none;
}
.mobile-tab__thumb.is-devices {
  background: rgb(43 182 172 / 0.12);
}
.mobile-tab__thumb.is-ready {
  transition:
    transform 0.28s cubic-bezier(0.3, 0.8, 0.3, 1),
    width 0.28s cubic-bezier(0.3, 0.8, 0.3, 1),
    background-color 0.2s ease;
}
@media (prefers-reduced-motion: reduce) {
  .mobile-tab__thumb.is-ready {
    transition: none;
  }
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
  /* 定位 + z-index 压过滑块:滑块在树里排在两颗按钮之前,不做这一步它会把文字盖住 */
  position: relative;
  z-index: 1;
  padding: 5px 12px;
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

/* 选中态只剩文字色:底色已由滑块承担(见 .mobile-tab__thumb),这里再画一层会和
   滑块叠成两块、切换时半路「重影」。 */
.mobile-tab--folders.is-active {
  color: var(--accent);
}

.mobile-tab--devices.is-active {
  color: var(--accent-2);
}

/* 栏内徽标搬上 tab:全局暂停(橙,复用 .paused-badge 配色)与收件箱待处理(红)。
   徽标本身不接管点击(点它照样冒泡到 tab 按钮),但保留 title 悬停说明。 */
.mobile-tab__flag--inbox {
  color: var(--offline);
  border-color: color-mix(in srgb, var(--offline) 55%, transparent);
}

/* 未读时周期脉冲:节奏在 style.css 的 @keyframes inbox-unread-pulse,
   与设备列表收件箱角标同一个提醒,这里只挂并做 reduced-motion 兜底。 */
.mobile-tab__flag--inbox.is-unread {
  animation: inbox-unread-pulse 4s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .mobile-tab__flag--inbox.is-unread {
    animation: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--offline) 45%, transparent);
  }
}

/* 手机页容器的上内衬收一档(18 → 12):顶栏之上剩下的全是纯留白。
   只挂本页的 .container,船队 / 文件管理器那些靠文档滚动的页面不受影响。 */
@media (max-width: 600px) {
  .container {
    padding: 12px 14px 10px;
  }
}
</style>
