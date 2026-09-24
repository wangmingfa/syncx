<script setup lang="ts">
import { computed, h } from 'vue';
import type { VNodeChild } from 'vue';
import { NButton, NDropdown, NPopover } from 'naive-ui';
import type { DropdownOption } from 'naive-ui';
import OsIcon from './OsIcon.vue';
import { useStatusContext } from '../composables/statusContext';
import { useTheme, type ThemeMode } from '../composables/useTheme';
import { formatBytes } from '../utils/bytes';
import { osIconLabel } from '../utils/os-icon';

const { status, busy, checkForUpdate, openUpload, openLogs, openTopology, openTraffic, openGuide, openSettings, openAuth, logout, copy } = useStatusContext();
const { mode: themeMode, resolved: themeResolved, setMode } = useTheme();

const themeOptions: DropdownOption[] = [
  { label: '跟随系统', key: 'system' },
  { label: '浅色', key: 'light' },
  { label: '深色', key: 'dark' },
];

/** 当前模式在菜单里画 ✓(配合 n-dropdown 的 value 高亮,一眼看清现在用的是哪档)。
    这版 naive-ui 的 renderLabel 只收 option 一个参数(不传 selected 状态),
    勾选与否自己按 key 比对当前模式。容器必须用 display:flex 而非 inline-flex ——
    空的 ✓ 槽位零高度,inline-flex 会拿它当基线,把整行文字拽得不居中;
    槽位定宽则保证切换勾选时文字不左右跳。 */
function renderThemeLabel(option: DropdownOption): VNodeChild {
  const selected = option.key === themeMode.value;
  return h('span', { style: 'display:flex;align-items:center;gap:8px' }, [
    h('span', { style: 'width:12px;flex:none;text-align:center;color:var(--accent)' }, selected ? '✓' : ''),
    h('span', { style: 'flex:1 1 auto' }, String(option.label ?? option.key)),
  ]);
}

function onThemeSelect(key: string): void {
  setMode(key as ThemeMode);
}

/** 累计收发(流量按钮直接把这组数当标签用:不点开也扫一眼可见)。 */
const trafficText = computed<string>(() => {
  const t = status.value.traffic;
  if (!t || (t.sent === 0 && t.received === 0)) return '流量';
  return `↑${formatBytes(t.sent)} · ↓${formatBytes(t.received)}`;
});

/** 本机网络信息(主机名 + 局域网地址)。 */
const ips = computed<string[]>(() => status.value.localAddresses ?? []);
const hasLocalInfo = computed<boolean>(() => !!status.value.hostname || ips.value.length > 0);

/**
 * 本机 chip 的图标同时说两件事:
 *  - **形状** = status.platform(daemon 的 process.platform,不是浏览器所在的那台机器
 *    —— 控制台常从另一台机器打开,读 navigator 会画出错的系统);
 *  - **彩色 / 灰** = 是否至少有一个对端连上,沿用原来那颗圆点的口径,语义没动。
 * 两件信息叠在同一枚图标上确有歧义风险(容易读成「Windows 在线/不在线」),
 * 所以 hint 文本把两件事分开说明,hover 即见。
 */
const anyPeerOnline = computed<boolean>(() => status.value.devices.some((p) => p.online));
const chipOsHint = computed<string>(
  () => `${osIconLabel(status.value.platform)} · ${anyPeerOnline.value ? '已有对端在线' : '暂无对端连接'}`,
);

/**
 * 顶栏收纳策略(定稿):所有低频操作收进本机 chip 的 hover 浮层,
 * 「更多」下拉与手机档 compact 分支一并删除 —— 顶栏常态只剩
 * brand / 流量 / 主题 / chip,桌面与移动同一套结构。
 * 浮内分两段:上半「本机信息」,分隔线下半「操作菜单」。
 */
type ChipRow =
  | { kind: 'item'; label: string; run: () => void; disabled?: boolean; danger?: boolean }
  | { kind: 'divider' };

const chipRows = computed<ChipRow[]>(() => [
  { kind: 'item', label: '全局设置', run: openSettings },
  { kind: 'item', label: '日志', run: openLogs },
  { kind: 'item', label: '拓扑', run: openTopology, disabled: busy.value },
  { kind: 'divider' },
  { kind: 'item', label: '检查更新', run: () => void checkForUpdate(), disabled: busy.value },
  { kind: 'item', label: '上传升级', run: openUpload, disabled: busy.value },
  { kind: 'divider' },
  { kind: 'item', label: '使用指南', run: openGuide },
  { kind: 'item', label: '登录密码', run: openAuth },
  { kind: 'divider' },
  { kind: 'item', label: '退出登录', run: () => void logout(), danger: true },
]);
</script>

<template>
  <div class="topbar">
    <div class="brand">
      <svg class="brand__mark" viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#4a7fc0" />
            <stop offset="1" stop-color="#2bb6ac" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="9" fill="url(#lg)" />
        <g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round">
          <path d="M8.5 13H20" />
          <path d="M24 19H12" />
        </g>
        <path d="M20 10.5 24.5 13 20 15.5Z" fill="#fff" />
        <path d="M12 16.5 7.5 19 12 21.5Z" fill="#fff" />
      </svg>
      <div class="brand__text">
        <div class="brand__name">SYNCX</div>
        <div class="brand__sub">P2P LAN SYNC</div>
      </div>
    </div>

    <n-button tertiary @click="openTraffic" title="传输统计:累计收发与最近 24 小时曲线(daemon 重启清零)">
      <template #icon>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 17 9 11l3.5 3.5L20 6" />
          <path d="M4 21h16" />
        </svg>
      </template>
      {{ trafficText }}
    </n-button>

    <!-- 主题切换:图标随当前生效主题变(日/月),悬停选三档。高频全局偏好,留在外面 -->
    <n-dropdown
      trigger="hover"
      placement="bottom-end"
      :options="themeOptions"
      :value="themeMode"
      :render-label="renderThemeLabel"
      @select="onThemeSelect"
    >
      <n-button tertiary circle :title="`主题:${themeMode === 'system' ? '跟随系统' : themeResolved === 'dark' ? '深色' : '浅色'}`">
        <template #icon>
          <svg v-if="themeResolved === 'dark'" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
          </svg>
        </template>
      </n-button>
    </n-dropdown>

    <div class="topbar__spacer"></div>

    <!-- 本机 chip:悬停浮出「网络明细 + 低频操作菜单」两段。顶栏所有收纳入口都在这 -->
    <n-popover trigger="hover" placement="bottom-end" :style="{ maxWidth: '360px' }">
      <template #trigger>
        <span class="device-chip">
          <OsIcon :platform="status.platform" :offline="!anyPeerOnline" :hint="chipOsHint" />
          <span class="mono">{{ status.deviceId }}</span>
          <span v-if="status.version" class="chip-version">{{ status.version === 'dev' ? status.version : `v${status.version}` }}</span>
          <svg class="chip-caret" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </template>
      <div class="chip-panel">
        <div v-if="hasLocalInfo" class="chip-info">
          <!-- 值可点复制(复用全局 copy:成功有 toast,与目录 ID 复制同一条路) -->
          <div v-if="status.hostname" class="chip-info-row">
            <span class="chip-info-label">主机名</span>
            <button type="button" class="chip-copy mono" title="点击复制" @click="copy(status.hostname!)">{{ status.hostname }}</button>
          </div>
          <div v-for="ip in ips" :key="ip" class="chip-info-row">
            <span class="chip-info-label">IPv4</span>
            <button type="button" class="chip-copy mono" title="点击复制" @click="copy(ip)">{{ ip }}</button>
          </div>
        </div>
        <div v-if="hasLocalInfo" class="chip-divider"></div>
        <div class="chip-menu">
          <template v-for="(row, i) in chipRows" :key="i">
            <div v-if="row.kind === 'divider'" class="chip-menu__divider"></div>
            <button
              v-else
              type="button"
              class="chip-menu__item"
              :class="{ 'chip-menu__item--danger': row.danger, 'is-disabled': row.disabled }"
              :disabled="row.disabled"
              @click="row.run()"
            >{{ row.label }}</button>
          </template>
        </div>
      </div>
    </n-popover>
  </div>
</template>
