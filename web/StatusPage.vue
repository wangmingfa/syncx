<script setup lang="ts">
import { provide, ref, onMounted, onUnmounted } from 'vue';
import type { StatusData } from './types';
import { useToast } from './composables/useToast';
import { StatusContextKey, type CoreDeps } from './composables/statusContext';
import { useStatus } from './composables/useStatus';
import { useConfirm } from './composables/useConfirm';
import { useDevices } from './composables/useDevices';
import { useFolders } from './composables/useFolders';
import { useOffers } from './composables/useOffers';
import { useSelfUpdate } from './composables/useSelfUpdate';
import { useFormat } from './composables/useFormat';
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
import ConfirmModal from './components/ConfirmModal.vue';
import EditFolderModal from './components/EditFolderModal.vue';
import AuthPasswordModal from './components/AuthPasswordModal.vue';
import LogsModal from './components/LogsModal.vue';
import TopologyModal from './components/TopologyModal.vue';
import UploadUpdateModal from './components/UploadUpdateModal.vue';
import DropOverlay from './components/DropOverlay.vue';
import ToastView from './components/ToastView.vue';
import StatusTopbar from './components/StatusTopbar.vue';
import StatusPills from './components/StatusPills.vue';
import OffersPanel from './components/OffersPanel.vue';
import FolderList from './components/FolderList.vue';
import DeviceList from './components/DeviceList.vue';

const props = defineProps<{ status: StatusData; message?: string }>();

// 核心状态 + 基础设施(status 本地持有、周期轮询、post/copy)
const core = useStatus(props);
const { status, busy, isDev, controlPort, refreshStatus, post, copy } = core;

// 通用二次确认弹窗(移除目录 / 移除设备 / 升级 / 自更新共用)
const { confirmState, askConfirm } = useConfirm(busy);

// 各业务 composable 共享的核心依赖
const deps: CoreDeps = { status, busy, isDev, refreshStatus, post, askConfirm };
const devices = useDevices(deps);
const folders = useFolders(deps);
const offers = useOffers(deps);
const selfUpdate = useSelfUpdate(deps);
const fmt = useFormat(status);

// 需要本页模板双向绑定的模态状态:必须提到顶层,否则 <script setup> 模板不会自动拆包 Ref
const { historyFolder, editDevicesOpen, editFolder, saveEditDevices } = folders;
const { upgrading, askSelfUpdate, uploadOpen, openUpload, selectUploadFile } = selfUpdate;
const { showToast } = useToast();

// 本页 overlay 模态开关(子组件通过 openXxx 触发)
const showGuide = ref(false);
const logsOpen = ref(false);
const topoOpen = ref(false);
const authOpen = ref(false);
function openGuide(): void {
  showGuide.value = true;
}
function openLogs(): void {
  logsOpen.value = true;
}
function openTopology(): void {
  topoOpen.value = true;
}
function openAuth(): void {
  authOpen.value = true;
}

/**
 * 页面任意处拖入安装包并松在中间投放区:打开弹窗并立刻送去预检。
 * 先 openUpload(会把上一轮的选包状态清干净)再选包,顺序不能颠倒。
 */
function onPackageDrop(file: File): void {
  if (isDev) {
    showToast('开发模式下不支持拖入升级包（运行态为 dev，无单文件运行时可替换）', 'alert');
    return;
  }
  openUpload();
  void selectUploadFile(file);
}

// Esc 关闭使用指南 / 日志弹窗(其余弹窗自行处理 Esc)
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (showGuide.value) showGuide.value = false;
  if (logsOpen.value) logsOpen.value = false;
  if (topoOpen.value) topoOpen.value = false;
  if (uploadOpen.value) uploadOpen.value = false;
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

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
  ...folders,
  ...offers,
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
  openGuide,
  openLogs,
  openTopology,
  openAuth,
  authOpen,
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

    <!-- 概览胶囊 -->
    <StatusPills :status="status" />

    <!-- 待确认:对方推送的配对 / 目录共享邀请 -->
    <OffersPanel />

    <!-- 主体:左右两栏(左=共享目录,右=设备) -->
    <div class="layout">
      <FolderList />
      <DeviceList />
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

    <!-- 设备同步拓扑弹窗 -->
    <TopologyModal :open="topoOpen" :status="status" @close="topoOpen = false" />

    <!-- 上传本地安装包升级(入口在顶栏「上传升级」，或把文件拖到页面中间) -->
    <UploadUpdateModal :open="uploadOpen" @close="uploadOpen = false" />

    <!-- 页面级拖入安装包:遮罩常驻挂在这里,只有拖文件进页面时才显示 -->
    <DropOverlay @package="onPackageDrop" />
  </div>
</template>
