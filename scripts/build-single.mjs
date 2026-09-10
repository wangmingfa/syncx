import { build, transformSync } from 'esbuild';
import { readFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outfile = fileURLToPath(new URL('../dist/syncx.js', import.meta.url));
const tmpfile = `${outfile}.tmp`;
const webClientPath = fileURLToPath(new URL('../dist/web/client.js', import.meta.url));

/**
 * 把 vite 构建出的 Web 客户端 bundle 内联为 'web-client' 模块,
 * 替换 dev 用的磁盘读取实现(src/web-client.ts),使最终单文件不依赖磁盘。
 */
const webClientPlugin = {
  name: 'web-client-embed',
  setup(b) {
    b.onResolve({ filter: /web-client(\.js)?$/ }, () => ({
      path: 'web-client-embedded',
      namespace: 'web-client-embedded',
    }));
    b.onLoad({ filter: /.*/, namespace: 'web-client-embedded' }, () => {
      let code = readFileSync(webClientPath, 'utf8');
      // 浏览器侧走 Vue 生产路径:把残留的 process.env.NODE_ENV 替换成字面量,
      // 交给下方 minify 常量折叠掉 dev 警告分支(若 vite 未做 define)。
      code = code.replace(/process\.env\.NODE_ENV/g, '"production"');
      // vite lib 模式默认不 minify,而 esbuild 的 bundle minify 不会压缩字符串字面量内容,
      // 故这里把内嵌进单文件的 web bundle 先压一层,避免 syncx.js 中段保留一大段未压缩源码。
      const minified = transformSync(code, { loader: 'js', target: 'es2020', minify: true });
      return {
        contents: `export default ${JSON.stringify(minified.code)};`,
        loader: 'js',
      };
    });
  },
};

await build({
  entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: tmpfile,
  packages: 'bundle',
  minify: true,
  treeShaking: true,
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __createRequire } from 'module';",
      // ESM 输出下,ws 等 CJS 依赖内部的动态 require 需一个真实 require;
      // 用 createRequire 提供,使其能解析 node 内置模块。
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  plugins: [webClientPlugin],
  logLevel: 'info',
});

// 先输出到临时文件,再原子重命名覆盖目标文件。
// 规避 Windows 实时防病毒/索引服务对 dist/syncx.js 的写锁(直接覆盖会 EPERM/Access denied)。
try {
  renameSync(tmpfile, outfile);
} catch (err) {
  // 极少数情况下重命名因目标被锁失败:删除目标后重试一次
  const { unlinkSync } = await import('node:fs');
  try {
    unlinkSync(outfile);
    renameSync(tmpfile, outfile);
  } catch (err2) {
    throw err2 instanceof Error ? err2 : new Error(String(err2));
  }
}

console.log(`built single-file bundle: ${outfile}`);
