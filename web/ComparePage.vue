<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue';
import { NButton } from 'naive-ui';
import { useCompare } from './composables/useCompare';
import { diffReportText } from './utils/diff-report';
import { useToast } from './composables/useToast';
import { copyText } from './utils/clipboard';
import { fmtTime, stripWs } from './utils/format';
import { goBack } from './utils/route';
import type { StatusData } from './types';
import FileDiffModal from './components/FileDiffModal.vue';

const props = defineProps<{
  status: StatusData;
  folderId: string;
  /** 路由上预选的对比设备。 */
  device?: string;
}>();

// props.status 在 script 里是解包后的值,但仍随父级 ref 变化;toRef 还原成 ref 交给 composable
const statusRef = toRef(props, 'status');
const {
  folder, devices, device, data, loading, error, rows, counts,
  selectDevice, reload,
  fileOpen, filePath, fileData, fileLoading, fileError,
  openFile, closeFile, syncFile,
} = useCompare(statusRef, props.folderId, props.device);

const { showToast } = useToast();

/** 只看差异:目录大时全量树会很长,这个开关是主要的浏览方式。 */
const onlyDiff = ref(false);

const visibleRows = computed(() =>
  onlyDiff.value ? rows.value.filter((r) => r.status !== 'same') : rows.value,
);

// 目录刚加载(或刚从路由进来)时拉一次;设备为空(未指派)时不发请求,页面直接提示
watch(
  () => [props.folderId, device.value] as const,
  () => {
    if (device.value) void reload();
  },
  { immediate: true },
);

/** 本机 / 对端的身份行:与对比弹窗同源(主机名 + IP),缺项就少一项不占位。 */
const localWhere = computed<string>(() => {
  const d = data.value;
  if (!d) return '';
  return [d.localHostname, ...d.localAddresses].filter(Boolean).join(' · ');
});

const remoteWhere = computed<string>(() => {
  const d = data.value;
  if (!d) return '';
  return [
    d.deviceHostname ?? '',
    d.deviceUrl ? stripWs(d.deviceUrl) : '',
    d.deviceVersion ? `syncx ${d.deviceVersion}` : '',
  ].filter(Boolean).join(' · ');
});

/** 设备按钮的悬停提示:设备 id 本身不好认,补上主机名与地址。 */
function deviceTip(id: string): string {
  const dev = props.status.devices.find((d) => d.deviceId === id);
  return [dev?.hostname, dev?.url ? stripWs(dev.url) : ''].filter(Boolean).join(' · ') || id;
}

function rowClass(row: { status: string }): string {
  return `is-${row.status}`;
}

/** 一侧的单元格内容摘要(悬停可见):大小 + 内容摘要前 8 位。 */
function sideTitle(entry?: { size: number; digest: string; deleted: boolean }): string {
  if (!entry) return '';
  if (entry.deleted) return '已删除（墓碑）';
  return `${entry.size} B · ${entry.digest ? entry.digest.slice(0, 8) : '—'}`;
}

/** 双击任意一侧的文件行:打开内容对比弹窗(目录没有内容可比)。 */
function onRowDblClick(row: { isDir: boolean; path: string }): void {
  if (row.isDir) return;
  void openFile(row.path);
}

async function copyReport(): Promise<void> {
  const d = data.value;
  if (!d) return;
  const ok = await copyText(diffReportText(d, props.status.deviceId));
  showToast(ok ? '已复制差异报告到剪贴板' : '复制失败，请手动选择文本复制', ok ? 'info' : 'alert');
}
</script>

<template>
  <div class="cmp-page">
    <header class="cmp-head">
      <div class="cmp-head__left">
        <n-button size="small" tertiary @click="goBack()">← 返回</n-button>
        <h1 class="cmp-title">目录对比</h1>
        <code v-if="folder" class="cmp-path mono break" :title="folder.path">{{ folder.path }}</code>
      </div>
      <div class="cmp-head__right">
        <n-button
          size="small"
          :tertiary="!onlyDiff"
          :type="onlyDiff ? 'primary' : 'default'"
          :disabled="!data"
          @click="onlyDiff = !onlyDiff"
        >只看差异</n-button>
        <n-button size="small" tertiary :disabled="loading || !device" @click="reload">重新对比</n-button>
        <n-button size="small" tertiary :disabled="!data" @click="copyReport">复制报告</n-button>
      </div>
    </header>

    <!-- 目录 id 不存在:路由带了个本机没有的目录,直接给错误页而不是空表格 -->
    <div v-if="!folder" class="cmp-error" role="alert">
      <h2 class="cmp-error__title">目录不存在</h2>
      <p class="cmp-error__msg">
        本机没有 id 为 <code class="mono break">{{ folderId }}</code> 的共享目录，可能已被移除，或链接来自另一台机器。
      </p>
      <n-button size="small" tertiary @click="goBack()">← 返回</n-button>
    </div>

    <template v-else>
      <div class="cmp-bar">
        <span class="cmp-bar__label">对比设备</span>
        <n-button
          v-for="d in devices"
          :key="d"
          size="small"
          class="mono"
          :type="d === device ? 'primary' : 'default'"
          :tertiary="d !== device"
          :disabled="loading"
          :title="deviceTip(d)"
          @click="selectDevice(d)"
        >{{ d }}</n-button>
        <span v-if="devices.length === 0" class="cmp-bar__empty">该目录还没有指派设备</span>
      </div>

      <div v-if="loading" class="cmp-state">正在取对端的索引快照…</div>

      <div v-else-if="error" class="cmp-error" role="alert">
        <div class="cmp-error__msg break">{{ error }}</div>
        <n-button size="small" tertiary :disabled="loading" @click="reload">重试</n-button>
      </div>

      <template v-else-if="data">
        <div class="cmp-meta">
          对端快照取自 {{ fmtTime(data.remoteAt) }} · 本机索引 {{ data.diff.localTotal }} 条 ·
          对端 {{ data.diff.remoteTotal }} 条 · 一致 {{ data.diff.counts['in-sync'] }} 条 ·
          差异行 {{ counts.diff + counts['only-local'] + counts['only-remote'] }}
        </div>

        <div class="cmp-legend mono">
          <div class="cmp-legend__row">
            <span class="cmp-legend__role">本机</span>
            <span class="cmp-legend__id">{{ status.deviceId }}</span>
            <span v-if="localWhere" class="cmp-legend__where">{{ localWhere }}</span>
          </div>
          <div class="cmp-legend__row">
            <span class="cmp-legend__role">对端</span>
            <span class="cmp-legend__id">{{ data.deviceId }}</span>
            <span v-if="remoteWhere" class="cmp-legend__where">{{ remoteWhere }}</span>
          </div>
        </div>

        <div class="cmp-table" role="table">
          <div class="cmp-thead" role="row">
            <div class="cmp-th" role="columnheader">本机目录结构</div>
            <div class="cmp-th" role="columnheader">对端目录结构</div>
          </div>

          <div v-if="visibleRows.length === 0" class="cmp-state">
            {{ onlyDiff ? '没有差异' : '两边都没有文件' }}
          </div>

          <div
            v-for="row in visibleRows"
            :key="row.path"
            class="cmp-row"
            :class="rowClass(row)"
            role="row"
          >
            <div
              class="cmp-cell"
              :title="sideTitle(row.left)"
              @dblclick="onRowDblClick(row)"
            >
              <template v-if="row.left">
                <span class="cmp-pad" :style="{ width: `${row.depth * 14}px` }" aria-hidden="true"></span>
                <span class="cmp-icon" aria-hidden="true">{{ row.isDir ? '▸' : '·' }}</span>
                <span class="cmp-name break">{{ row.name }}</span>
                <span v-if="row.left.deleted" class="cmp-tag">已删除</span>
              </template>
            </div>
            <div
              class="cmp-cell"
              :title="sideTitle(row.right)"
              @dblclick="onRowDblClick(row)"
            >
              <template v-if="row.right">
                <span class="cmp-pad" :style="{ width: `${row.depth * 14}px` }" aria-hidden="true"></span>
                <span class="cmp-icon" aria-hidden="true">{{ row.isDir ? '▸' : '·' }}</span>
                <span class="cmp-name break">{{ row.name }}</span>
                <span v-if="row.right.deleted" class="cmp-tag">已删除</span>
              </template>
            </div>
          </div>
        </div>

        <p class="cmp-hint">双击任意一侧的文件行，打开两侧内容对比（文本文件可逐块同步）</p>
      </template>
    </template>

    <FileDiffModal
      v-if="data"
      :open="fileOpen"
      :path="filePath"
      :data="fileData"
      :loading="fileLoading"
      :error="fileError"
      :device-id="data.deviceId"
      @close="closeFile"
      @sync="syncFile"
    />
  </div>
</template>
