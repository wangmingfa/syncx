# syncx

**Peer-to-peer 局域网文件同步工具**(类 Syncthing),使用 Node.js 开发。

在个人自己的多台设备之间,通过局域网实时双向同步文件:笔记本 ↔ 台式机 ↔ NAS ↔ 服务器。无中心服务器、无云依赖,所有设备对等直连。

## 特性

- **纯 P2P 架构** — 设备两两直连,无中心协调节点、无单点故障
- **版本向量冲突检测** — 双方并发编辑同一文件时,保留双方、生成冲突副本,绝不静默丢数据
- **分块增量传输** — 1MB 块 + SHA-256 内容寻址,只传输变化的块,大文件改动不整传
- **墓碑与防复活** — 删除记录带版本号传播,避免"离线修改的文件复活"
- **双模式发现** — mDNS 自动发现局域网设备,同时支持手动配置 `peers` 地址回退
- **忽略规则** — 每个共享目录一个 `.syncxignore`(gitignore 语法),排除不需同步的内容
- **端到端传输加密** — Ed25519 密钥对 + 双向握手,Device ID 由公钥派生
- **Web UI** — 浏览器查看状态、添加/移除共享目录
- **系统服务安装** — `syncx install` 生成 systemd / launchd / Windows 服务模板

## 架构

```
                     ┌─────────────┐
                     │  Device A    │
                     │  identity    │
                     │  index.db    │  SQLite 元数据(node:sqlite)
                     │  executor    │  文件落盘/删除/冲突副本
                     └──────┬──────┘
        mDNS / peers       │   WebSocket + mTLS
   ┌───────────────────────┼───────────────────────┐
   │                       │                       │
┌──┴──────┐           ┌────┴────┐            ┌─────┴────┐
│Device B │  ...       │Device C │   ...      │  Web UI  │
│  对等    │           │  对等    │            │ 控制 API │
└─────────┘           └─────────┘            └──────────┘
```

## 安装

要求 **Node.js ≥ 22.13**(内置 `node:sqlite` 无需额外依赖)。

```bash
git clone <repo-url> && cd syncx
npm install
```

## 配置

配置文件默认在 `~/.syncx/config.json`(用 `--config <路径>` 指定其他位置)。

```json
{
  "sharedFolders": [
    {
      "path": "/home/me/Documents",
      "devices": ["DEV1234567", "DEVABCDEFG"]
    }
  ],
  "peers": ["ws://192.168.1.10:22000"]
}
```

- **sharedFolders[*].path** — 要同步的本地目录绝对路径
- **sharedFolders[*].devices** — 允许与该目录同步的设备 ID(来自对端 `syncx status`)
- **peers** — 手动对端地址(mDNS 不可用时的回退),默认 `[]`

忽略规则:共享目录下放 `.syncxignore`(gitignore 语法),找出不需要同步的内容。

## 端口

| 端口(默认) | 用途 | 绑定 | 局域网可访问 |
|---|---|---|---|
| `22000`(`--port`) | WebSocket P2P 同步 | 所有接口 | ✅ |
| `8384`(`--control-port`) | Web UI + 控制 API | `127.0.0.1` 默认,`--host 0.0.0.0` 暴露 | ✅(需 `--host 0.0.0.0`) |

启动后日志会打印所有可达的 control UI 与 peer 地址,方便直接复制。

## 开发命令

```bash
npm run dev            # 开发运行:tsx watch 自动重载,默认 --host 0.0.0.0(局域网可访问)
npm run test           # 运行全部测试(vitest)
npm run test:watch     # 测试监视模式
npm run typecheck      # TypeScript 类型检查(tsc --noEmit)
npm run build          # 编译到 dist/(tsc)
```

### npm run dev 的参数

`npm run dev` 等价于 `tsx watch src/main.ts start`,任何 `start` 支持的参数都可以通过 `npm run dev -- <参数>` 传入(注意中间的 `--`):

| 参数 | 说明 | 默认值 |
|---|---|---|
| `--config <路径>` | 指定配置文件路径(任意 JSON 文件) | `~/.syncx/config.json` |
| `--port <端口>` | P2P 同步端口(其他设备连接用) | `22000` |
| `--control-port <端口>` | Web UI / 控制 API 端口 | `8384` |
| `--host <地址>` | 控制服务绑定地址 | `0.0.0.0`(dev 脚本已默认;`127.0.0.1` 仅本机) |

示例:

```bash
# 使用自定义配置文件(不修改默认配置)
npm run dev -- --config ~/syncx-home.json

# 指定同步端口与控制端口(避免与其他服务冲突)
npm run dev -- --port 24001 --control-port 8385

# 仅本机访问 Web UI(关闭局域网访问)
npm run dev -- --host 127.0.0.1

# 组合使用
npm run dev -- --config ~/syncx-home.json --port 24001 --control-port 8385
```

启动后日志会打印所有可达的 Web UI 地址(`http://IP:控制端口`)与 peer 同步地址(`ws://IP:同步端口`),可直接复制。

## 生产命令

```bash
# 启动 daemon(前台;部署时配合 systemd/launchd 后台常驻)
npm run build
node dist/main.js start [--config <路径>] [--port <端口>] [--control-port <端口>] [--host <主机>]

# 查看状态:设备 ID 与共享目录数
node dist/main.js status [--config <路径>]

# 生成系统服务模板
node dist/main.js install
```

常用选项:

| 选项 | 说明 |
|---|---|
| `--config <path>` | 指定配置文件路径(默认 `~/.syncx/config.json`) |
| `--port <port>` | peer 同步端口(默认 22000) |
| `--control-port <port>` | Web UI/控制 API 端口(默认 8384) |
| `--host <host>` | 控制服务绑定地址(默认 `127.0.0.1`;`0.0.0.0` 暴露局域网) |

## 双设备同步测试

仓库内置两种集成测试,自动化验证同步正确性:

```bash
npm test   # 含 test/integration/two-daemons.test.ts
```

`two-daemons.test.ts` 会 `spawn` 两个真实 daemon 进程(不同 configDir/端口/共享目录),通过 `peers` 相连,双向同步文件后断言两边一致——正是验证"同步服务是否正确"的方式。

手动体验双设备同步:写两个 config.json,`peers` 互指对方地址,分别启动两个 daemon,两边目录即自动互相同步。

## 许可证

MIT
