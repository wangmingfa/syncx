<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NCheckbox, NCheckboxGroup, NInput } from 'naive-ui';
import type { DeviceInfo, FolderInfo } from '../types';
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
  /** 「保存」:设备指派、.gitignore 开关与同步时段一起提交给父级,真正的写操作只有父级那一处。 */
  save: [payload: { path: string; devices: string[]; gitignore: boolean; schedule: string }];
}>();

const path = ref('');
const selected = ref<string[]>([]);
const gitignore = ref(true);
const schedule = ref('');

watch(
  () => props.folder,
  (f) => {
    if (!f) return;
    path.value = f.path;
    selected.value = [...f.devices];
    gitignore.value = f.useGitignore !== false;
    schedule.value = f.schedule ?? '';
  },
);

function onSave(): void {
  if (props.busy || !props.folder) return;
  emit('save', { path: path.value, devices: [...selected.value], gitignore: gitignore.value, schedule: schedule.value.trim() });
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
    <n-input
      v-model:value="schedule"
      class="schedule-input"
      placeholder="如 22:00-08:00;留空 = 全天同步"
      :disabled="busy"
      @keydown.enter="onSave"
    />
    <p class="confirm-note-extra">只在该时段内同步(支持跨午夜),时段外数据面停摆、到点自动恢复;控制面(连接 / 配对)不受影响。</p>

    <template #footer>
      <n-button class="modal-cancel" :disabled="busy" @click="emit('close')">取消</n-button>
      <n-button type="primary" :loading="busy" @click="onSave">保存</n-button>
    </template>
  </ModalShell>
</template>
