<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import { applyHunk, countChanged, diffText, type DiffHunk } from '../utils/text-diff';
import type { FileCompareData, FileSideData } from '../types';

/**
 * 文件内容对比弹窗(IDEA 风格的并排差异)。
 *
 * 三个状态各自有明确的降级路径 —— 不做「假装能比」:
 *  - 两侧都是文本 → 逐行并排,每个差异块可单独 ← / → 应用;
 *  - 任一侧是二进制 / 超过 2MB → 不回传内容,只提供整文件覆盖;
 *  - 任一侧缺失(文件只在一边存在)→ 只能从存在的那侧覆盖过去。
 */
const props = defineProps<{
  open: boolean;
  path: string;
  data: FileCompareData | null;
  loading: boolean;
  error: string;
  deviceId: string;
}>();

const emit = defineEmits<{
  close: [];
  /** direction:'pull' 写本机,'push' 写对端;content 省略 = 整文件照抄来源侧。 */
  sync: [direction: 'pull' | 'push', content?: string];
}>();

const left = computed<FileSideData>(() => props.data?.local ?? { exists: false });
const right = computed<FileSideData>(() => props.data?.remote ?? { exists: false });

/** 一侧能否用于逐行对比:存在、有文本、且不是二进制/过大。 */
function comparable(side: FileSideData): boolean {
  return side.exists && typeof side.text === 'string' && !side.binary && !side.tooLarge;
}

const canDiff = computed<boolean>(() => comparable(left.value) && comparable(right.value));

const diff = computed(() =>
  canDiff.value ? diffText(left.value.text ?? '', right.value.text ?? '') : { rows: [], hunks: [] },
);

/** 每个差异块的首行下标 → 块,用于在该行渲染 ← / → 按钮。 */
const hunkAtStart = computed<Map<number, DiffHunk>>(() => {
  const map = new Map<number, DiffHunk>();
  for (const h of diff.value.hunks) map.set(h.start, h);
  return map;
});

const changedCount = computed<number>(() => countChanged(diff.value.rows));

/** 二进制 / 过大 / 取不到时,说明为什么看不了内容。 */
function reasonOf(side: FileSideData, role: string): string {
  if (!side.exists) return `${role}没有这个文件${side.error ? `（${side.error}）` : ''}`;
  if (side.binary) return `${role}是二进制文件`;
  if (side.tooLarge) return `${role}超过 2MB`;
  return `${role}内容不可用`;
}

const blocked = computed<string>(() => {
  if (canDiff.value) return '';
  if (!comparable(left.value)) return reasonOf(left.value, '本机');
  return reasonOf(right.value, '对端');
});

function rowClass(type: string): string {
  return `is-${type}`;
}

/**
 * 整文件覆盖是破坏性操作(直接拿一侧内容替换另一侧),要先二次确认。
 * 逐块同步(apply)是外科手术式的一小块,不算破坏性,不拦。
 */
const overwriteConfirm = ref<'pull' | 'push' | null>(null);
function requestOverwrite(dir: 'pull' | 'push'): void {
  overwriteConfirm.value = dir;
}
function confirmOverwrite(): void {
  const dir = overwriteConfirm.value;
  overwriteConfirm.value = null;
  if (dir) emit('sync', dir);
}
// 关窗或换文件时,清掉进行中的覆盖确认,免得下次打开还停在上一步
watch(
  () => [props.open, props.path],
  () => {
    overwriteConfirm.value = null;
  },
);

/**
 * 把某个差异块应用到目标侧。
 * 目标是对端 → 写远端(push);目标是本机 → 写本地(pull)。
 */
function apply(hunk: DiffHunk, target: 'left' | 'right'): void {
  const newText = applyHunk(left.value.text ?? '', right.value.text ?? '', hunk, target);
  emit('sync', target === 'right' ? 'push' : 'pull', newText);
}
</script>

<template>
  <Transition name="guide">
    <div v-if="open" class="modal-overlay" @click.self="emit('close')">
      <div class="modal fd-modal" role="dialog" aria-modal="true" aria-labelledby="fd-title">
        <n-button quaternary circle class="modal-close" aria-label="关闭" @click="emit('close')">×</n-button>
        <div class="modal-title-row">
          <h2 id="fd-title" class="modal-title">文件内容对比</h2>
          <span class="modal-title-path mono" :title="path">{{ path }}</span>
        </div>

        <div v-if="loading" class="fd-state">正在读取两侧内容…</div>

        <div v-else-if="error" class="diff-error" role="alert">
          <div class="diff-error__msg break">{{ error }}</div>
        </div>

        <template v-else-if="data">
          <div class="fd-legend mono">
            <span class="fd-legend__role">本机</span>
            <span class="fd-legend__id">{{ data.folderPath }}</span>
            <span class="fd-legend__sep">↔</span>
            <span class="fd-legend__role">对端</span>
            <span class="fd-legend__id">{{ deviceId }}</span>
          </div>

          <!-- 逐行对比区 -->
          <div v-if="canDiff" class="fd-body">
            <div class="fd-head">
              <span class="fd-head__role">本机</span>
              <span v-if="changedCount === 0" class="fd-head__clean">两侧内容一致</span>
              <span v-else class="fd-head__count">{{ changedCount }} 行有差异</span>
              <span class="fd-head__role">对端（{{ deviceId }}）</span>
            </div>

            <div class="fd-rows">
              <div
                v-for="(row, i) in diff.rows"
                :key="i"
                class="fd-row"
                :class="rowClass(row.type)"
              >
                <span class="fd-no">{{ row.leftNo ?? '' }}</span>
                <pre class="fd-text">{{ row.leftText ?? '' }}</pre>
                <span class="fd-gutter">
                  <template v-if="hunkAtStart.get(i)">
                    <button
                      type="button"
                      class="fd-apply"
                      title="把右边的这块应用到本机（拉取覆盖）"
                      @click="apply(hunkAtStart.get(i)!, 'left')"
                    >←</button>
                    <button
                      type="button"
                      class="fd-apply"
                      title="把左边的这块应用到对端（推送覆盖）"
                      @click="apply(hunkAtStart.get(i)!, 'right')"
                    >→</button>
                  </template>
                </span>
                <span class="fd-no">{{ row.rightNo ?? '' }}</span>
                <pre class="fd-text">{{ row.rightText ?? '' }}</pre>
              </div>
            </div>
          </div>

          <!-- 降级:不能逐行比时,至少要能整文件覆盖 -->
          <div v-else class="fd-blocked">
            <p class="fd-blocked__msg">{{ blocked }}，无法逐行对比。</p>
            <p class="fd-blocked__hint">仍可整文件覆盖（以一侧内容为准替换另一侧）。</p>
          </div>

          <div class="modal-actions">
            <template v-if="overwriteConfirm">
              <span class="fd-confirm__msg">
                将用{{ overwriteConfirm === 'pull' ? '对端' : '本机' }}文件完全替换{{ overwriteConfirm === 'pull' ? '本机' : '对端' }}文件，此操作不可撤销。
              </span>
              <n-button size="small" type="error" @click="confirmOverwrite">确认覆盖</n-button>
              <n-button size="small" tertiary @click="overwriteConfirm = null">取消</n-button>
            </template>
            <template v-else>
              <n-button
                size="small"
                tertiary
                :disabled="!right.exists || loading"
                title="用对端文件内容覆盖本机文件"
                @click="requestOverwrite('pull')"
              >← 用对端覆盖本机</n-button>
              <n-button
                size="small"
                tertiary
                :disabled="!left.exists || loading"
                title="用本机文件内容覆盖对端文件"
                @click="requestOverwrite('push')"
              >用本机覆盖对端 →</n-button>
            </template>
            <n-button type="primary" @click="emit('close')">关闭</n-button>
          </div>
        </template>
      </div>
    </div>
  </Transition>
</template>
