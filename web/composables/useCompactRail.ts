import { ref } from 'vue';

/**
 * 「紧凑形态」探测:没有可靠 hover 的设备(触屏),或窄到放不下整条动作胶囊的窗口。
 * ActionRail 用它决定渲染 hover 摊开的胶囊,还是「更多 → 全屏遮罩的贴底动作面板」。
 *
 * 条件是逗号并集(任一命中即紧凑):
 *  - `(hover: none)` —— 触屏上 tooltip 永远收不到、hover 展开也时有时无,
 *    纯图标胶囊根本读不动,和屏幕宽度无关(iPad 放不下胶囊也读不懂 tooltip);
 *  - `(max-width: 600px)` —— 桌面窗口拖窄时 13 个按钮(约 396px)照样溢出屏幕,
 *    与是否触屏无关。
 *
 * 单例(模块级 ref + 一个 change 监听):每张目录卡都挂一个 ActionRail,
 * 一人一个监听器纯属浪费;与 useTheme 的 darkQuery 同构。
 */
const compactQuery = window.matchMedia('(hover: none), (max-width: 600px)');

const compact = ref(compactQuery.matches);
compactQuery.addEventListener('change', (e) => {
  compact.value = e.matches;
});

export function useCompactRail(): typeof compact {
  return compact;
}
