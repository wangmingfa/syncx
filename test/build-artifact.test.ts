import { describe, it, expect } from 'vitest';
import { request } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createControlServer } from '../src/api.js';

/**
 * 打包产物 + Web 接口回归测试。
 *
 * 背景:build:single 通过 esbuild 插件把 vite 构建出的 Web 客户端 bundle
 * (dist/web/client.js) 内联进单文件 dist/syncx.js,使运行时无需任何磁盘文件。
 * 若插件 filter 与真实 import 路径对不上(曾经发生的回归),打包会「成功」但 client.js
 * 并未内嵌 —— 运行时 /client.js 返回空 body、页面白屏,且 dev 模式完全掩盖该问题。
 *
 * 本文件分两块:
 *  A. 静态断言 dist/syncx.js 确实内嵌了 web bundle(不依赖端口绑定 / 网络,沙箱可跑);
 *  B. 起一个进程内 control server,验证真正对外提供 Web UI 的接口
 *     (/、/client.js、/login、/favicon.svg)返回非空、Content-Type 正确。
 *
 * 测试依赖构建产物存在。CI 流水线 `npm run build` 在 `npm test` 之前执行,产物就绪;
 * 本地若未构建,相关用例以 skip 处理并给出提示,不会误红。
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bundlePath = join(repoRoot, 'dist', 'syncx.js');
const webClientPath = join(repoRoot, 'dist', 'web', 'client.js');
const hasArtifacts = existsSync(bundlePath) && existsSync(webClientPath);

function httpGet(
  port: number,
  path: string,
): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          contentType: (res.headers['content-type'] as string) ?? '',
          body: data,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('build artifact: dist/syncx.js embeds the web client bundle', () => {
  it.skipIf(!hasArtifacts)('bundle exists and is a self-contained single-file (>300KB)', () => {
    const bundleSize = statSync(bundlePath).size;
    // 单文件 = node 运行时 + 被内嵌的 web bundle;回归(未内嵌)时仅约 271KB,
    // 故 300KB 下限能有效区分「空壳」与「已内嵌」。
    expect(bundleSize).toBeGreaterThan(300_000);
  });

  it.skipIf(!hasArtifacts)('does NOT contain the disk-read residue (must use the embedded branch)', () => {
    const s = readFileSync(bundlePath, 'utf8');
    // src/web-client.ts 的「运行时从磁盘读 dist/web/client.js」分支一旦被打进单文件,
    // 就会残留该字符串;正确内嵌时该分支被 esbuild 插件替换,不应出现。
    expect(s).not.toContain('dist/web/client.js');
  });

  it.skipIf(!hasArtifacts)('contains the embedded web client markers (Vue runtime + DOM mount)', () => {
    const s = readFileSync(bundlePath, 'utf8');
    expect(s).toContain('__VUE__');
    expect(s).toContain('textContent');
    expect(s).toContain('appendChild');
  });
});

describe('control server serves the built web UI', () => {
  it('GET / returns the CSR page shell referencing /client.js', async () => {
    const server = createControlServer({ token: 'secret', getStatus: () => ({ ok: true }) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const r = await httpGet(port, '/');

    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/html');
    expect(r.body).toContain('<div id="app">');
    expect(r.body).toContain('/client.js');

    server.close();
  });

  it('GET /login returns the same CSR shell', async () => {
    const server = createControlServer({ token: 'secret', getStatus: () => ({ ok: true }) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const r = await httpGet(port, '/login');

    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/html');
    expect(r.body).toContain('<div id="app">');

    server.close();
  });

  it('GET /favicon.svg returns the inline SVG', async () => {
    const server = createControlServer({ token: 'secret', getStatus: () => ({ ok: true }) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const r = await httpGet(port, '/favicon.svg');

    expect(r.status).toBe(200);
    expect(r.contentType).toContain('image/svg+xml');
    expect(r.body).toContain('<svg');

    server.close();
  });

  it.skipIf(!hasArtifacts)('GET /client.js returns the full client bundle with JS content-type', async () => {
    const server = createControlServer({ token: 'secret', getStatus: () => ({ ok: true }) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const r = await httpGet(port, '/client.js');
    const expected = readFileSync(webClientPath, 'utf8');

    // 在 src/test 运行时,webClientJs 由 src/web-client.ts 从磁盘读取 dist/web/client.js;
    // 该用例同时验证了「路由把真实 web bundle 原样吐出」的端到端链路 —— 若这里返回空,
    // 说明 /client.js 的提供逻辑或构建产物本身出了问题。
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('application/javascript');
    expect(r.body).toBe(expected);
    expect(r.body).toContain('__VUE__');

    server.close();
  });
});
