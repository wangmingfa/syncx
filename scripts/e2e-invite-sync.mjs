// E2E smoke: A(有内容的目录)邀请 B → B 确认 → 验证内容自动同步过来(方案 C 修复路径)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIST = new URL('../dist/syncx.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = mkdtempSync(join(tmpdir(), 'syncx-a-'));
const B = mkdtempSync(join(tmpdir(), 'syncx-b-'));
mkdirSync(join(A, 'dir'));
mkdirSync(join(B, 'dir'));
writeFileSync(join(A, 'dir', 'hello.txt'), `syncx-e2e-${Date.now()}`);

const procs = [];
function startDaemon(dir, controlPort, peerPort) {
  const child = spawn(
    process.execPath,
    [DIST, 'start', '--config', join(dir, 'config.json'), '--control-port', String(controlPort), '--port', String(peerPort), '--expose-control', '--host', '127.0.0.1'],
    { stdio: 'ignore' },
  );
  procs.push(child);
  return child;
}
async function api(port, dir, method, path, body) {
  const token = readFileSync(join(dir, 'control.token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function waitFor(fn, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(300);
  }
}

try {
  startDaemon(A, 18390, 22010);
  startDaemon(B, 18391, 22011);
  const idA = await waitFor(async () => (await api(18390, A, 'GET', '/api/status').catch(() => null))?.body?.deviceId, 'daemon A');
  const idB = await waitFor(async () => (await api(18391, B, 'GET', '/api/status').catch(() => null))?.body?.deviceId, 'daemon B');
  console.log(`device A=${idA}  B=${idB}`);

  // 1. A 添加 B(带地址)→ B 收到配对请求
  await api(18390, A, 'POST', '/api/devices', { deviceId: idB, address: 'ws://127.0.0.1:22011' });
  const pairOffer = await waitFor(async () => {
    const r = await api(18391, B, 'GET', '/api/offers');
    return (r.body ?? []).find((o) => o.kind === 'pairing' && o.fromDeviceId === idA);
  }, 'pairing offer on B');
  await api(18391, B, 'POST', `/api/offers/${pairOffer.id}/accept`, {});
  console.log('pairing accepted');

  // 2. A 新建共享目录(设备含 B)→ B 收到目录邀请
  await api(18390, A, 'POST', '/api/folders', { path: join(A, 'dir'), devices: [idB] });
  const folderOffer = await waitFor(async () => {
    const r = await api(18391, B, 'GET', '/api/offers');
    return (r.body ?? []).find((o) => o.kind === 'folder' && o.fromDeviceId === idA);
  }, 'folder offer on B');
  console.log(`folder offer ${folderOffer.folderId} received on B`);

  // 3. B 确认邀请(localPath 指向空目录)→ 此前 bug:A 侧不补建通道,内容永不同步
  await api(18391, B, 'POST', `/api/offers/${folderOffer.id}/accept`, { localPath: join(B, 'dir') });
  console.log('folder invitation accepted, waiting for content sync...');

  // 4. 验证 hello.txt 同步到 B(给扫描/传输 10s)
  const arrived = await waitFor(async () => existsSync(join(B, 'dir', 'hello.txt')), 'hello.txt on B', 10000);
  const src = readFileSync(join(A, 'dir', 'hello.txt'), 'utf8');
  const dst = readFileSync(join(B, 'dir', 'hello.txt'), 'utf8');
  console.log(arrived && src === dst ? 'E2E PASS: content synced to B' : 'E2E FAIL: content mismatch');
  if (!(arrived && src === dst)) process.exitCode = 1;
} catch (e) {
  console.error('E2E FAIL:', e.message);
  process.exitCode = 1;
} finally {
  for (const p of procs) p.kill();
  await sleep(500);
  try { rmSync(A, { recursive: true, force: true }); } catch {}
  try { rmSync(B, { recursive: true, force: true }); } catch {}
}
