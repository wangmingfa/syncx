#!/usr/bin/env node
/**
 * 本地打包 syncx 安装包(tgz),供 Web UI「上传安装包升级」快速验证,
 * 免去每验证一次都要发一个 npm 新版本的往返。
 *
 * 产物结构与 npm 发布物一致(顶层 package/ 内含 package.json + dist/syncx.js),
 * 因此能直接喂给服务端同一条自更新管线:解压 → 四道校验 → 整包换入 → 失败自动回滚。
 *
 * 版本号(重要):
 *   基数**就是本机 package.json 的 version** —— 不查 npm registry、不递增、也不写回仓库。
 *   也就是说:如果你本地是 0.2.14、npm 上最新是 0.2.20,打出来的包版本仍是 0.2.14。
 *   默认自动附加**打包时刻的时间戳**后缀(0.2.14-20261105.0930),让多次本地构建
 *   可区分(装到多台设备后能从界面看出装的是哪一次);--no-timestamp 可关掉。
 *   也可以用 --append 显式指定后缀(此时不再叠加时间戳):
 *     npm run pack:local -- --append local.1   → 0.2.14-local.1
 *   后缀属 semver 预发布标识,只改压缩包里那份 package.json,仓库文件一字不动。
 *   注意口径:semver 预发布排在同基数的正式版**之前**,所以带时间戳的本地包对
 *   「从对端升级」(版本必须严格比对端新)而言不算比 0.2.14 正式版新 —— 本地验证
 *   请让相关设备都装时间戳包,同后缀体系内按日期时间正常比大小。
 *
 * 用法:
 *   npm run pack:local                      先构建再打包(默认,版本取 package.json + 时间戳)
 *   npm run pack:local -- --no-build        直接用现有 dist/syncx.js 打包
 *   npm run pack:local -- --no-timestamp    不加时间戳,版本就是 package.json 原样
 *   npm run pack:local -- --append local.1  显式附预发布后缀(替代时间戳)
 *   npm run pack:local -- --out <目录>       指定输出目录(默认项目根)
 *   npm run pack:local -- --backend rust    打 Rust 后端安装包(syncx-rs)
 *   npm run pack:local -- --backend moonbit 打 MoonBit 后端安装包(syncx-mb)
 *
 * 打包完成时自动清理输出目录里**旧的时间戳产物**(匹配本脚本的时间戳命名方案,
 * 连带 rust/moonbit 资产;不带时间戳的文件一律不碰),防止反复打包无限堆积。
 *
 * --backend(node 缺省):
 *   node     现有行为 —— npm 载体的 tgz,喂给 Web UI「上传升级」。
 *   rust / moonbit  按发布 workflow 的资产命名(syncx-v{version}-{target-triple}.tar.gz
 *   / Windows .zip)打「本机目标」的包:解压结构与 GitHub Release 资产一致,
 *   便于在多台设备上验证自更新的下载/换入链路(真实 Release 的本地替身)。
 *   时间戳/--append 对 rust/moonbit 同样生效(仅改资产文件名;包内二进制的
 *   版本注入走不到,版本号只体现在资产文件名里)。
 *
 * 注意:升级是「整包替换安装目录」。请勿对源码仓库目录做升级 —— 直接
 * `node dist/syncx.js` 从仓库里跑时,安装目录就是仓库根,服务端会拒绝(防止删掉 src/)。
 * 想在本机验证,先把产物装到独立目录再启动:
 *   npm i -g --prefix ~/.syncx-test ./syncx-<version>-local.tgz
 *   node ~/.syncx-test/lib/node_modules/@wangmingfa/syncx/dist/syncx.js start \
 *     --config ~/.syncx-test/config.json --log-file ~/.syncx-test/syncx.log
 * (Windows 上模块根是 <prefix>/node_modules,非 lib/node_modules)
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(ROOT, '..');
const PKG_PATH = join(PROJECT, 'package.json');
const DIST_BUNDLE = join(PROJECT, 'dist', 'syncx.js');

const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';

const log = (msg) => console.log(`[pack:local] ${msg}`);
const fail = (msg) => {
  console.error(`[pack:local][error] ${msg}`);
  process.exit(1);
};

/**
 * Windows 下 .cmd 不能直接 spawn(会 EINVAL),须经 shell;但「shell:true + args 数组」
 * 在 Node 24 会报 DEP0190(参数被裸拼接、有注入风险)。这里自己拼好带引号的命令行后
 * 交给 shell、args 留空 —— 告警消失,且路径含空格也不会被拆开。
 */
function quoteArg(arg) {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return /[&|<>^()!]/.test(arg) ? arg.replace(/[&|<>^()!]/g, '^$&') : arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function run(cmd, args, { cwd = PROJECT } = {}) {
  const r = IS_WIN
    ? spawnSync([cmd, ...args.map(quoteArg)].join(' '), [], { cwd, stdio: 'inherit', shell: true })
    : spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.error) fail(`${cmd} 启动失败: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} 失败 (exit ${r.status})`);
}

/** 本脚本时间戳命名方案的产物名(输出目录清扫的匹配范围,匹配不到的一律不动):
 *  node tgz:syncx-<version>-YYYYMMDD.HHMM.tgz;后端资产:syncx-(rs|mbt)-v<version>
 *  -YYYYMMDD.HHMM-<triple>.tar.gz / .zip。 */
const TS_PACK_PATTERNS = [
  /^syncx-.+-\d{8}\.\d{4}\.tgz$/,
  /^syncx-(rs|mbt)-.+-\d{8}\.\d{4}-[A-Za-z0-9_.-]+\.(tar\.gz|zip)$/,
];

/**
 * 清理输出目录里旧的时间戳打包产物:每次打包生成一颗新包,不清会无限堆积。
 * 只删名字命中时间戳方案的文件(本轮产物 keepName 除外),其它文件——包括
 * 不带时间戳的手工命名包——绝不碰,防误删。清扫失败不挡打包,只记日志。
 */
function cleanOldTimestampedPacks(outDir, keepName) {
  let stale;
  try {
    stale = readdirSync(outDir).filter(
      (f) => f !== keepName && TS_PACK_PATTERNS.some((p) => p.test(f)),
    );
  } catch {
    return; // 目录不可读(权限/挂载异常):放弃清扫,打包照常
  }
  for (const f of stale) {
    try {
      rmSync(join(outDir, f));
      log(`清理旧时间戳包:${f}`);
    } catch (e) {
      log(`清理旧时间戳包失败(${f}):${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

const argv = process.argv.slice(2);
let doBuild = true;
let outDir = PROJECT;
let append = '';
let noTimestamp = false;
let backend = 'node';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-build') doBuild = false;
  else if (a === '--build') doBuild = true;
  else if (a === '--no-timestamp') noTimestamp = true;
  else if (a === '--backend') {
    const v = argv[++i];
    if (v !== 'node' && v !== 'rust' && v !== 'moonbit') {
      fail(`--backend 只支持 node / rust / moonbit(收到 "${v}")`);
    }
    backend = v;
  }
  else if (a.startsWith('--backend=')) {
    const v = a.slice('--backend='.length);
    if (v !== 'node' && v !== 'rust' && v !== 'moonbit') {
      fail(`--backend 只支持 node / rust / moonbit(收到 "${v}")`);
    }
    backend = v;
  }
  else if (a === '--append') {
    const v = argv[++i];
    if (!v) fail('--append 需要跟一个后缀,如 --append local.1');
    append = v;
  } else if (a.startsWith('--append=')) append = a.slice('--append='.length);
  else if (a === '--out') {
    const v = argv[++i];
    if (!v) fail('--out 需要跟一个目录');
    outDir = resolve(v);
  } else if (a.startsWith('--out=')) outDir = resolve(a.slice('--out='.length));
  else fail(`无法识别的参数: ${a}(支持 --no-build / --no-timestamp / --append <后缀> / --out <目录>)`);
}

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));

/** 打包时刻的本地时间戳后缀:YYYYMMDD.HHMM。作 semver 预发布标识时,
 *  upgrade.ts 的 compareVersions 恰好按「tag 字符串比日期、迭代号数值比时刻」解析,
 *  同体系内跨天/同天都能正确比出新旧(见文件头「注意口径」)。 */
function timestampSuffix() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// 版本 = 本机 package.json 的 version(不查 registry、不递增);预发布后缀只进包内。
// 默认附时间戳;显式 --append 以后缀为准(两者不叠加);--no-timestamp 打原样版本。
let version = pkg.version;
if (append) {
  if (!/^[0-9A-Za-z.-]+$/.test(append)) {
    fail(`--append 后缀不合法(${append}):只允许字母/数字/点/连字符(作 semver 预发布标识)`);
  }
  // 已是预发布(0.2.14-beta.3)时续在其后(beta.3.local.1),仍是合法 semver
  version = pkg.version.includes('-') ? `${pkg.version}.${append}` : `${pkg.version}-${append}`;
} else if (!noTimestamp) {
  const stamp = timestampSuffix();
  version = pkg.version.includes('-') ? `${pkg.version}.${stamp}` : `${pkg.version}-${stamp}`;
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`版本号 ${version} 不是合法 semver,无法打包`);
}

/** 运行时探测本机 target-triple(与 moonbit-release.yml 的 6 目标对齐)。
 *  Rust/MoonBit 后端的资产名由此拼出;对不上 Release 资产名自更新就匹配不到。 */
function detectTargetTriple() {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (plat === 'win32') return arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  if (plat === 'linux') return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  fail(`无法识别的平台 ${plat}/${arch}:Rust/MoonBit 打包只支持 darwin/linux/windows`);
}

if (backend === 'node') {
  packNode();
} else {
  packBackend();
}

function packNode() {
if (doBuild) {
  log('构建产物(npm run build)…');
  run(NPM, ['run', 'build']);
}
if (!existsSync(DIST_BUNDLE)) {
  fail(`构建产物不存在:${DIST_BUNDLE}(请先 npm run build,或去掉 --no-build)`);
}

// 手工组装 package/ 目录后打包:这样能在不改动仓库 package.json 的前提下,
// 只替换压缩包内那份版本号。文件集与 npm 发布物一致(files 仅 dist/syncx.js)。
// tar 统一走 cwd + 相对归档名:GNU tar 会把 `-f C:\...` 里的 `C:` 当成远程主机名。
const staging = mkdtempSync(join(tmpdir(), 'syncx-pack-local-'));
try {
  const pkgOut = join(staging, 'package');
  mkdirSync(join(pkgOut, 'dist'), { recursive: true });
  writeFileSync(join(pkgOut, 'package.json'), `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  copyFileSync(DIST_BUNDLE, join(pkgOut, 'dist', 'syncx.js'));
  // 与打包安装目录同口径:产物必须带可执行位,否则对端换入后可能 Permission denied
  chmodSync(join(pkgOut, 'dist', 'syncx.js'), 0o755);
  for (const extra of ['README.md', 'LICENSE']) {
    if (existsSync(join(PROJECT, extra))) copyFileSync(join(PROJECT, extra), join(pkgOut, extra));
  }

  log('打包(tar)…');
  run('tar', ['-czf', 'local.tgz', 'package'], { cwd: staging });

  const target = join(outDir, `syncx-${version}.tgz`);
  cleanOldTimestampedPacks(outDir, basename(target));
  // 不能用 renameSync:staging 在系统临时目录(Windows 上通常是 C:),而目标在项目盘
  // (如 F:)——跨卷 rename 直接 EXDEV 失败。staging 反正会在 finally 里整体清掉,
  // 这里复制一份等价且跨平台稳。
  copyFileSync(join(staging, 'local.tgz'), target);

  const size = statSync(target).size;
  const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');

  log(`✅ 打包完成:${target}`);
  log(`   版本 ${version} · ${(size / 1024).toFixed(0)} KB · sha256 ${sha256.slice(0, 16)}…`);
  if (!append && !noTimestamp) {
    log(`   版本 = package.json(${pkg.version}) + 打包时间戳;打原样版本用 --no-timestamp,自定义后缀用 --append local.N`);
  }
  log('');
  log('下一步:在目标设备的 Web UI 点顶栏「上传升级」,选该 tgz 即可(升级前会先显示版本对比)。');
  log('本机验证请装到独立目录(勿对源码仓库目录升级,服务端会拒绝):');
  log(`   npm i -g --prefix ~/.syncx-test ${target}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
}

/** Rust / MoonBit 后端:按发布 workflow 的资产命名打「本机目标」的包。
 *  产物结构与 GitHub Release 资产一致(顶层目录 + 固定二进制名),是真实
 *  Release 的本地替身 —— 用于在多台设备上验证自更新的下载/校验/换入链路。 */
function packBackend() {
  const triple = detectTargetTriple();
  const isRust = backend === 'rust';
  const binName = isRust ? 'syncx-rs' : 'syncx-mb';
  let binPath;
  if (isRust) {
    if (doBuild) {
      log('构建 Rust 后端(build:web + cargo build --release)…');
      run(NPM, ['run', 'build:rust']);
    }
    binPath = join(PROJECT, 'rust', 'target', 'release', IS_WIN ? 'syncx-rs.exe' : 'syncx-rs');
  } else {
    if (doBuild) {
      log('构建 MoonBit 后端(build:web + moon build --release)…');
      run(NPM, ['run', 'build:moonbit']);
    }
    binPath = join(PROJECT, 'moonbit', '_build', 'native', 'release', 'build', 'cli', 'cli.exe');
  }
  if (!existsSync(binPath)) {
    fail(`构建产物不存在:${binPath}(请先构建,或去掉 --no-build)`);
  }

  const staging = mkdtempSync(join(tmpdir(), 'syncx-pack-backend-'));
  try {
    // 资产名带后端标识(syncx-rs / syncx-mbt),与各 Release workflow 一致:
    // 两个后端的产物不会互相覆盖,自更新按名匹配也只会命中自己的后端。
    const prefix = isRust ? 'syncx-rs' : 'syncx-mbt';
    const stage = `${prefix}-v${version}-${triple}`;
    const pkgOut = join(staging, stage);
    mkdirSync(pkgOut, { recursive: true });
    copyFileSync(binPath, join(pkgOut, IS_WIN ? `${binName}.exe` : binName));
    if (!IS_WIN) chmodSync(join(pkgOut, binName), 0o755);
    for (const extra of ['README.md', 'LICENSE']) {
      if (existsSync(join(PROJECT, extra))) copyFileSync(join(PROJECT, extra), join(pkgOut, extra));
    }

    const ext = IS_WIN ? 'zip' : 'tar.gz';
    const archive = `${stage}.${ext}`;
    log(`打包(${ext},资产名与 Release 对齐)…`);
    if (IS_WIN) {
      // 与 workflow 同款:Compress-Archive(解压端 Expand-Archive 配套)
      run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path "${pkgOut}" -DestinationPath "${join(staging, archive)}"`], { cwd: staging });
    } else {
      run('tar', ['-czf', archive, stage], { cwd: staging });
    }

    const target = join(outDir, archive);
    cleanOldTimestampedPacks(outDir, basename(target));
    copyFileSync(join(staging, archive), target);

    const size = statSync(target).size;
    const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');

    log(`✅ 打包完成:${target}`);
    log(`   后端 ${backend} · 目标 ${triple} · ${(size / 1024).toFixed(0)} KB · sha256 ${sha256.slice(0, 16)}…`);
    log('');
    log(`注意:checksums.txt 的两空格格式自更新端会解析,喂给自更新流程时请按`);
    log(`  ${sha256}  ${archive}`);
    log('  的格式生成(与 GitHub Release 的 checksums.txt 一致)。');
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
