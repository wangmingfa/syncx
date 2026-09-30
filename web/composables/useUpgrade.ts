import { apiJson } from '../utils/api';
import { useToast } from './useToast';

/**
 * 「从对端升级」这一条动作:POST /api/devices/upgrade,由 daemon 从对方拉产物、
 * 自替换并重启。
 *
 * 单独成一个 composable 而不是留在 useDevices 里,是因为它有**两个**调用方:
 * 设备卡的「升级到 x.y.z」(askUpgrade)和版本一致锁(UpgradeLockHost,见 ADR-0018)。
 * 锁那边关不掉,升级是唯一的出路,所以反馈必须一条不少 —— 成功 toast、等 daemon 重启的
 * 间隙、再刷状态;少一步就成了「按了按钮页面纹丝不动」,而那是个死页面。
 *
 * 失败**原样抛出**:两个调用方展示位置不同(设备卡走确认弹窗的 toast,锁弹窗显示在行内,
 * 因为它没有别的地方可以说话)。
 */
export function useUpgrade(refreshStatus: () => Promise<void>): {
  upgradeFromDevice: (deviceId: string) => Promise<void>;
} {
  const { showToast } = useToast();

  async function upgradeFromDevice(deviceId: string): Promise<void> {
    const data = await apiJson<{ ok?: boolean; version?: string; error?: string }>('/api/devices/upgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });
    if (!data.ok) throw new Error(data.error ?? '升级失败');
    showToast(`已更新到 ${data.version},daemon 重启中…`, 'alert');
    // daemon 即将重启:稍等片刻再刷新,让状态先落回「离线/重启中」
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await refreshStatus();
  }

  return { upgradeFromDevice };
}
