import { ref } from 'vue';

/**
 * 敏感操作提权(终端 / 文件管理器)—— 模块级单例状态。
 *
 * 为什么要提权:登录会话能看状态、能加目录,但终端(整机 shell)和文件管理器
 * (列盘面/下载/删除)危险一档。二者共享同一条门:进入前用控制令牌或账号密码
 * 再验一次,拿到 10 分钟短时效提权 cookie;页面闲置超过 10 分钟视为过期,
 * 下次进入要重新验证。服务端(POST/GET /api/elevate、文件路由 403、终端 WS 403)
 * 才是权威,这里的状态只是减少弹窗的 UX 层。
 *
 * 为什么是模块级单例:入口分散在 StatusTopbar(终端菜单)、useFolders(浏览文件)、
 * TerminalPage(整页门),这些组件分属不同页面且没有共同的祖先上下文可用 ——
 * 模块单例让「是否已提权 / 门开着吗」全局一致,又不需要把状态沿 provide 链穿三层。
 */

/** 闲置多久后要求重新验证。 */
export const ELEVATE_IDLE_MS = 10 * 60 * 1000;

/** 最近一次验证成功的时间戳;0 = 本页会话从未验证过。 */
const elevatedAt = ref(0);
/** 验证弹窗开关与目的文案(显示在弹窗副标题,让用户知道在为什么操作授权)。 */
export const gateOpen = ref(false);
export const gatePurpose = ref('');
/** 门是否锁定(不可关闭):终端页整页被拦,允许关掉只会留下一个死页面。 */
export const gateLocked = ref(false);

/** 待执行的敏感动作:验证成功后自动接续,用户不用再点一次入口。 */
let pendingAction: (() => void) | null = null;

/** 最后一次用户活动时间(任意指针/键盘/滚轮活动都算「操作」)。 */
let activityAt = Date.now();
if (typeof window !== 'undefined') {
  const touch = (): void => {
    activityAt = Date.now();
  };
  // passive 监听只为记录时间,绝不阻塞交互;mousemove 不算 —— 挂机时扫过的鼠标不该续命
  for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) {
    window.addEventListener(ev, touch, { passive: true });
  }
}

/** 提权是否仍然新鲜:验证过、且自最后一次用户活动起没超过闲置窗口。 */
function isFresh(): boolean {
  return elevatedAt.value > 0 && Date.now() - activityAt < ELEVATE_IDLE_MS;
}

/** 是否已提权(新鲜)。 */
export const elevated = ref(false);

// 软定时器:每 20s 刷新一次 elevated 快照,闲置超限自动失效(下次敏感操作重新弹门)
if (typeof window !== 'undefined') {
  window.setInterval(() => {
    elevated.value = isFresh();
  }, 20_000);
}

/** 服务端权威校验:GET /api/elevate(401 视为未提权;会话过期由调用方另行处理)。 */
async function serverElevated(): Promise<boolean> {
  try {
    const res = await fetch('/api/elevate');
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

/**
 * 敏感操作入口的统一守卫:
 * 已提权(先看本地新鲜度,再向服务端确认)→ 直接执行动作;
 * 未提权 → 记下动作并弹验证门,验证成功后自动接续。
 * 返回是否已立即放行(false = 弹了门,等验证成功后执行)。
 * `opts.locked` = 弹出的门不允许关闭(终端页整页被拦时用)。
 */
export async function ensureElevated(
  purpose: string,
  action: () => void,
  opts?: { locked?: boolean },
): Promise<boolean> {
  activityAt = Date.now();
  if (isFresh() && (await serverElevated())) {
    elevated.value = true;
    action();
    return true;
  }
  elevated.value = false;
  gatePurpose.value = purpose;
  gateLocked.value = opts?.locked === true;
  pendingAction = action;
  gateOpen.value = true;
  return false;
}

/** 验证成功回调(LoginForm elevate 模式):关门、记账、接续被拦下的动作。 */
export function gateSuccess(): void {
  elevatedAt.value = Date.now();
  activityAt = Date.now();
  elevated.value = true;
  gateOpen.value = false;
  gateLocked.value = false;
  const action = pendingAction;
  pendingAction = null;
  action?.();
}

/** 用户主动关掉验证门(点了 × / 遮罩):放弃本次动作,挂起的回调一并清掉,
 *  不然之后从别的入口(如终端页自己的门)验证通过时会把陈年动作突然执行掉。
 *  锁定态(终端页)关门无意义,x/遮罩已被 ModalShell 挡住,这里再兜一层。 */
export function gateDismiss(): void {
  if (gateLocked.value) return;
  pendingAction = null;
  gateOpen.value = false;
}

/** 供整页门(TerminalPage)查询闲置是否超限 —— 超限则回收会话、重新验证。 */
export function idleExpired(): boolean {
  return Date.now() - activityAt >= ELEVATE_IDLE_MS;
}
