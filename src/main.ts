import { parseArgs, run } from './cli.js';

// 捕获未处理异常/拒绝,避免进程静默崩溃导致集成测试中子进程无法响应 SIGTERM
process.on('uncaughtException', (error) => {
  console.error(`[fatal] uncaughtException: ${error.message}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[fatal] unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

const args = parseArgs(process.argv.slice(2));
run(args).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
