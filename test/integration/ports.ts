import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import {
  startPeerServer,
  type PeerHandlers,
  type PeerServer,
  type PeerServerOptions,
} from '../../src/net/server.js';
import type { DeviceIdentity } from '../../src/identity.js';

/**
 * 探测一个空闲端口:绑定 0 端口获取系统分配的端口号后立即释放。
 * 用于给子进程 daemon 分配端口 —— 测试文件并行运行时,固定随机区间
 * (如 24000-34000)会互相碰撞导致 EADDRINUSE。
 *
 * 探测时保留 `127.0.0.1` 是为了让端口号问在**消费方真正使用的地址族**上:测试连的是
 * `ws://127.0.0.1:P`,而向 `::` 要来的号并不天然保证 v4 侧也空着(实测内核为 `listen(0)`
 * 会避开当时已被占的 v4 端口,200 次抽样零碰撞 —— 也就是说今天两种写法都不出事,但绑 v4
 * 不必把这个不变量寄托在内核行为上)。
 *
 * 这条路径上真正没被收住的是另外两点:①探测完就释放,由子进程去绑同一个号,中间必然留着
 * TOCTOU 窗口;②daemon 走 `startPeerServer(port)` 把端口绑在 `::`(双栈),而双栈绑定不独占
 * 环回 —— 那要靠 daemon 自己支持显式 host 才能收,属于生产网络层的事,不在测试 helper 范围内。
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
 * 起一个把端口**独占在 127.0.0.1 上**的 peer server(测试专用;生产走 `startPeerServer`)。
 *
 * 为什么不直接 `startPeerServer(..., 0)`:那样端口绑在 `::`(双栈),而双栈绑定不独占环回
 * —— 别的进程随后可以补绑同端口号的 `127.0.0.1`,并且那个更具体的 v4 绑定会接走环回连接。
 * 于是 `ws://127.0.0.1:P` 连到的是别人的服务,测试随机收到
 * `Unexpected server response: 404`(2026-09-29 的全量跑就是这样挂了一次:单文件连跑 40 次
 * 全绿,只有并发跑全量时才撞上)。内核为 `listen(0)` 只避让**当时已被占**的 v4 端口,
 * 保证不了之后不被补绑 —— 实测 200 次分配 0 次命中已占用端口,但补绑同端口一律成功。
 *
 * 这里先把 http server 绑到 `127.0.0.1:0` 并**保持监听**,再把它交给 peer server 复用:
 * 同端口再绑直接 EADDRINUSE,环回流量归属从此没有竞争者。`close()` 会连它一起关掉。
 */
export function startLoopbackPeerServer(
  identity: DeviceIdentity,
  handlers: PeerHandlers,
  options: PeerServerOptions = {},
): Promise<PeerServer> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer();
    // 绑定失败由 reject 接住;成功之后这枚 once 仍然挂着,后续任何 'error' 只会打在
    // 已 settle 的 promise 上(静默忽略),不会变成 uncaught 'error' 掀翻测试进程。
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve(startPeerServer(identity, handlers, port, { ...options, server }));
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
export function cleanDaemonEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  env.SYNCX_SCAN_INTERVAL_MS = '250';
  env.SYNCX_SERVE_LEASE_MS = '1200';
  return { ...env, ...extra };
}
