import { onUnmounted, watch } from 'vue';

/**
 * 弹窗 Esc 关闭的层叠登记表 —— 模块级单例(同 elevation.ts 的理由:弹窗分属不同组件树,
 * 没有共同祖先可以 provide;「Esc 只关最上层」天然是全局规则)。
 *
 * 规则只有一条:Esc 永远派发给**栈顶**那一条登记,栈序 = 开启序(后开的画在上面)。
 * 于是「同步记录弹窗上叠着二次确认」时,一响 Esc 只收掉确认层;再按一次,才轮到底下那层。
 * 栈顶自己决定怎么消费:忙碌(closeDisabled)时吞掉按键不做任何事 —— 隔着遮罩把底下
 * 那层关掉,比关不掉更让人糊涂。
 *
 * 全局只挂**一个** keydown:若每个弹窗自己往 window 上挂,两层同时开着一响就是竞速,
 * 谁后注册谁先跑,与视觉上的层叠序无关 —— 那正是要避免的。FileDiffModal 那种
 * 「Esc 先撤二次确认、不关窗」的特殊语义也走同一条登记(见它的 onEsc),才能与
 * 别的弹窗公平竞争「最上层」。
 */

interface EscEntry {
  /** 收到 Esc(仅当本条是栈顶)时执行;关窗、撤确认还是忽略,由登记方自己决定。 */
  onEsc: () => void;
}

/** 当前开着的、声明了「Esc 归我管」的弹窗层,按开启先后排;末尾即最上层。 */
const stack: EscEntry[] = [];

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    // 输入法组合中的 Esc 是「取消候选」不是「关弹窗」;已被别处 preventDefault 的也不接
    if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
    stack[stack.length - 1]?.onEsc();
  });
}

/**
 * 在组件 setup 里调用:`open` 为真期间把 `onEsc` 登记进栈,为假即除名;组件卸载自动清理,
 * 登记表里不留死条目。栈顶才能收到 Esc —— 多层同开时底下那层即使也开了 escClose 也听不见。
 */
export function useEscStackTop(open: () => boolean, onEsc: () => void): void {
  const entry: EscEntry = { onEsc };
  watch(open, (isOpen) => {
    const idx = stack.indexOf(entry);
    if (isOpen && idx === -1) stack.push(entry);
    else if (!isOpen && idx !== -1) stack.splice(idx, 1);
  }, { immediate: true });
  onUnmounted(() => {
    const idx = stack.indexOf(entry);
    if (idx !== -1) stack.splice(idx, 1);
  });
}
