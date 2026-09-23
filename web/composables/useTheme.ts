import { computed, ref, watch } from 'vue';

/** 主题模式:system = 跟随系统偏好;light/dark = 用户显式选择(存 localStorage)。 */
export type ThemeMode = 'system' | 'light' | 'dark';

const LS_KEY = 'syncx:theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function readStored(): ThemeMode {
  try {
    const v = localStorage.getItem(LS_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system'; // 无痕模式没有 localStorage:静默按「跟随系统」
  }
}

const mode = ref<ThemeMode>(readStored());
const systemDark = ref(darkQuery.matches);
darkQuery.addEventListener('change', (e) => {
  systemDark.value = e.matches;
});

/** 实际生效的主题。 */
const resolved = computed<'light' | 'dark'>(() =>
  mode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : mode.value,
);

/** 挂到 <html data-theme> 上供 CSS 变量层切换;index.html 的首绘前脚本用同一键位。 */
function apply(): void {
  document.documentElement.dataset.theme = resolved.value;
}
apply();
watch(resolved, apply);

/**
 * 单例主题状态:顶栏按钮写入,App.vue 读取(naive-ui 的 darkTheme 跟随 resolved)。
 * 模块级 ref 而非 provide/inject:主题是全应用横切面,挂谁身上都不公平。
 */
export function useTheme(): {
  mode: typeof mode;
  resolved: typeof resolved;
  setMode: (m: ThemeMode) => void;
} {
  return {
    mode,
    resolved,
    setMode(m: ThemeMode): void {
      mode.value = m;
      try {
        // 「跟随系统」= 清除显式选择,回到默认;其余两档落盘
        if (m === 'system') localStorage.removeItem(LS_KEY);
        else localStorage.setItem(LS_KEY, m);
      } catch {
        /* 写不进去只影响跨会话记忆,本次会话内照常生效 */
      }
    },
  };
}
