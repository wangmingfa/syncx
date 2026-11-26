/**
 * 拖拽路由:设备卡直发 drop target 与页面级安装包 DropOverlay 共用。
 *
 * 两者都监听 window 上的 dragover:设备卡在中央上传区之外时,
 * DropOverlay 会把 dropEffect 设成 none,浏览器就不派发设备卡的 drop 了。
 * 设备卡拖入时把 deviceId 写进来,DropOverlay 见到非空就直接让路;
 * 这样遮罩不会亮起、也不会抢走投放。
 */
import { ref, type Ref } from 'vue';

const activeDirectTarget: Ref<string | null> = ref(null);

export function setDirectDropTarget(deviceId: string | null): void {
  activeDirectTarget.value = deviceId;
}

export function getDirectDropTarget(): string | null {
  return activeDirectTarget.value;
}
