<script setup lang="ts">
/**
 * 对比表的行图标:目录 = 展开箭头;文件 = 按后缀区分的类型图标。
 *
 * 内联 SVG(无第三方图标库),描边用 currentColor,颜色由 .cmp-icon--<kind> 指定(见 style.css)。
 *
 * 三种「非纯描边」的画法,都是被 13px 逼出来的:
 *  - **实心 + 对比色字母**:js / ts / markdown(徽标方块吃 currentColor,字母压在 CSS 里);
 *  - **实心 + evenodd 镂空**:rust 的齿轮(R 是挖出来的,不是叠一块白);
 *  - **实心 + mask 镂空**:moonbit(耳根与头两段子路径重叠,evenodd 会把重叠区也挖掉)。
 * 镂空一律不能叠白色图形:白色只在白底上碰巧对,行底色一变(悬停/差异行)就露白。
 */
import { computed, useId } from 'vue';
import { fileIconKind } from '../utils/file-icon';

/**
 * MoonBit 图标的 mask id。mask 的 id 在整篇文档里必须唯一,而对比页会把同一个图标
 * 渲染很多份(两个窗格 × 每行)—— 所以每个组件实例领一个号。
 *
 * ⚠️ 别用「模块级 let 计数器 + 自增」:`<script setup>` 里的顶层语句会被编译进 setup(),
 * 每个实例都会重新执行 `let n = 0` → 永远拿到 1(实测 6 份渲染全是同一个 id)。
 * 计数要么放进独立模块,要么直接用 Vue 3.5 的 useId()——后者才是正解。
 */
const moonbitMaskId = `mbt-mask-${useId()}`;

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

    <!-- Rust:按官方 logo 画 —— 实心齿轮,中间镂空一个 R。
         镂空走同一条 path 的 evenodd(不是叠一个白色 R):缺口透出的是行底色,
         悬停高亮/别的底色下依然对。三段子路径是「齿轮 → R 外轮廓 → R 碗内孔」,
         奇偶计数于是得到:齿轮实心、R 笔画镂空、R 的碗底(被笔画围住的封闭区)重新实心。
         齿轮 10 齿(再密 13px 下就糊成一圈);R 用斜腿,比直角腿更像字母。 -->
    <svg v-else-if="kind === 'rust'" class="cmp-svg" viewBox="0 0 16 16">
      <path
        class="cmp-svg__rust"
        fill-rule="evenodd"
        d="M13.35 8L13.33 8.45L13.28 8.89L13.18 9.33L14.49 10.34L14.33 10.74L14.15 11.13L13.94 11.51L12.33 11.14L12.05 11.5L11.74 11.82L11.41 12.12L11.88 13.71L11.51 13.94L11.13 14.15L10.74 14.33L9.65 13.09L9.22 13.21L8.78 13.29L8.34 13.34L7.78 14.9L7.35 14.87L6.92 14.82L6.49 14.73L6.35 13.09L5.93 12.93L5.52 12.74L5.13 12.52L3.77 13.45L3.44 13.18L3.12 12.88L2.82 12.56L3.67 11.14L3.42 10.77L3.21 10.38L3.03 9.97L1.37 9.93L1.27 9.51L1.18 9.08L1.13 8.65L2.65 8L2.67 7.55L2.72 7.11L2.82 6.67L1.51 5.66L1.67 5.26L1.85 4.87L2.06 4.49L3.67 4.86L3.95 4.5L4.26 4.18L4.59 3.88L4.12 2.29L4.49 2.06L4.87 1.85L5.26 1.67L6.35 2.91L6.78 2.79L7.22 2.71L7.66 2.66L8.22 1.1L8.65 1.13L9.08 1.18L9.51 1.27L9.65 2.91L10.07 3.07L10.48 3.26L10.87 3.48L12.23 2.55L12.56 2.82L12.88 3.12L13.18 3.44L12.33 4.86L12.58 5.23L12.79 5.62L12.97 6.03L14.63 6.07L14.73 6.49L14.82 6.92L14.87 7.35L13.35 8Z
           M5.5 4.35L9.8 4.35L9.8 8.85L10.5 11.65L9 11.65L8.3 8.85L7 8.85L7 11.65L5.5 11.65Z
           M7 5.85L8.3 5.85L8.3 7.35L7 7.35Z"
      />
    </svg>

    <!-- MoonBit(.mbt / .mbti):官方 logo 的吉祥物 —— 两只大耳 + 圆头 + 面罩横带。
         整只实心,横带靠 mask 挖出来:耳根**必然插在头里**(两段子路径重叠),用 evenodd 会把
         重叠区一起挖成洞,只能走 mask。mask 是黑白图层,挖出来的是「透出下层」——
         行底色/悬停高亮怎么变都对,不像叠一块白色矩形那样只在白底上碰巧成立。
         右耳由左耳镜像而来、但**书写顺序反向**,好让两段子路径绕向一致(nonzero 下绕向相反的
         重叠区同样成洞)。13px 下耳朵与横带还分得清;带内更小的 <>(logo 里那对尖角)就不画了。 -->
    <svg v-else-if="kind === 'moonbit'" class="cmp-svg" viewBox="0 0 16 16">
      <defs>
        <mask :id="moonbitMaskId">
          <!-- 白 = 保留,黑 = 挖掉。横带两边各留约 1 的洋红边(logo 里面罩是嵌在头里的) -->
          <rect width="16" height="16" fill="#fff" />
          <rect x="5.2" y="9.3" width="5.6" height="1.9" rx="0.95" fill="#000" />
        </mask>
      </defs>
      <path
        class="cmp-svg__solid"
        :mask="`url(#${moonbitMaskId})`"
        d="M5.9 8.2C4.1 7.2 2.2 4.4 2.6 2.6C2.9 1.2 4.6 1.2 5.3 2.4C6.4 4.2 7.1 6.8 7.4 8.9Z
           M8.6 8.9C8.9 6.8 9.6 4.2 10.7 2.4C11.4 1.2 13.1 1.2 13.4 2.6C13.8 4.4 11.9 7.2 10.1 8.2Z
           M3.7 10.8a4.3 3.6 0 1 0 8.6 0 4.3 3.6 0 1 0-8.6 0Z"
      />
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

    <!-- JSON:一对花括号(通行做法),加粗加高到接近满格。
         原来 json 与 yaml/toml/ini 共用这一枚图形,一屏里全是同样的花括号 →
         JSON 反而认不出来;现在 JSON 独占花括号,通用配置改走滑杆(见下方 data)。 -->
    <svg v-else-if="kind === 'json'" class="cmp-svg" viewBox="0 0 16 16">
      <path class="cmp-svg__brace" d="M6.2 2.2c-2.3 0-1.3 4.7-3.5 5.8 2.2 1.1 1.2 5.8 3.5 5.8" />
      <path class="cmp-svg__brace" d="M9.8 2.2c2.3 0 1.3 4.7 3.5 5.8-2.2 1.1-1.2 5.8-3.5 5.8" />
    </svg>

    <!-- 配置 / 结构化数据:三条滑杆(设置类文件的通用隐喻)。
         花括号让给 json 之后,这里不能再是花括号 —— 两枚几乎同形同色的图标并排,
         扫一眼分不出哪个是 JSON。 -->
    <svg v-else-if="kind === 'data'" class="cmp-svg" viewBox="0 0 16 16">
      <path d="M2.6 4.4h10.8M2.6 8h10.8M2.6 11.6h10.8" />
      <circle class="cmp-svg__fill" cx="6.4" cy="4.4" r="1.6" />
      <circle class="cmp-svg__fill" cx="9.9" cy="8" r="1.6" />
      <circle class="cmp-svg__fill" cx="5.2" cy="11.6" r="1.6" />
    </svg>

    <!-- Markdown:官方 mark —— 实心圆角方块 + M + 下箭头。
         方块实心、字母压对比色,与 js / ts 的「实心徽标 + 字母」同一套做法;
         比描边框那版在小尺寸下清楚得多(13px 时 M 的拐点会糊成一团)。 -->
    <svg v-else-if="kind === 'markdown'" class="cmp-svg" viewBox="0 0 16 16">
      <rect class="cmp-svg__badge" x="2.2" y="3.6" width="11.6" height="8.8" rx="1.5" />
      <path class="cmp-svg__badge-letter" d="M4.7 10.2V6.4l1.7 1.9 1.7-1.9v3.8" />
      <path class="cmp-svg__badge-letter" d="M11 6.4v3.8M10 9.2l1 1 1-1" />
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
