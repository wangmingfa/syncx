<script setup lang="ts">
/**
 * 操作系统图标:本机 chip 用它替代原来那个「有无对端在线」的圆点,设备卡用它替代字母头像。
 *
 * 内联 SVG(项目无图标库,与 FileIcon.vue 同一条路)。四枚:Windows / macOS / Linux / 未知。
 *
 * 「在线彩色、离线灰色」怎么实现 —— 走 CSS 的 `filter: grayscale(1)`,而不是「一条规则
 * 把子元素 fill 覆盖成 var(--muted)」:后者看着更优雅(SVG 的 fill 是 presentation
 * attribute,优先级低于任何 CSS 规则,一行就能整体翻灰),但它会**毁掉 Tux** ——
 * 企鹅的肚皮和身子一旦被刷成同一个灰,图标塌成一块没有轮廓的灰斑,形状信息全丢。
 * grayscale 保留亮度对比:四格窗去饱和后仍是四块不同明度的灰,Tux 的肚子仍比身子亮。
 * 规则在 style.css 的 `.os-icon.is-offline`。
 *
 * 也因此**苹果必须画成彩虹版**:单色黑剪影没有「彩色态」可言,去饱和对它完全无效,
 * 在线 / 离线会长得一模一样 —— 那正是这个组件唯一不能失败的地方。
 */
import { computed, useId } from 'vue';
import { osIconKind, osIconLabel } from '../utils/os-icon';

const props = defineProps<{
  /** process.platform 原值(本机取 status.platform,对端取 device.platform);缺省 = 旧后端未发。 */
  platform?: string;
  /** 不在线:整枚图标去色 + 减淡。 */
  offline?: boolean;
  /** 覆盖 title / aria-label 的文本。形状 + 颜色是唯一的状态载体,文本是色觉障碍用户的兜底通道。 */
  hint?: string;
}>();

const kind = computed(() => osIconKind(props.platform));
const label = computed(() => props.hint ?? osIconLabel(props.platform));

/**
 * 彩虹苹果的 clipPath id。文档内必须唯一,而设备卡会把同一枚图标渲染 N 份,
 * 所以每个实例领一个号 —— 照 FileIcon.vue 里 moonbit mask 的教训:别用模块级
 * 自增计数器,`<script setup>` 顶层语句会进 setup() 每次重跑,永远拿到同一个号。
 */
const appleClipId = `os-apple-${useId()}`;
</script>

<template>
  <span class="os-icon" :class="{ 'is-offline': offline }" :title="label" :aria-label="label" role="img">
    <!-- Windows:四格窗,官方四色。取 Win11 的平直面四格而不是 Win8 的透视旗 ——
         14px 下透视梯形的斜边会糊成一团,而格间那道缝本身就足够给出「四格」的辨识度。 -->
    <svg v-if="kind === 'windows'" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="2.15" y="2.15" width="5.5" height="5.5" rx="0.3" fill="#F25022" />
      <rect x="8.35" y="2.15" width="5.5" height="5.5" rx="0.3" fill="#7FBA00" />
      <rect x="2.15" y="8.35" width="5.5" height="5.5" rx="0.3" fill="#00A4EF" />
      <rect x="8.35" y="8.35" width="5.5" height="5.5" rx="0.3" fill="#FFB900" />
    </svg>

    <!-- macOS:1977 彩虹苹果。剪影做 clipPath,后面铺 6 条官方色横带(上→下:
         绿 / 黄 / 橙 / 红 / 紫 / 蓝)。顶端那条绿正好盖住树叶 —— 原版树叶就是绿的,
         条纹顺序不是凑出来的。镂空不能叠白色图形:白色只在浅底上碰巧对,
         chip 底与深色主题一换就露馅,所以走 clip 而不是叠色。 -->
    <svg v-else-if="kind === 'macos'" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <defs>
        <clipPath :id="appleClipId">
          <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
        </clipPath>
      </defs>
      <g :clip-path="`url(#${appleClipId})`">
        <rect x="0" y="3" width="24" height="3" fill="#61bc44" />
        <rect x="0" y="6" width="24" height="3" fill="#fdb922" />
        <rect x="0" y="9" width="24" height="3" fill="#f58319" />
        <rect x="0" y="12" width="24" height="3" fill="#e1373c" />
        <rect x="0" y="15" width="24" height="3" fill="#973898" />
        <rect x="0" y="18" width="24" height="3" fill="#009edd" />
      </g>
    </svg>

    <!-- Linux:简化 Tux。身子 + 肚皮 + 黄嘴黄脚的明暗关系必须靠**色值差**而不是靠描边,
         14px 下 1px 描边会被抗锯齿吃掉。肚皮不能用纯白:chip 底就是 --card(浅底时近白),
         纯白等于隐形。绘制顺序即遮挡顺序 —— 鳍与身子同色所以无接缝,脚最后画才压得住裙边。 -->
    <svg v-else-if="kind === 'linux'" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <!-- 墨色:头、身、两鳍 -->
      <ellipse cx="3.15" cy="9.2" rx="1.05" ry="2.9" transform="rotate(14 3.15 9.2)" fill="#2f3338" />
      <ellipse cx="12.85" cy="9.2" rx="1.05" ry="2.9" transform="rotate(-14 12.85 9.2)" fill="#2f3338" />
      <circle cx="8" cy="4.7" r="3.05" fill="#2f3338" />
      <ellipse cx="8" cy="9.7" rx="4.55" ry="5" fill="#2f3338" />
      <!-- 浅色:脸与肚皮(比身子亮一档,不是白) -->
      <ellipse cx="8" cy="5" rx="2.25" ry="2" fill="#e8eaee" />
      <ellipse cx="8" cy="10.5" rx="2.85" ry="3.5" fill="#e8eaee" />
      <!-- 眼与嘴 -->
      <circle cx="7.1" cy="4.35" r="0.85" fill="#fff" />
      <circle cx="8.9" cy="4.35" r="0.85" fill="#fff" />
      <circle cx="7.25" cy="4.45" r="0.42" fill="#2f3338" />
      <circle cx="8.75" cy="4.45" r="0.42" fill="#2f3338" />
      <path d="M8 4.9c.9 0 1.4.4 1.4.9 0 .5-.6.9-1.4.9s-1.4-.4-1.4-.9c0-.5.5-.9 1.4-.9z" fill="#f0a420" />
      <!-- 脚 -->
      <ellipse cx="6.1" cy="14.4" rx="1.7" ry="0.95" fill="#f0a420" />
      <ellipse cx="9.9" cy="14.4" rx="1.7" ry="0.95" fill="#f0a420" />
    </svg>

    <!-- 未知平台:中性芯片。刻意与前几枚的实心风格不同(纯描边 + currentColor),
         让它一眼看起来「我不认识」,而不是像某个认识的平台的劣质版本。 -->
    <svg v-else viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">
      <rect x="4.8" y="4.8" width="6.4" height="6.4" rx="1.4" />
      <path d="M7 2.6v2.2M9 2.6v2.2M7 11.2v2.2M9 11.2v2.2M2.6 7h2.2M2.6 9h2.2M11.2 7h2.2M11.2 9h2.2" />
    </svg>
  </span>
</template>
