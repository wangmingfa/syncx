<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';
import { errText } from '../utils/api';
import type { UploadPackageInfo } from '../types';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { upgrading, inspectUpload, applyUpload } = useStatusContext();

const fileInput = ref<HTMLInputElement | null>(null);
/** 已选中的安装包;null = 还没选。 */
const file = ref<File | null>(null);
/** 服务端只读预检结果;null = 尚未预检或预检失败。 */
const info = ref<UploadPackageInfo | null>(null);
const inspecting = ref(false);
const error = ref('');

/** 每次打开都复位:关掉再打开不该残留上一轮选中的包与结论。 */
watch(
  () => props.open,
  (open) => {
    if (open) reset();
  },
);

function reset(): void {
  file.value = null;
  info.value = null;
  error.value = '';
  inspecting.value = false;
  if (fileInput.value) fileInput.value.value = '';
}

/** 选包后立刻让服务端做只读预检:拿包内版本与当前版本做对比,失败原因原样展示。 */
async function onPick(e: Event): Promise<void> {
  const picked = (e.target as HTMLInputElement).files?.[0] ?? null;
  if (!picked) return;
  file.value = picked;
  info.value = null;
  error.value = '';
  inspecting.value = true;
  try {
    info.value = await inspectUpload(picked);
  } catch (e) {
    error.value = errText(e, '安装包校验失败');
  } finally {
    inspecting.value = false;
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function pickFile(): void {
  if (upgrading.value || inspecting.value) return;
  fileInput.value?.click();
}

async function onConfirm(): Promise<void> {
  if (!file.value || !info.value || upgrading.value) return;
  error.value = '';
  try {
    // 成功路径不会返回:applyUpload 等到服务重启完成后整页刷新
    await applyUpload(file.value);
  } catch (e) {
    error.value = errText(e, '升级失败');
  }
}
</script>

<template>
  <Transition name="guide">
    <div v-if="open" class="modal-overlay" @click.self="emit('close')">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="upload-update-title">
        <n-button quaternary circle class="modal-close" aria-label="关闭" @click="emit('close')">×</n-button>
        <h2 id="upload-update-title" class="modal-title">上传安装包升级</h2>
        <p class="modal-lead">
          选择本机 <code class="mono">npm run pack:local</code> 打出的 <code class="mono">.tgz</code>，
          校验通过后整包替换并自动重启 —— 无需发布 npm 新版本即可在多台设备上验证构建。
        </p>

        <input
          ref="fileInput"
          class="upload-input"
          type="file"
          accept=".tgz,.tar.gz,application/gzip"
          @change="onPick"
        />
        <button type="button" class="upload-drop" :disabled="upgrading || inspecting" @click="pickFile">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 16V4" />
            <path d="m7 9 5-5 5 5" />
            <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
          <span v-if="!file" class="upload-drop__main">点击选择安装包</span>
          <span v-else class="upload-drop__main mono">{{ file.name }}</span>
          <span class="upload-drop__sub mono">
            <template v-if="!file">syncx-&lt;版本&gt;-local.tgz</template>
            <template v-else>{{ fmtSize(file.size) }} · 点击可重新选择</template>
          </span>
        </button>

        <div v-if="inspecting" class="history-loading">校验安装包中…</div>
        <div v-else-if="error" class="logs-unavailable" role="alert">{{ error }}</div>
        <div v-else-if="info" class="upload-verdict">
          <div class="upload-verdict__row">
            <span class="upload-verdict__label">当前版本</span>
            <span class="mono">{{ info.current || '未知' }}</span>
          </div>
          <div class="upload-verdict__row">
            <span class="upload-verdict__label">将升级到</span>
            <span class="mono upload-verdict__to">{{ info.version }}</span>
          </div>
          <p v-if="info.version === info.current" class="confirm-note-extra confirm-note-extra--flush">
            与当前版本相同：将用这个包直接替换现有安装（用于验证新构建）。
          </p>
        </div>

        <p class="confirm-note-extra">
          升级会整包替换安装目录并重启服务，页面将短暂失去连接，完成后自动刷新；新进程若启动失败会自动回滚旧版本。
          请勿对源码仓库目录升级（服务端会直接拒绝，以免删除源码）。
        </p>

        <div class="modal-actions">
          <n-button class="modal-cancel" :disabled="upgrading" @click="emit('close')">取消</n-button>
          <n-button
            type="primary"
            :disabled="!info || !!error"
            :loading="upgrading || inspecting"
            @click="onConfirm"
          >
            开始升级
          </n-button>
        </div>
      </div>
    </div>
  </Transition>
</template>
