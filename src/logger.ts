import pino, { type Logger } from 'pino';
import pretty from 'pino-pretty';
import { mkdirSync, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 创建全局日志实例。
 * - logFile 指定时:日志以人类可读格式追加写入文件,同时输出到 stdout
 * - 未指定时:日志仅输出到 stdout
 * - 每行带本地时间戳(yyyy-mm-dd HH:MM:ss),无 hostname/pid 噪声
 * - 级别可通过 LOG_LEVEL 环境变量覆盖(debug/info/warn/error)
 */
export function createLogger(logFile?: string): Logger {
  const prettyOpts: Parameters<typeof pretty>[0] = {
    translateTime: 'yyyy-mm-dd HH:MM:ss',
    ignore: 'hostname,pid',
    colorize: false,
    singleLine: true,
  };

  if (logFile) {
    try {
      mkdirSync(dirname(logFile), { recursive: true });
    } catch {
      // 目录已存在或创建失败,继续尝试写入
    }
    const fileStream = createWriteStream(logFile, { flags: 'a' });
    return pino(
      { level: process.env.LOG_LEVEL ?? 'info', base: undefined },
      pretty({ ...prettyOpts, destination: fileStream }),
    );
  }

  return pino(
    { level: process.env.LOG_LEVEL ?? 'info', base: undefined },
    pretty(prettyOpts),
  );
}