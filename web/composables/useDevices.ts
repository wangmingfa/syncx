import { ref, type Ref } from 'vue';
import { useToast } from './useToast';
import { useUpgrade } from './useUpgrade';
import { apiJson, errText } from '../utils/api';
import { parsePairCode } from '../utils/qrcode';
import type { CoreDeps } from './statusContext';
import type { DeviceInfo, DiscoveredDevice } from '../types';

/** 对端数据面的默认端口(与 daemon 的 --port 默认值一致);表单初始值、留空回退、清空回位共用这一个。 */
const DEFAULT_PEER_PORT = '22000';

/** 设备相关:扫描/重连/配对/移除(防误删确认)/从对端升级/附近发现一键添加。 */
export function useDevices(deps: CoreDeps): {
  rescan: () => void;
  reconnect: (deviceId: string) => void;
  addDeviceOpen: Ref<boolean>;
  toggleAddDevice: () => void;
  addDevice: () => Promise<void>;
  newDeviceId: Ref<string>;
  newDeviceHost: Ref<string>;
  newDevicePort: Ref<string>;
  askRemoveDevice: (deviceId: string) => void;
  askUpgrade: (p: DeviceInfo) => void;
  /** 一键添加「附近发现的设备」:直接带 mDNS 学到的地址配对。 */
  addDiscovered: (d: DiscoveredDevice) => Promise<void>;
} {
  const { status, busy, refreshStatus, post, askConfirm } = deps;
  const { showToast } = useToast();

  function rescan(): void {
    void post('/api/rescan');
  }

  function reconnect(deviceId: string): void {
    void post(`/api/reconnect?deviceId=${encodeURIComponent(deviceId)}`);
  }

  // ---- 设备配对(按 ID,默认收起,点按钮展开表单) ----
  const addDeviceOpen = ref(false);
  const newDeviceId = ref('');
  const newDeviceHost = ref('');
  const newDevicePort = ref(DEFAULT_PEER_PORT);

  /**
   * 添加表单的「空」只定义一次:成功提交与取消都走它。
   * 端口**回到默认值而不是清空** —— 22000 是绝大多数情况的正确答案,
   * 清空只会逼人在下次添加时重打一遍,那不是「清空草稿」而是「制造额外工作」。
   */
  function resetAddDeviceForm(): void {
    newDeviceId.value = '';
    newDeviceHost.value = '';
    newDevicePort.value = DEFAULT_PEER_PORT;
  }

  /**
   * 开 / 关配对表单,关闭时连输入一起丢弃(理由同 useFolders 的 toggleAddFolder)。
   * 关闭只有「取消」这一条路:表单展开时右上角的「＋ 添加」是 `is-invisible` +
   * `tabindex=-1`,点不到。
   */
  function toggleAddDevice(): void {
    addDeviceOpen.value = !addDeviceOpen.value;
    if (!addDeviceOpen.value) resetAddDeviceForm();
  }

  async function addDevice(): Promise<void> {
    const raw = newDeviceId.value.trim();
    if (!raw) {
      showToast('请填写设备 ID');
      return;
    }
    if (busy.value) return;
    // 支持直接粘贴对方的 syncx:// 配对串(扫对方二维码得到):拆出 ID 与地址自动填表
    const pair = parsePairCode(raw);
    const id = pair?.deviceId ?? raw;
    if (pair) {
      newDeviceId.value = id;
      if (pair.host) newDeviceHost.value = pair.host;
      if (pair.port) newDevicePort.value = pair.port;
    }
    // 地址为可选项:仅跨网段/无 mDNS 时需要。由 ws://(前缀) + 主机 + :端口(默认 22000) 拼成
    const host = newDeviceHost.value.trim();
    let address: string | undefined;
    if (host) {
      const port = newDevicePort.value.trim() || DEFAULT_PEER_PORT;
      address = `ws://${host}:${port}`;
    }
    busy.value = true;
    try {
      await apiJson('/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: id, address }),
      });
      showToast(address ? '已添加设备并发起直连' : '已添加设备');
      resetAddDeviceForm();
      addDeviceOpen.value = false;
      await refreshStatus();
    } catch (e) {
      showToast(errText(e, '添加失败,请重试'), 'alert');
    } finally {
      busy.value = false;
    }
  }

  /** 「附近发现的设备」一键添加:deviceId + mDNS 学到的 ws://host:port 直连地址。 */
  async function addDiscovered(d: DiscoveredDevice): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    try {
      await apiJson('/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: d.deviceId, address: `ws://${d.host}:${d.port}` }),
      });
      showToast(`已添加设备 ${d.deviceId}`);
      await refreshStatus();
    } catch (e) {
      showToast(errText(e, '添加失败,请重试'), 'alert');
    } finally {
      busy.value = false;
    }
  }

  /** 点设备卡「移除」:列出会从哪些共享目录里摘掉它(目录本身保留),确认后才执行。 */
  function askRemoveDevice(deviceId: string): void {
    // 受影响的目录 = devices 里含该设备的目录;others 用于区分「仅共享给它」的目录
    // (旧配置的 devices 字段可能缺失,统一兜底为空数组)
    const affected = status.value.folders
      .filter((f) => (f.devices ?? []).includes(deviceId))
      .map((f) => ({ path: f.path, others: (f.devices ?? []).filter((d) => d !== deviceId).length }));

    askConfirm({
      title: '移除设备?',
      message: '将与该设备取消配对并断开连接。共享目录与磁盘文件都会保留,只是不再向它同步。',
      detail: deviceId,
      folders: affected,
      note: '对方仍保留自己的配置,需要对方也移除一次才会彻底断开。',
      confirmText: '确认移除',
      action: () => doRemoveDevice(deviceId),
    });
  }

  async function doRemoveDevice(deviceId: string): Promise<void> {
    await apiJson(`/api/devices?deviceId=${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
    showToast('已移除设备');
    await refreshStatus();
  }

  // ---- 从对端升级(设备卡版本低于对方时显示;dev↔build 混跑不出现) ----
  // 动作本体在 useUpgrade:版本一致锁(UpgradeLockHost)那条路走的是同一段流程。
  const { upgradeFromDevice } = useUpgrade(refreshStatus);

  /** 点设备卡「升级到 x.y.z」:二次确认后从对方拉取产物并自动重启。 */
  function askUpgrade(p: DeviceInfo): void {
    askConfirm({
      title: '从该设备升级?',
      message: `将从对方拉取 syncx ${p.version} 替换本机产物,并自动重启服务。重启期间 Web UI 会短暂断开,稍后自动恢复。`,
      detail: p.deviceId,
      confirmText: '升级并重启',
      action: () => upgradeFromDevice(p.deviceId),
    });
  }

  return {
    rescan,
    reconnect,
    addDeviceOpen,
    toggleAddDevice,
    addDevice,
    newDeviceId,
    newDeviceHost,
    newDevicePort,
    askRemoveDevice,
    askUpgrade,
    addDiscovered,
  };
}
