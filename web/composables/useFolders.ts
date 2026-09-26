import { ref, type Ref } from 'vue';
import { useToast } from './useToast';
import { apiJson, errText } from '../utils/api';
import { folderKey } from '../utils/format';
import type { CoreDeps } from './statusContext';
import type { ConflictPolicy, FolderInfo, GitSyncMode } from '../types';

/** 文件夹相关:添加/移除(防误删确认)/编辑指派设备/ .gitignore 开关/悬停联动/同步记录。 */
export function useFolders(deps: CoreDeps): {
  hoverDevices: Ref<string[]>;
  hoverFolderKey: Ref<string>;
  onFolderEnter: (f: { id?: string; path: string; devices: string[] }) => void;
  onFolderLeave: () => void;
  hoverDeviceId: Ref<string>;
  onDeviceEnter: (deviceId: string) => void;
  onDeviceLeave: () => void;
  addFolderOpen: Ref<boolean>;
  toggleAddFolder: () => void;
  addFolder: () => Promise<void>;
  newPath: Ref<string>;
  newFolderId: Ref<string>;
  newFolderDevices: Ref<string[]>;
  newFolderReceiveOnly: Ref<boolean>;
  askRemoveFolder: (path: string) => void;
  openEditDevices: (f: FolderInfo) => void;
  openHistory: (f: FolderInfo) => void;
  /** 打开全局时间线(HistoryModal 的全局模式,跨目录归并视图)。 */
  openGlobalHistory: () => void;
  /** 打开某目录的冲突收件箱(ConflictModal;列残留冲突副本并提供处理动作)。 */
  openConflicts: (f: FolderInfo) => void;
  /** 打开某目录的文件版本弹窗(拉取与展示在 VersionsModal 内)。 */
  openVersions: (f: FolderInfo) => void;
  /** 打开某目录的忽略规则编辑器(编辑 .syncxignore + 实时测试器)。 */
  openIgnoreEditor: (f: FolderInfo) => void;
  /** 打开某目录的端到端加密设置弹窗(口令 + 不可信节点勾选)。 */
  openE2E: (f: FolderInfo) => void;
  /** 打开某目录的浏览器内文件管理器(独立路由页 /files;浏览/下载仅需登录,删除需提权)。 */
  openFiles: (f: FolderInfo) => void;
  editDevicesOpen: Ref<boolean>;
  editFolder: Ref<FolderInfo | null>;
  historyFolder: Ref<FolderInfo | null>;
  /** 为真 = 以全局模式打开同步记录弹窗(与 historyFolder 互斥)。 */
  historyGlobal: Ref<boolean>;
  /** 非空 = 打开该目录的冲突收件箱。 */
  conflictsFolder: Ref<FolderInfo | null>;
  /** 非空 = 打开该目录的文件版本弹窗。 */
  versionsFolder: Ref<FolderInfo | null>;
  /** 非空 = 打开该目录的忽略规则编辑器。 */
  ignoreFolder: Ref<FolderInfo | null>;
  /** 非空 = 打开该目录的端到端加密设置弹窗。 */
  e2eFolder: Ref<FolderInfo | null>;
  saveEditDevices: (payload: { path: string; devices: string[]; gitignore: boolean; schedule: string; gitSync: GitSyncMode; conflictPolicy: ConflictPolicy; onDemand: boolean }) => Promise<void>;
  /** 「优先同步」:把该目录某个在传文件的块请求插到对端发送队列最前(幂等)。 */
  prioritizeFile: (f: FolderInfo, path: string) => Promise<void>;
  toggleFolderPaused: (f: FolderInfo, paused: boolean) => Promise<void>;
  toggleGlobalPaused: (paused: boolean) => Promise<void>;
  /** 「目录不可信」横幅上的重新采集身份(仅更新指纹,索引不动)。 */
  reAdoptIdentity: (f: FolderInfo) => Promise<void>;
} {
  const { status, busy, refreshStatus, post, askConfirm } = deps;
  const { showToast } = useToast();

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

  // 反向联动:悬停设备卡时,设备卡自身与所有指派到它的目录卡同时高亮,
  // 一眼看出该设备在同步哪些目录。与目录→设备各自独立(互不复用状态:
  // 若共用 hoverDevices,悬停目录会把「共享同一设备的其他目录」也链着点亮)。
  const hoverDeviceId = ref('');
  function onDeviceEnter(deviceId: string): void {
    hoverDeviceId.value = deviceId;
  }
  function onDeviceLeave(): void {
    hoverDeviceId.value = '';
  }

  // ---- 添加共享目录(默认收起,点按钮展开表单) ----
  const addFolderOpen = ref(false);
  const newPath = ref('');
  const newFolderId = ref('');
  const newFolderDevices = ref<string[]>([]);
  /** 接收模式(只拉不推):勾选后该目录只从对端拉取变更,绝不把本地变更反灌对端。 */
  const newFolderReceiveOnly = ref(false);

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
      const data = await apiJson<{ created?: boolean }>('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path,
          devices: newFolderDevices.value,
          id: newFolderId.value.trim() || undefined,
          receiveOnly: newFolderReceiveOnly.value,
        }),
      });
      showToast(data.created ? '已添加共享目录(原路径不存在,已自动创建)' : '已添加共享目录');
      newPath.value = '';
      newFolderId.value = '';
      newFolderDevices.value = [];
      newFolderReceiveOnly.value = false;
      addFolderOpen.value = false;
      await refreshStatus();
    } catch (e) {
      showToast(errText(e, '添加失败,请重试'), 'alert');
    } finally {
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
      // 默认勾选:一并删掉索引库,避免同目录重加时复用旧索引(旧墓碑会再次参与对账,造成误删)
      checkbox: { label: '同时删除索引库（清掉历史残留，防止重加时旧记录复用）', checked: true },
      action: (purgeIndex) => doRemoveFolder(path, purgeIndex),
    });
  }

  async function doRemoveFolder(path: string, purgeIndex = false): Promise<void> {
    const qs = purgeIndex ? `?path=${encodeURIComponent(path)}&purgeIndex=1` : `?path=${encodeURIComponent(path)}`;
    await apiJson(`/api/folders${qs}`, { method: 'DELETE' });
    showToast(purgeIndex ? '已移除共享目录（含索引库）' : '已移除共享目录');
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

  /** 弹窗「保存」:设备指派、.gitignore 开关、同步时段、git 同步模式与冲突策略一起提交,真正的写操作只有这里。 */
  async function saveEditDevices(payload: { path: string; devices: string[]; gitignore: boolean; schedule: string; gitSync: GitSyncMode; conflictPolicy: ConflictPolicy; onDemand: boolean }): Promise<void> {
    await commitFolderDevices(payload.path, payload.devices);
    // refreshStatus 后按最新 folders 找回该目录,开关/时段/git 模式/冲突策略有变化才额外发请求
    const f = status.value.folders.find((x) => x.path === payload.path);
    if (f && (f.useGitignore !== false) !== payload.gitignore) {
      await toggleFolderGitignore(f, payload.gitignore);
    }
    if (f && (f.schedule ?? '') !== payload.schedule) {
      await saveFolderSchedule(f, payload.schedule);
    }
    if (f && (f.gitSync ?? 'off') !== payload.gitSync) {
      await saveFolderGitSync(f, payload.gitSync);
    }
    if (f && (f.conflictPolicy ?? 'keep-both') !== payload.conflictPolicy) {
      await saveFolderConflictPolicy(f, payload.conflictPolicy);
    }
    if (f && (f.onDemand ?? false) !== payload.onDemand) {
      await saveFolderOnDemand(f, payload.onDemand);
    }
    editDevicesOpen.value = false;
  }

  /** 提交某目录的按需同步开关;失败回读后端真实状态。 */
  async function saveFolderOnDemand(f: FolderInfo, on: boolean): Promise<void> {
    try {
      await apiJson('/api/folders/on-demand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: f.id ?? f.path, onDemand: on }),
      });
      showToast(
        on
          ? '已开启按需同步:对端新文件先只记索引,点「下载」才落盘'
          : '已关闭按需同步:此后对端新文件恢复即时落盘(既有占位文件仍需手动下载)',
      );
    } catch (e) {
      showToast(errText(e, '设置按需同步失败'), 'alert');
    }
    await refreshStatus();
  }

  /** 提交某目录的 git 提交同步模式;失败回读后端真实状态。 */
  async function saveFolderGitSync(f: FolderInfo, mode: GitSyncMode): Promise<void> {
    try {
      await apiJson('/api/folders/git-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: f.id ?? f.path, mode }),
      });
      showToast(
        mode === 'off'
          ? '已关闭 Git 提交同步'
          : mode === 'send'
            ? '已设为仅发送:本机提交会通知对端,但不自动提交对端通知'
            : mode === 'receive'
              ? '已设为仅接收:自动提交对端通知,不广播本机提交'
              : '已开启双向 Git 提交同步',
      );
    } catch (e) {
      showToast(errText(e, '设置 Git 同步模式失败'), 'alert');
    }
    await refreshStatus();
  }

  /** 提交某目录的冲突自动处理策略;失败回读后端真实状态。 */
  async function saveFolderConflictPolicy(f: FolderInfo, policy: ConflictPolicy): Promise<void> {
    try {
      await apiJson('/api/folders/conflict-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: f.id ?? f.path, policy }),
      });
      showToast(
        policy === 'local-wins'
          ? '冲突策略已设为「本机优先」:冲突时保留本机内容并推回对端'
          : policy === 'newest-wins'
            ? '冲突策略已设为「新者胜」:按修改时间自动覆盖旧内容'
            : '冲突策略已恢复「保留双方」:冲突时生成副本进收件箱',
      );
    } catch (e) {
      showToast(errText(e, '设置冲突策略失败'), 'alert');
    }
    await refreshStatus();
  }

  /**
   * 「优先同步」:让该目录某个在收文件插队到对端发送队列最前。
   * 幂等 —— 此刻没在收就是空操作,点了没反应等下一轮状态推送自然会显示。
   */
  async function prioritizeFile(f: FolderInfo, path: string): Promise<void> {
    try {
      await apiJson('/api/folders/prioritize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: f.id ?? f.path, path }),
      });
      showToast(`已请求优先同步「${path.split('/').pop() ?? path}」`);
    } catch (e) {
      showToast(errText(e, '优先同步请求失败'), 'alert');
    }
    await refreshStatus();
  }

  /** 提交某目录的同步时段(空串 = 清除,全天同步);失败回读后端真实状态。 */
  async function saveFolderSchedule(f: FolderInfo, schedule: string): Promise<void> {
    try {
      await apiJson('/api/folders/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: f.id ?? f.path, schedule }),
      });
      showToast(schedule ? `已设置同步时段 ${schedule},时段外自动暂停` : '已清除同步时段(全天同步)');
    } catch (e) {
      showToast(errText(e, '设置同步时段失败'), 'alert');
    }
    await refreshStatus();
  }

  async function commitFolderDevices(path: string, devices: string[]): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    try {
      await apiJson('/api/folders/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, devices }),
      });
      showToast('已更新目录设备');
      await refreshStatus();
    } catch (e) {
      showToast(errText(e, '更新失败,请重试'), 'alert');
    } finally {
      busy.value = false;
    }
  }

  // ---- .gitignore 忽略开关(在目录编辑弹窗内,缺省勾选) ----
  /** 勾选 = 忽略 .gitignore 中的文件(不参与同步);取消勾选 = .gitignore 内文件也同步。 */
  async function toggleFolderGitignore(f: FolderInfo, enabled: boolean): Promise<void> {
    try {
      await apiJson('/api/folders/gitignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: f.path, enabled }),
      });
      f.useGitignore = enabled;
      showToast(enabled ? '已开启:.gitignore 中的文件将不再同步' : '已关闭:.gitignore 中的文件也会同步');
    } catch (e) {
      showToast(errText(e, '更新失败,请重试'), 'alert');
      await refreshStatus(); // 回读后端真实状态,避免勾选框与配置不一致
    }
  }

  // 同步记录弹窗:非空 = 打开该目录的记录;historyGlobal = 打开跨目录全局时间线。
  // 两者互斥(开一个必关另一个),同一个 HistoryModal 靠 mode 区分数据源与「目录」列。
  const historyFolder = ref<FolderInfo | null>(null);
  const historyGlobal = ref(false);
  function openHistory(f: FolderInfo): void {
    historyGlobal.value = false;
    historyFolder.value = f;
  }
  function openGlobalHistory(): void {
    historyFolder.value = null;
    historyGlobal.value = true;
  }

  // 冲突收件箱:非空 = 打开该目录的冲突副本处理面板
  const conflictsFolder = ref<FolderInfo | null>(null);
  function openConflicts(f: FolderInfo): void {
    conflictsFolder.value = f;
  }

  // 文件版本弹窗:非空 = 打开该目录的版本留档(拉取与展示在 VersionsModal 内)
  const versionsFolder = ref<FolderInfo | null>(null);
  function openVersions(f: FolderInfo): void {
    versionsFolder.value = f;
  }

  // 忽略规则编辑器:非空 = 打开该目录的 .syncxignore 编辑弹窗(拉取/保存/测试在 IgnoreModal 内)
  const ignoreFolder = ref<FolderInfo | null>(null);
  function openIgnoreEditor(f: FolderInfo): void {
    ignoreFolder.value = f;
  }

  // 端到端加密设置:非空 = 打开该目录的口令/不可信节点弹窗(提交在 E2EModal 内)
  const e2eFolder = ref<FolderInfo | null>(null);
  function openE2E(f: FolderInfo): void {
    e2eFolder.value = f;
  }

  // 浏览器内文件管理器:独立路由页 /files(与终端 /terminal 同套路,新开标签页)。
  // 浏览/下载只需登录,不再进页前弹提权门;删除在页内二次确认后走 ensureElevated。
  function openFiles(f: FolderInfo): void {
    window.open(`/files?folder=${encodeURIComponent(f.id ?? f.path)}`, '_blank');
  }

  // ---- 暂停同步(目录卡开关 + 全局开关):数据面停摆,控制面照常 ----
  /** 暂停/恢复单个目录的同步。暂停 = 不扫描、不广播、不接收;连接与配对不受影响。 */
  async function toggleFolderPaused(f: FolderInfo, paused: boolean): Promise<void> {
    try {
      await apiJson('/api/folders/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: f.id ?? f.path, paused }),
      });
      f.paused = paused;
      showToast(paused ? '已暂停该目录同步(连接保持在线)' : '已恢复该目录同步');
      await refreshStatus();
    } catch (e) {
      showToast(errText(e, '操作失败,请重试'), 'alert');
      await refreshStatus(); // 回读后端真实状态,避免按钮与配置不一致
    }
  }

  /** 全局暂停/恢复:所有目录一起停摆;各目录自己的暂停状态独立保留,恢复全局后仍生效。 */
  async function toggleGlobalPaused(paused: boolean): Promise<void> {
    try {
      await apiJson('/api/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused }),
      });
      showToast(paused ? '已全局暂停同步' : '已恢复同步');
      await refreshStatus();
    } catch (e) {
      showToast(errText(e, '操作失败,请重试'), 'alert');
      await refreshStatus();
    }
  }

  /**
   * 「目录不可信」→ 重新采集身份指纹:仅更新 folderIdentity、不动索引,成功后
   * 后端会补一轮扫描让目录恢复。目录不可读时后端拒绝,错误原样透出到 toast。
   */
  async function reAdoptIdentity(f: FolderInfo): Promise<void> {
    try {
      await apiJson('/api/folders/re-adopt-identity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: f.id ?? f.path }),
      });
      showToast('已重新采集目录身份,正在恢复同步');
      await refreshStatus();
    } catch (e) {
      showToast(errText(e, '采集身份失败'), 'alert');
      await refreshStatus();
    }
  }

  return {
    hoverDevices,
    hoverFolderKey,
    onFolderEnter,
    onFolderLeave,
    hoverDeviceId,
    onDeviceEnter,
    onDeviceLeave,
    addFolderOpen,
    toggleAddFolder,
    addFolder,
    newPath,
    newFolderId,
    newFolderDevices,
    newFolderReceiveOnly,
    askRemoveFolder,
    openEditDevices,
    openHistory,
    openGlobalHistory,
    openConflicts,
    openVersions,
    openIgnoreEditor,
    ignoreFolder,
    openE2E,
    e2eFolder,
    openFiles,
    editDevicesOpen,
    editFolder,
    saveEditDevices,
    prioritizeFile,
    historyFolder,
    historyGlobal,
    conflictsFolder,
    versionsFolder,
    toggleFolderPaused,
    toggleGlobalPaused,
    reAdoptIdentity,
  };
}
