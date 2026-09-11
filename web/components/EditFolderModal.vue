<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NCheckbox, NCheckboxGroup } from 'naive-ui';
import type { DeviceInfo, FolderInfo } from '../types';

const props = defineProps<{
  open: boolean;
  /** 正在编辑的目录(打开时预填当前指派与忽略开关,不直接改任何数据)。 */
  folder: FolderInfo | null;
  devices: DeviceInfo[];
  busy: boolean;
}>();
const emit = defineEmits<{
  close: [];
  /** 「保存」:设备指派与 .gitignore 开关一起提交给父级,真正的写操作只有父级那一处。 */
  save: [payload: { path: string; devices: string[]; gitignore: boolean }];
}>();

const path = ref('');
const selected = ref<string[]>([]);
const gitignore = ref(true);

watch(
  () => props.folder,
  (f) => {
    if (!f) return;
    path.value = f.path;
    selected.value = [...f.devices];
    gitignore.value = f.useGitignore !== false;
  },
);

function onSave(): void {
  if (props.busy || !props.folder) return;
  emit('save', { path: path.value, devices: [...selected.value], gitignore: gitignore.value });
}

// 地址(host:port)与主机名合并成一行,在设备 ID 之外提供可辨认的信息;两者都可能缺失
function deviceAddrLine(p: DeviceInfo): string {
  const addr = p.url ? (p.url.startsWith('ws://') ? p.url.slice(5) : p.url) : '';
  return [addr, p.hostname].filter(Boolean).join(' · ');
}
</script>

<template>
  <Transition name="guide">
    <div v-if="open && folder" class="modal-overlay" @click.self="emit('close')">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="edit-devices-title">
        <n-button quaternary circle class="modal-close" aria-label="关闭" @click="emit('close')">×</n-button>
        <div class="modal-title-row">
          <h2 id="edit-devices-title" class="modal-title">设置</h2>
          <span class="modal-title-path mono" :title="path">{{ path }}</span>
        </div>

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

        <div class="modal-actions">
          <n-button class="modal-cancel" :disabled="busy" @click="emit('close')">取消</n-button>
          <n-button type="primary" :loading="busy" @click="onSave">保存</n-button>
        </div>
      </div>
    </div>
  </Transition>
</template>
