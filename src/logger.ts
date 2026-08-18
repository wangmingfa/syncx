import pino, { type Logger } from 'pino';
import pretty from 'pino-pretty';
import { mkdirSync, statSync, renameSync, unlinkSync, existsSync, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { Writable } from 'node:stream';

/** 日志轮转配置。 */
interface LogRotation {
  /** 单文件最大字节数,默认 10 MB。 */
  maxSizeBytes: number;
  /** 保留的轮转文件数,默认 5。 */
  maxFiles: number;
}

const DEFAULT_ROTATION: LogRotation = {
  maxSizeBytes: 10 * 1024 * 1024,
  maxFiles: 5,
};

/**
 * 创建全局日志实例。
 * - logFile 指定时:日志以人类可读格式追加写入文件,同时输出到 stdout;
 *   文件超过 maxSizeBytes 自动轮转,保留 maxFiles 份旧日志
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
    const rotatingStream = createRotatingStream(logFile, DEFAULT_ROTATION);
    return pino(
      { level: process.env.LOG_LEVEL ?? 'info', base: undefined },
      pretty({ ...prettyOpts, destination: rotatingStream }),
    );
  }

  return pino(
    { level: process.env.LOG_LEVEL ?? 'info', base: undefined },
    pretty(prettyOpts),
  );
}

/**
 * 基于 pino-pretty 的轮转 WriteStream:每次写入前检查文件大小,
 * 超过 maxSizeBytes 则按 .1/.2/... 轮转,保留 maxFiles 份。
 */
function createRotatingStream(logFile: string, rotation: LogRotation): Writable {
  let currentFile = logFile;

  function rotate(): void {
    try {
      for (let i = rotation.maxFiles - 1; i >= 1; i--) {
        const old = `${logFile}.${i}`;
        const newer = `${logFile}.${i + 1}`;
        if (existsSync(newer)) unlinkSync(newer);
        if (existsSync(old)) renameSync(old, newer);
      }
      if (existsSync(logFile)) renameSync(logFile, `${logFile}.1`);
      currentFile = logFile;
    } catch {
      // 轮转失败(如磁盘满)不影响写入,继续追加
    }
  }

  return new Writable({
    write(chunk: Buffer, _encoding: string, cb: (error?: Error | null) => void): void {
      try {
        if (existsSync(currentFile)) {
          const stat = statSync(currentFile);
          if (stat.size >= rotation.maxSizeBytes) {
            rotate();
          }
        }
      } catch {
        // stat 失败继续写入
      }
      const ws = createWriteStream(currentFile, { flags: 'a' });
      ws.write(chunk, () => {
        ws.end();
        cb();
      });
    },
  });
}