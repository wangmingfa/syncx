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
 *
 * 同时注入测试加速参数:扫描节奏 250ms、发送租约 1.2s(生产分别是 5s / 15s,
 * 经 SYNCX_SCAN_INTERVAL_MS / SYNCX_SERVE_LEASE_MS 覆盖)。慢测试的时间大头
 * 就是「等下一个 5s 扫描 tick」和「等 15s 租约过期」。
 */
export function cleanDaemonEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  env.SYNCX_SCAN_INTERVAL_MS = '250';
  env.SYNCX_SERVE_LEASE_MS = '1200';
  return env;
}
