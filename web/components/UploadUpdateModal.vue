<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton } from 'naive-ui';
import { useStatusContext } from '../composables/statusContext';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

// 选包与预检状态在 useSelfUpdate 里(页面级拖入与这里共用同一份),本组件只当视图
const {
  upgrading,
  uploadFile,
  uploadInfo,
  uploadInspecting,
  uploadError,
  selectUploadFile,
  applyUpload,
} = useStatusContext();

const fileInput = ref<HTMLInputElement | null>(null);
/** 校验/升级期间不接受新的点击:避免误触把正在校验的包换掉。 */
const busy = computed(() => upgrading.value || uploadInspecting.value);

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function pickFile(): void {
  if (busy.value) return;
  fileInput.value?.click();
}

async function onPick(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const picked = input.files?.[0] ?? null;
  // 立刻清空 input:否则再次选中同一个文件不会触发 change
  input.value = '';
  if (picked) await selectUploadFile(picked);
}

function onConfirm(): void {
  if (!uploadFile.value || !uploadInfo.value || upgrading.value) return;
  // 成功路径不会返回:applyUpload 等到服务重启完成后整页刷新;失败写进 uploadError
  void applyUpload(uploadFile.value);
}
</script>

<template>
  <Transition name="guide">
    <div v-if="props.open" class="modal-overlay" @click.self="emit('close')">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="upload-update-title">
        <n-button quaternary circle class="modal-close" aria-label="关闭" @click="emit('close')">×</n-button>
        <h2 id="upload-update-title" class="modal-title">上传安装包升级</h2>
        <p class="modal-lead">
          选择本机 <code class="mono">npm run pack:local</code> 打出的 <code class="mono">.tgz</code>，
          或直接把文件拖到页面中间的投放区；校验通过后整包替换并自动重启 ——
          无需发布 npm 新版本即可在多台设备上验证构建。
        </p>

        <input
          ref="fileInput"
          class="upload-input"
          type="file"
          accept=".tgz,.tar.gz,application/gzip"
          @change="onPick"
        />
        <button type="button" class="upload-drop" :disabled="busy" @click="pickFile">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 16V4" />
            <path d="m7 9 5-5 5 5" />
            <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
          <span v-if="!uploadFile" class="upload-drop__main">点击选择安装包</span>
          <span v-else class="upload-drop__main mono">{{ uploadFile.name }}</span>
          <span class="upload-drop__sub mono">
            <template v-if="!uploadFile">syncx-&lt;版本&gt;.tgz</template>
            <template v-else>{{ fmtSize(uploadFile.size) }} · 点击可重新选择</template>
          </span>
        </button>

        <div v-if="uploadInspecting" class="history-loading">校验安装包中…</div>
        <div v-else-if="uploadError" class="logs-unavailable" role="alert">{{ uploadError }}</div>
        <div v-else-if="uploadInfo" class="upload-verdict">
          <div class="upload-verdict__row">
            <span class="upload-verdict__label">当前版本</span>
            <span class="mono">{{ uploadInfo.current || '未知' }}</span>
          </div>
          <div class="upload-verdict__row">
            <span class="upload-verdict__label">将升级到</span>
            <span class="mono upload-verdict__to">{{ uploadInfo.version }}</span>
          </div>
          <p v-if="uploadInfo.version === uploadInfo.current" class="confirm-note-extra confirm-note-extra--flush">
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
            :disabled="!uploadInfo || !!uploadError"
            :loading="upgrading || uploadInspecting"
            @click="onConfirm"
          >
            开始升级
          </n-button>
        </div>
      </div>
    </div>
  </Transition>
</template>
