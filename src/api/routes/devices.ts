import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlServerDeps } from '../deps.js';
import { pathname, readBody, redirect, sendJson } from '../helpers.js';

/** 设备域:设备增删(含手动地址)、从对端升级、手动重扫/重连(表单 + JSON API)。 */
export async function tryDeviceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
): Promise<boolean> {
  const { addDevice, removeDevice, selfUpdate, shutdown, rescan, reconnect } = deps;
  const path = req.url ? pathname(req.url) : '/';

  // POST /api/devices : 添加一个已知对端设备 ID
  if (req.method === 'POST' && path === '/api/devices' && addDevice) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw);
      if (typeof (body as any).deviceId !== 'string' || (body as any).deviceId === '') {
        sendJson(res, 400, { error: 'deviceId is required' });
        return true;
      }
      const address =
        typeof (body as any).address === 'string' && (body as any).address !== ''
          ? (body as any).address
          : undefined;
      addDevice((body as any).deviceId, address);
      sendJson(res, 201, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'failed to add device' });
    }
    return true;
  }

  // DELETE /api/devices?deviceId=xxx : 移除一个已知对端设备
  if (req.method === 'DELETE' && req.url && path === '/api/devices' && removeDevice) {
    const url = new URL(req.url, 'http://localhost');
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) {
      sendJson(res, 400, { error: 'deviceId is required' });
      return true;
    }
    removeDevice(deviceId);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // POST /api/devices/upgrade : 从对端拉取其安装包(tgz)并自更新(需认证)。
  // 失败(设备离线/版本不低于对方/校验不通过)返回 400 与原因,进程不动;
  // 成功时 updater 已派发,响应后延迟触发优雅关闭,由 updater 换入新包并重启。
  if (req.method === 'POST' && path === '/api/devices/upgrade') {
    if (!selfUpdate) {
      sendJson(res, 503, { error: 'self-update not available' });
      return true;
    }
    let body: { deviceId?: unknown } = {};
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return true;
    }
    if (typeof body.deviceId !== 'string' || body.deviceId === '') {
      sendJson(res, 400, { error: 'deviceId required' });
      return true;
    }
    try {
      const r = await selfUpdate(body.deviceId);
      sendJson(res, 200, { ok: true, version: r.version, restarting: true });
      setTimeout(() => shutdown?.(), 150);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  // Form POST /actions : 手动重扫或重连(需认证)
  if (req.method === 'POST' && path === '/actions') {
    const params = new URLSearchParams(await readBody(req));
    const action = params.get('action');
    if (action === 'rescan' && rescan) {
      rescan();
      redirect(res, '/?msg=' + encodeURIComponent('扫描已触发'));
      return true;
    }
    if (action === 'reconnect' && reconnect) {
      const deviceId = params.get('deviceId');
      if (deviceId) reconnect(deviceId);
      redirect(res, '/?msg=' + encodeURIComponent('重连已触发'));
      return true;
    }
    redirect(res, '/');
    return true;
  }

  // POST /api/reconnect?deviceId=xxx : 手动重连指定对端
  if (req.method === 'POST' && req.url && path === '/api/reconnect' && reconnect) {
    const url = new URL(req.url, 'http://localhost');
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) {
      sendJson(res, 400, { error: 'deviceId is required' });
      return true;
    }
    reconnect(deviceId);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
