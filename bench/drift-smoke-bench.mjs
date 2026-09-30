#!/usr/bin/env node
/**
 * drift 哨兵的真机冒烟:两个真 daemon 走环回,验「审计真的会在活体进程里报出来」——
 * 补齐 test/drift.test.ts 补不上的那一段:那 43 例都是在进程内驱动 createSyncPeer,
 * 没有经过 session-manager 的接线、logger 的落盘与真扫描器写的索引。
 *
 * 判据(同时成立才算过):
 *  1. 干净舰队:文件同步完成后重连一轮,B 的日志里出现 `audit … sampled=3 declared=0 disk=0`;
 *  2. 篡改一字节必须报红:把 B 盘上三份文件的每 256KB 各翻一字节(**size 与 mtime 都还原**),
 *     下一轮 B 报 `disk>0` 并带 `drift … disk <path> slot=` 明细,而**同轮的 A 报 disk=0**
 *     (哨兵不在诚实的一侧哭狼);
 *  3. 只报不回修:报完之后 B 的字节仍然是坏的、两侧 sha256 仍然不一致 —— v1 没有任何动作;
 *  4. 负向对照:B 以 SYNCX_DRIFT_SAMPLE_N=0 重启后,同一套触发一次审计行都不出,
 *     而它**照常同步新文件**(第 4 份文件照样落地)—— 否则判据 1/2 只是「没连上」的假绿。
 *
 * 为什么把损坏打在每 256KB 一个点上:CDC 块长下界是 CDC_MIN_CHUNK(256KB),任意长度 ≥256KB
 * 的半开区间必含一个这样的格点,所以不论 pickSlot 抽中哪个槽都必然落在被改过的字节上;
 * 末块可短于 256KB,故额外在文件尾再翻一字节。
 *
 * 用法(需要 dist/syncx.js,先 npm run build):
 *   npx tsx bench/drift-smoke-bench.mjs
 *
 * 端口固定 24721/24722(+ 控制口 24731/24732),config 目录在系统临时目录里现造。
 * 子进程无论成功失败都在 finally 里收掉;工作目录保留供检查(约 15MB)。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  utimesSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateIdentity } from '../src/identity.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const log = (m) => console.log(`[driftbench] ${m}`);

const PORT_A = 24721;
const PORT_B = 24722;
const CTRL_A = 24731;
const CTRL_B = 24732;

const FILE_BYTES = 3 * 1024 * 1024;
const LATTICE = 256 * 1024; // = CDC_MIN_CHUNK:见文件头
const NAMES = ['f1.bin', 'f2.bin', 'f3.bin'];

const workDir = mkdtempSync(join(tmpdir(), 'syncx-drift-smoke-'));
const shareA = join(workDir, 'shareA');
const shareB = join(workDir, 'shareB');
const aDir = join(workDir, 'a');
const bDir = join(workDir, 'b');
const logA = join(aDir, 'daemon.log');
const logB = join(bDir, 'daemon.log');

const procs = new Map(); // name -> child

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise((res) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); res(true); });
      s.once('error', () => { s.destroy(); res(false); });
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`端口 ${port} 等待超时`);
    await sleep(200);
  }
}
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await sleep(80);
  }
}
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 造一份「每 4KB 一个Deterministic 字」的文件,先写暂存目录再 rename 进共享目录。 */
function dropIntoShareA(name) {
  const stage = join(workDir, 'stage');
  mkdirSync(stage, { recursive: true });
  const buf = Buffer.alloc(FILE_BYTES);
  for (let i = 0; i < buf.length; i += 4) buf.writeUInt32LE((i * 2654435761 + name.length * 7919) >>> 0, i);
  const stagePath = join(stage, name);
  writeFileSync(stagePath, buf);
  renameSync(stagePath, join(shareA, name));
}

/**
 * 就地翻字节:只改内容,**不改 size、不改 mtime/atime**(写完用 utimesSync 还原)。
 * 这正是哨兵唯一存在的理由 —— 这种损坏扫描器永远看不见(size 与 mtime 都没动 → 走无哈希快路)。
 */
function corruptInPlace(path) {
  const st = statSync(path);
  const fd = openSync(path, 'r+');
  let flips = 0;
  const offsets = [];
  for (let off = 7; off < st.size; off += LATTICE) offsets.push(off);
  offsets.push(st.size - 8); // 末块可短于 LATTICE
  try {
    for (const off of offsets) {
      const b = Buffer.alloc(1);
      // 5 参形式:第 3 参是 buffer 内偏移,第 5 参才是文件位置(3 参写法会把字节写到文件开头)
      let got = 0;
      while (got < 1) {
        const n = readSync(fd, b, got, 1 - got, off + got);
        if (n <= 0) break;
        got += n;
      }
      if (got === 1) {
        const flipped = Buffer.from([(b[0] ^ 0xff)]);
        let written = 0;
        while (written < 1) written += writeSync(fd, flipped, 0, 1, off + written);
        flips++;
      }
    }
  } finally {
    closeSync(fd);
  }
  utimesSync(path, new Date(st.atimeMs), new Date(st.mtimeMs));
  return flips;
}

const AUDIT_RE = /audit folder=(\S+) peer=(\S+) round=(\d+) candidates=(\d+) sampled=(\d+) declared=(\d+) disk=(\d+) unreadable=(\d+)/;
function auditLines(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = AUDIT_RE.exec(line);
    if (m) out.push({ raw: line.trim(), round: +m[3], candidates: +m[4], sampled: +m[5], declared: +m[6], disk: +m[7], unreadable: +m[8] });
  }
  return out;
}
function driftDetails(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (/\bdrift folder=\S+ peer=\S+ (declared|disk|unreadable) /.test(line)) out.push(line.trim());
  }
  return out;
}

function spawnDaemon(name, dir, port, controlPort, extraEnv) {
  const p = spawn(process.execPath, [
    join(REPO, 'dist', 'syncx.js'), 'start',
    '--config', join(dir, 'config.json'),
    '--port', String(port),
    '--control-port', String(controlPort),
    '--log-file', join(dir, 'daemon.log'),
  ], {
    cwd: REPO,
    env: {
      ...process.env,
      SYNCX_SCAN_INTERVAL_MS: '250',
      SYNCX_DRIFT_INTERVAL_MS: '1000',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  procs.set(name, p);
  return p;
}
async function restart(name, dir, port, controlPort, extraEnv) {
  const old = procs.get(name);
  if (old) {
    old.kill('SIGKILL');
    await new Promise((r) => { old.once('exit', r); setTimeout(r, 3000); });
    await sleep(400);
  }
  spawnDaemon(name, dir, port, controlPort, extraEnv);
  await waitPort(controlPort, 30000);
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

  spawnDaemon('A', aDir, PORT_A, CTRL_A, {});
  await waitPort(CTRL_A, 30000);
  spawnDaemon('B', bDir, PORT_B, CTRL_B, {});
  await waitPort(CTRL_B, 30000);
  log(`A=${aId.deviceId} B=${bId.deviceId} 工作目录=${workDir}`);
  await sleep(2500); // 会话建立 + 互发 full 索引

  // —— 判据 1:干净舰队必须报 sampled>0 declared=0 disk=0
  for (const n of NAMES) dropIntoShareA(n);
  await waitFor(
    () => NAMES.every((x) => existsSync(join(shareB, x)) && statSync(join(shareB, x)).size === FILE_BYTES),
    60_000, '三份文件落地 B',
  );
  log('三份文件已落地 B,等收敛后重连 A 触发一轮审计…');
  await sleep(2000);
  const bBefore = auditLines(logB).length;
  const aBefore = auditLines(logA).length;
  await restart('A', aDir, PORT_A, CTRL_A, {});
  const bRound = await waitFor(() => {
    const ls = auditLines(logB).slice(bBefore);
    return ls.find((l) => l.sampled > 0) ?? false;
  }, 30_000, 'B 的 sampled>0 审计行');
  await sleep(1500);
  const aClean = auditLines(logA).slice(aBefore).find((l) => l.sampled > 0);
  log(`干净一轮  B: ${bRound.raw}`);
  log(`          A: ${aClean?.raw ?? '(无)'}`);
  const cleanPass = bRound.declared === 0 && bRound.disk === 0 && aClean !== undefined
    && aClean.declared === 0 && aClean.disk === 0;

  // —— 判据 2:篡改一字节(size/mtime 都还原)必须报红
  let flips = 0;
  for (const n of NAMES) flips += corruptInPlace(join(shareB, n));
  const corruptedSha = NAMES.map((n) => sha256File(join(shareB, n)));
  const stB = statSync(join(shareB, NAMES[0]));
  log(`已在 B 盘上翻掉 ${flips} 个字节(size 仍 ${stB.size},mtime 已还原)`);
  await sleep(1500); // 让扫描器跑几轮:它必须完全无感
  const bBefore2 = auditLines(logB).length;
  const aBefore2 = auditLines(logA).length;
  await restart('A', aDir, PORT_A, CTRL_A, {});
  const bDrift = await waitFor(() => {
    const ls = auditLines(logB).slice(bBefore2);
    return ls.find((l) => l.disk > 0) ?? false;
  }, 30_000, 'B 的 disk>0 审计行');
  await sleep(1500);
  const aAtDrift = auditLines(logA).slice(aBefore2).find((l) => l.sampled > 0);
  const details = driftDetails(logB);
  log(`篡改一轮  B: ${bDrift.raw}`);
  log(`          A(诚实侧): ${aAtDrift?.raw ?? '(无)'}`);
  for (const d of details.slice(-6)) log(`          明细 ${d}`);
  const driftPass = bDrift.disk > 0 && details.some((d) => / disk /.test(d))
    && aAtDrift !== undefined && aAtDrift.disk === 0 && aAtDrift.declared === 0;

  // —— 判据 3:只报不回修
  await sleep(3000);
  const nowShaB = NAMES.map((n) => sha256File(join(shareB, n)));
  const nowShaA = NAMES.map((n) => sha256File(join(shareA, n)));
  const untouched = nowShaB.every((s, i) => s === corruptedSha[i]);      // 报过之后没有任何东西重写 B 的文件
  const stillDifferent = nowShaB.every((s, i) => s !== nowShaA[i]);       // 两侧内容仍然不一致
  log(`报完之后:B 字节未被动过 = ${untouched},两侧仍不一致 = ${stillDifferent}(只报不回修)`);
  const noRepairPass = untouched && stillDifferent;

  // —— 判据 4:负向对照 —— 旋钮关到 0 后一次审计都不报,而同步照常
  const bBefore3 = auditLines(logB).length;
  await restart('B', bDir, PORT_B, CTRL_B, { SYNCX_DRIFT_SAMPLE_N: '0' });
  await sleep(1000);
  dropIntoShareA('f4.bin');
  await waitFor(() => existsSync(join(shareB, 'f4.bin')), 60_000, 'B 关闭哨兵后仍能收到新文件');
  await restart('A', aDir, PORT_A, CTRL_A, {}); // 再造一轮「本该审计」的时机
  await sleep(4000);
  const newB = auditLines(logB).slice(bBefore3);
  const offPass = newB.length === 0;
  log(`N=0 之后 B 新增审计行 = ${newB.length}(应为 0),而同步照常(f4 已落地)`);

  const verdict = {
    workDir,
    cleanRound: { sampled: bRound.sampled, declared: bRound.declared, disk: bRound.disk, aDisk: aClean?.disk ?? null },
    cleanPass,
    corruptedBytes: flips,
    driftRound: { sampled: bDrift.sampled, declared: bDrift.declared, disk: bDrift.disk, unreadable: bDrift.unreadable },
    honestSideDisk: aAtDrift?.disk ?? null,
    driftPass,
    bBytesUntouchedAfterReport: untouched,
    sidesStillDiffer: stillDifferent,
    noRepairPass,
    sentinelOffAuditLines: newB.length,
    negativeControlPass: offPass,
    pass: cleanPass && driftPass && noRepairPass && offPass,
  };
  console.log(JSON.stringify(verdict, null, 2));
  log(`工作目录保留在 ${workDir}`);
  if (!verdict.pass) throw new Error('判据未全过,见上面 verdict');
};

run().catch((e) => {
  console.error('[driftbench][error]', e.message);
  console.error(`[driftbench] 工作目录 ${workDir}`);
  process.exitCode = 1;
}).finally(async () => {
  for (const p of procs.values()) { try { p.kill(); } catch {} }
  await Promise.all([...procs.values()].map((p) => new Promise((r) => { p.once('exit', r); setTimeout(r, 3000); })));
  log('子进程已收尾');
});
