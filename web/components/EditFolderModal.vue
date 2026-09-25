<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NCheckbox, NCheckboxGroup, NSelect, NTimePicker } from 'naive-ui';
import type { DeviceInfo, FolderInfo, GitSyncMode } from '../types';
import ModalShell from './ModalShell.vue';

const props = defineProps<{
  open: boolean;
  /** 正在编辑的目录(打开时预填当前指派与忽略开关,不直接改任何数据)。 */
  folder: FolderInfo | null;
  devices: DeviceInfo[];
  busy: boolean;
}>();
const emit = defineEmits<{
  close: [];
  /** 「保存」:设备指派、.gitignore 开关、同步时段与 git 同步模式一起提交给父级,真正的写操作只有父级那一处。 */
  save: [payload: { path: string; devices: string[]; gitignore: boolean; schedule: string; gitSync: GitSyncMode }];
}>();

const path = ref('');
const selected = ref<string[]>([]);
const gitignore = ref(true);
// 时段拆成开始/结束两个时间戳(n-time-picker 的 value 是毫秒时间戳),保存时再拼回
// 后端约定的 `HH:MM-HH:MM` 字符串;两端都空 = 全天同步。
const scheduleFrom = ref<number | null>(null);
const scheduleTo = ref<number | null>(null);
const gitSync = ref<GitSyncMode>('off');

const GIT_SYNC_OPTIONS: { label: string; value: GitSyncMode }[] = [
  { label: '关闭', value: 'off' },
  { label: '仅发送(广播本机提交,不自动提交)', value: 'send' },
  { label: '仅接收(自动提交对端通知,不广播)', value: 'receive' },
  { label: '双向(广播本机提交,并自动提交对端通知)', value: 'full' },
];

watch(
  () => props.folder,
  (f) => {
    if (!f) return;
    path.value = f.path;
    selected.value = [...f.devices];
    gitignore.value = f.useGitignore !== false;
    const [from, to] = (f.schedule ?? '').split('-');
    scheduleFrom.value = parseScheduleTime(from ?? '');
    scheduleTo.value = parseScheduleTime(to ?? '');
    gitSync.value = f.gitSync ?? 'off';
  },
);

/** `HH:MM`(小时可一位数)→ 当日该时刻的时间戳;空串/非法返回 null。 */
function parseScheduleTime(part: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(part.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return new Date(2000, 0, 1, Number(m[1]), Number(m[2])).getTime();
}

/** 时间戳 → 两位 `HH:MM`,用于拼回后端约定的时段字符串。 */
function formatScheduleTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 只填了一端:拼不出合法时段,禁止保存并提示。 */
const scheduleIncomplete = computed(() => (scheduleFrom.value === null) !== (scheduleTo.value === null));

function onSave(): void {
  if (props.busy || !props.folder || scheduleIncomplete.value) return;
  const schedule =
    scheduleFrom.value !== null && scheduleTo.value !== null
      ? `${formatScheduleTime(scheduleFrom.value)}-${formatScheduleTime(scheduleTo.value)}`
      : '';
  emit('save', { path: path.value, devices: [...selected.value], gitignore: gitignore.value, schedule, gitSync: gitSync.value });
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
    <!-- n-time-picker 不支持区间,用开始/结束两个选择器表达,天然支持跨午夜 -->
    <div class="schedule-pickers">
      <n-time-picker
        v-model:value="scheduleFrom"
        class="schedule-picker"
        format="HH:mm"
        placeholder="开始时间"
        clearable
        :disabled="busy"
      />
      <span class="schedule-sep">至</span>
      <n-time-picker
        v-model:value="scheduleTo"
        class="schedule-picker"
        format="HH:mm"
        placeholder="结束时间"
        clearable
        :disabled="busy"
      />
    </div>
    <p class="confirm-note-extra">
      两端都留空 = 全天同步;只在该时段内同步(支持跨午夜),时段外数据面停摆、到点自动恢复,控制面(连接 / 配对)不受影响。
    </p>
    <p v-if="scheduleIncomplete" class="confirm-note-extra schedule-incomplete">开始与结束需同时设置,或都留空。</p>

    <div class="edit-section-label">Git 提交同步</div>
    <n-select
      v-model:value="gitSync"
      class="schedule-input"
      :options="GIT_SYNC_OPTIONS"
      :disabled="busy"
    />
    <p class="confirm-note-extra">
      目录为 git 仓库时生效:一端 commit 后通知其他设备,对端把本地全部改动一次性
      commit(<code>git add -A</code>)并沿用相同提交信息,无需每台设备手动提交。
      首次启用只记录当前 HEAD 作为基线,不会重放历史提交。
    </p>

    <template #footer>
      <n-button class="modal-cancel" :disabled="busy" @click="emit('close')">取消</n-button>
      <n-button type="primary" :loading="busy" :disabled="scheduleIncomplete" @click="onSave">保存</n-button>
    </template>
  </ModalShell>
</template>
