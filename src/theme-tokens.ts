import { readFileSync } from 'node:fs';

/**
 * 设计变量(`:root { --bg / --border / --accent … }`)的唯一真相源是 `web/style.css`。
 *
 * 回退页(src/ui-fallback.ts)原先把这些色值**手抄**了一份,改 style.css 不会自动带过去,
 * 于是「无 JS 回退页与主应用视觉一致」这条保证只能靠人记得去同步两边 —— 现在改成直接取
 * style.css 里的 `:root` 块:一处定义,两处使用。
 *
 * - dev / tsx:从磁盘读 `web/style.css` 并抽出 `:root` 块。
 * - 单文件打包:esbuild 插件拦截本模块的导入,注入构建期抽好的字符串
 *   (与 src/web-client.ts 同一套路 —— 产物旁边没有源文件可读)。
 *
 * 只抽 `:root`,不抽深色主题块:回退页是无 JS 的静态页,`html[data-theme]` 由应用脚本
 * 写入,回退页永远只跑浅色。
 */

/**
 * 从整份 CSS 里取出 `:root { … }`。
 *
 * `[^}]*` 够用是因为 :root 块内只有声明、没有嵌套规则(里面的 var() 引用也都指向
 * 本块内的变量)。真出现嵌套时会返回空串而不是半截规则 —— 宁可让调用方发现「回退页
 * 没配色了」,也不要悄悄给出一份缺变量的样式。
 */
export function extractRootRule(css: string): string {
  return css.match(/:root\s*\{[^}]*\}/)?.[0] ?? '';
}

let themeRoot = '';
try {
  themeRoot = extractRootRule(readFileSync(new URL('../web/style.css', import.meta.url), 'utf8'));
} catch {
  // 打包态走 esbuild 插件注入,不会执行到这里;dev 下源文件缺失时保持空串,
  // 让回退页仍能出内容(只是退回浏览器默认配色),而不是把整个页面打挂。
  themeRoot = '';
}

export default themeRoot;
