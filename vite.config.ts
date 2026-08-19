import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
  test: {
    // 集成测试会拉起真实 daemon(tsx 转译 + 5s 扫描周期 + 子进程同步),
    // 并行测试文件会互相争抢 CPU 导致间歇性超时;串行化保证稳定
    fileParallelism: false,
  },
  build: {
    target: 'node22',
    outDir: resolve(root, 'dist/ui'),
    ssr: true,
    lib: {
      entry: resolve(root, 'src/web/server.ts'),
      formats: ['es'],
      fileName: 'server',
    },
    rollupOptions: {
      external: ['vue', '@vue/server-renderer'],
    },
  },
});
