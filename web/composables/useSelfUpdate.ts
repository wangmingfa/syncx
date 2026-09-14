import { ref } from 'vue';
import type { Ref } from 'vue';
import { useToast } from './useToast';
import { apiJson, errText } from '../utils/api';
import type { CoreDeps } from './statusContext';

/** npm 自更新(检查/升级流程)与登录态相关(退出登录)。 */
export function useSelfUpdate(deps: CoreDeps): {
  upgrading: Ref<boolean>;
  askSelfUpdate: (u: { latest: string; current: string }) => void;
  checkForUpdate: () => Promise<void>;
  logout: () => Promise<void>;
} {
  const { status, busy, refreshStatus, askConfirm } = deps;
  const { showToast } = useToast();

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
    const body = await apiJson<{ ok?: boolean; error?: string }>('/api/self-update', { method: 'POST' });
    if (!body.ok) throw new Error(body.error ?? '升级失败');
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

  return { upgrading, askSelfUpdate, checkForUpdate, logout };
}
