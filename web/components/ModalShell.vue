<script setup lang="ts">
import { useId } from 'vue';
import ModalCloseButton from './ModalCloseButton.vue';

/**
 * 弹窗外壳 —— 全部弹窗共用的骨架(21 处引用):遮罩 + 过渡 + dialog + 关闭按钮 + 标题行
 * + 正文滚动区 + 动作区容器。
 *
 * 为什么值得抽出来:这几层一直是一模一样的,只有中间的内容不同,于是每个弹窗都自己抄一遍
 * `<Transition name="guide">` + `.modal-overlay` + `role="dialog" aria-modal` + 手写
 * `aria-labelledby` 的 id。任何一层要改(比如「忙碌时不许点遮罩关闭」)都得改 20 遍,
 * 而漏掉的那一个不会报错 —— 只会静静地行为不一致。
 *
 * 滚动只发生在**正文**:dialog 是定高 flex 列,标题行与动作区 `flex: none` 不参与压缩,
 * 默认 slot 被包在 `.modal-body` 里独自滚动。长内容从「整块弹窗跟着滚」变成「只有正文滚」,
 * 于是滚到哪都看得见自己开的是哪个弹窗、确认按钮在哪 —— 这套分工由外壳统一提供,
 * 弹窗自己不要再套滚动容器(需要内部窗格的对比弹窗是唯一的例外,见 style.css 的
 * `.fd-modal .modal-body`)。
 *
 * 四个可配置的位置:
 *  - `title`(prop):标题。`aria-labelledby` 指向它,id 由 `useId()` 生成 —— 原先手写的
 *    `guide-title` / `fd-title` 一类固定 id 每加一个弹窗就要新起一个名字,还得担心撞车。
 *  - `description`(prop):标题**右侧**的说明,通常是目录路径或一句副标题。给了才渲染
 *    `.modal-title-row`;不给就还是裸 `h2`(保留它 4px 的下边距),空的标题行会白占高度。
 *  - 默认 slot:正文,挂在 `.modal-body` 里滚动。
 *  - `footer` slot:底部动作区。**容器由外壳提供**,这样 `.modal-actions` 那套「按钮按内容
 *    宽度排、整组靠右、窄屏换行」的规则不会因为某个弹窗忘了套而失效(footer 为空时连容器
 *    都不渲染,省掉 18px 的 `margin-top`)。
 *
 * 刻意**不做**的一件事:
 *  - 不管 Esc。看着该由外壳统一处理,但弹窗可以叠加(同步记录弹窗里点「清空记录」会再开一层
 *    确认弹窗),挂在 window 上的 keydown 一响就会把两层一起关掉。要做得先定「只关最上面
 *    那层」的规则,那是另一件事。今天只有对比弹窗自己处理 Esc(它还兼着「先撤销覆盖确认」
 *    的语义,不是单纯的关闭),维持原样。
 *
 * 样式在文件末尾的 `<style>` 里(组件自有样式放组件内),但**不带 scoped** —— 两条理由写在那块
 * 注释里:类名由调用方模板共写(`.modal-lead`、`#footer` 里的按钮),而 scoped 抬的那一档特异度
 * 会把调用方的宽度覆盖打成「靠注入顺序取胜」。反过来,只有本组件写的 `.modal-close` /
 * `.modal-close-x` 已经搬进 `ModalCloseButton.vue` 并**敢用 scoped**(那两个类名没有第二个写主,
 * 也就没有覆盖要被压)。只有 `.guide-*` 开合动画仍留在 `web/style.css`:那几条裸选择器还被
 * `DropOverlay.vue` 用着,拆过来会让同一组规则分处两地。
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
    /**
     * 彻底不可关闭:不渲染右上角 ×,且遮罩点击不再触发 close(与 closeDisabled 同挡遮罩)。
     * 用于「版本不一致」这类用户没有退出余地的强制弹窗;Esc 本就不由外壳处理,天然关不掉。
     */
    hideClose?: boolean;
  }>(),
  { description: '', descriptionMono: false, wide: false, closeDisabled: false, hideClose: false },
);

const emit = defineEmits<{ close: [] }>();

/** 标题 id。用 useId() 而不是手写常量:同时开两个弹窗也不会撞(FileIcon 里同一套做法)。 */
const titleId = `modal-title-${useId()}`;
</script>

<template>
  <Transition name="guide">
    <div v-if="open" class="modal-overlay" @click.self="!closeDisabled && !hideClose && emit('close')">
      <div
        class="modal"
        :class="{ 'modal-wide': wide }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        v-bind="$attrs"
      >
        <ModalCloseButton v-if="!hideClose" :disabled="closeDisabled" @close="emit('close')" />

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

        <div class="modal-body">
          <slot />
        </div>

        <div v-if="$slots.footer" class="modal-actions">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Transition>
</template>

<style>
/* ⚠️ 这块刻意**不带 scoped**,两条理由任一被破坏都会静默走样:
   1. 这套类名不只写在本组件模板里:`.modal-lead` 由调用方写(如待处理冲突弹窗的导语),
      `#footer` 里的按钮更是调用方渲染的节点 —— 它们带的是**调用方的** scope 属性。scoped
      只认本组件模板的节点,于是 `.modal-lead` 与 `.modal-actions > *` 会一起失灵。
   2. scoped 给每条选择器抬一档特异度:单类的 `.modal-wide[data-v-*]` 就是 (0,2,0),与按仓库
      约定写成双类的调用方覆盖(`.modal-wide.conflict-modal`、`.modal.fd-modal`、
      `.modal.settings-modal`…)**打平**,胜负掉到注入顺序上 —— 而 style.css 在组件样式**之后**
      注入(`web/client.ts` 第 2 行先求值整棵组件图,第 3 行才 `import './style.css'`;要复核就在
      `npm run build:web` 后比较 `dist/web/client.js` 里 `.modal-overlay{` 与
      `.modal.fd-modal{` 两处下标,前者明显更小)。覆盖会赢,但赢法是 AGENTS.md 明令禁止的
      「后来者胜」。不带 scoped 时外壳全是单类 (0,1,0),双类覆盖靠特异度稳赢,不看顺序。
   不加 scoped 依旧满足「组件自有样式放组件内」:样式跟着模板一起搬,编译产物依旧是全局 CSS。
   只有 `.guide-*` 开合动画仍留在 `web/style.css`:那几条裸选择器还被 `DropOverlay.vue` 用着,
   拆过来会让同一组规则分处两地。 */

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgb(22 32 52 / 0.4);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: var(--z-overlay);
}

.modal {
  position: relative;
  width: 100%;
  max-width: 520px;
  max-height: 88vh;
  /* 定高 flex 列 + 自身不滚:滚动交给正文那一段(见下面 .modal-body)。
     原先是 overflow-y: auto 让整块滚 —— 内容一长,标题滚出视野、按钮也滚出视野,
     用户既不记得自己在哪个弹窗,也得先把弹窗滚到底才能点「保存」。 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 26px 26px 22px;
  box-shadow: 0 24px 60px -24px rgb(22 32 52 / 0.45);
}

/* 标题与动作区是「不滚动的那两段」:flex: none 既挡住被压缩,也挡住让位。
   ⚠️ 别给它们 flex-shrink 的余地 —— 正文撑满时标题先被压扁,比滚动条更难解释。 */
.modal-title,
.modal-title-row,
.modal-actions {
  flex: none;
}

/* 唯一的滚动区。min-height: 0 是这条链的关键:flex 子项的默认最小高度是内容高度,
   不写的话正文会顶穿 .modal 的 max-height,滚动条又跑回整块弹窗上。
   滚动条**贴弹窗内壁**:容器用负 margin 抵掉 .modal 的左右内衬,再用等值 padding 把正文
   推回原位 —— 正文盒仍与标题/动作区逐像素对齐(左右各 26px),挪位置的只有滚动条那一条。
   一个顺带的后果:滚动容器自成 BFC,正文首元素的 margin-top 不再与标题的下边距折叠,
   两者相加。实测只有「首块自带 18px 顶距」的编辑目录 / 分享弹窗受影响,多出 12px 的
   段前距 —— 那是分节标签本来就该有的距离,不做 first-child 归零(Vue 的 v-if 会留注释
   节点占位,`:first-child` 在这些弹窗里根本匹配不上,规则会静默失灵)。 */
.modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* 滚到尽头不带动背后的页面:弹窗是独立视口,连锁滚动会让人以为在滚底下那页 */
  overscroll-behavior: contain;
  margin-inline: -26px;
  padding-inline: 26px;
}

/* 右上角关闭按钮的样式跟着它的标记一起搬进了
   `web/components/ModalCloseButton.vue`(那两个类名只有那里写,所以那块敢用 scoped)。
   这里只留一条提醒:它的 `top/right: 14px` 定位吃的是上面 `.modal` 的 `position: relative`
   与 26px 内衬 —— 改了 `.modal` 那两条,那颗角会跟着飘。 */

.modal-title {
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin-bottom: 4px;
}

/* 标题与目录路径同一行,长路径省略号截断,悬停 title 看全 */
.modal-title-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  margin-bottom: 12px;
}

.modal-title-row .modal-title {
  margin-bottom: 0;
  flex-shrink: 0;
}

.modal-title-path {
  color: var(--muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* 正文导语:比标题退一档的说明文字。写在调用方模板里,所以样式必须全局可达。 */
.modal-lead {
  color: var(--muted);
  font-size: 13px;
  margin-bottom: 16px;
}

/* 需要更宽的弹窗:同步记录(容纳列表)、使用指南(520px 下四步正文被挤成窄长条 ——
   640 是拐点,再宽各行不再变短、反而行长超过舒适阅读宽度)。由 `wide` prop 挂上。 */
.modal-wide {
  max-width: 640px;
}

/* 弹窗底部动作区:按钮**按内容宽度**排,整组靠右。
   早先这里是 `.modal-actions > * { flex: 1 }`(等宽铺满),窄弹窗(520)下看不出来,
   一到大弹窗就崩:对比弹窗(96% 宽)里三个按钮各 ~370px、拓扑弹窗单个「关闭」~590px、
   使用指南的「我知道了」整条 588px —— 读起来像几根横杠,分不清哪颗按钮重要。
   等宽铺满还有个副作用:按钮宽度跟着**弹窗宽度**走,同一颗「关闭」在不同弹窗里宽度不同。 */
.modal-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  justify-content: flex-end;
  /* 窄屏(360)三个按钮放不下时整体换行,而不是让按钮溢出弹窗 */
  flex-wrap: wrap;
}

/* 显式写 `flex: 0 1 auto`(即默认值)是为了钉住这个决定:⚠️ 别改回 `flex: 1`,
   那正是「大弹窗里按钮很宽」的成因。宽度交给 naive-ui 的左右 padding + 文字决定。
   二次确认行里的说明文字也按同一条规则排(见 `.fd-confirm__msg`,它**不能**设
   `flex-grow`),这样「警示 + 两颗按钮」是一个整体、整组靠右 —— 焦点不被拉开。 */
.modal-actions > * {
  flex: 0 1 auto;
}
</style>
