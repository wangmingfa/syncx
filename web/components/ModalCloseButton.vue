<script setup lang="ts">
import { NButton } from 'naive-ui';

/**
 * 弹窗右上角的关闭按钮。唯一的引用者是 `ModalShell.vue`,所以它替全部弹窗(21 处)渲染这颗角
 * —— 各弹窗不再自己抄一遍 `<n-button quaternary circle>×`,叉号也由此从文字换成了 SVG。
 *
 * 叉号为什么是内联 SVG 而不是文字「×」:一个字的墨迹位置由字体度量(baseline 与数学轴)决定,
 * CSS 的 align-items / line-height 只能摆布行盒、摆布不了墨迹。实测同一个 28px 的「×」,
 * macOS 默认字体的墨迹中心比圆心低 2.00px、Helvetica 低 2.75px、Verdana 低 2.12px,
 * 而 Arial 反而高 0.88px、Courier New 高 1.00px —— 靠 transform/line-height 去凑等于把外观
 * 绑死在某款字体上,换个平台就翻车(14px 时偏差只有 ~0.5px,所以字号小的时候看不出来)。
 * SVG 的几何与字体无关。改回文字前请先读这段。
 *
 * 样式就在本文件末尾(组件自有样式放组件内),而且是 **scoped** —— 这两个类名只有这里挂
 * (`grep -rn 'class="modal-close' web/` 只命中下面模板那两行),没有调用方覆盖要照顾,
 * 所以抬一档特异度不伤任何人;`.modal-close` 落在子组件 `<n-button>` 的根元素上,
 * Vue 会把本组件的 scope 属性同样写到子组件根节点,叉号那个 `<svg>` 则是在这里编译的槽内容,
 * 两者都拿得到 scope。圆 34px(naive-ui medium)、图标 14x14、34px 盒内左右各留 10px 整数边距。
 *
 * ⚠️ 一处跨组件依赖搬不走:`top/right: 14px` 是相对**外壳那层 `.modal` 的内衬盒角**定位的,
 *    要 `web/components/ModalShell.vue` 的 `.modal { position: relative }` 在上方兜着 ——
 *    离了那个定位父级,这颗角会去找最近的别的祖先(或视口),位置整个飘掉。
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

<style scoped>
/* 右上角关闭按钮。圆(悬停底色)沿用 naive-ui medium 的 34px 不变,里面的叉号是内联 SVG 画的
   —— 为什么不用文字字符,理由写在组件注释里(那段实测数据是这块几何的唯一出处)。
   14px 的定位依赖外壳 `.modal` 的 position: relative 与它的 26px 内衬,见组件注释的 ⚠️ 段。 */
.modal-close {
  position: absolute;
  top: 14px;
  right: 14px;
}

/* 叉号的尺寸只在这里定一处;stroke 走 currentColor,自动跟随按钮文字色(hover / disabled 态一致)。
   viewBox 是 14x14、path 从 (1,1) 划到 (13,13),加上 round 端帽正好填满 viewBox,
   即墨迹 14x14、笔画 2 —— 与改造前文字版实测的 1.8~2.1px 同一量级。 */
.modal-close-x {
  width: 14px;
  height: 14px;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  fill: none;
}
</style>
