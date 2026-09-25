import { describe, expect, it, vi } from 'vitest';

/**
 * 极简 CSR 路由解析(web/utils/route.ts)。route 是模块级状态,每个用例
 * resetModules 后重新 import,并先桩好 location/addEventListener/history
 * (模块加载即 parse 一次,还会挂 popstate 监听 —— node 环境没有这些全局)。
 */
async function routeAt(pathname: string, search = ''): Promise<{ name: string; folderId?: string; device?: string }> {
  vi.resetModules();
  vi.stubGlobal('location', { pathname, search });
  vi.stubGlobal('addEventListener', () => {});
  vi.stubGlobal('history', { pushState: () => {}, back: () => {} });
  const m = await import('../web/utils/route.js');
  return m.route.value;
}

describe('parse: /files 文件管理器路由', () => {
  it('/files 命中文件管理器页,无参数时不带 folderId', async () => {
    expect(await routeAt('/files')).toEqual({ name: 'files' });
    expect(await routeAt('/files/')).toEqual({ name: 'files' });
  });

  it('?folder= 透传目录 id,并解码 %2F 等转义', async () => {
    expect(await routeAt('/files', '?folder=f1')).toEqual({ name: 'files', folderId: 'f1' });
    expect(await routeAt('/files', '?folder=a%2Fb')).toEqual({ name: 'files', folderId: 'a/b' });
  });

  it('无关查询参数忽略(只认 folder)', async () => {
    expect(await routeAt('/files', '?x=1')).toEqual({ name: 'files' });
  });

  it('既有路由不受影响:status / terminal / compare 各自归位', async () => {
    expect(await routeAt('/')).toEqual({ name: 'status' });
    expect(await routeAt('/terminal')).toEqual({ name: 'terminal' });
    expect(await routeAt('/compare/f1', '?device=d2')).toEqual({
      name: 'compare',
      folderId: 'f1',
      device: 'd2',
    });
    // /filesX 不是文件管理器页(精确匹配,不做前缀放行)
    expect(await routeAt('/filesX')).toEqual({ name: 'status' });
  });
});
