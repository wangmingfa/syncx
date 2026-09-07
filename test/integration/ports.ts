import { createServer } from 'node:net';

/**
 * 探测一个空闲端口:绑定 0 端口获取系统分配的端口号后立即释放。
 * 用于给子进程 daemon 分配端口 —— 测试文件并行运行时,固定随机区间
 * (如 24000-34000)会互相碰撞导致 EADDRINUSE。
 */
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 派生 daemon 子进程用的干净 env:剥离宿主环境注入的 NODE_OPTIONS
 * (如 IDE 沙箱的 fs 审计 shim——它会让 daemon 读取 device.key / control.token
 * 等敏感文件时阻塞等待外部审批,直接拖垮测试的启动超时)。
 */
export function cleanDaemonEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return env;
}
