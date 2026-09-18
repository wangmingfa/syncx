import { ref } from 'vue';
import type { Ref } from 'vue';
import { useToast } from './useToast';
import { apiJson, errText } from '../utils/api';
import type { CoreDeps } from './statusContext';
import type { UploadPackageInfo } from '../types';

/**
 * 自更新(npm 定时检查 / 上传本地安装包)与登录态相关(退出登录)。
 *
 * 上传弹窗的「选包 + 预检」状态放在这里而不是弹窗内部:页面级拖入
 * (DropOverlay)与弹窗内的点击选择要落到同一份状态上,弹窗只当视图用。
 */
export function useSelfUpdate(deps: CoreDeps): {
  upgrading: Ref<boolean>;
  askSelfUpdate: (u: { latest: string; current: string }) => void;
  checkForUpdate: () => Promise<void>;
  uploadOpen: Ref<boolean>;
  openUpload: () => void;
  closeUpload: () => void;
  uploadFile: Ref<File | null>;
  uploadInfo: Ref<UploadPackageInfo | null>;
  uploadInspecting: Ref<boolean>;
  uploadError: Ref<string>;
  selectUploadFile: (file: File) => Promise<void>;
  resetUpload: () => void;
  applyUpload: (file: File) => Promise<void>;
  logout: () => Promise<void>;
} {
  const { status, busy, isDev, refreshStatus, askConfirm } = deps;
  const { showToast } = useToast();

  /** dev 运行态下自更新不可用:原因统一在此说明,各入口拦截后原样透出。 */
  const DEV_UPDATE_BLOCKED = '开发模式下不支持升级功能（运行态为 dev，无单文件运行时可替换）';

  /** 升级进行中:隐藏横幅、禁用入口并防止重复触发。 */
  const upgrading = ref(false);

  /** 「上传升级」弹窗开关(弹窗自己管选包与确认,这里只控制显隐)。 */
  const uploadOpen = ref(false);
  /** 已选中的安装包;null = 还没选。 */
  const uploadFile = ref<File | null>(null);
  /** 服务端只读预检结果;null = 尚未预检或预检失败。 */
  const uploadInfo = ref<UploadPackageInfo | null>(null);
  const uploadInspecting = ref(false);
  const uploadError = ref('');
  /** 预检可以被新的选择打断(拖入第二个包),用序号丢弃过期结果。 */
  let inspectSeq = 0;

  function resetUpload(): void {
    inspectSeq += 1; // 让在途预检的结果作废
    uploadFile.value = null;
    uploadInfo.value = null;
    uploadError.value = '';
    uploadInspecting.value = false;
  }

  function openUpload(): void {
    if (isDev) {
      showToast(DEV_UPDATE_BLOCKED, 'alert');
      return;
    }
    resetUpload(); // 每次打开都从干净态开始,不残留上一轮的包与结论
    uploadOpen.value = true;
  }

  function closeUpload(): void {
    uploadOpen.value = false;
  }

  /**
   * 选中安装包后立刻让服务端做只读预检:拿包内版本与当前版本做对比,
   * 失败原因原样展示。点击选择与拖入上传共用这一条路径。
   */
  async function selectUploadFile(picked: File): Promise<void> {
    const seq = ++inspectSeq;
    uploadFile.value = picked;
    uploadInfo.value = null;
    uploadError.value = '';
    uploadInspecting.value = true;
    try {
      const info = await inspectUpload(picked);
      if (seq !== inspectSeq) return;
      uploadInfo.value = info;
    } catch (e) {
      if (seq !== inspectSeq) return;
      uploadError.value = errText(e, '安装包校验失败');
    } finally {
      if (seq === inspectSeq) uploadInspecting.value = false;
    }
  }

  /** 横幅「立即升级」:二次确认后走 npm 自升级,服务重启完成自动刷新页面。 */
  function askSelfUpdate(u: { latest: string; current: string }): void {
    if (isDev) {
      showToast(DEV_UPDATE_BLOCKED, 'alert');
      return;
    }
    askConfirm({
      title: `升级到 ${u.latest}?`,
      message: `将从 npm 下载官方安装包,校验通过后自动重启服务(当前 ${u.current})。重启期间页面会短暂失去连接,完成后自动刷新。`,
      confirmText: '开始升级',
      action: () => doSelfUpdate(u.latest),
    });
  }

  async function doSelfUpdate(latest: string): Promise<void> {
    upgrading.value = true;
    try {
      const body = await apiJson<{ ok?: boolean; error?: string }>('/api/self-update', { method: 'POST' });
      if (!body.ok) throw new Error(body.error ?? '升级失败');
      showToast(`已开始升级到 ${latest},服务重启中,请稍候…`, 'alert');
      await waitForRestart();
      // 新 daemon 已在同一端口就绪:整页刷新加载新版本前端
      window.location.reload();
    } catch (e) {
      // 失败(校验不通过 / 服务没起来):解除升级态,别让入口永久卡死
      upgrading.value = false;
      throw e;
    }
  }

  /**
   * 「上传升级」第一步:把安装包原样 POST 给服务端做只读预检,拿回包内版本与当前版本,
   * 供弹窗展示升级前后对比。不改动服务端任何状态,失败即包本身有问题(原因原样透出)。
   * 只由 selectUploadFile 调用,外部不直接用。
   */
  async function inspectUpload(file: File): Promise<UploadPackageInfo> {
    const body = await apiJson<{
      ok?: boolean;
      error?: string;
      version?: string;
      name?: string;
      current?: string;
    }>('/api/self-update/upload/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    if (!body.ok) throw new Error(body.error ?? '安装包校验失败');
    return { version: body.version ?? '', name: body.name ?? '', current: body.current ?? '' };
  }

  /**
   * 「上传升级」第二步:确认后真升级。服务端走与 npm / P2P 同一条管线
   * (校验 → updater 整包换入 → 新进程起不来则回滚),响应后优雅关闭;
   * 这里等 /health 重新可用,再整页刷新加载新版本前端。
   *
   * 失败只写进 uploadError 不外抛:错误展示位就在弹窗里,调用方无需再管。
   */
  async function applyUpload(file: File): Promise<void> {
    upgrading.value = true;
    uploadError.value = '';
    try {
      const body = await apiJson<{ ok?: boolean; error?: string; version?: string }>('/api/self-update/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      if (!body.ok) throw new Error(body.error ?? '升级失败');
      showToast(`已开始升级到 ${body.version ?? ''},服务重启中,请稍候…`, 'alert');
      await waitForRestart();
      window.location.reload();
    } catch (e) {
      upgrading.value = false;
      uploadError.value = errText(e, '升级失败');
    }
  }

  /** 轮询 /health(免认证)直到服务回来;超时抛错由弹窗展示。 */
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
    if (isDev) {
      showToast(DEV_UPDATE_BLOCKED, 'alert');
      return;
    }
    try {
      const body = await apiJson<{
        ok?: boolean;
        error?: string;
        update?: { latest: string } | null;
      }>('/api/self-update/check', { method: 'POST' });
      if (!body.ok) throw new Error(body.error ?? '检查更新失败');
      await refreshStatus();
      showToast(
        body.update ? `发现新版本 ${body.update.latest}` : `已是最新版本 ${status.value.version ?? ''}`,
        body.update ? 'alert' : 'info',
      );
    } catch (e) {
      showToast(errText(e, '检查更新失败,请重试'), 'alert');
    }
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

  return {
    upgrading,
    askSelfUpdate,
    checkForUpdate,
    uploadOpen,
    openUpload,
    closeUpload,
    uploadFile,
    uploadInfo,
    uploadInspecting,
    uploadError,
    selectUploadFile,
    resetUpload,
    applyUpload,
    logout,
  };
}
