import { defineConfig, type Plugin } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * 把构建产出的 CSS 内联进 JS bundle。
 *
 * 单文件后端(dist/syncx.js)只把 `dist/web/client.js` 内嵌进去,
 * 页面壳(UI_SHELL)里也没有 <link rel="stylesheet">。若 CSS 单独输出成
 * dist/web/client.css,单文件形态下样式会整份丢失 —— 前端又退回裸 HTML。
 * 这里把 CSS 收拢成一段运行时注入 <style> 的 JS,追加到 bundle 末尾。
 */
function inlineCssIntoJs(): Plugin {
  return {
    name: 'inline-css-into-js',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      let css = '';
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'asset' && fileName.endsWith('.css')) {
          css += String(output.source);
          delete bundle[fileName];
        }
      }
      if (css === '') return;

      const inject = `\n;(()=>{const el=document.createElement('style');el.textContent=${JSON.stringify(css)};document.head.appendChild(el);})();\n`;
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk' && fileName.endsWith('.js')) {
          output.code += inject;
        }
      }
    },
  };
}

export default defineConfig({
  // 开发 + 生产构建的根目录均为 web/(前端源码所在目录)
  root: 'web',
  plugins: [vue(), inlineCssIntoJs()],
  test: {
    // vitest 运行根目录回到仓库根(测试在 test/),与 vite dev/build 的 web/ 根分开
    // fileParallelism 保证集成测试串行化
    root: '..',
    fileParallelism: false,
  },
  // 开发模式:Vite dev server 提供 web/ 的热重载(HMR),
  // 把 /api/*、/login 代理到 control server(127.0.0.1:8384),
  // 登录 cookie 与认证逻辑经代理转发保持一致。
  // allowedHosts:局域网/外网访问时 Vite 会拒绝请求;手动白名单放行。
  server: {
    host: '0.0.0.0',
    // 固定端口:dev 下 8384 会把前端请求代理到这个地址(见 --dev-vite),
    // 端口一旦漂移,代理目标就静默失效。strictPort 让冲突直接报错而非换端口。
    port: 5173,
    strictPort: true,
    // 页面是从 8384 打开的,HMR 的 WebSocket 若按 location.port 连会打到 8384,
    // 而那里没有 HMR 端点。显式指回 vite 自身端口。
    // 注意:Vite 已废弃 server.hmr.clientPort,改用 server.ws.clientPort。
    ws: {
      clientPort: 5173,
    },
    allowedHosts: ['wmf3.com'],
    // 只代理 /api:登录与页面壳现在由 8384 侧统一处理。
    // 注意不能把 /login 也代理出去 —— dev 下 8384 会把非控制端点反向代理回来,
    // 形成 8384 → vite → 8384 的无限回环。
    proxy: {
      '/api': 'http://127.0.0.1:8384',
    },
  },
  // 顶层 define:Vite 不会替换 process.env.NODE_ENV,需手动注入。
  // 放错位置(如 build.define)会导致 Vue 跑在 dev 模式(TS 也会报 overload 错误)。
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  // 生产构建:客户端 bundle,由浏览器加载 web/client.ts,
  // 接管交互(fetch + 局部刷新 + toast)。产物目录 dist/web(与源码目录对齐)。
  build: {
    target: 'es2020',
    outDir: resolve(root, 'dist/web'),
    // lib 模式下 vite 默认不 minify。显式压缩避免内嵌到单文件后端后
    // syncx.js 中段保留一整份未压缩的 Vue 运行时源码(体积虚高)。
    minify: 'esbuild',
    lib: {
      entry: resolve(root, 'web/client.ts'),
      formats: ['es'],
      fileName: 'client',
    },
    rollupOptions: {
      // vue 一同打进 client.js,使内嵌到单文件后端后浏览器侧可独立运行,
      // 无需额外的 import map 或全局 vue。
    },
  },
});
