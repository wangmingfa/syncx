/**
 * 设备间直发的 HTTP 面(ADR-0028):本机浏览器 → 本机 daemon → 已握手 P2P 会话。
 *
 * 大文件不一次性读进内存:请求体边流边写进 `<configDir>/inbox/.tmp/`,同时算 sha256;
 * 校验通过才把路径交给 direct 服务发提议。暂存文件不属于任何共享目录,永不进索引。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createWriteStream, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ControlServerDeps } from '../deps.js';
import { pathname, readBody, sendJson } from '../helpers.js';
import { DIRECT_MAX_FILE_BYTES, type DirectSendAck } from '../../direct.js';
import { writeZip, ZIP_MAX_BYTES } from '../../zip.js';

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

/** 一次发送最多选 20 台:避免浏览器误点「全选」时把 daemon 打满。 */
const DIRECT_MAX_TARGETS = 20;

/**
 * 「打包成一个压缩包」的暂存区(ADR-0028 后续项)。
 *
 * 流程分两步:每个文件先 `POST /api/direct/file?zip=<batch>` 落进
 * `<inbox>/.tmp/zip-<batch>/`,再由 `POST /api/direct/zip` 把整包打出来、一次性投送。
 * 之所以不在上传时边收边写 zip:zip 的中央目录要等最后一个条目才知道偏移,
 * 而上传是并发的(浏览器可能同时发几个),顺序不可控 —— 落盘暂存最稳。
 */
interface ZipManifestEntry {
  name: string;
  /** 暂存文件名(`000.dat` 这种),真实名字只在清单里,避免路径穿越。 */
  file: string;
  size: number;
}

const ZIP_BATCH_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** 暂存目录的保鲜期:用户打开发送弹窗后又关掉,不能把文件永久留在 .tmp 里。 */
const ZIP_STAGING_TTL_MS = 2 * 60 * 60 * 1000;

function zipStagingDir(root: string, batch: string): string {
  return join(root, `zip-${batch}`);
}

function readZipManifest(dir: string): ZipManifestEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((e): e is ZipManifestEntry => {
      if (typeof e !== 'object' || e === null) return false;
      const r = e as Record<string, unknown>;
      return typeof r.name === 'string' && typeof r.file === 'string' && /^\d{3}\.dat$/.test(r.file)
        && typeof r.size === 'number' && r.size > 0;
    });
  } catch {
    return [];
  }
}

function writeZipManifest(dir: string, entries: ZipManifestEntry[]): void {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entries }, null, 2), 'utf8');
}

/** 清掉上次没打完的暂存目录:只有真被遗弃的(超过保鲜期)才删,正在传的别动。 */
function sweepZipStaging(root: string): void {
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith('zip-')) continue;
    const dir = join(root, name);
    try {
      if (now - statSync(dir).mtimeMs > ZIP_STAGING_TTL_MS) rmSync(dir, { recursive: true, force: true });
    } catch { /* 被别的请求清掉了 */ }
  }
}

/** 包名:去掉路径分隔符,补 .zip 后缀,空则给个按时间的默认名。 */
function zipArchiveName(raw: unknown): string {
  const stamp = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const fallback = `打包-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
  const base = typeof raw === 'string' ? raw.replace(/[\\/]+/g, '_').trim().slice(0, 120) : '';
  const name = base || fallback;
  return /\.zip$/i.test(name) ? name : `${name}.zip`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 兼容旧的单设备 deviceId 与新的多设备 deviceIds,去重并保持传入顺序。 */
function parseTargets(single: unknown, many: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v !== 'string') return;
    const id = v.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  add(single);
  if (Array.isArray(many)) for (const v of many) add(v);
  return ids;
}

interface DirectSendResult {
  deviceId: string;
  id?: string;
  /** true = 目标离线,内容已进排队,等它上线自动投递。 */
  queued?: boolean;
  error?: string;
}

/** 逐台投送:某台离线/旧版本不影响其它设备,失败原因随结果返回给 UI。 */
function dispatch(ids: string[], send: (deviceId: string) => DirectSendAck): DirectSendResult[] {
  return ids.map((deviceId) => {
    try {
      const ack = send(deviceId);
      return { deviceId, id: ack.id, ...(ack.queued ? { queued: true } : {}) };
    } catch (e) {
      return { deviceId, error: e instanceof Error ? e.message : '发送失败' };
    }
  });
}

/** 保留单设备响应里的 id,老前端拿到它就能继续工作。 */
function sendBatch(res: ServerResponse, ids: string[], results: DirectSendResult[]): void {
  const first = results.find((r) => r.id);
  sendJson(res, 200, { ...(first?.id ? { id: first.id } : {}), ids, results });
}

/** 直发域:未命中返回 false,交给后续路由处理。 */
export async function tryDirectRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ControlServerDeps,
  elevated = false,
  reissueElevation: (res: ServerResponse) => void = () => {},
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

  // POST /api/direct/inbox/read : 收件箱标记全部已读(用户打开收件箱时调用)
  if (req.method === 'POST' && path === '/api/direct/inbox/read') {
    try {
      await readBody(req); // 无参数,但请求体要读掉,keep-alive 连接上不留没消费的字节
      sendJson(res, 200, { ok: true, count: direct.markInboxRead() });
    } catch (e) {
      fail(res, e);
    }
    return true;
  }

  // DELETE /api/direct/inbox/:id
  const deleteMatch = /^\/api\/direct\/inbox\/([^/]+)$/.exec(path);
  if (req.method === 'DELETE' && deleteMatch) {
    const ok = await direct.remove(decodeURIComponent(deleteMatch[1]!));
    sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '收件箱条目不存在' });
    return true;
  }

  // POST /api/direct/reply : 接收方确认/拒绝待确认文件。id = 单条;batchId = 同一次多文件投送整组
  if (req.method === 'POST' && path === '/api/direct/reply') {
    try {
      const body = JSON.parse(await readBody(req)) as { id?: unknown; batchId?: unknown; accept?: unknown; reason?: unknown; saveTo?: unknown };
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const batchId = typeof body.batchId === 'string' ? body.batchId.trim() : '';
      // 二者取其一:id 是单条, batchId 是整组。同时给会让「到底处理了几条」变得含混。
      if (typeof body.accept !== 'boolean' || (!id && !batchId) || (id && batchId)) {
        sendJson(res, 400, { error: '需要 id 或 batchId（二者取其一）以及 accept' });
        return true;
      }
      let saveDir: string | undefined;
      if (body.saveTo !== undefined) {
        if (body.accept !== true) {
          sendJson(res, 400, { error: '只有接收文件时才能指定保存目录' });
          return true;
        }
        // 普通「接收」落 daemon 收件箱,不需要提权;另存会写用户目录,与删除/终端同一条门。
        if (!elevated) {
          sendJson(res, 403, { error: '另存到指定目录需要验证:请用控制令牌或密码完成验证' });
          return true;
        }
        if (typeof body.saveTo !== 'string' || !deps.directSavePath) {
          sendJson(res, typeof body.saveTo === 'string' ? 503 : 400, {
            error: typeof body.saveTo === 'string' ? '当前后端不支持另存到指定目录' : '保存目录格式不正确',
          });
          return true;
        }
        saveDir = deps.directSavePath(body.saveTo);
        // 校验通过才续期:失败的请求不该靠错误输入延长提权窗口。
        reissueElevation(res);
      }
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      if (batchId) {
        const count = direct.replyBatch(batchId, body.accept, reason, saveDir);
        sendJson(res, count > 0 ? 200 : 404, count > 0 ? { ok: true, count } : { error: '该组待确认文件不存在或已处理' });
        return true;
      }
      const ok = direct.reply(id, body.accept, reason, saveDir);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true, count: 1 } : { error: '待确认项不存在或已处理' });
    } catch (e) {
      fail(res, e);
    }
    return true;
  }

  // POST /api/direct/cancel : 取消一条仍在排队的投送(设备离线时才有)
  if (req.method === 'POST' && path === '/api/direct/cancel') {
    try {
      const body = JSON.parse(await readBody(req)) as { id?: unknown };
      if (typeof body.id !== 'string') {
        sendJson(res, 400, { error: '缺少投送 id' });
        return true;
      }
      const ok = direct.cancelQueued(body.id);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: '该投送不在排队中(可能已发出或已结束)' });
    } catch (e) {
      fail(res, e);
    }
    return true;
  }

  // POST /api/direct/text : 发送一段文本(支持 deviceIds 多设备)
  if (req.method === 'POST' && path === '/api/direct/text') {
    try {
      const body = JSON.parse(await readBody(req)) as { deviceId?: unknown; deviceIds?: unknown; text?: unknown };
      const ids = parseTargets(body.deviceId, body.deviceIds);
      if (typeof body.text !== 'string' || !ids.length || ids.length > DIRECT_MAX_TARGETS) {
        sendJson(res, 400, { error: '需要 1 ~ 20 台目标设备和文本内容' });
        return true;
      }
      sendBatch(res, ids, dispatch(ids, (deviceId) => direct.sendText(deviceId, body.text as string)));
    } catch (e) {
      fail(res, e);
    }
    return true;
  }

  // POST /api/direct/file?deviceIds=&name=&size=&batch= : 流式暂存一次 + 发起多设备文件直发
  // 带 `zip=<batch>` 时只暂存、不投送,等 POST /api/direct/zip 打包后一次性发。
  if (req.method === 'POST' && path === '/api/direct/file') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ids = parseTargets(url.searchParams.get('deviceId'), url.searchParams.getAll('deviceIds'));
    const name = url.searchParams.get('name') ?? '';
    const size = Number(url.searchParams.get('size'));
    // 批次号由前端每次「发送」生成:同一次投的多个文件共用,接收方据此合并成一张卡。
    const batch = url.searchParams.get('batch') ?? '';
    const zipBatch = url.searchParams.get('zip') ?? '';
    // 早退时把请求体读空再回:客户端还在写一个几十 MB 的文件,直接回包会让它收到
    // ECONNRESET 而不是这条中文原因。
    if (!name || !Number.isInteger(size) || size <= 0 || size > DIRECT_MAX_FILE_BYTES) {
      sendJson(res, 400, { error: '文件参数不正确（名字、大小必填，单文件不超过 100MB）' });
      req.resume();
      return true;
    }
    if (!zipBatch && (!ids.length || ids.length > DIRECT_MAX_TARGETS)) {
      sendJson(res, 400, { error: '需要 1 ~ 20 台目标设备及合法的文件参数' });
      req.resume();
      return true;
    }
    if ((batch && !ZIP_BATCH_RE.test(batch)) || (zipBatch && !ZIP_BATCH_RE.test(zipBatch))) {
      sendJson(res, 400, { error: '批次号格式不正确' });
      req.resume();
      return true;
    }
    if (!deps.configDir) {
      sendJson(res, 503, { error: '未配置数据目录,无法暂存待发文件' });
      req.resume();
      return true;
    }
    // direct 服务正常会在构造时建好这个目录;路由仍自己兜一层,
    // 免得最小 deps / 目录被手工清掉时上传直接 ENOENT。
    const stagingDir = join(deps.configDir, 'inbox', '.tmp');
    mkdirSync(stagingDir, { recursive: true });
    let staging: string | undefined;
    try {
      if (zipBatch) {
        // 打包模式:先进暂存目录,凑齐了再由 /api/direct/zip 统一打包。
        mkdirSync(stagingDir, { recursive: true });
        sweepZipStaging(stagingDir);
        const dir = zipStagingDir(stagingDir, zipBatch);
        mkdirSync(dir, { recursive: true });
        const entries = readZipManifest(dir);
        const slot = `${String(entries.length).padStart(3, '0')}.dat`;
        await stageUpload(req, join(dir, slot), size);
        entries.push({ name, file: slot, size });
        writeZipManifest(dir, entries);
        sendJson(res, 200, { staged: true, count: entries.length, name, size });
        return true;
      }
      staging = join(stagingDir, `out-${randomBytes(8).toString('hex')}`);
      const sha256 = await stageUpload(req, staging, size);
      const file = { name, sourcePath: staging, size, sha256 };
      let started = false;
      const results = dispatch(ids, (deviceId) => {
        const ack = direct.sendFile(deviceId, file, batch || undefined);
        started = true;
        return ack;
      });
      // 一笔都没发出去时没有服务接管暂存文件,这里自己清理;
      // 否则由 direct 服务按引用计数在最后一笔结束时删。
      if (!started) rmSync(staging, { force: true });
      sendBatch(res, ids, results);
    } catch (e) {
      // 请求体没读完就报错(超长 / 大小不符)时,这条连接不能留着复用:
      // 残留的字节会被当成下一个请求的开头,客户端看到的是 ECONNRESET 而不是这条原因。
      res.shouldKeepAlive = false;
      // 暂存文件可能已经写了一半:sendFile 抛错(队列满 / 参数不合法)时没人接管它。
      if (staging) rmSync(staging, { force: true });
      fail(res, e);
    }
    return true;
  }

  // POST /api/direct/zip { batch, deviceIds, name? } : 把暂存的文件打成一个包再投送
  if (req.method === 'POST' && path === '/api/direct/zip') {
    try {
      const body = JSON.parse(await readBody(req)) as { batch?: unknown; deviceId?: unknown; deviceIds?: unknown; name?: unknown };
      const batch = typeof body.batch === 'string' ? body.batch.trim() : '';
      const ids = parseTargets(body.deviceId, body.deviceIds);
      if (!ZIP_BATCH_RE.test(batch) || !ids.length || ids.length > DIRECT_MAX_TARGETS) {
        sendJson(res, 400, { error: '需要批次号与 1 ~ 20 台目标设备' });
        return true;
      }
      if (!deps.configDir) {
        sendJson(res, 503, { error: '未配置数据目录,无法打包' });
        return true;
      }
      const stagingDir = join(deps.configDir, 'inbox', '.tmp');
      const dir = zipStagingDir(stagingDir, batch);
      const entries = readZipManifest(dir);
      if (!entries.length) {
        sendJson(res, 404, { error: '这批文件还没有暂存内容（可能已发送或暂存已过期）' });
        return true;
      }
      const total = entries.reduce((sum, e) => sum + e.size, 0);
      if (total > ZIP_MAX_BYTES) {
        sendJson(res, 400, { error: `打包后约 ${fmtBytes(total)},超过单文件上限 ${fmtBytes(ZIP_MAX_BYTES)}` });
        return true;
      }
      const archive = join(stagingDir, `out-${randomBytes(8).toString('hex')}.zip`);
      let built;
      try {
        built = await writeZip(archive, entries.map((e) => ({ name: e.name, path: join(dir, e.file), size: e.size })));
      } catch (e) {
        rmSync(archive, { force: true });
        throw e;
      }
      // 暂存目录已经没用了:无论投送成败都清掉(源文件进了 zip,zip 由 direct 服务接管)。
      rmSync(dir, { recursive: true, force: true });
      const file = { name: zipArchiveName(body.name), sourcePath: archive, size: built.size, sha256: built.sha256 };
      let started = false;
      const results = dispatch(ids, (deviceId) => {
        const ack = direct.sendFile(deviceId, file, batch);
        started = true;
        return ack;
      });
      if (!started) rmSync(archive, { force: true });
      sendBatch(res, ids, results);
    } catch (e) {
      fail(res, e);
    }
    return true;
  }

  return false;
}
