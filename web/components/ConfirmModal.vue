<script setup lang="ts">
import { ref } from 'vue';
import { NButton } from 'naive-ui';
import type { ConfirmState } from '../types';

const props = defineProps<{
  /** 非空 = 弹出确认弹窗;确认前不触碰任何数据。 */
  state: ConfirmState | null;
  /** 轻提示(父级 useToast 提供),失败原因原样展示。 */
  notify: (msg: string, kind?: 'info' | 'alert') => void;
}>();
/** 成功时通知父级清空确认状态;失败保留弹窗便于取消或重试。 */
const emit = defineEmits<{ closed: [] }>();

const busy = ref(false);

async function runConfirm(): Promise<void> {
  const state = props.state;
  if (!state || busy.value) return;
  busy.value = true;
  try {
    await state.action();
    emit('closed');
  } catch (error) {
    // 失败时保留弹窗,便于取消或重试,不做任何数据假设;后端给的原因(如有)优先展示
    props.notify(error instanceof Error && error.message ? error.message : '操作失败,请重试');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Transition name="guide">
    <div v-if="state" class="modal-overlay" @click.self="!busy && emit('closed')">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <n-button quaternary circle class="modal-close" aria-label="关闭" :disabled="busy" @click="emit('closed')">×</n-button>
        <h2 id="confirm-title" class="modal-title">{{ state.title }}</h2>
        <p class="modal-lead">{{ state.message }}</p>
        <div v-if="state.detail" class="confirm-detail mono break">{{ state.detail }}</div>

        <template v-if="state.folders && state.folders.length > 0">
          <p class="confirm-sub">将从以下 {{ state.folders.length }} 个共享目录中移除它</p>
          <div class="confirm-list">
            <div v-for="fd in state.folders" :key="fd.path" class="confirm-row">
              <div class="confirm-row-main">
                <span class="confirm-path mono break">{{ fd.path }}</span>
                <span class="confirm-note">
                  {{ fd.others > 0 ? `还有 ${fd.others} 个设备 · 其他设备不受影响` : '仅共享给它 · 之后不再同步给任何设备' }}
                </span>
              </div>
              <span v-if="fd.others === 0" class="confirm-tag">变空闲</span>
            </div>
          </div>
        </template>

        <p v-if="state.note" class="confirm-note-extra">{{ state.note }}</p>
        <div class="modal-actions">
          <n-button class="modal-cancel" :disabled="busy" @click="emit('closed')">取消</n-button>
          <n-button type="error" class="modal-danger" :loading="busy" @click="runConfirm">
            {{ state.confirmText }}
          </n-button>
        </div>
      </div>
    </div>
  </Transition>
</template>
