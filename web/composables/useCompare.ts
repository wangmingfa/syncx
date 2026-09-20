import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { apiJson, apiPost, errText } from '../utils/api';
import { buildTreeRows, countRows, type RowStatus, type TreeRow } from '../utils/tree';
import { useToast } from './useToast';
import type {
  FileCompareData,
  FolderCompareData,
  FolderDiffKind,
  FolderInfo,
  StatusData,
} from '../types';

/** 按目录 id 记住上次对比选中的设备,免得每次进 /compare/<id> 都重新点一遍。 */
const LS_PREFIX = 'syncx:compare-device:';
function readStoredDevice(folderId: string): string | null {
  try {
    return localStorage.getItem(LS_PREFIX + folderId);
  } catch {
    return null; // 无痕模式 / 非浏览器环境没有 localStorage,静默降级为不记忆
  }
}
function writeStoredDevice(folderId: string, device: string): void {
  try {
    localStorage.setItem(LS_PREFIX + folderId, device);
  } catch {
    /* 同上,写入失败不影响主流程 */
  }
}

/**
 * 双栏对比页的状态与动作。
 *
 * 与旧版弹窗式对比两点不同:
 *  1. 目录 id 来自**路由**,页面一进来就知道要比哪个目录;没有就渲染错误页;
 *  2. 除了差异分类,还要两侧的**完整条目清单**(目录结构视图必须看到「两边一样的
 *     那些文件」,否则「对齐」无从谈起)。
 *
 * 并发保护与弹窗版一致:切换设备 / 重跑会让上一次请求还在飞,用单调递增的 seq
 * 丢弃迟到响应 —— 否则慢的那次(可能是上一个设备的)会覆盖当前结果,而两者看起来
 * 都「像是对的」。
 */
export interface CompareApi {
  /** 路由指定的目录;本机配置里没有它时为 null(页面据此渲染错误页)。 */
  folder: ComputedRef<FolderInfo | null>;
  folderId: string;
  devices: ComputedRef<string[]>;
  /** 当前对比设备(路由参数优先,否则取第一个)。 */
  device: Ref<string>;
  data: Ref<FolderCompareData | null>;
  loading: Ref<boolean>;
  error: Ref<string>;
  rows: ComputedRef<TreeRow[]>;
  counts: ComputedRef<Record<RowStatus, number>>;
  selectDevice: (device: string) => Promise<void>;
  reload: () => Promise<void>;
  /** 文件内容弹窗 */
  fileOpen: Ref<boolean>;
  filePath: Ref<string>;
  fileData: Ref<FileCompareData | null>;
  fileLoading: Ref<boolean>;
  fileError: Ref<string>;
  openFile: (path: string) => Promise<void>;
  closeFile: () => void;
  reloadFile: () => Promise<void>;
  /** direction:'pull' 写本机;'push' 写对端。content 省略 = 整文件照抄来源侧。 */
  syncFile: (direction: 'pull' | 'push', content?: string) => Promise<void>;
}

export function useCompare(
  status: Ref<StatusData>,
  folderId: string,
  initialDevice?: string,
): CompareApi {
  const { showToast } = useToast();

  const folder = computed<FolderInfo | null>(
    () => status.value.folders.find((f) => (f.id ?? f.path) === folderId) ?? null,
  );
  const devices = computed<string[]>(() => folder.value?.devices ?? []);
  // 设备选择记忆:路由参数优先,其次上次选过的(按目录 id 存 localStorage),最后取第一个。
  // 路由带的值只有在「确实是本目录指派设备」时才认,过期链接不认。
  const initialStored = readStoredDevice(folderId);
  const device = ref<string>(
    initialDevice && devices.value.includes(initialDevice)
      ? initialDevice
      : initialStored && devices.value.includes(initialStored)
        ? initialStored
        : (devices.value[0] ?? ''),
  );
  // status 可能在挂载后才带出 devices(首屏没加载完):目录一旦有指派设备,若当前
  // device 仍空或已不在列表里,就补选到记忆值或第一个,避免页面卡在「未选设备」。
  watch(devices, (list) => {
    if (device.value && list.includes(device.value)) return;
    const stored = readStoredDevice(folderId);
    if (stored && list.includes(stored)) device.value = stored;
    else if (list.length) device.value = list[0] ?? '';
  });

  const data = ref<FolderCompareData | null>(null);
  const loading = ref(false);
  const error = ref('');
  let seq = 0;

  async function load(): Promise<void> {
    const f = folder.value;
    const d = device.value;
    if (!f) return;
    if (!d) {
      data.value = null;
      error.value = '该目录还没有指派设备，无从对比';
      return;
    }
    const mine = ++seq;
    loading.value = true;
    error.value = '';
    try {
      const res = await apiJson<FolderCompareData>(
        `/api/folders/compare?folderId=${encodeURIComponent(f.id ?? f.path)}&device=${encodeURIComponent(d)}`,
      );
      if (mine !== seq) return;
      data.value = res;
    } catch (e) {
      if (mine !== seq) return;
      data.value = null;
      error.value = errText(e, '对比失败（对端可能离线或版本过旧）');
    } finally {
      if (mine === seq) loading.value = false;
    }
  }

  const rows = computed<TreeRow[]>(() => {
    const d = data.value;
    if (!d) return [];
    const kindByPath = new Map<string, FolderDiffKind>();
    for (const item of d.diff.items) kindByPath.set(item.path, item.kind);
    return buildTreeRows(d.local, d.remote, kindByPath);
  });

  const counts = computed<Record<RowStatus, number>>(() => countRows(rows.value));

  async function selectDevice(next: string): Promise<void> {
    if (next === device.value) return;
    device.value = next;
    writeStoredDevice(folderId, next);
    data.value = null;
    await load();
  }

  // 文件弹窗
  const fileOpen = ref(false);
  const filePath = ref('');
  const fileData = ref<FileCompareData | null>(null);
  const fileLoading = ref(false);
  const fileError = ref('');
  let fileSeq = 0;

  async function reloadFile(): Promise<void> {
    const f = folder.value;
    const d = device.value;
    const p = filePath.value;
    if (!f || !d || !p) return;
    const mine = ++fileSeq;
    fileLoading.value = true;
    fileError.value = '';
    try {
      const res = await apiJson<FileCompareData>(
        `/api/folders/file?folderId=${encodeURIComponent(f.id ?? f.path)}` +
          `&device=${encodeURIComponent(d)}&path=${encodeURIComponent(p)}`,
      );
      if (mine !== fileSeq) return;
      fileData.value = res;
    } catch (e) {
      if (mine !== fileSeq) return;
      fileData.value = null;
      fileError.value = errText(e, '读取文件失败');
    } finally {
      if (mine === fileSeq) fileLoading.value = false;
    }
  }

  async function openFile(path: string): Promise<void> {
    filePath.value = path;
    fileData.value = null;
    fileError.value = '';
    fileOpen.value = true;
    await reloadFile();
  }

  function closeFile(): void {
    fileOpen.value = false;
    // 关窗后迟到的响应不再写入,下次打开是干净状态
    fileSeq += 1;
    fileLoading.value = false;
  }

  async function syncFile(direction: 'pull' | 'push', content?: string): Promise<void> {
    const f = folder.value;
    const d = device.value;
    const p = filePath.value;
    if (!f || !d || !p) return;
    try {
      await apiPost('/api/folders/file/sync', {
        folderId: f.id ?? f.path,
        device: d,
        path: p,
        direction,
        ...(content !== undefined ? { content } : {}),
      });
      showToast(direction === 'pull' ? '已把对端内容同步到本机' : '已把本机内容同步到对端');
      // 两侧都重取:文件内容变了,目录结构里的差异分类也变了
      await reloadFile();
      await load();
    } catch (e) {
      showToast(errText(e, '同步失败'), 'alert');
    }
  }

  return {
    folder,
    folderId,
    devices,
    device,
    data,
    loading,
    error,
    rows,
    counts,
    selectDevice,
    reload: load,
    fileOpen,
    filePath,
    fileData,
    fileLoading,
    fileError,
    openFile,
    closeFile,
    reloadFile,
    syncFile,
  };
}
