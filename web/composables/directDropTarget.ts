/**
 * 拖拽路由:设备卡直发 drop target 与页面级安装包 DropOverlay 共用。
 *
 * 两者都监听 window 上的 dragover:设备卡在中央上传区之外时,
 * DropOverlay 会把 dropEffect 设成 none,浏览器就不派发设备卡的 drop 了。
 * 设备卡拖入时把 deviceId 写进来,DropOverlay 见到非空就直接让路;
 * 这样遮罩不会亮起、也不会抢走投放。
 *
 * 发送弹窗也走同一路由:弹窗打开时整页拖入归发送队列(窗口本身接 drop),
 * 升级遮罩同样让路 —— 见下方 sendDropsClaimed。
 */
import { ref, type Ref } from 'vue';

const activeDirectTarget: Ref<string | null> = ref(null);

export function setDirectDropTarget(deviceId: string | null): void {
  activeDirectTarget.value = deviceId;
}

export function getDirectDropTarget(): string | null {
  return activeDirectTarget.value;
}

/**
 * 「发送到设备」弹窗打开期间为 true:整页拖入的**文件**都归它(加入发送队列),
 * 设备卡与升级遮罩都让路。
 *
 * 弹窗盖住了设备卡,但 window 上的升级遮罩还在监听 —— 不设这道闸,拖文件到弹窗里
 * 会弹出「拖入 .tgz 安装包升级」的提示,松手又什么都不做(非安装包被静默忽略)。
 */
const sendDropsClaimed = ref(false);

export function claimSendDrops(claimed: boolean): void {
  sendDropsClaimed.value = claimed;
}

export function isSendDropsClaimed(): boolean {
  return sendDropsClaimed.value;
}
