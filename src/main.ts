import { ensureSelfExecutable } from './selfexec.js';
import { run } from './cli.js';
import { parseArgs, type ParsedArgs } from './args.js';
import { helpText, packageVersion, wantsHelp, wantsVersion } from './usage.js';

// 自修复执行位:跨平台升级(尤其 Windows → Linux)后,换入的 bundle 在 Unix 上可能落到 0644
// (Windows 无 POSIX exec 位,tar 头记录 ~0644)。本段在 bundle 自身启动早期补 0755,
// 使后续 `syncx` CLI 直接执行可用。逻辑位于新 bundle 的启动代码,故只要对端版本含本修,
// 老接收方换入后首次被 node 拉起即自修,不依赖接收方旧代码。仅 Unix 需要;dev(.ts)跳过。
ensureSelfExecutable();

// 捕获未处理异常/拒绝,避免进程静默崩溃导致集成测试中子进程无法响应 SIGTERM
process.on('uncaughtException', (error) => {
  console.error(`[fatal] uncaughtException: ${error.message}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[fatal] unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

const argv = process.argv.slice(2);

// --help / --version 必须在 parseArgs 之前拦截:它们不是合法命令,
// 交给 parseArgs 只会落到 unknown command,而且退出码会变成 0。
if (wantsHelp(argv)) {
  console.log(helpText(packageVersion()));
  process.exit(0);
}
if (wantsVersion(argv)) {
  console.log(packageVersion());
  process.exit(0);
}

let args: ParsedArgs;
try {
  args = parseArgs(argv);
} catch (error) {
  // 参数错误必须走非零退出码,否则 `syncx status --bogus || exit 1` 这类
  // 脚本/CI 判断会全部失灵。
  console.error(error instanceof Error ? error.message : String(error));
  console.error('');
  console.error('用 `syncx --help` 查看用法。');
  process.exit(1);
}

// 自更新重启拉起的新进程:先等旧进程走完优雅关闭、释放端口,再开始绑定,
// 避免 EADDRINUSE(延迟值由 src/selfupdate.ts 的 spawnRestart 注入)。
const restartDelayMs = Number(process.env.SYNCX_RESTART_DELAY_MS ?? '0') || 0;

const boot = async (): Promise<void> => {
  if (restartDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, restartDelayMs));
  }
  await run(args);
};

boot().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
