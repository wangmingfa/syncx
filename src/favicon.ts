/**
 * 站点图标(SVG 源码)。
 *
 * 刻意不从磁盘读取 `web/favicon.svg`:
 * - 单文件打包形态(`dist/syncx.js`)运行时没有 `web/` 目录,磁盘读取必然失败;
 * - 失败若被静默吞掉,就会重演 `/client.js` 返回空内容导致整页白屏、
 *   且控制台不报错的问题(见 docs/code-review-2026-08-27.md 第 5 条)。
 *
 * 图标体积极小(数百字节),内联为常量可让 dev / tsc 运行 / 打包三种形态行为一致。
 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="7" fill="#0F6E56"/>
<g fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round">
<path d="M8.5 13H20"/>
<path d="M24 19H12"/>
</g>
<path d="M20 10.5 24.5 13 20 15.5Z" fill="#FFFFFF"/>
<path d="M12 16.5 7.5 19 12 21.5Z" fill="#FFFFFF"/>
</svg>
`;
