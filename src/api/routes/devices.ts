import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlServerDeps } from '../deps.js';
import { pathname, readBody, redirect, sendJson } from '../helpers.js';

/** 设备域:设备增删(含手动地址)、从对端升级、手动重扫/重连(表单 + JSON API)。 */
export async function tryDeviceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
): Promise<boolean> {
  const { addDevice, removeDevice, selfUpdate, shutdown, rescan, reconnect, setFolderPaused, setGlobalPaused, setGlobalSettings, testWebhook, restoreFolderVersion, deleteFolderVersion } = deps;
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

  // POST /api/settings : 全局设置(设置弹窗)。键出现才改;值为 null = 回默认。
  // 校验/拒绝非法值在 devices.setGlobalSettings,错误原样透出(400 + 原因)。
  if (req.method === 'POST' && path === '/api/settings' && setGlobalSettings) {
    try {
      const raw = await readBody(req);
      const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>;
      // 数字字段逐一校验:非有限数字一律拒绝,不静默吞掉
      for (const key of ['maxSendKbps', 'versionsPerPath', 'historyMaxEvents', 'batteryPauseThreshold'] as const) {
        if (!(key in body)) continue;
        const v = body[key];
        if (v !== null && !Number.isFinite(Number(v))) {
          sendJson(res, 400, { error: `${key} must be a number or null` });
          return true;
        }
      }
      // 电源守卫/分享开关是布尔(null = 关闭);范围校验在 devices.setGlobalSettings
      for (const key of ['pauseOnMeteredNetwork', 'pauseOnLowBattery', 'shareEnabled'] as const) {
        if (!(key in body)) continue;
        const v = body[key];
        if (v !== null && typeof v !== 'boolean') {
          sendJson(res, 400, { error: `${key} must be a boolean or null` });
          return true;
        }
      }
      // webhook 两键是字符串(null = 清除);格式校验在 devices.setGlobalSettings
      for (const key of ['webhookUrl', 'webhookSecret'] as const) {
        if (!(key in body)) continue;
        const v = body[key];
        if (v !== null && typeof v !== 'string') {
          sendJson(res, 400, { error: `${key} must be a string or null` });
          return true;
        }
      }
      setGlobalSettings({
        ...(('maxSendKbps' in body) ? { maxSendKbps: body.maxSendKbps === null ? null : Number(body.maxSendKbps) } : {}),
        ...(('versionsPerPath' in body) ? { versionsPerPath: body.versionsPerPath === null ? null : Number(body.versionsPerPath) } : {}),
        ...(('historyMaxEvents' in body) ? { historyMaxEvents: body.historyMaxEvents === null ? null : Number(body.historyMaxEvents) } : {}),
        ...(('webhookUrl' in body) ? { webhookUrl: body.webhookUrl === null ? null : String(body.webhookUrl) } : {}),
        ...(('webhookSecret' in body) ? { webhookSecret: body.webhookSecret === null ? null : String(body.webhookSecret) } : {}),
        ...(('pauseOnMeteredNetwork' in body) ? { pauseOnMeteredNetwork: body.pauseOnMeteredNetwork === null ? null : Boolean(body.pauseOnMeteredNetwork) } : {}),
        ...(('pauseOnLowBattery' in body) ? { pauseOnLowBattery: body.pauseOnLowBattery === null ? null : Boolean(body.pauseOnLowBattery) } : {}),
        ...(('batteryPauseThreshold' in body) ? { batteryPauseThreshold: body.batteryPauseThreshold === null ? null : Number(body.batteryPauseThreshold) } : {}),
        ...(('shareEnabled' in body) ? { shareEnabled: body.shareEnabled === null ? null : body.shareEnabled === true } : {}),
      });
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : '保存设置失败' });
    }
    return true;
  }

  // POST /api/settings/webhook-test : 向已配置地址真实发一条测试事件,同步等回执。
  if (req.method === 'POST' && path === '/api/settings/webhook-test' && testWebhook) {
    try {
      const r = await testWebhook();
      if (r.ok) sendJson(res, 200, { ok: true });
      else sendJson(res, 400, { error: r.error ?? 'Webhook 测试失败' });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Webhook 测试失败' });
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
    // 暂停/恢复某目录的同步(fallback UI 的目录卡开关)
    if (action === 'pause-folder' && setFolderPaused) {
      const folderId = params.get('folderId');
      if (folderId) setFolderPaused(folderId, params.get('paused') === '1');
      redirect(res, '/?msg=' + encodeURIComponent(params.get('paused') === '1' ? '目录同步已暂停' : '目录同步已恢复'));
      return true;
    }
    // 全局暂停/恢复同步(fallback UI 的总开关)
    if (action === 'pause-global' && setGlobalPaused) {
      setGlobalPaused(params.get('paused') === '1');
      redirect(res, '/?msg=' + encodeURIComponent(params.get('paused') === '1' ? '已全局暂停同步' : '已恢复同步'));
      return true;
    }
    // 文件版本:恢复 / 删除(fallback 版本页的行内按钮)
    if (action === 'restore-version' && restoreFolderVersion) {
      const folderId = params.get('folderId');
      const file = params.get('file');
      if (folderId && file) {
        try {
          restoreFolderVersion(folderId, file);
          redirect(res, (params.get('back') || '/') + '&msg=' + encodeURIComponent('版本已恢复到原路径'));
        } catch (e) {
          redirect(res, (params.get('back') || '/') + '&msg=' + encodeURIComponent(e instanceof Error ? e.message : '恢复失败'));
        }
        return true;
      }
    }
    if (action === 'delete-version' && deleteFolderVersion) {
      const folderId = params.get('folderId');
      const file = params.get('file');
      if (folderId && file) {
        try {
          deleteFolderVersion(folderId, file);
          redirect(res, (params.get('back') || '/') + '&msg=' + encodeURIComponent('版本已删除'));
        } catch (e) {
          redirect(res, (params.get('back') || '/') + '&msg=' + encodeURIComponent(e instanceof Error ? e.message : '删除失败'));
        }
        return true;
      }
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
