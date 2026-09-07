import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, statSync, createWriteStream, type WriteStream } from 'node:fs';
import { rmDir } from './helpers.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRotatingStream } from '../src/logger.js';

describe('rotating log stream', () => {
  it('reuses a single WriteStream across writes instead of opening one per write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-log-'));
    const logFile = join(dir, 'syncx.log');
    const opened: string[] = [];

    // 注入流工厂以计数打开的流数:修复前每次写都新建流(50 次),
    // 修复后复用同一流(1 次)
    const stream = createRotatingStream(
      logFile,
      { maxSizeBytes: 1024 * 1024, maxFiles: 3 },
      (path) => {
        opened.push(path);
        return createWriteStream(path, { flags: 'a' });
      },
    );

    for (let i = 0; i < 50; i++) {
      await new Promise<void>((resolve, reject) => {
        stream.write(Buffer.from(`line ${i}\n`), (err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise<void>((resolve) => stream.end(() => resolve()));

    expect(opened).toHaveLength(1);
    expect(readFileSync(logFile, 'utf8').split('\n').filter(Boolean)).toHaveLength(50);

    rmDir(dir);
  });

  it('attaches an error handler to the underlying WriteStream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-log-'));
    const logFile = join(dir, 'syncx.log');
    const created: WriteStream[] = [];
    const stream = createRotatingStream(
      logFile,
      { maxSizeBytes: 1024 * 1024, maxFiles: 3 },
      (path) => {
        const ws = createWriteStream(path, { flags: 'a' });
        created.push(ws);
        return ws;
      },
    );

    await new Promise<void>((resolve, reject) => {
      stream.write(Buffer.from('hello\n'), (err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve) => stream.end(() => resolve()));

    // 缓存流常驻:磁盘满/轮转重开失败时 fs 流会 emit 'error',必须有处理器,
    // 否则依赖 main.ts 的 uncaughtException 兜底(修复前 created[0] 无 error 监听)
    expect(created).toHaveLength(1);
    expect(created[0]!.listenerCount('error')).toBeGreaterThan(0);

    rmDir(dir);
  });

  it('rotates the file when it exceeds maxSizeBytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncx-log-'));
    const logFile = join(dir, 'syncx.log');
    const stream = createRotatingStream(logFile, { maxSizeBytes: 1024, maxFiles: 3 });

    const line = Buffer.from('x'.repeat(256) + '\n');
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve, reject) => {
        stream.write(line, (err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise<void>((resolve) => stream.end(() => resolve()));

    // 轮转已发生:旧日志在 .1,主文件不超过上限(留一行余量)
    expect(existsSync(`${logFile}.1`)).toBe(true);
    expect(statSync(logFile).size).toBeLessThanOrEqual(1024 + 256);

    rmDir(dir);
  });
});
