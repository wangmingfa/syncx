<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NCheckbox, NCheckboxGroup, NSelect } from 'naive-ui';
import type { ConflictPolicy, DeviceInfo, FolderInfo, GitSyncMode, Schedule } from '../types';
import ModalShell from './ModalShell.vue';
import ScheduleRuleEditor from './ScheduleRuleEditor.vue';

const props = defineProps<{
  open: boolean;
  /** 正在编辑的目录(打开时预填当前指派与忽略开关,不直接改任何数据)。 */
  folder: FolderInfo | null;
  devices: DeviceInfo[];
  busy: boolean;
}>();
const emit = defineEmits<{
  close: [];
  /** 「保存」:设备指派、.gitignore 开关、同步时段、git 同步模式与冲突策略一起提交给父级,真正的写操作只有父级那一处。 */
  save: [payload: { path: string; devices: string[]; gitignore: boolean; schedule: Schedule | null; gitSync: GitSyncMode; conflictPolicy: ConflictPolicy; onDemand: boolean }];
}>();

const path = ref('');
const selected = ref<string[]>([]);
const gitignore = ref(true);
// 时段规则(undefined = 全天);编辑器自带「填一半不生效」的宽松语义,见 ScheduleRuleEditor
const schedule = ref<Schedule | undefined>(undefined);
const gitSync = ref<GitSyncMode>('off');
const conflictPolicy = ref<ConflictPolicy>('keep-both');
const onDemand = ref(false);

const GIT_SYNC_OPTIONS: { label: string; value: GitSyncMode }[] = [
  { label: '关闭', value: 'off' },
  { label: '仅发送(广播本机提交,不自动提交)', value: 'send' },
  { label: '仅接收(自动提交对端通知,不广播也不中继)', value: 'receive' },
  { label: '双向(广播本机提交,并自动提交、中继对端通知)', value: 'full' },
];

const CONFLICT_POLICY_OPTIONS: { label: string; value: ConflictPolicy }[] = [
  { label: '保留双方(默认,生成冲突副本)', value: 'keep-both' },
  { label: '新者胜(按修改时间覆盖旧内容)', value: 'newest-wins' },
  { label: '本机优先(本机内容始终保留)', value: 'local-wins' },
];

watch(
  () => props.folder,
  (f) => {
    if (!f) return;
    path.value = f.path;
    selected.value = [...f.devices];
    gitignore.value = f.useGitignore !== false;
    schedule.value = f.schedule;
    gitSync.value = f.gitSync ?? 'off';
    conflictPolicy.value = f.conflictPolicy ?? 'keep-both';
    onDemand.value = f.onDemand === true;
  },
);

function onSave(): void {
  if (props.busy || !props.folder) return;
  emit('save', { path: path.value, devices: [...selected.value], gitignore: gitignore.value, schedule: schedule.value ?? null, gitSync: gitSync.value, conflictPolicy: conflictPolicy.value, onDemand: onDemand.value });
}

// 地址(host:port)与主机名合并成一行,在设备 ID 之外提供可辨认的信息;两者都可能缺失
function deviceAddrLine(p: DeviceInfo): string {
  const addr = p.url ? (p.url.startsWith('ws://') ? p.url.slice(5) : p.url) : '';
  return [addr, p.hostname].filter(Boolean).join(' · ');
}
</script>

<template>
  <!-- 没有正在编辑的目录就不该开(只看 open 会渲染出一个空壳),条件投影给外壳 -->
  <ModalShell
    :open="open && !!folder"
    title="设置"
    :description="path"
    description-mono
    class="edit-folder-modal"
    @close="emit('close')"
  >
    <div class="edit-section-label">同步设备</div>
    <n-checkbox-group v-model:value="selected">
      <div v-if="devices.length > 0" class="device-checks">
        <n-checkbox v-for="d in devices" :key="d.deviceId" :value="d.deviceId">
          <span class="device-check-text">
            <span class="mono device-check-id">{{ d.deviceId }}</span>
            <span v-if="deviceAddrLine(d)" class="device-check-meta mono">{{ deviceAddrLine(d) }}</span>
          </span>
        </n-checkbox>
      </div>
      <p v-else class="confirm-note-extra confirm-note-extra--flush">还没有已配对的设备,先在「设备」栏添加。</p>
    </n-checkbox-group>
    <p class="confirm-note-extra">保存后,新加入的设备会立即收到共享邀请(在线时),被移除的设备不再同步此目录。</p>

    <div class="edit-section-label">忽略规则</div>
    <n-checkbox v-model:checked="gitignore" :disabled="busy">忽略 .gitignore 中的文件</n-checkbox>
    <p class="confirm-note-extra">勾选时,该目录内 .gitignore 命中的文件不参与同步(.syncxignore 优先级更高)。</p>

    <div class="edit-section-label">同步时段</div>
    <ScheduleRuleEditor v-model:model-value="schedule" />
    <p class="confirm-note-extra">
      留空 = 全天同步。时段外该目录数据面停摆(不扫描、不广播、不接收),到点自动恢复;连接与配对照常。
      与「设置 → 全局同步时段」取交集:全局是硬闸门,这里只能在其内再收窄。
      「工作日 / 休息日」按节假日日历判(设置里可配置来源与手动覆盖)。
    </p>

    <!-- label 右侧的实时警告:daemon 探测到目录不是 git 仓库时,先把「开关是空头支票」点破,
         不然绿色下拉选完、保存后毫无效果,用户只能困惑 -->
    <div class="edit-section-label">Git 提交同步<span v-if="folder?.gitRepo === false" class="label-warn">此目录不是 git 仓库,开关开启后也不会生效</span></div>
    <n-select
      v-model:value="gitSync"
      class="schedule-input"
      :options="GIT_SYNC_OPTIONS"
      :disabled="busy"
    />
    <p class="confirm-note-extra">
      目录为 git 仓库时生效:一端 commit 后通知其他设备,对端等同步过来的文件全部落地后,把本地全部改动一次性
      commit(<code>git add -A</code>)并沿用相同提交信息,无需每台设备手动提交;本机无待提交内容时跳过。
      提交会一跳一跳中继:自动提交成功的设备会把同一条通知转给它的其他对端,所以只与中间设备配对的机器也能收到提交。
      首次启用只记录当前 HEAD 作为基线,不会重放历史提交。
    </p>

    <div class="edit-section-label">冲突处理</div>
    <n-select
      v-model:value="conflictPolicy"
      class="schedule-input"
      :options="CONFLICT_POLICY_OPTIONS"
      :disabled="busy"
    />
    <p class="confirm-note-extra">
      两端同时修改同一文件时的自动裁决:保留双方 = 拉回对端版本、本机旧内容存为冲突副本(进冲突收件箱);
      新者胜 = 修改时间新的一方覆盖(跨机比较依赖各设备时钟,时钟漂移大时判定可能不准);
      本机优先 = 本机内容始终保留,对端自动拉取本机版本。任一时刻只影响「并发修改」,正常单向同步不受影响。
    </p>

    <div class="edit-section-label">按需同步</div>
    <n-checkbox v-model:checked="onDemand" :disabled="busy">对端新文件先不下载(占位)</n-checkbox>
    <p class="confirm-note-extra">
      小容量设备的省盘开关:开启后,对端推来的非空文件只同步索引(记全块哈希)、
      <strong>不在本机落盘</strong>,在文件管理器里显示为「未下载」,点「下载」才真正拉取内容。
      空文件照常即时落地;已占位的文件在关闭开关后仍保持占位,需要实体请手动下载。
    </p>

    <template #footer>
      <n-button class="modal-cancel" :disabled="busy" @click="emit('close')">取消</n-button>
      <n-button type="primary" :loading="busy" @click="onSave">保存</n-button>
    </template>
  </ModalShell>
</template>

<style scoped>
/* 「Git 提交同步」label 右侧的实时警告:类名仅本组件使用,故 scoped 成立。
   琥珀取 paused 徽标一族色值 —— 勾选之前就该看到,不能沿用「绿色 = 已启用」的开关语汇;
   深色主题跟随 paused 徽标同样提亮。 */
.label-warn {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 500;
  color: #c47c14;
}

html[data-theme='dark'] .label-warn {
  color: #e0a94a;
}
</style>
