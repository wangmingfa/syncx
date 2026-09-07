import { describe, expect, it } from 'vitest';
import { createControlServer } from '../src/api.js';
import type { AddressInfo } from 'node:net';

// 回归 1:offer id 含冒号(:),前端用 encodeURIComponent 编码为 %3A。
// 路由提取时必须解码,否则与盘上存储的 id 不一致 → accept/decline 报 offer not found。
// 回归 2:accept/decline 路由必须校验后缀。真实守护进程两个 handler 都注入,
// 若 accept 路由只判 startsWith('/api/offers/') 而不看后缀,会先截胡 /decline 请求,
// 用 ".../decline" 结尾的错误 id 查 offer → 报 offer not found。
// 因此两个用例都同时注入两个 handler(与真实注入方式一致),缺一不可。
describe('offer accept/decline routing', () => {
  const encodedId = encodeURIComponent('c335b0be:pair:AALQHUYOGA:');

  function createServer(accepted: string[], declined: string[]) {
    return createControlServer({
      token: '',
      getStatus: () => ({}),
      getOffers: () => [],
      acceptOffer: (id) => {
        accepted.push(id);
      },
      declineOffer: (id) => {
        declined.push(id);
      },
    });
  }

  async function listen(server: ReturnType<typeof createServer>): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  it('POST /api/offers/:id/accept passes the decoded id to acceptOffer', async () => {
    const accepted: string[] = [];
    const declined: string[] = [];
    const server = createServer(accepted, declined);
    const port = await listen(server);

    const res = await fetch(`http://127.0.0.1:${port}/api/offers/${encodedId}/accept`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(accepted).toEqual(['c335b0be:pair:AALQHUYOGA:']);
    expect(declined).toEqual([]);

    server.close();
  });

  it('POST /api/offers/:id/decline passes the decoded id to declineOffer', async () => {
    const accepted: string[] = [];
    const declined: string[] = [];
    const server = createServer(accepted, declined);
    const port = await listen(server);

    const res = await fetch(`http://127.0.0.1:${port}/api/offers/${encodedId}/decline`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(declined).toEqual(['c335b0be:pair:AALQHUYOGA:']);
    expect(accepted).toEqual([]);

    server.close();
  });

  it('POST /api/offers/:id/restore passes the decoded id to restoreOffer', async () => {
    const restored: string[] = [];
    const accepted: string[] = [];
    const declined: string[] = [];
    const server = createControlServer({
      token: '',
      getStatus: () => ({}),
      getOffers: () => [],
      acceptOffer: (id) => {
        accepted.push(id);
      },
      declineOffer: (id) => {
        declined.push(id);
      },
      restoreOffer: (id) => {
        restored.push(id);
      },
    });
    const port = await listen(server);

    const res = await fetch(`http://127.0.0.1:${port}/api/offers/${encodedId}/restore`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(restored).toEqual(['c335b0be:pair:AALQHUYOGA:']);
    expect(accepted).toEqual([]);
    expect(declined).toEqual([]);

    server.close();
  });
});
