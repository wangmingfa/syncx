/**
 * 极简前端路由(不引 vue-router)。
 *
 * 项目是纯 CSR 单页应用,只有一个页面壳;为几个页面(状态页 / 双栏对比页 / 终端页 /
 * 文件管理器页)引入路由库属于杀鸡用牛刀,故直接解析 location:
 *  - `/`              → 状态页
 *  - `/compare/<id>`  → 双栏对比页(?device=<id> 预选对比设备)
 *  - `/terminal`      → 浏览器内终端(完整 PTY + xterm.js)
 *  - `/files`         → 文件管理器(?folder=<id> 直接进入该共享目录)
 *
 * 用**路径路由**而不是哈希路由:链接可分享、可刷新、可收藏。代价是服务端必须为
 * `/compare/*`、`/terminal` 与 `/files` 回页面壳(已在 api/routes/auth.ts 处理),
 * 否则刷新直接 404。
 */
import { ref, type Ref } from 'vue';

export interface Route {
  name: 'status' | 'compare' | 'terminal' | 'files';
  /** 对比页 / 文件管理器页的目录 id(已 URI 解码)。 */
  folderId?: string;
  /** 预选的对比设备(来自 ?device=);未给则由页面让用户选。 */
  device?: string;
}

/** 只认一层:`/compare/<folderId>`,更深的路径不视为对比页。 */
const COMPARE_RE = /^\/compare\/([^/]+)\/?$/;

function parse(): Route {
  const { pathname, search } = globalThis.location;
  if (pathname === '/terminal' || pathname === '/terminal/') {
    return { name: 'terminal' };
  }
  if (pathname === '/files' || pathname === '/files/') {
    const folder = new URLSearchParams(search).get('folder');
    return {
      name: 'files',
      ...(folder ? { folderId: decodeURIComponent(folder) } : {}),
    };
  }
  const m = COMPARE_RE.exec(pathname);
  if (m && m[1]) {
    const device = new URLSearchParams(search).get('device');
    return {
      name: 'compare',
      folderId: decodeURIComponent(m[1]),
      ...(device ? { device } : {}),
    };
  }
  return { name: 'status' };
}

export const route: Ref<Route> = ref(parse());

/** 前端跳转:改地址栏 + 更新路由,不刷新页面。 */
export function navigate(url: string): void {
  globalThis.history.pushState({}, '', url);
  route.value = parse();
}

/** 返回上一页(浏览器前进/后退由 popstate 同步)。 */
export function goBack(): void {
  globalThis.history.back();
}

globalThis.addEventListener('popstate', () => {
  route.value = parse();
});
