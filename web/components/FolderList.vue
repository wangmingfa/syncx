<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NInput, NCheckbox, NCheckboxGroup, NTooltip } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';
import { folderPathPlaceholder } from '../utils/format';
import type { FolderInfo, TransferFile } from '../types';

/**
 * 卡片上的「对比」跳到双栏对比页,而不是开一个弹窗。
 *
 * 目录 id 放进路径(`/compare/<id>`):链接可分享、可刷新、可用浏览器后退回来;
 * 对比设备到页面上再选(首次进入默认选第一个指派设备)。
 */
function openCompare(f: FolderInfo): void {
  const url = `/compare/${encodeURIComponent(folderKey(f))}`;
  // 新窗口打开双栏对比页:同域共享会话 cookie,API 鉴权照常生效;
  // 对比与状态页互不遮挡,可一边看差异一边在状态页操作。
  window.open(url, '_blank', 'noopener');
}

/** 路径取文件名(共享根内的相对路径,用 / 分隔)。 */
function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}
/** 传输百分比(0–100);总字节未知或 0 时记 0。 */
function filePercent(f: TransferFile): number {
  if (!f.bytesTotal) return 0;
  return Math.max(0, Math.min(100, Math.round((f.bytesDone / f.bytesTotal) * 100)));
}

const {
  status,
  busy,
  rescan,
  addFolderOpen,
  toggleAddFolder,
  newPath,
  newFolderId,
  newFolderDevices,
  newFolderReceiveOnly,
  addFolder,
  askRemoveFolder,
  openEditDevices,
  openHistory,
  copy,
  hoverFolderKey,
  onFolderEnter,
  onFolderLeave,
  folderKey,
  deviceTagStatus,
  deviceTagTip,
  progressOf,
  isActive,
  progressText,
  folderErrorOf,
  fmtTime,
  deviceAddrLine,
} = useStatusContext();

/** 路径示例按 daemon 平台给(Windows 显示 F:\shared\docs),避免在 Windows 上提示 POSIX 路径。 */
const pathPlaceholder = computed(() => folderPathPlaceholder(status.value.platform));
</script>

<template>
  <section class="col col--folders">
    <div class="col-head">
      <span>共享目录</span>
      <span class="badge">{{ status.folders.length }}</span>
      <n-button :disabled="busy" @click="rescan">扫描全部</n-button>
      <n-button v-if="status.folders.length > 0" class="add-toggle" :class="{ 'is-invisible': addFolderOpen }" :disabled="busy" :tabindex="addFolderOpen ? -1 : 0" @click="toggleAddFolder">＋ 添加</n-button>
    </div>

    <!-- 添加共享目录:头部按钮触发展开;列表为空时表单常显 -->
    <form v-if="addFolderOpen || status.folders.length === 0" class="add-form" @submit.prevent="addFolder">
      <!-- 输入框与它的提示包成一组:.add-form 的 flex gap 会插进两者之间(8px gap + 4px margin
           叠成 12px),而到下一个字段只有 8px —— 提示反而离自己的字段更远,被读成下方字段的 label -->
      <div class="add-field">
        <n-input v-model:value="newPath" :placeholder="pathPlaceholder" />
        <p class="form-hint">目录不存在时会自动创建</p>
      </div>
      <n-input v-model:value="newFolderId" placeholder="目录 ID(留空自动生成;跨机同步需与对方一致)" />
      <n-checkbox-group v-model:value="newFolderDevices">
        <div v-if="status.devices.length > 0" class="device-checks">
          <n-checkbox v-for="d in status.devices" :key="d.deviceId" :value="d.deviceId">
            <span class="device-check-text">
              <span class="mono device-check-id">{{ d.deviceId }}</span>
              <span v-if="deviceAddrLine(d)" class="device-check-meta mono">{{ deviceAddrLine(d) }}</span>
            </span>
          </n-checkbox>
        </div>
        <p v-else class="confirm-note-extra confirm-note-extra--flush">还没有已配对的设备,可先添加目录,稍后在卡片上指派。</p>
      </n-checkbox-group>
      <n-checkbox v-model:checked="newFolderReceiveOnly" class="ro-check">
        接收模式(只拉不推):只从对端拉取变更,不把本地改动同步出去
      </n-checkbox>
      <div class="add-form-actions">
        <n-button quaternary :disabled="busy" @click="toggleAddFolder">取消</n-button>
        <n-button type="primary" attr-type="submit" :disabled="busy">添加</n-button>
      </div>
    </form>

    <div v-if="status.folders.length === 0" class="empty">还没有共享目录 · 在上方添加第一个</div>
    <div
      v-for="f in status.folders"
      :key="folderKey(f)"
      class="item-card"
      :class="{ 'is-linked': hoverFolderKey === folderKey(f) }"
      @mouseenter="onFolderEnter(f)"
      @mouseleave="onFolderLeave"
    >
      <div class="item-top">
        <span class="avatar" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
        </span>
        <span class="item-title">{{ f.path }}</span>
        <span v-if="f.receiveOnly" class="ro-badge" title="接收模式:只拉不推,本机改动不会同步出去">接收</span>
        <n-button
          size="small"
          tertiary
          :disabled="busy || f.devices.length === 0"
          :title="f.devices.length === 0 ? '该目录还没有指派设备,无从对比' : '打开双栏对比:左右目录结构对齐,双击文件可看内容差异'"
          @click="openCompare(f)"
        >对比</n-button>
        <n-button size="small" tertiary :disabled="busy" @click="openHistory(f)">记录</n-button>
        <n-button
          size="small"
          type="error"
          tertiary
          :disabled="busy"
          @click="askRemoveFolder(f.path)"
        >移除</n-button>
      </div>

      <!-- 目录 ID:跨机同步需两边配置同一 ID 才能对上 -->
      <div class="fid-row">
        <span class="fid-label">目录 ID</span>
        <code class="fid-code break">{{ f.id ?? f.path }}</code>
        <n-button size="small" tertiary @click="copy(f.id ?? f.path)">复制</n-button>
      </div>

      <!-- 同步错误横幅:该目录最近一次同步失败的原因(扫描干净后自动消失) -->
      <div v-if="folderErrorOf(f)" class="folder-error" role="alert">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="folder-error__icon">
          <path d="M12 3 2.5 20h19z" />
          <line x1="12" y1="10" x2="12" y2="14" />
          <line x1="12" y1="17" x2="12" y2="17.1" />
        </svg>
        <div class="folder-error__body">
          <div class="folder-error__msg break">{{ folderErrorOf(f)!.message }}</div>
          <div class="folder-error__time">{{ fmtTime(folderErrorOf(f)!.ts) }} · 下一轮扫描成功后自动清除</div>
        </div>
      </div>

      <!-- 按目录指派可同步的设备:卡片上只读展示,点「编辑」弹窗修改后显式保存 -->
      <div class="fid-devices">
        <div class="device-tags">
          <n-tooltip v-for="d in f.devices" :key="d" trigger="hover" :style="{ maxWidth: '280px' }">
            <template #trigger>
              <span class="device-tag mono" :class="`is-${deviceTagStatus(f, d).key}`">{{ d }}</span>
            </template>
            {{ deviceTagTip(f, d) }}
          </n-tooltip>
          <span v-if="f.devices.length === 0" class="device-tag device-tag-empty">未指派设备</span>
        </div>
        <n-button size="small" tertiary :disabled="busy" @click="openEditDevices(f)">设置</n-button>
      </div>

      <div v-if="progressOf(f)" class="item-progress">
        <div class="progress-bar">
          <div
            class="progress-fill"
            :class="{ 'is-flowing': isActive(progressOf(f)!) }"
            :style="isActive(progressOf(f)!) ? '' : 'width:100%'"
          ></div>
        </div>
        <div class="item-sub">{{ progressText(progressOf(f)!) }}</div>
        <ul v-if="progressOf(f)!.files && progressOf(f)!.files!.length" class="xfer-files">
          <li v-for="tf in progressOf(f)!.files!" :key="tf.path" class="xfer-file">
            <span class="xfer-file__dir" :title="tf.direction === 'receive' ? '下载中' : '上传中'">{{ tf.direction === 'receive' ? '↓' : '↑' }}</span>
            <span class="xfer-file__name" :title="tf.path">{{ basename(tf.path) }}</span>
            <span class="xfer-file__pct">{{ filePercent(tf) }}%</span>
            <div class="progress-bar xfer-file__bar">
              <div class="progress-fill" :style="{ width: filePercent(tf) + '%' }"></div>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
