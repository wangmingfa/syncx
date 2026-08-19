import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 开发 + 生产构建的根目录均为 web/(前端源码所在目录)
  root: 'web',
  plugins: [vue()],
  test: {
    // 集成测试会拉起真实 daemon(tsx 转译 + 5s 扫描周期 + 子进程同步),
    // 并行测试文件会互相争抢 CPU 导致间歇性超时;串行化保证稳定
    fileParallelism: false,
  },
  // 开发模式:Vite dev server 提供 web/ 的热重载(HMR),
  // 把 /api/*、/login 代理到 control server(127.0.0.1:8384),
  // 登录 cookie 与认证逻辑经代理转发保持一致。
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://127.0.0.1:8384',
      '/login': 'http://127.0.0.1:8384',
    },
  },
  // 生产构建:客户端 bundle,由浏览器加载 web/client.ts,
  // 接管交互(fetch + 局部刷新 + toast)。产物目录 dist/web(与源码目录对齐)。
  build: {
    target: 'es2020',
    outDir: resolve(root, 'dist/web'),
    lib: {
      entry: resolve(root, 'web/client.ts'),
      formats: ['es'],
      fileName: 'client',
    },
    rollupOptions: {
      external: ['vue'],
    },
  },
});
