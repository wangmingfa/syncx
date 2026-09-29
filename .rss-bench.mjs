/**
 * 一次性基准:两个真 daemon 之间同步一个 2GB 文件,采样接收端的 RSS 峰值。
 * 用于断点续传阶段 1a(去掉落地整文件 concat)的前后对比。用后即删,不入库。
 *
 * 采样方式:接收端以 `node --require rss-sampler.cjs` 启动,采样器每 100ms 把
 * process.memoryUsage().rss 追加进自己的日志 —— 直接读进程内 RSS,比外部 PowerShell 准。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, renameSync } from 'node:fs';
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { loadOrCreateIdentity } from './src/identity.js';

const REPO = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const BENCH = 'F:/.rss-bench';
const FILE_BYTES = 2 * 1024 * 1024 * 1024;
const CHUNK = 64 * 1024 * 1024;
const log = (m) => console.log(`[bench] ${m}`);

const samplerCjs = join(BENCH, 'rss-sampler.cjs');

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

const run = async () => {
  mkdirSync(BENCH, { recursive: true });
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
  const shareA = join(BENCH, 'shareA');
  const shareB = join(BENCH, 'shareB');
  mkdirSync(shareA, { recursive: true });
  mkdirSync(shareB, { recursive: true });

  const aDir = join(BENCH, 'a');
  const bDir = join(BENCH, 'b');
  const aId = loadOrCreateIdentity(aDir);
  const bId = loadOrCreateIdentity(bDir);
  log(`A=${aId.deviceId} B=${bId.deviceId}`);

  const samplerFor = (dir) => {
    const p = join(dir, 'rss.log');
    if (existsSync(p)) writeFileSync(p, '');
    return p;
  };
  const rssLogA = samplerFor(aDir);
  const rssLogB = samplerFor(bDir);

  writeFileSync(join(aDir, 'config.json'), JSON.stringify({
    sharedFolders: [{ id: 'main', path: shareA, devices: [bId.deviceId] }],
    peers: [],
  }));
  writeFileSync(join(bDir, 'config.json'), JSON.stringify({
    sharedFolders: [{ id: 'main', path: shareB, devices: [aId.deviceId] }],
    peers: ['ws://127.0.0.1:24601'],
  }));

  const spawnDaemon = (dir, port, controlPort, rssLog) => spawn(
    process.execPath,
    [
      // 1.5GB 文件在默认 4GB 堆限下会让发送端 OOM(实测):基准要量的是峰值而不是崩溃
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

  log('启动 A(发送/基线持有方)…');
  const procA = spawnDaemon(aDir, 24601, 24611, rssLogA);
  await waitPort(24611, 30000);
  log('启动 B(接收/被采样方)…');
  const procB = spawnDaemon(bDir, 24602, 24612, rssLogB);
  await waitPort(24612, 30000);

  // 先写进**同卷暂存目录**再 rename 进共享目录:A 的扫描每 250ms 一轮,边写边扫会
  // 把「部分写入的版本」逐轮广播出去,接收端反复重收、耗时可判性全无。
  // 文件尺寸 1.5GB:applySend 是 readFileSync 整文件读,Node 对 >2GiB 直接抛
  // ERR_FS_FILE_TOO_LARGE —— 这个上限是本次顺带发现的产品事实。
  const stageBin = join(BENCH, 'stage', 'big.bin');
  const bigBin = 'big.bin';
  // 600MB:基线接收路径峰值 ≈ 3×文件大小(blocks + provider concat + landRemote concat),
  // 在默认 4GB 堆限内可完整跑完。1.5GB 会在默认堆限下 OOM、8GB 堆限下仍触顶 ——
  // 这个「文件多大就会崩」的边界本身就是阶段 1 的立论证据,已另记。
  const FILE_BYTES = Math.floor(0.6 * 1024 * 1024 * 1024);
  mkdirSync(join(BENCH, 'stage'), { recursive: true });
  log(`写入 ${FILE_BYTES} 字节到暂存目录…`);
  const srcBuf = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < srcBuf.length; i += 4096) {
    // 确定性伪随机:重复内容对 CDC 无碍,哈希对比仍可判等
    srcBuf.writeUInt32LE((i * 2654435761) >>> 0, i);
  }
  const t0 = Date.now();
  const fullChunks = Math.floor(FILE_BYTES / srcBuf.length);
  const remainder = FILE_BYTES % srcBuf.length;
  for (let i = 0; i < fullChunks; i++) {
    writeFileSync(stageBin, srcBuf, { flag: i === 0 ? 'w' : 'a' });
  }
  if (remainder) writeFileSync(stageBin, srcBuf.subarray(0, remainder), { flag: 'a' });
  const writtenBytes = statSync(stageBin).size;
  if (writtenBytes !== FILE_BYTES) throw new Error(`写入不完整: ${writtenBytes} / ${FILE_BYTES}`);
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
  log(`sha256 一致: ${ha === hb}`);
  log(`B 侧 RSS 峰值: ${(peak / 1073741824).toFixed(2)} GB(采样 ${samples.length} 点)`);
  console.log(JSON.stringify({ peakRssBytes: peak, samples: samples.length, shaMatch: ha === hb }));
};

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

run().catch((e) => { console.error('[bench][error]', e); process.exit(1); });
