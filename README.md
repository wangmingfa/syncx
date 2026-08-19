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

## 快速上手(普通用户)

下面是最短路径:装好 → 启动 → 配对 → 开始同步。

### 1. 安装与启动

要求 **Node.js ≥ 22.13**(内置 SQLite,无额外依赖)。

```bash
git clone <repo-url> && cd syncx
npm install
npm run build
node dist/main.js start
```

首次启动会自动完成:

- 生成设备身份与配置文件(`~/.syncx/`,内含 Device ID)
- 启动 **P2P 同步服务**(默认端口 `22000`)——其他设备通过这个端口连你
- 启动 **Web UI**(默认端口 `8384`,默认仅本机可访问)

日志会打印你的 **Device ID**(形如 `GP72F7K72B`)、Web UI 地址与访问令牌。保持终端运行即可;后台常驻见「系统服务安装」。

### 2. 用 Web UI 管理(推荐)

1. 浏览器打开日志里的地址:`http://127.0.0.1:8384`
2. 登录令牌:日志里有,或查看 `~/.syncx/control.token`
3. 状态页可完成日常操作:
   - **添加共享目录**:填本机目录绝对路径,并勾选允许同步的设备(Device ID)
   - **移除共享目录**:目录列表里删除
   - 查看对端连接状态与同步进度、**手动触发扫描**、**手动重连**某台对端

想让局域网内其它设备也能打开 Web UI?启动时加 `--host 0.0.0.0 --expose-control`(详见「端口」一节)。

### 3. 两台设备配对

每台设备先各自启动 daemon,并用 `node dist/main.js status` 确认自己的 Device ID。

**方式一:邀请码(推荐)**

在 A 上(该目录需已添加为共享目录):

```bash
node dist/main.js invite /home/me/Documents
# 输出一串 base64url 邀请码(1 小时有效,可随时 revoke)
```

在 B 上:

```bash
node dist/main.js join <邀请码> /home/me/Documents
```

B 会打印一串**反向邀请码**——把它发给 A,再在 A 上执行一次 `join`。配对是**双向信任**,双方都要把对方加入白名单,否则对端会拒绝连接。

**方式二:手动配置**(`~/.syncx/config.json`,格式见「配置」一节)

```json
{
  "sharedFolders": [
    {
      "id": "docs",
      "path": "/home/me/Documents",
      "devices": ["对端A的DeviceID"]
    }
  ],
  "peers": ["ws://对端A的IP:22000"]
}
```

- 双方目录配置**相同的 `id`**(如 `docs`),否则对端无法识别这是同一个目录
- 每方的 `devices` 填对方的 Device ID
- mDNS 不可用(跨网段/关防火墙)时,`peers` 填对方地址;同一局域网内一般自动发现,可不配

### 4. 日常使用

- 同步全自动:目录内文件变化几秒内传到对端,删除也会传播;局域网内无需手动操作
- **冲突处理**:双方同时编辑同一文件时,保留双方内容——本地版本存为 `xxx.sync-conflict-时间-设备ID.ext` 副本,远端版本落地,绝不静默丢数据
- **忽略不需要同步的内容**:在共享目录里放一个 `.syncxignore` 文件(gitignore 语法,如 `node_modules/`、`*.tmp`),新建的忽略规则只影响之后的变化
- **限制带宽**:给目录加 `"maxBandwidthKbps": 1024` 可限制单个对端的发送速率,避免大文件占满局域网

### 常见问题(FAQ)

| 问题 | 解决 |
|---|---|
| Web UI 打不开? | 默认仅监听本机。局域网访问需 `--host 0.0.0.0 --expose-control` 启动 |
| 两台设备互相找不到? | mDNS 依赖同一局域网;跨网段或路由器隔离时,双方在 `peers` 互填 `ws://IP:22000`,并放行 UDP 5353 与 TCP 22000 |
| 启动提示端口被占用? | `--port 24001` 改同步端口;`--control-port 8385` 改 Web UI 端口 |
| 忘了自己的 Device ID? | `node dist/main.js status` |
| 想撤销已发出的邀请码? | `node dist/main.js revoke <邀请码>` |
| 换电脑了,原来配对的设备怎么办? | 新设备按「配对」一节重新配对即可;旧设备 ID 不再出现在任何 `devices` 白名单中即断开 |

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
