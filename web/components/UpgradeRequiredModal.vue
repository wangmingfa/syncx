<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton } from 'naive-ui';
import ModalShell from './ModalShell.vue';
import type { DeviceInfo } from '../types';

/**
 * 版本一致锁:任何**在线**配对设备的 syncx 版本比本机新时,整页被这层不可关闭的
 * 弹窗盖住,唯一的出路是把本机升到对方的版本(升级走 daemon 自替换重启,回来后
 * status 刷新,canUpgrade 归 false,弹窗自行消失)。
 *
 * 判定直接吃 daemon 在 status.devices 里算好的 `canUpgrade`(本机与对端都是具体
 * semver 且本机更低;dev↔build 混跑、dev 运行态一律不触发),web 端不出现第二份
 * 版本比较逻辑 —— 也因此每行一颗按钮、升哪台由人选,而不是前端再比一次取最高。
 * 离线对端不锁(版本是上次握手的缓存,升级也需要对方在线):它一上线重新 hello,
 * canUpgrade 即刻变 true,这层锁随即落下。
 *
 * `onUpgrade` 是异步动作 prop(而非 emit):弹窗要 await 它才能按行收 busy、
 * 接住失败在行内展示 —— 弹窗关不掉,错误不能只进 toast 后凭空消失。
 */
const props = defineProps<{
  /** 完整的 status.devices 列表,由组件自己筛出需要锁的行。 */
  devices: DeviceInfo[];
  /** 本机运行版本(展示用;dev 态时这层锁根本不会出现)。 */
  localVersion?: string;
  /** 执行升级(即 useDevices.upgradeDevice:POST /api/devices/upgrade 并等待重启)。 */
  onUpgrade: (deviceId: string) => Promise<void>;
}>();

const outdated = computed(() => props.devices.filter((d) => d.online && d.canUpgrade));

/** 升级中的行(按 deviceId)。daemon 重启期间请求返回后 status 不可用,按钮保持 busy 直到页面重连刷新。 */
const busy = ref(new Set<string>());
/** 行内错误信息(升级失败时展示;成功路径由 upgradeDevice 自己 toast)。 */
const error = ref('');

async function upgrade(d: DeviceInfo): Promise<void> {
  error.value = '';
  busy.value.add(d.deviceId);
  try {
    await props.onUpgrade(d.deviceId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value.delete(d.deviceId);
  }
}

function deviceName(d: DeviceInfo): string {
  return d.hostname || `设备 ${d.deviceId.slice(0, 10)}`;
}
</script>

<template>
  <ModalShell
    :open="outdated.length > 0"
    title="需要升级"
    description="版本必须与配对设备一致"
    hide-close
  >
    <p class="upgrade-lock__lead">
      以下设备运行的 syncx 版本比本机新。同步要求所有配对设备版本一致,
      请先从对方升级本机;升级会自动重启服务,完成后本弹窗自动消失。
    </p>
    <ul class="upgrade-lock__list">
      <li v-for="d in outdated" :key="d.deviceId" class="upgrade-lock__row">
        <div class="upgrade-lock__info">
          <span class="upgrade-lock__name">{{ deviceName(d) }}</span>
          <span class="upgrade-lock__versions mono">
            本机 v{{ localVersion ?? '?' }} → 对方 v{{ d.version }}
          </span>
        </div>
        <n-button
          size="small"
          type="warning"
          :loading="busy.has(d.deviceId)"
          :disabled="busy.size > 0"
          @click="upgrade(d)"
        >
          {{ busy.has(d.deviceId) ? '升级中…' : '从对方升级并重启' }}
        </n-button>
      </li>
    </ul>
    <p v-if="error" class="upgrade-lock__error">{{ error }}</p>
  </ModalShell>
</template>

<style scoped>
.upgrade-lock__lead {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.6;
}

.upgrade-lock__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.upgrade-lock__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-soft);
}

.upgrade-lock__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.upgrade-lock__name {
  font-weight: 600;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upgrade-lock__versions {
  font-size: 12px;
  color: var(--muted);
}

.upgrade-lock__error {
  margin: 14px 0 0;
  font-size: 12.5px;
  color: var(--offline);
  line-height: 1.5;
}
</style>
