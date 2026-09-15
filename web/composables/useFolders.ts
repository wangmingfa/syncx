import { ref, type Ref } from 'vue';
import { useToast } from './useToast';
import { apiJson, errText } from '../utils/api';
import { folderKey } from '../utils/format';
import type { CoreDeps } from './statusContext';
import type { FolderInfo } from '../types';

/** 文件夹相关:添加/移除(防误删确认)/编辑指派设备/ .gitignore 开关/悬停联动/同步记录。 */
export function useFolders(deps: CoreDeps): {
  hoverDevices: Ref<string[]>;
  hoverFolderKey: Ref<string>;
  onFolderEnter: (f: { id?: string; path: string; devices: string[] }) => void;
  onFolderLeave: () => void;
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
  editDevicesOpen: Ref<boolean>;
  editFolder: Ref<FolderInfo | null>;
  historyFolder: Ref<FolderInfo | null>;
  saveEditDevices: (payload: { path: string; devices: string[]; gitignore: boolean }) => Promise<void>;
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

  // 同步记录弹窗:非空 = 打开该目录的记录(拉取与展示在 HistoryModal 内)
  const historyFolder = ref<FolderInfo | null>(null);
  function openHistory(f: FolderInfo): void {
    historyFolder.value = f;
  }

  return {
    hoverDevices,
    hoverFolderKey,
    onFolderEnter,
    onFolderLeave,
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
    editDevicesOpen,
    editFolder,
    saveEditDevices,
    historyFolder,
  };
}
