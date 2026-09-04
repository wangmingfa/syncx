import { describe, expect, it } from 'vitest';
import { createControlServer } from '../src/api.js';
import type { AddressInfo } from 'node:net';

// 回归:offer id 含冒号(:),前端用 encodeURIComponent 编码为 %3A。
// 路由提取时必须解码,否则与盘上存储的 id 不一致 → accept/decline 报 offer not found。
describe('offer accept/decline route decodes the encoded id', () => {
  const encodedId = encodeURIComponent('c335b0be:pair:AALQHUYOGA:');

  it('POST /api/offers/:id/accept passes the decoded id to acceptOffer', async () => {
    const accepted: string[] = [];
    const server = createControlServer({
      token: '',
      getStatus: () => ({}),
      getOffers: () => [],
      acceptOffer: (id) => {
        accepted.push(id);
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/offers/${encodedId}/accept`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(accepted).toEqual(['c335b0be:pair:AALQHUYOGA:']);

    server.close();
  });

  it('POST /api/offers/:id/decline passes the decoded id to declineOffer', async () => {
    const declined: string[] = [];
    const server = createControlServer({
      token: '',
      getStatus: () => ({}),
      getOffers: () => [],
      declineOffer: (id) => {
        declined.push(id);
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/offers/${encodedId}/decline`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(declined).toEqual(['c335b0be:pair:AALQHUYOGA:']);

    server.close();
  });
});
