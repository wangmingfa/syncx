<script setup lang="ts">
/**
 * 一排操作按钮的「收起 / 展开」组件。
 *
 * 收起态只留一个「更多」占位图标参与布局;展开态把全部动作平铺成一条,
 * **绝对定位浮在页面上、不占布局位置** —— 所以卡片标题不会因为动作多少而忽宽忽窄。
 *
 * 三条设计取舍,改这里之前先读:
 *
 * 1. **展开状态可由父级驱动,也可以自管**。`expanded` 不传时组件自己记(点占位图标切换);
 *    传了则完全听父级。之所以要受控:「hover 目录卡展开」这条规则里,只有卡片知道自己
 *    的边界在哪,组件不知道。父级驱动时点击占位图标仍会发 `update:expanded`,由父级决定怎么响应。
 * 2. **键盘可达不靠 JS**。CSS 里 `.rail:focus-within` 与 `.is-open` 驱动同一套展开样式,
 *    所以 Tab 走到占位图标时动作条自动摊开,受控模式下父级完全不参与也成立。
 * 3. **散开动画是 transform 的结果,不是逐个挂载**。N 个按钮常驻 DOM,收起时各自
 *    `translateX` 回占位图标那一点并缩到 0.35、透明度 0;展开即反向移动。这样不需要
 *    TransitionGroup 也不需要测量尺寸,而 `visibility: hidden` 顺手把收起态的按钮
 *    从 tab 序列里摘掉(比 `inert` 好,`inert` 是 DOM 属性、CSS 驱动不了,会和第 2 条打架)。
 */
import { computed, ref } from 'vue';
import { NButton, NTooltip } from 'naive-ui';
import ActionIcon from './ActionIcon.vue';
import type { RailAction } from '../utils/action-rail';

const props = defineProps<{
  actions: RailAction[];
  /** 父级驱动展开状态;不传(undefined)则组件自管。 */
  expanded?: boolean;
  /** 占位图标的无障碍名称。 */
  label?: string;
}>();

const emit = defineEmits<{ (e: 'update:expanded', value: boolean): void }>();

const own = ref(false);
const open = computed<boolean>(() => props.expanded ?? own.value);

/** 先算出目标值再改状态:否则 open 已被自己翻过去,发出去的会是翻转前的旧值。 */
function onMoreClick(): void {
  const next = !open.value;
  if (props.expanded === undefined) own.value = next;
  emit('update:expanded', next);
}

/**
 * 图标只能走 `#icon` 插槽,并且两条分支必须写成**两个独立的 v-if**,不能 v-if / v-else。
 *
 * 两个坑都是实测出来的:
 *  - NButton 没有 `icon` **prop**(naive-ui 的 `icon` 在 Slots 接口里),写成
 *    `:icon="fn"` 会被 Vue 当普通属性落到 DOM 上变成 `icon="() => h(...)"`,
 *    按钮里一个图形都没有 —— 类型检查不报、构建不报,只有渲染出来才看得见。
 *  - `<template v-if="a.icon" #icon>` 配 `<template v-else>` 是「具名插槽 + 默认插槽」
 *    跨名的一条 if/else 链,Vue 编译器 slot codegen 直接抛
 *    `TypeError: Cannot read properties of undefined (reading 'type')`
 *    —— vue-tsc 与 dev 都不报,只有 vite build 炸。拆成两个独立 v-if 即可。
 */
</script>

<template>
  <span class="rail" :class="{ 'is-open': open }" :style="{ '--rail-n': actions.length }">
    <span class="rail__panel">
      <!-- 背板单独一层、铺满面板:收起时面板 visibility:hidden 会连它一起摘掉,
           不会留下一条盖住标题的空心胶囊;它自己的 opacity 过渡则负责展开时淡入。
           不直接写 .rail__panel 的 background 是因为面板盒子在收起时仍占着那一条宽度。 -->
      <span class="rail__scrim" aria-hidden="true"></span>

      <span v-for="(a, i) in actions" :key="a.key" class="rail__slot" :style="{ '--rail-i': i }">
        <!-- 禁用态按钮不派发鼠标事件,tooltip 必须由外层 .icon-btn 承接 hover —— 沿用
             目录卡原来的做法,否则「该目录还没有指派设备,无从对比」这类解释文案就看不到 -->
        <n-tooltip trigger="hover" :disabled="!a.tooltip" :style="{ maxWidth: '280px' }">
          <template #trigger>
            <span class="icon-btn">
              <n-button
                size="small"
                quaternary
                :circle="!a.text"
                :type="a.danger ? 'error' : a.active ? 'primary' : 'default'"
                :disabled="a.disabled"
                @click="a.onClick()"
              >
                <template v-if="a.icon" #icon>
                  <ActionIcon :name="a.icon" />
                </template>
                <template v-if="!a.icon">{{ a.text }}</template>
              </n-button>
            </span>
          </template>
          {{ a.tooltip }}
        </n-tooltip>
      </span>
    </span>

    <n-button
      class="rail__more"
      size="small"
      quaternary
      circle
      :aria-label="label ?? '更多操作'"
      :aria-expanded="open"
      @click="onMoreClick"
    >
      <template #icon>
        <ActionIcon name="more" />
      </template>
    </n-button>
  </span>
</template>

<style scoped>
/* 只有占位图标参与布局,动作条绝对定位浮在页面上 —— 卡片标题的可用宽度
   因此与「展开还是收起」「有几个动作」完全无关。 */
.rail {
  --rail-gap: 2px;
  --rail-dur: 200ms;
  --rail-stagger: 22ms;
  /* n-button `size=small` + `circle` 的盒高。圆钮是「全圆」的,所以它的 R 就是盒高的一半,
     下面胶囊的圆角由这一个数派生。
     为什么要在 CSS 里再记一份按钮尺寸:naive-ui 把 --n-height 挂在按钮元素自己身上,
     自定义属性只向下继承,而背板是按钮的**兄弟**节点,拿不到。改 size 时这条要一起改。 */
  --rail-btn: 28px;
  /* 四周留白:让 hover 的圆形高亮与胶囊之间有空隙,不贴边。 */
  --rail-pad: 4px;
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: none;
}

.rail__panel {
  position: absolute;
  /* 右缘对齐 rail 右缘 = 正好盖在占位图标上方:展开后最后一个动作就落在「更多」原来的
     位置上,占位图标被不透明背板整块遮住,视线里只有 6 个动作、右缘不发生位移。
     (此前钉在占位图标左缘,展开后是「6 个动作 + 占位」共 7 格,右侧多出一个空位。) */
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
  display: flex;
  align-items: center;
  gap: var(--rail-gap);
  /* 四周等距留白:hover 时按钮会亮起一个与自身等大的圆,贴边会让那个圆和胶囊边打架。
     代价是胶囊比按钮高 2×pad,于是圆角不能再靠 999px 夹到半高来取 —— 那会夹出
     (28+8)/2 = 18px,比按钮的 14px 大一圈;改由下面 .rail__scrim 显式派生。 */
  padding: var(--rail-pad);
  /* 收起态整条摘掉。用 visibility 而不是 inert:前者顺带把按钮移出 tab 序列,
     且能被 CSS 驱动 —— 下面那条 :focus-within 规则才有机会把它翻回 visible。
     延迟取动画时长,让按钮先收拢完再消失;展开时延迟归零,立刻可见。 */
  visibility: hidden;
  transition: visibility 0s linear var(--rail-dur);
}

/* :focus-within 与 .is-open 驱动同一套展开样式:键盘 Tab 到占位图标时动作条自动摊开,
   受控模式下父级完全不参与也成立。 */
.rail.is-open .rail__panel,
.rail:focus-within .rail__panel {
  visibility: visible;
  transition-delay: 0s;
}

.rail__scrim {
  position: absolute;
  inset: 0;
  /* 与圆钮同一个 R。圆钮是全圆的 → 它的 R = 盒高一半,所以从 --rail-btn 派生,
     而不是写死 14px:改按钮尺寸时只动 --rail-btn 一处,两边仍然一致。
     (胶囊现在比按钮高,不能用 999px 夹取,那会得到自己的半高而不是按钮的 R。) */
  border-radius: calc((var(--rail-btn) + var(--rail-pad) * 2) / 2);
  background: var(--card-hi);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  opacity: 0;
  transition: opacity calc(var(--rail-dur) * 0.6) ease;
}

.rail.is-open .rail__scrim,
.rail:focus-within .rail__scrim {
  opacity: 1;
}

/* 收起 = 每个动作各自平移到占位图标那一点并缩小;展开 = 回到自己的位置。
   位移量写成 (100% + gap) 的倍数:100% 就是按钮自身宽度,按钮尺寸怎么调都算不错,
   不留「28px 小圆钮」这种会过期的魔法数字。
   两个方向的错峰相反:散开时离占位图标最近的先到(外层 .is-open 的 delay),
   收拢时最远的先走(这里的 delay),否则按钮会在收拢途中叠成一摞。 */
.rail__slot {
  display: inline-flex;
  opacity: 0;
  transform: translateX(calc((var(--rail-n) - var(--rail-i) - 1) * (100% + var(--rail-gap)))) scale(0.35);
  transition:
    transform var(--rail-dur) cubic-bezier(0.2, 0.8, 0.3, 1),
    opacity calc(var(--rail-dur) * 0.6) ease;
  transition-delay: calc(var(--rail-i) * var(--rail-stagger));
}

.rail.is-open .rail__slot,
.rail:focus-within .rail__slot {
  opacity: 1;
  transform: none;
  transition-delay: calc((var(--rail-n) - var(--rail-i) - 1) * var(--rail-stagger));
}

@media (prefers-reduced-motion: reduce) {
  /* 只留淡入淡出,不做位移与错峰。选择器把两种状态都写出来是为了对上特异度 ——
     只写 .rail__slot 会被 .rail.is-open .rail__slot 压过,动画照样跑。 */
  .rail__slot,
  .rail.is-open .rail__slot,
  .rail:focus-within .rail__slot {
    transform: none;
    transition-property: opacity;
    transition-duration: 120ms;
    transition-delay: 0s;
  }
}
</style>
