import { parseArgs, run, type ParsedArgs } from './cli.js';
import { helpText, packageVersion, wantsHelp, wantsVersion } from './usage.js';

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

run(args).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
