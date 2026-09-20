<script setup lang="ts">
/**
 * 对比表的行图标:目录 = 展开箭头;文件 = 按后缀区分的类型图标。
 *
 * 内联 SVG(无第三方图标库),描边用 currentColor,颜色由 .cmp-icon--<kind> 指定(见 style.css)。
 * 例外:js / ts 用「品牌色实心徽标 + 对比色字母」两笔色(VS Code 同款观感),
 * 字母颜色也在 CSS 里(.cmp-icon--js / --ts 下),浅底深底都看得清。
 */
import { computed } from 'vue';
import { fileIconKind } from '../utils/file-icon';

const props = defineProps<{
  name: string;
  isDir?: boolean;
  /** 仅目录有意义:折叠时箭头朝右,展开朝下。 */
  collapsed?: boolean;
}>();

const kind = computed(() => fileIconKind(props.name));
</script>

<template>
  <span
    class="cmp-icon"
    :class="isDir ? undefined : `cmp-icon--${kind}`"
    aria-hidden="true"
  >
    <!-- 目录:展开箭头(兼作折叠指示) -->
    <svg v-if="isDir" class="cmp-svg" viewBox="0 0 16 16">
      <path v-if="collapsed" d="M6 4l4 4-4 4" />
      <path v-else d="M4 6l4 4 4-4" />
    </svg>

    <!-- Rust:齿轮(外圈 + 轴心 + 八个短齿,别做成太阳光芒) -->
    <svg v-else-if="kind === 'rust'" class="cmp-svg" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="4.1" />
      <circle cx="8" cy="8" r="1.5" />
      <path d="M8 2.4v1.5M8 12.1v1.5M2.4 8h1.5M12.1 8h1.5M4 4l1.1 1.1M10.9 10.9 12 12M12 4l-1.1 1.1M5.1 10.9 4 12" />
    </svg>

    <!-- JavaScript:实心方块 + J -->
    <svg v-else-if="kind === 'js'" class="cmp-svg" viewBox="0 0 16 16">
      <rect class="cmp-svg__badge" x="2.6" y="2.6" width="10.8" height="10.8" rx="2.2" />
      <path class="cmp-svg__badge-letter" d="M9.8 5.4v3.5a1.75 1.75 0 0 1-3.5 0" />
    </svg>

    <!-- TypeScript:实心方块 + T -->
    <svg v-else-if="kind === 'ts'" class="cmp-svg" viewBox="0 0 16 16">
      <rect class="cmp-svg__badge" x="2.6" y="2.6" width="10.8" height="10.8" rx="2.2" />
      <path class="cmp-svg__badge-letter" d="M5.6 5.9h4.8M8 5.9v5.2" />
    </svg>

    <!-- React:原子(核 + 三条轨道) -->
    <svg v-else-if="kind === 'react'" class="cmp-svg" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="1.5" class="cmp-svg__fill" />
      <ellipse cx="8" cy="8" rx="6.1" ry="2.4" />
      <ellipse cx="8" cy="8" rx="6.1" ry="2.4" transform="rotate(60 8 8)" />
      <ellipse cx="8" cy="8" rx="6.1" ry="2.4" transform="rotate(120 8 8)" />
    </svg>

    <!-- Vue:双层 V -->
    <svg v-else-if="kind === 'vue'" class="cmp-svg" viewBox="0 0 16 16">
      <path d="M2.4 3.4 8 13.2 13.6 3.4" />
      <path d="M5.7 3.4 8 7.8 10.3 3.4" />
    </svg>

    <!-- Python:蛇身 + 眼 -->
    <svg v-else-if="kind === 'python'" class="cmp-svg" viewBox="0 0 16 16">
      <path d="M3.1 5.3c0-1.6 1.3-2.9 2.9-2.9h4c1.6 0 2.9 1.3 2.9 2.9s-1.3 2.9-2.9 2.9H6c-1.6 0-2.9 1.3-2.9 2.9s1.3 2.9 2.9 2.9h3.2" />
      <circle cx="6.2" cy="5.3" r="0.9" class="cmp-svg__fill" />
    </svg>

    <!-- Go:地鼠头 -->
    <svg v-else-if="kind === 'go'" class="cmp-svg" viewBox="0 0 16 16">
      <rect x="2.7" y="4.7" width="10.6" height="7.5" rx="3.4" />
      <circle cx="6.2" cy="8.2" r="0.95" class="cmp-svg__fill" />
      <circle cx="9.8" cy="8.2" r="0.95" class="cmp-svg__fill" />
      <path d="M4.4 5.3 5.8 3.3M11.6 5.3 10.2 3.3" />
    </svg>

    <!-- Java:咖啡杯 + 热气 -->
    <svg v-else-if="kind === 'java'" class="cmp-svg" viewBox="0 0 16 16">
      <path d="M3.4 6.6h8.6v3.1a3.3 3.3 0 0 1-3.3 3.3H6.7a3.3 3.3 0 0 1-3.3-3.3z" />
      <path d="M12 7.7h.8a1.7 1.7 0 0 1 0 3.4H12" />
      <path d="M6.2 2.6c.6.6.6 1.2 0 1.9M9.6 2.6c.6.6.6 1.2 0 1.9" />
    </svg>

    <!-- C/C++:字母 C(开口弧) -->
    <svg v-else-if="kind === 'c'" class="cmp-svg" viewBox="0 0 16 16">
      <path d="M11.4 4.8a4.6 4.6 0 1 0 0 6.4" />
    </svg>

    <!-- HTML:HTML5 盾牌 -->
    <svg v-else-if="kind === 'html'" class="cmp-svg" viewBox="0 0 16 16">
      <path d="M3.1 2.9h9.8l-.9 9.4L8 13.6l-4-1.3z" />
      <path d="M6.5 6.3h3.2l-.2 2.1H6.8l.1 1.2 1.1.3 1.1-.3.2-1.5" />
    </svg>

    <!-- CSS:# 选择器 -->
    <svg v-else-if="kind === 'css'" class="cmp-svg" viewBox="0 0 16 16">
      <path d="M6.5 3.4 5.4 12.6M10.6 3.4 9.5 12.6M3.4 6.4h9.2M3.2 9.6h9.2" />
    </svg>

    <!-- SQL:数据库圆柱 -->
    <svg v-else-if="kind === 'sql'" class="cmp-svg" viewBox="0 0 16 16">
      <ellipse cx="8" cy="4.4" rx="4.7" ry="2" />
      <path d="M3.3 4.4v7.2c0 1.1 2.1 2 4.7 2s4.7-.9 4.7-2V4.4" />
      <path d="M3.3 8c0 1.1 2.1 2 4.7 2s4.7-.9 4.7-2" />
    </svg>

    <!-- 脚本:终端窗口 + 提示符 -->
    <svg v-else-if="kind === 'shell'" class="cmp-svg" viewBox="0 0 16 16">
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.4" />
      <path d="M5 7l1.8 1.6L5 10.2" />
      <path d="M8.4 10.4h2.6" />
    </svg>

    <!-- 通用源码:尖括号 <> -->
    <svg v-else-if="kind === 'code'" class="cmp-svg" viewBox="0 0 16 16">
      <path d="M5.5 4 2 8l3.5 4" />
      <path d="M10.5 4 14 8l-3.5 4" />
    </svg>

    <!-- 数据 / 配置:花括号 {} -->
    <svg v-else-if="kind === 'data'" class="cmp-svg" viewBox="0 0 16 16">
      <path d="M6.5 3c-2 0-1.5 4-3.5 5 2 1 1.5 5 3.5 5" />
      <path d="M9.5 3c2 0 1.5 4 3.5 5-2 1-1.5 5-3.5 5" />
    </svg>

    <!-- 文档 / 文本:折角页 + 文字行 -->
    <svg v-else-if="kind === 'doc'" class="cmp-svg cmp-svg--file" viewBox="0 0 16 16">
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
      <path d="M6 8.5h4M6 11h4" />
    </svg>

    <!-- 图片:相框 + 山 + 太阳 -->
    <svg v-else-if="kind === 'image'" class="cmp-svg cmp-svg--file" viewBox="0 0 16 16">
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.4" />
      <circle cx="5.6" cy="6.4" r="1" />
      <path d="M3 11.2 6.2 8.2 8.5 10.2 10.2 8.7 13 11.2" />
    </svg>

    <!-- 压缩包:盒 + 提手 -->
    <svg v-else-if="kind === 'archive'" class="cmp-svg cmp-svg--file" viewBox="0 0 16 16">
      <path d="M3.5 6h9v7h-9z" />
      <path d="M3 3.5h10V6H3z" />
      <path d="M8 6v2.2" />
    </svg>

    <!-- 音视频:播放 -->
    <svg v-else-if="kind === 'media'" class="cmp-svg cmp-svg--file" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="5.2" />
      <path d="M6.8 5.6 10.4 8l-3.6 2.4z" />
    </svg>

    <!-- 表格:网格 -->
    <svg v-else-if="kind === 'sheet'" class="cmp-svg cmp-svg--file" viewBox="0 0 16 16">
      <rect x="3" y="3.5" width="10" height="9" rx="1.2" />
      <path d="M3 6.5h10M3 9.5h10M6.5 3.5v9M9.5 3.5v9" />
    </svg>

    <!-- PDF:折角页 + 底部标签 -->
    <svg v-else-if="kind === 'pdf'" class="cmp-svg cmp-svg--file" viewBox="0 0 16 16">
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
      <path d="M6 10.6h4" stroke-width="2.4" />
    </svg>

    <!-- 通用文件:空白折角页 -->
    <svg v-else class="cmp-svg cmp-svg--file" viewBox="0 0 16 16">
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </svg>
  </span>
</template>
