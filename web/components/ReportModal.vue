<script setup lang="ts">
import { NButton } from 'naive-ui';
import { useToast } from '../composables/useToast';
import { copyText } from '../utils/clipboard';
import ModalShell from './ModalShell.vue';

/**
 * 对比报告弹窗 —— 替代原先页头上那颗「复制报告」按钮。
 *
 * 原先一点按钮文本就进了剪贴板,用户毫无预期(没见过要复制的是什么、复制成功与否
 * 全靠一条 toast)。现在改成「查看报告」:先在弹窗里看到完整报告,再自己决定复制 ——
 * 与运行日志弹窗(查看 + 复制)是同一个交互模式。
 *
 * 报告文本由调用方用 diffReportText() 算好传进来(弹窗不关心对比数据结构),
 * 空报告 = 按钮 disabled,不需要 loading/出错分支。
 */
const props = defineProps<{
  open: boolean;
  /** 报告正文(diffReportText 的产物,已是纯文本)。 */
  report: string;
  /** 标题右侧的目录路径(mono 截断),与对比页头部同源。 */
  folderPath: string;
}>();

const emit = defineEmits<{ close: [] }>();

const { showToast } = useToast();

async function copyReport(): Promise<void> {
  if (!props.report) return;
  const ok = await copyText(props.report);
  if (ok) {
    showToast('已复制报告到剪贴板', 'info');
  } else {
    showToast('复制失败，请手动选择文本复制', 'alert');
  }
}
</script>

<template>
  <!-- 目录路径放标题右侧(与日志弹窗同款「标题 + 右侧路径」);报告正文里也有完整路径,
       但标题行先给一眼「看的是哪个目录」的锚点,长路径截断后靠原生 title 看全。 -->
  <ModalShell
    :open="open"
    title="对比报告"
    :description="folderPath"
    description-mono
    wide
    @close="emit('close')"
  >
    <p class="modal-lead">与对比页同一份数据生成的纯文本报告，适合贴进对话或 issue。</p>
    <pre class="report-view mono">{{ report }}</pre>

    <template #footer>
      <n-button :disabled="!report" @click="copyReport">复制报告</n-button>
      <n-button type="primary" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>
</template>
