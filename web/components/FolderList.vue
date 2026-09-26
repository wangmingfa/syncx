<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton, NInput, NCheckbox, NCheckboxGroup, NTooltip } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';
import ActionRail from './ActionRail.vue';
import WeeklyReportModal from './WeeklyReportModal.vue';
import { folderPathPlaceholder, visibleTransferFiles, XFER_FILE_LIMIT } from '../utils/format';
import { outsideSchedule } from '../utils/schedule';
import type { RailAction } from '../utils/action-rail';
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
/** 该目录残留冲突副本数(索引 LIKE 计数,徽标只做量级提示;以收件箱实时扫盘为准)。 */
function conflictCountOf(f: FolderInfo): number {
  return status.value.conflictCounts?.[folderKey(f)] ?? 0;
}

/**
 * 「目录不可信」→ 重新采集身份的二次确认。文案按 kind 分级:
 * remounted(仅设备号变、inode 未变)大概率是重挂,语气给到"可以放心确认";
 * changed(inode 也变了)可能是换盘/重建,把风险说满,让用户先看内容再决定。
 */
function askReAdopt(f: FolderInfo): void {
  const kind = folderErrorOf(f)?.kind;
  askConfirm({
    title: '重新采集目录身份',
    message:
      kind === 'identity-remounted'
        ? '仅设备号变化、inode 未变:大概率是同一块盘重新挂载(重启 / 容器重启 / Android A/B 分区每次 OTA)。确认后将更新目录指纹并恢复同步,索引不受影响;本次的设备号会被记住,下次再变回它时不再询问。'
        : '目录身份与记录不符(换盘 / 目录被重建?)。请先确认该目录内容就是你要同步的数据 —— 确认后仅更新指纹,索引不受影响。',
    detail: f.path,
    confirmText: '确认并恢复同步',
    note: '若内容看起来不对(像是挂了别的盘),不要确认;接回正确的盘后下一轮扫描会自动恢复。',
    action: () => reAdoptIdentity(f),
  });
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
  openGlobalHistory,
  openConflicts,
  openVersions,
  openIgnoreEditor,
  openFiles,
  openDiff,
  toggleFolderPaused,
  toggleGlobalPaused,
  reAdoptIdentity,
  prioritizeFile,
  askConfirm,
  copy,
  hoverFolderKey,
  onFolderEnter,
  onFolderLeave,
  hoverDeviceId,
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

/**
 * 栏头动作(扫描全部 / 全局记录 / 全局暂停)收成数据交给 ActionRail,与目录卡同款
 * hover 展开 —— 收起只留一个「更多」占位图标,小屏不再挤一行按钮。
 * hover 范围是整栏(hover 目录卡也会顺带摊开栏头动作,与「hover 卡片展开」同构);
 * 点占位图标可钉住(触屏兜底),离开整栏一并复位。全局暂停没有目录可停,
 * 沿用原按钮的 conditions:无目录不给这个动作。
 */
const headHover = ref(false);
const headPinned = ref(false);
/** 同步周报弹窗开关:入口在栏头动作,弹窗本体挂在组件根部。 */
const reportOpen = ref(false);

function onHeadLeave(): void {
  headHover.value = false;
  headPinned.value = false;
}

const headActions = computed<RailAction[]>(() => {
  const b = busy.value;
  const actions: RailAction[] = [
    { key: 'rescan', icon: 'rescan', disabled: b, tooltip: '扫描全部目录', onClick: () => rescan() },
    { key: 'global-history', icon: 'history', tooltip: '全局同步记录:跨目录的归并时间线', onClick: () => openGlobalHistory() },
    { key: 'report', icon: 'report', tooltip: '同步周报:近 7 天变更趋势 / 目录贡献 / 冲突汇总', onClick: () => (reportOpen.value = true) },
  ];
  if (status.value.folders.length > 0) {
    actions.push({
      key: 'global-pause',
      icon: status.value.paused ? 'play' : 'pause',
      active: status.value.paused,
      disabled: b,
      tooltip: status.value.paused ? '恢复所有目录的同步' : '暂停所有目录的同步(连接保持在线)',
      onClick: () => toggleGlobalPaused(!status.value.paused),
    });
  }
  return actions;
});

/**
 * 目录卡的六个动作,收成数据交给 ActionRail。
 *
 * 每次渲染重新构造数组是有意的:禁用态与 tooltip 文案都跟着 `busy` / `f.paused` /
 * `f.devices.length` 变,写成 computed 反而要为每个目录建一份。`key` 稳定,
 * 所以展开动画过渡的始终是同一批 DOM 节点。
 */
function folderActions(f: FolderInfo): RailAction[] {
  const noPeer = f.devices.length === 0;
  const b = busy.value;
  return [
    {
      key: 'pause',
      icon: f.paused ? 'play' : 'pause',
      active: f.paused,
      disabled: b,
      tooltip: f.paused ? '恢复该目录的同步' : '暂停该目录的同步(连接保持在线)',
      onClick: () => toggleFolderPaused(f, !f.paused),
    },
    {
      key: 'files',
      icon: 'browse',
      disabled: b,
      tooltip: '浏览文件:查看本机目录内容,可下载单个文件或删除',
      onClick: () => openFiles(f),
    },
    {
      key: 'compare',
      icon: 'compare',
      disabled: b || noPeer,
      tooltip: noPeer ? '该目录还没有指派设备,无从对比' : '打开双栏对比:左右目录结构对齐,双击文件可看内容差异',
      onClick: () => openCompare(f),
    },
    {
      key: 'diff',
      icon: 'diff',
      disabled: b || noPeer,
      tooltip: noPeer ? '该目录还没有指派设备,无从对比' : '差异报告:实时取两端索引,按「冲突/待推送/待拉取…」分类',
      onClick: () => openDiff(f),
    },
    { key: 'history', icon: 'history', disabled: b, tooltip: '查看该目录的同步记录', onClick: () => openHistory(f) },
    {
      key: 'versions',
      icon: 'versions',
      disabled: b,
      tooltip: '查看文件版本:被对端覆盖修改前的旧内容会自动留档,可恢复或删除',
      onClick: () => openVersions(f),
    },
    {
      key: 'ignore',
      icon: 'ignore',
      disabled: b,
      tooltip: '忽略规则:编辑 .syncxignore,粘贴路径即可测试命中哪条规则',
      onClick: () => openIgnoreEditor(f),
    },
    {
      key: 'remove',
      icon: 'trash',
      danger: true,
      disabled: b,
      tooltip: '移除共享目录(磁盘文件不会被删除)',
      onClick: () => askRemoveFolder(f.path),
    },
  ];
}

/**
 * 触屏兜底:hover 在触屏上不可靠(且 :focus 是否随点击落住要看浏览器),
 * 所以点一下占位图标也把动作条钉住,离开卡片即复位。
 *
 * 展开条件与 `hoverFolderKey` 取并集 —— 那个 ref 是拓扑联动已经在维护的「当前悬停目录」,
 * 直接复用,不再另起一套 hover 状态。代价是两件事共用一个状态:将来若给拓扑联动加
 * 防抖之类,动作条会跟着一起变,改的人需要知道。
 */
const railPinned = ref('');

function onRailExpand(expanded: boolean, key: string): void {
  railPinned.value = expanded ? key : '';
}

function onCardLeave(): void {
  railPinned.value = '';
  onFolderLeave();
}

/**
 * 「传输中文件」列表的展开状态(按目录)。
 *
 * 默认只显示前 5 条:后端 files 无条数上限(整目录首批同步可能上千条),全渲染会把卡片撑得极高、
 * 把并列的设备列甩到屏幕外。用**替换 Set** 而非原地 add/delete,改动必然触发响应式重渲染。
 */
const xferExpanded = ref<Set<string>>(new Set());

function isXferExpanded(f: FolderInfo): boolean {
  return xferExpanded.value.has(folderKey(f));
}

function toggleXferExpand(f: FolderInfo): void {
  const next = new Set(xferExpanded.value);
  const key = folderKey(f);
  if (!next.delete(key)) next.add(key);
  xferExpanded.value = next;
}

/** 该目录当前要渲染的传输文件:展开时全部,收起时前 5 条。 */
function visibleFiles(f: FolderInfo): TransferFile[] {
  return visibleTransferFiles(progressOf(f)?.files ?? [], isXferExpanded(f));
}
</script>

<template>
  <section class="col col--folders" @mouseenter="headHover = true" @mouseleave="onHeadLeave">
    <!-- 全局暂停徽标:与目录卡的暂停徽标同款,贴在栏容器顶缘右上角;
         电源守卫(计费网络/低电量)自动挂起优先级更高,原因放 title 里 -->
    <span
      v-if="status.powerGuard || status.paused"
      class="float-badge paused-badge col-paused"
      :title="status.powerGuard ? `${status.powerGuard}:电源守卫已自动挂起所有目录同步,条件解除自动恢复;连接与配对照常` : '全局已暂停:所有目录不扫描、不广播、不接收;连接与配对照常'"
    >{{ status.powerGuard ? '自动挂起' : '已暂停' }}</span>
    <div class="col-head">
      <!-- 标题+徽标绑成一组(.col-head__lead):窄屏 wrap 时两者同进退,
           徽标不会单独掉进按钮行;手机上 lead 整行独占,按钮组落到第二行(见 style.css) -->
      <div class="col-head__lead">
        <span>共享目录</span>
        <span class="badge">{{ status.folders.length }}</span>
      </div>
      <!-- 栏头动作收进 ActionRail(与目录卡同款):收起只留一个「更多」图标,
           hover 栏头摊开;省空间,小屏不再挤一行文字按钮 -->
      <ActionRail
        :actions="headActions"
        :expanded="headHover || headPinned"
        direction="right"
        label="目录栏操作"
        @update:expanded="headPinned = $event"
      />
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
      :class="{ 'is-linked': hoverFolderKey === folderKey(f) || (hoverDeviceId !== '' && f.devices.includes(hoverDeviceId)) }"
      @mouseenter="onFolderEnter(f)"
      @mouseleave="onCardLeave"
    >
      <!-- 状态悬浮标签:贴在卡片顶缘外侧,不占标题行空间(内联徽标会让标题与按钮
           整行横移,切换时卡片内容左右跳)。多个共用一个容器 → 同时命中时并排而不打架;
           容器 pointer-events:none 让空隙鼠标穿透到下方按钮,单个徽标可命中以显示
           title 说明(「接收」没有专属操作按钮,只能靠徽标自身的 tooltip 解释)。
           「冲突 N」做成按钮:徽标本身就是收件箱入口,点它直接处理。 -->
      <div v-if="f.receiveOnly || f.paused || outsideSchedule(f) || conflictCountOf(f) > 0" class="card-floats">
        <span v-if="f.receiveOnly" class="float-badge receive-badge" title="接收模式:只拉不推,本机改动不会同步出去">接收</span>
        <span v-if="f.paused" class="float-badge paused-badge" title="已暂停:不扫描、不广播、不接收;连接与配对照常">已暂停</span>
        <span v-if="outsideSchedule(f)" class="float-badge paused-badge" :title="`同步时段外(${f.schedule}),到点自动恢复;连接与配对照常`">时段外</span>
        <button
          v-if="conflictCountOf(f) > 0"
          type="button"
          class="float-badge conflict-float"
          :title="`${conflictCountOf(f)} 个冲突副本待处理:两边都改过同一文件,点开逐条选保留哪版`"
          @click="openConflicts(f)"
        >冲突 {{ conflictCountOf(f) }}</button>
      </div>

      <div class="item-top">
        <span class="avatar" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
        </span>
        <span class="item-title">{{ f.path }}</span>
        <!-- 操作成组(.item-actions):窄屏下整组一起落到标题下一行,而不是逐个换行
             留单个按钮孤零零占一行 —— 与设备卡同一套策略。
             六个动作收成数据交给 ActionRail:收起只留一个「更多」占位图标,hover 卡片时摊开。 -->
        <div class="item-actions">
          <ActionRail
            :actions="folderActions(f)"
            :expanded="hoverFolderKey === folderKey(f) || railPinned === folderKey(f)"
            label="目录操作"
            @update:expanded="onRailExpand($event, folderKey(f))"
          />
        </div>
      </div>

      <!-- 目录 ID:跨机同步需两边配置同一 ID 才能对上 -->
      <div class="fid-row">
        <span class="fid-label">目录 ID</span>
        <code class="fid-code break">{{ f.id ?? f.path }}</code>
        <n-tooltip trigger="hover" :style="{ maxWidth: '280px' }">
          <template #trigger>
            <span class="icon-btn">
              <n-button size="small" quaternary circle @click="copy(f.id ?? f.path)">
                <template #icon>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                  </svg>
                </template>
              </n-button>
            </span>
          </template>
          复制目录 ID
        </n-tooltip>
      </div>

      <!-- 同步错误横幅:该目录最近一次同步失败的原因(扫描干净后自动消失) -->
      <div v-if="folderErrorOf(f)" class="folder-error" :class="{ 'folder-error--identity': folderErrorOf(f)!.kind?.startsWith('identity') }" role="alert">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="folder-error__icon">
          <path d="M12 3 2.5 20h19z" />
          <line x1="12" y1="10" x2="12" y2="14" />
          <line x1="12" y1="17" x2="12" y2="17.1" />
        </svg>
        <div class="folder-error__body">
          <div class="folder-error__msg break">{{ folderErrorOf(f)!.message }}</div>
          <div class="folder-error__time">
            {{ fmtTime(folderErrorOf(f)!.ts) }} ·
            {{ folderErrorOf(f)!.kind === 'identity-missing' ? '接回正确的盘后下一轮扫描自动恢复' : folderErrorOf(f)!.kind?.startsWith('identity') ? '需人工确认,不会自动恢复' : folderErrorOf(f)!.kind === 'disk-space' ? '释放磁盘空间后自动恢复接收' : '下一轮扫描成功后自动清除' }}
          </div>
        </div>
        <!-- 身份不符(非"目录读不到")才给轻量恢复入口:只更新指纹、不动索引;
             missing 挂的可能是空目录/别的盘,绝不能一键确认,接回正确的盘自愈 -->
        <n-button
          v-if="folderErrorOf(f)!.kind === 'identity-changed' || folderErrorOf(f)!.kind === 'identity-remounted'"
          size="tiny"
          class="folder-error__adopt"
          :disabled="busy"
          @click="askReAdopt(f)"
        >重新采集身份</n-button>
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
        <n-tooltip trigger="hover" :style="{ maxWidth: '280px' }">
          <template #trigger>
            <span class="icon-btn">
              <n-button size="small" quaternary circle :disabled="busy" @click="openEditDevices(f)">
                <template #icon>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <line x1="4" y1="8" x2="20" y2="8" />
                    <circle cx="9" cy="8" r="2" />
                    <line x1="4" y1="16" x2="20" y2="16" />
                    <circle cx="15" cy="16" r="2" />
                  </svg>
                </template>
              </n-button>
            </span>
          </template>
          编辑设备指派
        </n-tooltip>
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
          <li v-for="tf in visibleFiles(f)" :key="tf.path" class="xfer-file">
            <span class="xfer-file__dir" :title="tf.direction === 'receive' ? '下载中' : '上传中'">{{ tf.direction === 'receive' ? '↓' : '↑' }}</span>
            <span class="xfer-file__name" :title="tf.path">{{ basename(tf.path) }}</span>
            <span class="xfer-file__pct">{{ filePercent(tf) }}%</span>
            <!-- 「优先同步」:让对端把该文件的块插到其限速发送队列最前(幂等,仅接收方向可提) -->
            <button
              v-if="tf.direction === 'receive'"
              class="xfer-file__prio"
              :class="{ 'is-on': tf.priority }"
              :title="tf.priority ? '已优先:对端正把它的块插队发送' : '优先同步:插队到对端发送队列最前'"
              :aria-label="tf.priority ? '已优先同步' : '优先同步'"
              @click="prioritizeFile(f, tf.path)"
            >▲</button>
            <div class="progress-bar xfer-file__bar">
              <div class="progress-fill" :style="{ width: filePercent(tf) + '%' }"></div>
            </div>
          </li>
        </ul>
        <!-- 超过 5 条才出现:收起时只展示前 5 条,避免长列表把卡片撑高、把并列的设备列甩出屏幕 -->
        <n-button
          v-if="progressOf(f)!.files && progressOf(f)!.files!.length > XFER_FILE_LIMIT"
          size="tiny"
          quaternary
          class="xfer-more"
          :aria-expanded="isXferExpanded(f)"
          @click="toggleXferExpand(f)"
        >
          {{ isXferExpanded(f) ? '收起' : `查看全部 ${progressOf(f)!.files!.length} 个文件` }}
          <span class="xfer-more__chev" :class="{ 'is-open': isXferExpanded(f) }" aria-hidden="true">
            <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2.5 4.5 6 8l3.5-3.5" />
            </svg>
          </span>
        </n-button>
      </div>
    </div>
  </section>

  <!-- 同步周报:入口在栏头动作;弹窗本体就近挂在组件尾(ModalShell 自带遮罩定位) -->
  <WeeklyReportModal :open="reportOpen" @close="reportOpen = false" />
</template>
