import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
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
