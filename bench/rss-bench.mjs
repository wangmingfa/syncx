#!/usr/bin/env node
/**
 * 接收端 RSS 基准:两个真 daemon 之间同步一个大文件,采样接收端的 RSS 峰值。
 *
 * 用途(断点续传阶段 1a/1b 与阶段 2 的前后对比,见 docs/adr/0018):
 *  - 峰值 ≈ 2× 文件大小 → 落地仍是整文件 concat(阶段 1a 之前);
 *  - 峰值 ≈ 1× 文件大小 → concat 已去,但块仍全量驻留内存(阶段 1a 之后);
 *  - 峰值 ≈ O(块大小)  → 真流式 + 断点续传(阶段 2)。
 *
 * 用法:
 *   npx tsx bench/rss-bench.mjs [工作目录] [文件大小MB]
 *   - 工作目录缺省在系统临时目录下 mkdtemp;量大盘请指到空间充足的卷;
 *   - 需要 dist/syncx.js(先 npm run build)与 tsx(脚本 import 了 src 的身份模块);
 *   - 结束后工作目录原样保留,供检查/复测,整目录删掉即可。
 *
 * 采样方式:接收端以 `node --require <采样器>` 启动,采样器每 100ms 把
 * process.memoryUsage().rss 追加进自己的日志 —— 直接读进程内 RSS,
 * 比外部 Get-Process/tasklist 采样准(那两者受工作集裁剪影响,峰量会被低估)。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateIdentity } from '../src/identity.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const log = (m) => console.log(`[bench] ${m}`);

const argv = process.argv.slice(2);
const workDir = resolve(argv[0] ?? mkdtempSync(join(tmpdir(), 'syncx-rss-bench-')));
const sizeMB = Number(argv[1] ?? 600);
const FILE_BYTES = Math.floor(sizeMB * 1024 * 1024);

const PORT_A = 24601;
const PORT_B = 24602;
const CTRL_A = 24611;
const CTRL_B = 24612;

function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`端口 ${port} 等待超时`));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

async function sha256Of(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v;
      try { v = fn(); } catch { v = false; }
      if (v) return resolve();
      if (Date.now() > deadline) return reject(new Error('waitFor 超时'));
      setTimeout(tick, 300);
    };
    tick();
  });
}

const run = async () => {
  mkdirSync(workDir, { recursive: true });
  const shareA = join(workDir, 'shareA');
  const shareB = join(workDir, 'shareB');
  mkdirSync(shareA, { recursive: true });
  mkdirSync(shareB, { recursive: true });

  const aDir = join(workDir, 'a');
  const bDir = join(workDir, 'b');
  const aId = loadOrCreateIdentity(aDir);
  const bId = loadOrCreateIdentity(bDir);
  log(`A=${aId.deviceId} B=${bId.deviceId}`);

  // 采样器:接收端进程内每 100ms 记一次 RSS。RSS_LOG 由 spawn 的 env 传入。
  const samplerCjs = join(workDir, 'rss-sampler.cjs');
  writeFileSync(
    samplerCjs,
    [
      'const fs = require("node:fs");',
      'const out = process.env.RSS_LOG;',
      'const tick = () => { try { fs.appendFileSync(out, process.memoryUsage().rss + "\\n"); } catch {} };',
      'tick(); setInterval(tick, 100);',
      '',
    ].join('\n'),
  );
  const samplerFor = (dir) => {
    const p = join(dir, 'rss.log');
    if (existsSync(p)) writeFileSync(p, '');
    return p;
  };

  writeFileSync(join(aDir, 'config.json'), JSON.stringify({
    sharedFolders: [{ id: 'main', path: shareA, devices: [bId.deviceId] }],
    peers: [],
  }));
  writeFileSync(join(bDir, 'config.json'), JSON.stringify({
    sharedFolders: [{ id: 'main', path: shareB, devices: [aId.deviceId] }],
    peers: [`ws://127.0.0.1:${PORT_A}`],
  }));

  const spawnDaemon = (dir, port, controlPort, rssLog) => spawn(
    process.execPath,
    [
      // 堆限抬到 8GB:两侧现在都逐块过盘(发送 hashFileViews / 接收 1a 逐块写),
      // 峰值本该 ≈ 在途块,但本基准还要能跑「改前」的那一版做对比 —— 整读时代
      // 1.5GB 文件在默认 4GB 堆限下是直接 V8 OOM,量不到峰值。留着 8GB 的意义是让
      // **回归**(重新引入整读)表现为「看得见的 RSS 峰」而不是「daemon 悄悄崩掉」。
      '--max-old-space-size=8192',
      '--require', samplerCjs,
      join(REPO, 'dist', 'syncx.js'),
      'start',
      '--config', join(dir, 'config.json'),
      '--port', String(port),
      '--control-port', String(controlPort),
      '--log-file', join(dir, 'daemon.log'),
    ],
    {
      cwd: REPO,
      env: { ...process.env, SYNCX_SCAN_INTERVAL_MS: '250', RSS_LOG: rssLog },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );

  const rssLogA = samplerFor(aDir);
  const rssLogB = samplerFor(bDir);

  log('启动 A(发送方)…');
  const procA = spawnDaemon(aDir, PORT_A, CTRL_A, rssLogA);
  await waitPort(CTRL_A, 30000);
  log('启动 B(接收方,被采样)…');
  const procB = spawnDaemon(bDir, PORT_B, CTRL_B, rssLogB);
  await waitPort(CTRL_B, 30000);

  // 大文件先写进**同卷暂存目录**再 rename 进共享目录:A 的扫描每 250ms 一轮,
  // 边写边扫会把「部分写入的版本」逐轮广播出去,接收端反复重收、峰值可判性全无。
  // (尺寸注意:发送侧已改逐块读盘,不再有 readFileSync 的 ~2GiB 硬上限;但接收侧
  // 阶段 1a 仍把在途块攒在 PendingEntry.blocks 里,再往上调尺寸要先看判读档位是否
  // 还落在「≈1× 文件大小」这一档。)
  const stageBin = join(workDir, 'stage', 'big.bin');
  mkdirSync(join(stageBin, '..'), { recursive: true });
  const bigBin = 'big.bin';
  log(`写入 ${FILE_BYTES} 字节到暂存目录…`);
  const srcBuf = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < srcBuf.length; i += 4096) {
    // 确定性伪随机:重复内容对 CDC 无碍,两侧 sha256 对比仍可判等
    srcBuf.writeUInt32LE((i * 2654435761) >>> 0, i);
  }
  const t0 = Date.now();
  const fullChunks = Math.floor(FILE_BYTES / srcBuf.length);
  const remainder = FILE_BYTES % srcBuf.length;
  for (let i = 0; i < fullChunks; i++) {
    writeFileSync(stageBin, srcBuf, { flag: i === 0 ? 'w' : 'a' });
  }
  if (remainder) writeFileSync(stageBin, srcBuf.subarray(0, remainder), { flag: 'a' });
  if (statSync(stageBin).size !== FILE_BYTES) throw new Error('写入不完整');
  log(`写入完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  log('rename 进 A 的共享目录(原子,只让扫描见到完整文件)…');
  const tRename = Date.now();
  renameSync(stageBin, join(shareA, bigBin));
  log(`rename 完成 ${((Date.now() - tRename) / 1000).toFixed(1)}s`);

  await waitFor(() => existsSync(join(shareB, bigBin)), 600_000);
  log('接收端文件已落地(存在即已 rename)');

  await new Promise((r) => setTimeout(r, 1500)); // 留出日志/采样尾巴
  procA.kill();
  procB.kill();
  await Promise.all([
    new Promise((r) => procA.once('exit', r)),
    new Promise((r) => procB.once('exit', r)),
  ]);

  const ha = await sha256Of(join(shareA, bigBin));
  const hb = await sha256Of(join(shareB, bigBin));
  const samples = readFileSync(rssLogB, 'utf8').split('\n').filter(Boolean).map(Number);
  const peak = Math.max(...samples);
  const peakGB = (peak / 1073741824).toFixed(2);
  log(`sha256 一致: ${ha === hb}`);
  log(`B 侧 RSS 峰值: ${peakGB} GB(采样 ${samples.length} 点)`);
  console.log(JSON.stringify({ peakRssBytes: peak, samples: samples.length, shaMatch: ha === hb }));
  log(`工作目录保留在 ${workDir}(量完可整目录删除)`);
};

run().catch((e) => { console.error('[bench][error]', e); process.exit(1); });
