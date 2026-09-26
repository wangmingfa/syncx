<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NCheckbox, NCheckboxGroup, NInput } from 'naive-ui';
import { apiPost, errText } from '../utils/api';
import { useStatusContext } from '../composables/statusContext';
import ModalShell from './ModalShell.vue';
import type { FolderInfo } from '../types';

/**
 * 端到端加密设置(不可信节点)。
 *
 * v1 语义:口令派生的密钥只存本机 daemon 内存/配置(口令本身不落盘);
 * 被标记「不可信」的设备只能收到**密文视图** —— 路径与内容在发出前加密,
 * 盲区节点永不回源明文。凭口令可从盲区磁盘还原(recoverFile)。
 *
 * 口令框是**只写**的:已设置时留空 = 保持不变,勾选「清除口令」才下发清空;
 * 不可信节点勾选任何时候都可改(前提是口令已设或将设)。
 */
const props = defineProps<{
  /** 非空 = 打开该目录的端到端加密设置弹窗。 */
  folder: FolderInfo | null;
  notify: (msg: string, kind?: 'info' | 'alert') => void;
  /** 设置变更后重建盲区通道,通知父级刷新状态。 */
  changed: () => void;
}>();
const emit = defineEmits<{ close: [] }>();

const { status } = useStatusContext();

const passphrase = ref('');
const clearing = ref(false);
const untrusted = ref<string[]>([]);
const saving = ref(false);

const keySet = computed(() => props.folder?.e2eKeySet === true);

/** 该目录已指派的设备(勾选框数据源);hostname 缺省(旧版对端)退回 id。 */
const deviceOptions = computed(() => {
  const f = props.folder;
  if (!f) return [];
  const byId = new Map(status.value.devices.map((d) => [d.deviceId, d]));
  return f.devices.map((id) => ({
    id,
    label: byId.get(id)?.hostname ? `${byId.get(id)!.hostname}(${id})` : id,
    online: byId.get(id)?.online === true,
  }));
});

watch(
  () => props.folder,
  (f) => {
    passphrase.value = '';
    clearing.value = false;
    untrusted.value = [...(f?.e2eUntrusted ?? [])];
  },
);

function folderId(): string {
  const f = props.folder;
  return f ? f.id ?? f.path : '';
}

async function save(): Promise<void> {
  const body: { folderId: string; passphrase?: string; untrusted?: string[] } = {
    folderId: folderId(),
  };
  // 口令三态:勾选清除 → 下发空串(后端 = 清密钥+清不可信名单);
  // 填了新口令 → 校验长度后下发;留空未勾选 → 不带该键(保持不变)。
  if (clearing.value) {
    body.passphrase = '';
  } else if (passphrase.value !== '') {
    if (passphrase.value.length < 4) {
      props.notify('端到端口令至少 4 字符', 'alert');
      return;
    }
    body.passphrase = passphrase.value;
  } else if (!keySet.value && untrusted.value.length > 0) {
    props.notify('请先设置端到端口令,再标记不可信节点', 'alert');
    return;
  }
  body.untrusted = untrusted.value;
  saving.value = true;
  try {
    await apiPost('/api/folders/e2e', body);
    props.notify('端到端加密设置已保存(盲区通道已重建)');
    props.changed();
    emit('close');
  } catch (e) {
    props.notify(errText(e, '保存端到端加密设置失败'), 'alert');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <ModalShell
    :open="!!folder"
    title="端到端加密"
    :description="folder?.path ?? ''"
    description-mono
    @close="emit('close')"
  >
    <p class="modal-lead">
      给「不可信备份节点」开的密文通道:路径与内容在发出前用口令派生的密钥加密,
      盲区设备只存密文块、永不回源明文;凭口令可从盲区磁盘还原文件。
      注意:文件名长度与文件大小仍会泄露(密文路径是单段不可读文件名),口令本身不落盘、遗失无法找回。
    </p>

    <div class="e2e-field">
      <label class="e2e-label">口令</label>
      <n-input
        v-model:value="passphrase"
        type="password"
        show-password-on="click"
        :disabled="clearing"
        :placeholder="keySet ? '已设置(留空保持不变)' : '设置口令(至少 4 字符)'"
      />
      <label v-if="keySet" class="e2e-clear">
        <n-checkbox v-model:checked="clearing">清除口令(同时解除全部不可信标记,盲区通道关闭)</n-checkbox>
      </label>
      <p v-else class="e2e-hint muted">口令只在派生密钥时使用,不会写入配置文件;请妥善保管 —— 遗失将无法从盲区还原。</p>
    </div>

    <div v-if="!clearing" class="e2e-field">
      <label class="e2e-label">不可信节点</label>
      <p class="e2e-hint muted">勾选的设备只会收到该目录的密文视图(只出不进);取消勾选即恢复明文同步。</p>
      <n-checkbox-group v-if="deviceOptions.length" v-model:value="untrusted">
        <div v-for="d in deviceOptions" :key="d.id" class="e2e-device">
          <n-checkbox :value="d.id" :label="d.label" />
          <span class="e2e-device__state muted">{{ d.online ? '在线' : '离线' }}</span>
        </div>
      </n-checkbox-group>
      <p v-else class="e2e-hint muted">该目录还没有指派设备,先在「编辑设备」里共享目录后再来标记。</p>
    </div>

    <template #footer>
      <n-button @click="emit('close')">取消</n-button>
      <n-button type="primary" :loading="saving" @click="save">保存</n-button>
    </template>
  </ModalShell>
</template>

<style scoped>
.e2e-field {
  margin-top: 14px;
}
.e2e-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}
.e2e-clear {
  display: block;
  margin-top: 8px;
}
.e2e-hint {
  margin: 6px 0;
  font-size: 12px;
}
.e2e-device {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.e2e-device__state {
  font-size: 12px;
}
</style>
