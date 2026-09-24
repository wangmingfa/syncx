<script setup lang="ts">
import { NButton } from 'naive-ui';

/**
 * 弹窗右上角的关闭按钮(9 个弹窗共用)。
 *
 * 叉号为什么是内联 SVG 而不是文字「×」:一个字的墨迹位置由字体度量(baseline 与数学轴)决定,
 * CSS 的 align-items / line-height 只能摆布行盒、摆布不了墨迹。实测同一个 28px 的「×」,
 * macOS 默认字体的墨迹中心比圆心低 2.00px、Helvetica 低 2.75px、Verdana 低 2.12px,
 * 而 Arial 反而高 0.88px、Courier New 高 1.00px —— 靠 transform/line-height 去凑等于把外观
 * 绑死在某款字体上,换个平台就翻车(14px 时偏差只有 ~0.5px,所以字号小的时候看不出来)。
 * SVG 的几何与字体无关。改回文字前请先读这段。
 *
 * 样式在 `web/style.css` 的 `.modal-close` / `.modal-close-x`(留在全局而不是收进组件,是因为
 * 它与 `.modal` 的定位互相咬合,拆开会看不出层叠关系)。圆 34px(naive-ui medium)、图标 14x14、
 * 34px 盒内左右各留 10px 整数边距。
 */
defineProps<{
  /** 禁用(如确认弹窗正在忙)。注意:naive-ui 禁用态仍会派发 mouseenter,但原生 title 会静默失效。 */
  disabled?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <n-button
    quaternary
    circle
    class="modal-close"
    aria-label="关闭"
    :disabled="disabled"
    @click="emit('close')"
  >
    <svg class="modal-close-x" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M1 1 13 13M13 1 1 13" />
    </svg>
  </n-button>
</template>
