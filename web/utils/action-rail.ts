/**
 * ActionRail(一排操作按钮的收起/展开组件)的数据契约。
 *
 * 类型判定放这里、组件只管渲染,与 utils/file-icon.ts 同构。
 */

/** 动作图标名。新增动作时在这里加一个键,并在 ActionIcon.vue 补对应画法。 */
export type ActionIconName =
  | 'pause'
  | 'play'
  | 'rescan'
  | 'compare'
  | 'diff'
  | 'history'
  | 'report'
  | 'versions'
  | 'trash'
  | 'restore'
  | 'browse'
  | 'ignore'
  | 'lock'
  | 'more';

/**
 * 一个动作。
 *
 * `icon` 与 `text` 至少一个由类型强制:写成判别联合而不是 `icon?: ...; text?: ...`,
 * 因为「两个都不给」的按钮在界面上是一个点不出任何东西的空位 —— 那种错不该等到
 * 运行时才发现,而 vue-tsc 会把「只写了 tooltip 忘了图标」直接拦下。
 *
 * `onClick` 必填:一个没有回调的动作没有存在意义,给它开缺省值只会让漏接线
 * 静默变成「点了没反应」。
 */
export type RailAction = {
  /** v-for 的稳定 key。必须稳定:展开动画靠 CSS transition 驱动同一批 DOM 节点,
   *  节点若因 key 变化被重建,动画会从中间帧重来。 */
  key: string;
  onClick: () => void;
  /** hover tooltip。可省 —— 但省掉后鼠标悬停没有任何解释,只适合旁边就有文字的按钮。 */
  tooltip?: string;
  disabled?: boolean;
  /** 危险动作(移除/删除):描边与文字转红,与现有 .act-delete 的语义色一致。 */
  danger?: boolean;
  /** 图标态下是否高亮为「已激活」(如目录已暂停时的播放键)。 */
  active?: boolean;
} & ({ icon: ActionIconName; text?: string } | { icon?: never; text: string });
