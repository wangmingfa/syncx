import { ref, watch } from 'vue';

/**
 * 视觉风格(皮肤)模式:决定「材质语言」,与深浅主题(useTheme)**正交** ——
 * 每种皮肤自带浅色/深色两套令牌,CSS 按 `html[data-skin][data-theme]` 双属性覆盖。
 *
 *  - `slate`(板岩,缺省):不透明平面 + 细描边,项目沿用至今的形态;
 *  - `glass`(液态玻璃):半透明磨砂表面悬浮在光斑渐变底上,内缘高光描边。
 *
 * 缺省不落盘(与「跟随系统」同风格:默认态不占存储),localStorage 键与
 * index.html 首绘前脚本一致,两处改必须同步。
 */
export type SkinMode = 'slate' | 'glass';

const LS_KEY = 'syncx:skin';

function readStored(): SkinMode {
  try {
    return localStorage.getItem(LS_KEY) === 'glass' ? 'glass' : 'slate';
  } catch {
    return 'slate'; // 无痕模式没有 localStorage:静默回默认皮肤
  }
}

const mode = ref<SkinMode>(readStored());

/** 挂到 <html data-skin> 供 CSS 皮肤层选择;缺省也显式写,便于定向样式引用。 */
function apply(): void {
  document.documentElement.dataset.skin = mode.value;
}
apply();
watch(mode, apply);

/** 单例皮肤状态:顶栏下拉写入。模块级 ref 与 useTheme 同理 —— 全应用横切面。 */
export function useSkin(): {
  mode: typeof mode;
  setMode: (m: SkinMode) => void;
} {
  return {
    mode,
    setMode(m: SkinMode): void {
      mode.value = m;
      try {
        if (m === 'slate') localStorage.removeItem(LS_KEY);
        else localStorage.setItem(LS_KEY, m);
      } catch {
        /* 写不进去只影响跨会话记忆,本次会话内照常生效 */
      }
    },
  };
}
