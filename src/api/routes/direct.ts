/**
 * 设备间直发的 HTTP 面(ADR-0028):本机浏览器 → 本机 daemon → 已握手 P2P 会话。
 *
 * 大文件不一次性读进内存:请求体边流边写进 `<configDir>/inbox/.tmp/`,同时算 sha256;
 * 校验通过才把路径交给 direct 服务发提议。暂存文件不属于任何共享目录,永不进索引。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ControlServerDeps } from '../deps.js';
import { pathname, readBody, sendJson } from '../helpers.js';
import { DIRECT_MAX_FILE_BYTES } from '../../direct.js';

/** 写暂存文件:超出预期大小立刻失败,收尾核对字节数与 sha256。 */
async function stageUpload(req: IncomingMessage, path: string, size: number): Promise<string> {
  const hash = createHash('sha256');
  let written = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > size) {
        callback(new Error('uploaded file is larger than declared size'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(req, guard, createWriteStream(path, { flags: 'wx' }));
  } catch (err) {
    rmSync(path, { force: true });
    throw err;
  }
  if (written !== size) {
    rmSync(path, { force: true });
    throw new Error('uploaded file does not match declared size');
  }
  // 指纹由 daemon 边收边算:浏览器在局域网 HTTP 下没有 crypto.subtle,
  // 让前端算会逼用户上 HTTPS,对纯 LAN 工具是本末倒置。
  return hash.digest('hex');
}

function fail(res: ServerResponse, error: unknown, status = 400): void {
  sendJson(res, status, { error: error instanceof Error ? error.message : '直发请求失败' });
}

/** 直发域:未命中返回 false,交给后续路由处理。 */
export async function tryDirectRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
): Promise<boolean> {
  const path = req.url ? pathname(req.url) : '/';
  if (!path.startsWith('/api/direct')) return false;
  const direct = deps.direct;
  if (!direct) {
    sendJson(res, 503, { error: '当前后端不支持设备间直发' });
    return true;
  }

  // GET /api/direct/inbox : 元数据快照(正文不进状态,按需另取)
  if (req.method === 'GET' && path === '/api/direct/inbox') {
    sendJson(res, 200, direct.snapshot());
    return true;
  }

  // GET /api/direct/inbox/:id/content : 文本/文件正文(下载用)
  const contentMatch = /^\/api\/direct\/inbox\/([^/]+)\/content$/.exec(path);
  if (req.method === 'GET' && contentMatch) {
    const found = await direct.content(decodeURIComponent(contentMatch[1]!));
    if (!found) {
      sendJson(res, 404, { error: '收件箱条目不存在' });
      return true;
    }
    if (found.item.kind === 'text') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(found.data);
      return true;
    }
    const name = encodeURIComponent(found.item.name).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
      'Content-Length': String(found.data.length),
      'Cache-Control': 'no-store',
    });
    res.end(found.data);
    return true;
  }

  // DELETE /api/direct/inbox/:id
  const deleteMatch = /^\/api\/direct\/inbox\/([^/]+)$/.exec(path);
  if (req.method === 'DELETE' && deleteMatch) {
    const ok = await direct.remove(decodeURIComponent(deleteMatch[1]!));
    sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '收件箱条目不存在' });
    return true;
  }

  // POST /api/direct/reply : 接收方确认/拒绝一个待确认文件
  if (req.method === 'POST' && path === '/api/direct/reply') {
    try {
      const body = JSON.parse(await readBody(req)) as { id?: unknown; accept?: unknown; reason?: unknown };
      if (typeof body.id !== 'string' || typeof body.accept !== 'boolean') {
        sendJson(res, 400, { error: '缺少 id 或 accept' });
        return true;
      }
      const ok = direct.reply(body.id, body.accept, typeof body.reason === 'string' ? body.reason : undefined);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '待确认项不存在或已处理' });
    } catch (e) {
      fail(res, e);
    }
    return true;
  }

  // POST /api/direct/text : 发送一段文本
  if (req.method === 'POST' && path === '/api/direct/text') {
    try {
      const body = JSON.parse(await readBody(req)) as { deviceId?: unknown; text?: unknown };
      if (typeof body.deviceId !== 'string' || !body.deviceId || typeof body.text !== 'string') {
        sendJson(res, 400, { error: '缺少 deviceId 或 text' });
        return true;
      }
      const id = direct.sendText(body.deviceId, body.text);
      sendJson(res, 200, { id });
    } catch (e) {
      fail(res, e);
    }
    return true;
  }

  // POST /api/direct/file?deviceId=&name=&size= : 流式暂存 + 发起文件直发
  if (req.method === 'POST' && path === '/api/direct/file') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const deviceId = url.searchParams.get('deviceId') ?? '';
    const name = url.searchParams.get('name') ?? '';
    const size = Number(url.searchParams.get('size'));
    if (!deviceId || !name || !Number.isInteger(size) || size <= 0 || size > DIRECT_MAX_FILE_BYTES) {
      sendJson(res, 400, { error: '文件参数不合法' });
      return true;
    }
    if (!deps.configDir) {
      sendJson(res, 503, { error: '未配置数据目录,无法暂存待发文件' });
      return true;
    }
    // direct 服务正常会在构造时建好这个目录;路由仍自己兜一层,
    // 免得最小 deps / 目录被手工清掉时上传直接 ENOENT。
    const stagingDir = join(deps.configDir, 'inbox', '.tmp');
    mkdirSync(stagingDir, { recursive: true });
    const staging = join(stagingDir, `out-${randomBytes(8).toString('hex')}`);
    try {
      const sha256 = await stageUpload(req, staging, size);
      const id = direct.sendFile(deviceId, { name, sourcePath: staging, size, sha256 });
      sendJson(res, 200, { id });
    } catch (e) {
      rmSync(staging, { force: true });
      fail(res, e);
    }
    return true;
  }

  return false;
}
