<script setup lang="ts">
import { useId } from 'vue';
import ModalCloseButton from './ModalCloseButton.vue';

/**
 * 弹窗外壳 —— 9 个弹窗共用的骨架:遮罩 + 过渡 + dialog + 关闭按钮 + 标题行 + 动作区容器。
 *
 * 为什么值得抽出来:这几层一直是一模一样的,只有中间的内容不同,于是每个弹窗都自己抄一遍
 * `<Transition name="guide">` + `.modal-overlay` + `role="dialog" aria-modal` + 手写
 * `aria-labelledby` 的 id。任何一层要改(比如「忙碌时不许点遮罩关闭」)都得改 9 遍,
 * 而漏掉的那一个不会报错 —— 只会静静地行为不一致。
 *
 * 四个可配置的位置:
 *  - `title`(prop):标题。`aria-labelledby` 指向它,id 由 `useId()` 生成 —— 原先手写的
 *    `guide-title` / `fd-title` 一类固定 id 每加一个弹窗就要新起一个名字,还得担心撞车。
 *  - `description`(prop):标题**右侧**的说明,通常是目录路径或一句副标题。给了才渲染
 *    `.modal-title-row`;不给就还是裸 `h2`(保留它 4px 的下边距),空的标题行会白占高度。
 *  - 默认 slot:正文。
 *  - `footer` slot:底部动作区。**容器由外壳提供**,这样 `.modal-actions` 那套「按钮按内容
 *    宽度排、整组靠右、窄屏换行」的规则不会因为某个弹窗忘了套而失效(footer 为空时连容器
 *    都不渲染,省掉 18px 的 `margin-top`)。
 *
 * 刻意**不做**的两件事:
 *  - 不管 Esc。看着该由外壳统一处理,但弹窗可以叠加(同步记录弹窗里点「清空记录」会再开一层
 *    确认弹窗),挂在 window 上的 keydown 一响就会把两层一起关掉。要做得先定「只关最上面
 *    那层」的规则,那是另一件事。今天只有对比弹窗自己处理 Esc(它还兼着「先撤销覆盖确认」
 *    的语义,不是单纯的关闭),维持原样。
 *  - 不搬样式。`.modal` / `.modal-*` 是一组互相咬合的定位上下文,散进各组件就看不出层叠关系了。
 *    (原先这里写的「本项目约定组件样式集中在 web/style.css」已作废:自包含的组件样式放组件
 *    自己的 `<style scoped>` 里,只有像这样跨层依赖上下文的才留在 style.css。)
 *
 * ⚠️ `inheritAttrs: false` 是必须的:属性透传的默认目标是**根元素**,而根元素是
 * `.modal-overlay`,调用方写的 `class` 会落到遮罩上 —— 对比弹窗的 `.fd-modal`(96% 宽)
 * 就再也盖不到 `.modal` 了。这里显式把 `$attrs` 转接到 dialog 自己身上。
 */
defineOptions({ inheritAttrs: false });

withDefaults(
  defineProps<{
    /** 是否展示。由调用方按自己的条件算(可以是 `!!state` 这种从可空对象投出来的布尔)。 */
    open: boolean;
    /** 标题。同时被 `aria-labelledby` 引用,是读屏软件念出来的那个名字。 */
    title: string;
    /** 标题右侧的说明(目录路径 / 副标题)。空字符串 = 不渲染,不会留一个空的标题行。 */
    description?: string;
    /** description 用等宽字体(路径场景开,纯文字副标题不要开)。 */
    descriptionMono?: boolean;
    /** 更宽的弹窗(`.modal-wide`,640px;用于列表与长文)。 */
    wide?: boolean;
    /**
     * 关闭按钮禁用,**同时**挡住「点遮罩关闭」。
     * 两者必须同一个开关:只禁用 × 而遮罩还能关,等于忙碌时照样能把状态关掉。
     */
    closeDisabled?: boolean;
  }>(),
  { description: '', descriptionMono: false, wide: false, closeDisabled: false },
);

const emit = defineEmits<{ close: [] }>();

/** 标题 id。用 useId() 而不是手写常量:同时开两个弹窗也不会撞(FileIcon 里同一套做法)。 */
const titleId = `modal-title-${useId()}`;
</script>

<template>
  <Transition name="guide">
    <div v-if="open" class="modal-overlay" @click.self="!closeDisabled && emit('close')">
      <div
        class="modal"
        :class="{ 'modal-wide': wide }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        v-bind="$attrs"
      >
        <ModalCloseButton :disabled="closeDisabled" @close="emit('close')" />

        <!-- 有 description 才起标题行:`.modal-title-row` 是 flex 基线对齐,右侧那格自带
             省略号截断,所以始终挂上原生 title(截不截断取决于视口与内容长度,静态判断不出来,
             而真截断时 tooltip 正是唯一能看全的手段)。 -->
        <div v-if="description" class="modal-title-row">
          <h2 :id="titleId" class="modal-title">{{ title }}</h2>
          <span
            class="modal-title-path"
            :class="{ mono: descriptionMono }"
            :title="description"
          >{{ description }}</span>
        </div>
        <h2 v-else :id="titleId" class="modal-title">{{ title }}</h2>

        <slot />

        <div v-if="$slots.footer" class="modal-actions">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Transition>
</template>
