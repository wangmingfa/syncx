#!/usr/bin/env node
/**
 * 断点续传的真机验证:两个真 daemon 走环回,大文件传输**中途 SIGKILL 接收端**,
 * 重启后断言「接着传而不是从头传」。补齐 ADR-0021 记的那条缺口 —— 单元/集成用例
 * 都只在 executor 接缝与管线接缝上证明续传,没有真的杀过进程。
 *
 * 判据(同时成立才算过):
 *  1. kill 时盘上有中间态对(tmp + manifest),且位图里已提交槽数 > 0;
 *  2. 重启后 tmp 长度不掉回近 0 —— 从头传必然走 openSync(tmp,'w') 截断,长度会塌下去;
 *  3. 落地后 sha256 与发送端一致,且中间态对成对消失。
 *
 * 判据 2 是有负向对照的:位图一删,同一条判据必须翻成 false(实测塌到 2MB),
 * 否则它只是个「碰巧没变」的观测值,不构成证据。
 *
 * 用法(需要 dist/syncx.js,先 npm run build):
 *   npx tsx bench/resume-kill-bench.mjs [文件大小MB] [kill 阈值MB]
 *   MODE=cdc     ... 先让第一代落地(接收端因此有 CDC 视图可比差集),再整份改写内容
 *                    投放 → 接收按 clens 前缀和布局,验的是变长槽位那一套偏移口径
 *   DROP_MANIFEST=1  kill 后删掉位图再重启 → 期望 resumedNotRestarted=false(负向对照)
 *
 * 2026-09-30 实测(400MB / kill 阈值 80MB,三跑全过):
 *   fresh  400 槽(定长 1MB),kill 时已提交 80 → 重启后 tmp 最小值 87,031,808(未截断)
 *   cdc    1600 槽(变长块),kill 时已提交 336 → 重启后 tmp 最小值 88,080,384(未截断)
 *   负向对照(删位图)→ tmp 塌到 2,097,152,判据翻 false,而 sha256 仍一致
 *
 * 端口固定 24701/24702(+ 控制口 24711/24712),config 目录在系统临时目录里现造,
 * 不碰本机在跑的 daemon 的状态目录。子进程无论成功失败都在 finally 里收掉。
 * 工作目录原样保留供检查(一轮约 800MB),整目录删掉即可。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateIdentity } from '../src/identity.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const log = (m) => console.log(`[killbench] ${m}`);

const sizeMB = Number(process.argv[2] ?? 400);
const killAtMB = Number(process.argv[3] ?? 80);
const MODE = process.env.MODE ?? 'fresh'; // fresh | cdc
const DROP_MANIFEST = process.env.DROP_MANIFEST === '1'; // 负向对照:位图没了 → 必须从头传
const FILE_BYTES = Math.floor(sizeMB * 1024 * 1024);
const KILL_AT = Math.floor(killAtMB * 1024 * 1024);

const PORT_A = 24701;
const PORT_B = 24702;
const CTRL_A = 24711;
const CTRL_B = 24712;

const workDir = mkdtempSync(join(tmpdir(), 'syncx-resume-kill-'));
const shareA = join(workDir, 'shareA');
const shareB = join(workDir, 'shareB');
const aDir = join(workDir, 'a');
const bDir = join(workDir, 'b');
const target = join(shareB, 'big.bin');
const tmpPath = `${target}.syncx-tmp`;
const manifestPath = `${target}.syncx-partial`;

const procs = [];
function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const once = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); res(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) rej(new Error(`端口 ${port} 等待超时`));
        else setTimeout(once, 200);
      });
    };
    once();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await sleep(60);
  }
}
async function sha256Of(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}
function readBitmap() {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const buf = Buffer.from(m.bitmap, 'base64');
  let bits = 0;
  for (let i = 0; i < m.slots; i++) if ((buf[i >> 3] & (1 << (i & 7))) !== 0) bits++;
  return { slots: m.slots, cdc: m.cdc, bits, startedAt: m.startedAt, updatedAt: m.updatedAt };
}
/** 同卷暂存后 rename 进 A 的共享目录:边写边扫会把半写版本逐轮广播出去。 */
function dropIntoShareA(gen) {
  const stage = join(workDir, 'stage');
  mkdirSync(stage, { recursive: true });
  const stageBin = join(stage, 'big.bin');
  const buf = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < buf.length; i += 4096) buf.writeUInt32LE((i * 2654435761 + gen * 7919) >>> 0, i);
  for (let i = 0; i < Math.floor(FILE_BYTES / buf.length); i++) writeFileSync(stageBin, buf, { flag: i === 0 ? 'w' : 'a' });
  const rem = FILE_BYTES % buf.length;
  if (rem) writeFileSync(stageBin, buf.subarray(0, rem), { flag: 'a' });
  renameSync(stageBin, join(shareA, 'big.bin'));
}

function spawnDaemon(dir, port, controlPort) {
  const p = spawn(process.execPath, [
    join(REPO, 'dist', 'syncx.js'), 'start',
    '--config', join(dir, 'config.json'),
    '--port', String(port),
    '--control-port', String(controlPort),
    '--log-file', join(dir, 'daemon.log'),
  ], {
    cwd: REPO,
    env: { ...process.env, SYNCX_SCAN_INTERVAL_MS: '250' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  procs.push(p);
  return p;
}

const run = async () => {
  for (const d of [shareA, shareB, aDir, bDir]) mkdirSync(d, { recursive: true });
  const aId = loadOrCreateIdentity(aDir);
  const bId = loadOrCreateIdentity(bDir);
  writeFileSync(join(aDir, 'config.json'), JSON.stringify({
    sharedFolders: [{ id: 'main', path: shareA, devices: [bId.deviceId] }], peers: [],
  }));
  writeFileSync(join(bDir, 'config.json'), JSON.stringify({
    sharedFolders: [{ id: 'main', path: shareB, devices: [aId.deviceId] }],
    peers: [`ws://127.0.0.1:${PORT_A}`],
  }));

  let procB = spawnDaemon(bDir, PORT_B, CTRL_B);
  await waitPort(CTRL_B, 30000);
  const procA = spawnDaemon(aDir, PORT_A, CTRL_A);
  await waitPort(CTRL_A, 30000);
  log(`A=${aId.deviceId} B=${bId.deviceId} 工作目录=${workDir}`);

  dropIntoShareA(1);
  // 落地标记:第一代用「存在与否」,CDC 模式用 mtime 变化(目标此时已存在)
  const landedMarker = () => (existsSync(target) ? statSync(target).mtimeMs : 0);
  let marker0 = 0;
  if (MODE === 'cdc') {
    await waitFor(() => landedMarker() !== 0, 300_000, '第一代落地');
    log('第一代已落地(接收端有 CDC 视图可比差集),投放整份改写内容…');
    await sleep(2000);
    marker0 = landedMarker();
    dropIntoShareA(2);
  }
  log(`已投放 ${sizeMB}MB,等待接收端中间态长到 ${killAtMB}MB…`);

  const tStart = Date.now();
  await waitFor(() => existsSync(tmpPath) && statSync(tmpPath).size >= KILL_AT, 180_000, 'tmp 长到阈值');
  const sizeAtKill = statSync(tmpPath).size;
  const bmAtKill = existsSync(manifestPath) ? readBitmap() : null;
  log(`tmp=${sizeAtKill} 字节,中间态位图=${JSON.stringify(bmAtKill)}`);

  procB.kill('SIGKILL');
  await new Promise((r) => procB.once('exit', (code, sig) => r(sig)));
  await sleep(500);
  const pairAliveAfterKill = existsSync(tmpPath) && existsSync(manifestPath);
  const landedTooEarly = landedMarker() !== marker0;
  log(`SIGKILL 后: 中间态对还在=${pairAliveAfterKill} 目标已落地(应为 false)=${landedTooEarly}`);
  if (!pairAliveAfterKill || landedTooEarly) throw new Error('kill 时机不对:没抓住在途中间态');

  const sizeAfterKill = statSync(tmpPath).size;
  if (DROP_MANIFEST) {
    rmSync(manifestPath, { force: true });
    log('负向对照:位图已删掉 → 这次必须从头传(判据应翻成 false)');
  }
  procB = spawnDaemon(bDir, PORT_B, CTRL_B);
  await waitPort(CTRL_B, 30000);
  // 重启后的采样窗口:从头传必然先截断 tmp(openSync 'w'),续传则保持长度
  let minAfterRestart = sizeAfterKill;
  const sampleUntil = Date.now() + 20_000;
  while (Date.now() < sampleUntil && landedMarker() === marker0) {
    if (existsSync(tmpPath)) minAfterRestart = Math.min(minAfterRestart, statSync(tmpPath).size);
    await sleep(60);
  }
  log(`kill 时 tmp=${sizeAfterKill},重启后观测到的最小 tmp=${minAfterRestart}`);

  await waitFor(() => landedMarker() !== marker0, 300_000, '重启后文件落地');
  const tDone = Date.now();
  await sleep(1500);
  log(`落地耗时(重启后)= ${((tDone - tStart) / 1000).toFixed(1)}s`);

  const ha = await sha256Of(join(shareA, 'big.bin'));
  const hb = await sha256Of(target);
  const pairGone = !existsSync(tmpPath) && !existsSync(manifestPath);
  const resumed = minAfterRestart > KILL_AT * 0.5;
  const verdict = {
    mode: MODE,
    dropManifest: DROP_MANIFEST,
    fileBytes: FILE_BYTES,
    sizeAtKillBytes: sizeAtKill,
    committedSlotsAtKill: bmAtKill?.bits ?? 0,
    totalSlots: bmAtKill?.slots ?? 0,
    cdc: bmAtKill?.cdc ?? null,
    minTmpAfterRestartBytes: minAfterRestart,
    resumedNotRestarted: resumed,
    shaMatch: ha === hb,
    scratchPairCleaned: pairGone,
    pass: DROP_MANIFEST ? (!resumed && ha === hb) : (resumed && ha === hb && pairGone),
  };
  console.log(JSON.stringify(verdict, null, 2));
  log(`工作目录保留在 ${workDir}`);
};

run().catch((e) => {
  console.error('[killbench][error]', e.message);
  console.error(`[killbench] 工作目录 ${workDir}`);
  process.exitCode = 1;
}).finally(async () => {
  for (const p of procs) { try { p.kill(); } catch {} }
  await Promise.all(procs.map((p) => new Promise((r) => { p.once('exit', r); setTimeout(r, 3000); })));
  log('子进程已收尾');
});
