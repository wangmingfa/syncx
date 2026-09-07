import { defineConfig, type Plugin } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { codeInspectorPlugin } from 'code-inspector-plugin';

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

// code-inspector 是 dev 态「点击元素跳 IDE」的便利插件;测试(vitest)与生产
// 构建都不需要它。受限环境(沙箱)下其临时目录创建会被拦截,导致 vitest 在
// 配置加载/转换阶段直接失败,故仅在非测试模式下启用(VITEST 由 vitest 注入)。
export default defineConfig(({ mode }: { mode: string }) => {
  // code-inspector 是 dev 态「点击元素跳 IDE」的便利插件;测试(vitest, mode=test)
  // 与生产构建都不需要它。受限环境(沙箱)下其临时目录创建会被拦截,导致 vitest
  // 在配置加载/转换阶段直接失败,故仅在非测试模式下启用。
  const isTest = mode === 'test';
  return {
  // 开发 + 生产构建的根目录均为 web/(前端源码所在目录)
  root: 'web',
  plugins:[
    vue(),
    inlineCssIntoJs(),
    ...(isTest ? [] : [codeInspectorPlugin({
      bundler: 'vite',
    })]),
  ],
  test: {
    // vitest 运行根目录回到仓库根(测试在 test/),与 vite dev/build 的 web/ 根分开。
    // 注意:test.root 是相对「项目根(即本配置所在目录)」解析,不是相对 web/。
    // 写 '..' 会抬到仓库上级(如 D:/code),连带扫描 wmfx 等兄弟仓库的测试;
    // 仓库根应为 '.'。fileParallelism 保证集成测试串行化。
    root: '.',
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
    // HMR 的 WebSocket 不再需要 ws.clientPort:dev 下页面由 vite 自身(5173)
    // 直接提供,浏览器按 location.port 连过来正好命中 HMR 端点。
    // (旧写法是为了兼容"页面从 8384 打开"的反向代理形态,该形态已废弃。)
    allowedHosts: ['wmf3.com'],
    // dev 下浏览器经 8384 的页面会 302 跳到 5173(vite 原生 HMR 源),
    // 因此 5173 才是前端实际运行域。这里把前端需要的控制端点代理回 8384:
    // - /api:JSON 控制 API(状态/扫描/配对等)
    // - /login:仅代理 POST(登录提交,8384 下发 HttpOnly cookie);
    //   GET /login 是页面壳,交给 vite 自身 SPA fallback 返回 index.html,避免回环。
    // - /favicon.svg:8384 侧提供的站点图标,避免 5173 页面 404。
    proxy: {
      '/api': 'http://127.0.0.1:8384',
      '/favicon.svg': 'http://127.0.0.1:8384',
      '/login': {
        target: 'http://127.0.0.1:8384',
        changeOrigin: true,
        // GET /login 不代理(返回 index.html 让前端渲染登录表单);POST /login 才转发到 8384
        bypass(req) {
          return req.method === 'GET' ? '/login' : undefined;
        },
      },
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
    // vite root 是 web/,outDir(dist/web)在 root 之外,vite 默认不清理并警告。
    // 这里是纯构建产物目录(单文件后端只内嵌 client.js),清空是安全且必要的:
    // 不清空会残留旧产物,被 build:single 一并内嵌。
    emptyOutDir: true,
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
  };
});
