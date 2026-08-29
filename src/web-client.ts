import { readFileSync } from 'node:fs';

/**
 * Web 客户端 bundle 内容。
 *
 * - dev / 非打包运行时:从磁盘读取 vite 生产构建产物 `dist/web/client.js`。
 * - 单文件打包时:esbuild 插件会拦截 `./web-client` 这个导入,
 *   直接返回内嵌的 client.js 字符串,从而无需任何磁盘文件依赖。
 *
 * 用真实模块(而非仅 .d.ts 虚拟声明)是为了让 dev / tsx 也能解析此导入,
 * 否则 `npm run dev` 启动会因找不到裸模块名而崩溃。
 */
let webClientJs = '';
try {
  webClientJs = readFileSync(new URL('../dist/web/client.js', import.meta.url), 'utf8');
} catch {
  webClientJs = '';
}

export default webClientJs;
