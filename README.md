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
- **Web UI** — 浏览器查看状态、添加/移除共享目录、配对设备
- **系统服务安装** — `syncx install` 生成 systemd / launchd / Windows 服务模板

## 快速上手(普通用户)

下面是最短路径:装好 → 启动 → 配对 → 开始同步。全程用 `syncx` 命令,不需要克隆仓库。

### 1. 安装与启动

要求 **Node.js ≥ 22.13**(内置 SQLite,无额外依赖)。

```bash
npm i -g @wangmingfa/syncx
syncx start
```

> 开发者 / 想跑源码:见下方「从源码运行(开发者)」。

首次启动会自动完成:

- 生成设备身份与配置文件(`~/.syncx/`,内含 Device ID)
- 启动 **P2P 同步服务**(默认端口 `22000`)——其他设备通过这个端口连你
- 启动 **Web UI**(默认端口 `8384`,默认仅本机可访问)

日志会打印你的 **Device ID**(形如 `GP72F7K72B`)、Web UI 地址与访问令牌。保持终端运行即可;
想开机自启 / 后台常驻,用 `syncx install` 生成 systemd / launchd / Windows 服务模板(见「生产命令」)。

### 2. 用 Web UI 管理(推荐)

1. 浏览器打开日志里的地址:`http://127.0.0.1:8384`
2. 登录令牌:日志里有,或查看 `~/.syncx/control.token`
3. 嫌令牌难记?顶栏「登录密码」里设一个**用户名 + 密码**,之后就用账号登录。令牌不会被替代,而是降级为恢复通道 —— 忘密码时用令牌进来重设即可(详见「登录密码」)
4. 状态页可完成日常操作:
   - **添加共享目录**:填本机目录绝对路径,并记下自动生成的**目录 ID**(跨机同步对方须用同一 ID)
   - **移除共享目录**:目录列表里删除
   - **设备配对**:右栏粘贴对方**设备 ID** 即发起配对,对方网页弹出请求、点「确认」即双向生效;目录卡上把目录指派给某设备即发出**共享邀请**,对方点「确认」并选好本地路径即开始同步(详见「两台设备配对」)
   - **待确认**:对方发来的配对 / 共享邀请会出现在页面顶部「待确认」区,确认或忽略都在这里
   - 查看对端连接状态与同步进度、**手动触发扫描**、**手动重连**某台对端

想让局域网内其它设备也能打开 Web UI?启动时加 `--host 0.0.0.0 --expose-control`(详见「端口」一节)。

### 3. 两台设备配对(Syncthing 式)

每台设备先各自启动 daemon,记下自己的 Device ID(网页顶部,或 `syncx status`)。

syncx 采用类 Syncthing 的配对模型:**粘贴对方设备 ID 即发起配对,对方网页点「确认」即双向生效;
把目录指派给某设备即发出共享邀请,对方网页点「确认」并选好本地路径即开始同步**。

在 A(本机)上完成配对:

1. 左栏「共享目录」添加要同步的目录,记下它的**目录 ID**(跨机同步对方须用同一目录 ID)。
2. 右栏「设备」粘贴 B 的 Device ID → 点「添加设备」。B 的网页立刻弹出**配对请求**,
   B 点「确认」后双方互相把对方加入已知设备,配对完成。
3. 回到 A 的目录卡,在「选择可同步此目录的设备」里勾选 B → B 的网页弹出**目录共享邀请**,
   B 点「确认」并填写自己机器上对应的本地路径后,该目录开始在两端同步。

> 邀请是**实时推送**的:双方 daemon 需同时在线(A 操作经已建立的连接推送给 B)。
> 若对方暂时离线,待其上线并互连后,本机会在连接建立时自动重发共享意图,对方上线即可看到待确认项。

**方式二:手动配置(无 mDNS / 跨网段)**(`~/.syncx/config.json`,格式见「配置」一节)

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

**方式三:命令行邀请码(专家 / 无局域网发现)**

仍可用 CLI 的 `invite` / `join` / `revoke`(见下方「配置」一节),适合完全无 mDNS、且不便于粘贴设备 ID 的场景。
该方式以签名邀请码交换白名单,与 Web UI 的配对/共享邀请并存、互不冲突。

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
| 忘了自己的 Device ID? | `syncx status` |
| 想撤销已发出的 CLI 邀请码? | `syncx revoke <邀请码>`(仅对命令行邀请码有效;Web UI 的配对/共享可在对方确认前于「待确认」里忽略,或移除设备/取消目录指派) |
| 想升级 / 卸载? | 升级:`npm i -g @wangmingfa/syncx@latest`;卸载:`npm uninstall -g @wangmingfa/syncx`(配置与数据在 `~/.syncx/`,需手动删除) |
| 忘了命令 / 想确认装的是哪个版本? | `syncx --help` 看全部命令与选项,`syncx --version` 看版本号 |
| 令牌太长记不住 / 忘了登录密码? | 用令牌登录 → 顶栏「登录密码」设置账号密码;反之忘密码就用令牌登录进来重设(令牌是永久恢复通道) |
| 对方没收到配对 / 共享邀请? | 邀请经实时连接推送,双方须同时在线且已互连(状态页该设备显示「在线」);离线时会于对方上线并互连后自动补发。先确认设备 ID 填写正确、且对方 daemon 已启动 |
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

### 全局安装(普通用户)

```bash
npm i -g @wangmingfa/syncx     # 安装 / 升级
syncx start                    # 装完即可用,无需克隆仓库
npm uninstall -g @wangmingfa/syncx
```

全局安装后命令名就是 `syncx`,下文所有 `node dist/syncx.js …` 都可写成 `syncx …`。

### 从源码运行(开发者)

改代码、跑测试、或用未发布的功能时才需要:

```bash
git clone <repo-url> && cd syncx
npm install
npm run build          # 编译到 dist/
node dist/syncx.js start
```

日常开发用 `npm run dev`(热重载,见「开发命令」),只在验证生产产物时才 `npm run build` + `node dist/syncx.js`。

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

忽略规则:见下方「忽略规则(`.syncxignore`)」一节。

## 忽略规则(`.syncxignore`)

在共享目录根下放一个 `.syncxignore` 文件即可排除不需要同步的内容,语法与 **gitignore 一致**。

### 基本用法

```gitignore
# 注释行
node_modules          # 任意层级下的 node_modules 目录(扫描时整棵剪枝)
*.log                 # 无斜杠模式:匹配任意层级的文件名
/tmp/                 # 前导斜杠 + 尾斜杠:仅根下的 tmp 目录
build/**/*.map        # 含斜杠模式:按完整相对路径匹配
!important.log        # 取反:从之前的忽略中豁免
```

规则语义:

| 写法 | 含义 |
|---|---|
| `#` 开头 | 注释,跳过 |
| `!` 开头 | 取反(豁免),后写的规则覆盖先写的 |
| `*` | 匹配任意字符,但不跨 `/` |
| `**` | 跨任意层级(须紧邻 `/`,如 `**/foo`、`a/**`) |
| `?` | 匹配单个非 `/` 字符 |
| 模式含 `/` | 按完整相对路径匹配;否则按文件名在任意层级匹配 |

### 行为说明

- **每设备本地生效**:规则文件不会同步给对端,各设备可维护各自不同的规则(想让两端一致,需各放一份相同内容);
- **热加载**:修改 `.syncxignore` 后自动生效,无需重启 daemon;
- **新增规则只影响之后的变化**:已同步的文件不会因为后来才被 ignore 就从对端消失;已同步文件的**删除仍会传播**(墓碑不受 ignore 影响),避免复活 bug;
- **被忽略的目录会整棵跳过**:扫描时命中目录规则即不深入,其下内容不参与同步;
- **无内置默认忽略**(仅协议自身的 `*.syncx-tmp` 临时文件):隐藏文件、`.git/`、系统垃圾文件等默认都会同步,需要排除请自行写入 `.syncxignore`;
- **`.syncxignore` 自身会被当作普通文件同步**,如不想传播规则,在文件里加一行 `**/.syncxignore`。

### 从 Syncthing 迁移

`.stignore` 的 gitignore 部分可直接复用,但 **`(?d)` 前缀不被支持**——它会被当成模式的一部分导致规则静默失效,迁移时请剥掉该前缀;目录规则**不要加尾斜杠**(syncx 的目录规则不支持通配符,加尾斜杠会使规则失效,保持 `**/dir` 形式即可)。

## 登录密码

Web UI 默认用 `~/.syncx/control.token`(48 位随机串)登录。令牌难记,所以支持在设过一次之后改用**账号密码**:

1. 用令牌登录 → 顶栏「登录密码」→ 填用户名(≥1 字符)与密码(≥6 位)→ 保存
2. 之后登录页直接显示用户名 + 密码框,不再需要令牌

规则与边界:

| 项 | 说明 |
|---|---|
| 恢复通道 | 令牌**始终有效**,不因设置密码而失效。忘记密码就用令牌登录进来重设 |
| 密码存储 | scrypt 加盐派生后写入 `~/.syncx/auth.json`(0600),**不存明文** |
| 会话 | 登录后签发 HMAC 签名的无状态 Cookie(24h),daemon 重启不掉线 |
| 改 / 清密码 | 会让**所有已登录页面**重新登录(签名密钥随密码哈希变化)。清除后退回令牌登录 |
| 爆破防护 | 同一来源 IP 连续失败 5 次锁定 60 秒 |
| 安全边界 | 密码是便利而非加固:能读 `~/.syncx/` 的人照样能读令牌。且 `--host 0.0.0.0 --expose-control` 下是明文 HTTP,密码与令牌一样可被嗅探 |

## 端口

| 端口(默认) | 用途 | 绑定 | 局域网可访问 |
|---|---|---|---|
| `22000`(`--port`) | WebSocket P2P 同步 | 所有接口 | ✅ |
| `8384`(`--control-port`) | Web UI + 控制 API | `127.0.0.1` 默认,`--host 0.0.0.0` 暴露 | ✅(需 `--host 0.0.0.0`) |

启动后日志会打印所有可达的 control UI 与 peer 地址,方便直接复制。

**健康检查**:控制端口提供免认证的 `GET /health`,适合监控 / 反向代理探活:

```bash
curl -f http://127.0.0.1:8384/health   # → {"ok":true,"msg":"syncx is ok","uptime":1234}
```

只报存活与进程运行时长,不暴露设备 ID 等细节;其余 API(含 `/api/status`)仍需认证。

## 开发命令

```bash
npm run dev            # 开发运行:tsx watch 自动重载,默认 --host 0.0.0.0(局域网可访问)
npm run test           # 运行全部测试(vitest)
npm run test:watch     # 测试监视模式
npm run typecheck      # TypeScript 类型检查(tsc --noEmit)
npm run build          # 编译到 dist/(tsc)
```

`npm run dev` 会同时起两个进程:vite dev server(固定 `5173`)和 syncx 后端(控制端口 `8384`)。

**dev 下浏览器请打开 `http://localhost:5173`** —— 页面由 vite 原生提供,改 `.vue` 即时热更新,
也不需要先跑 `vite build`。vite 会把前端用到的控制端点(`/api/*`、`POST /login`、`/favicon.svg`)
代理回 `8384`,登录与会话行为和生产一致。

为避免走错入口,dev 下 `8384` **不再提供 web 页面**:访问它会 302 重定向到 `5173`(只换端口、
沿用你输入的主机名,因此局域网访问 `http://<内网IP>:8384` 也会正确跳到 `http://<内网IP>:5173`)。
`8384` 此时只保留控制 API。

> 为什么不能从 `8384` 打开页面?HMR 走 WebSocket,而 `8384` 侧只能做 HTTP 反向代理、
> 无法转发 WebSocket upgrade —— 以前从 `8384` 打开的页面能加载却**不会热更新**,
> 是个静默失效的坑,所以现在直接重定向到 `5173`。

**build 之后则相反**:不带 `--dev-vite` 启动时,`8384` 直接提供页面(前端来自内嵌 bundle),
`5173` 不参与,这就是生产形态。

### npm run dev 的参数

`npm run dev` 等价于 `tsx watch src/main.ts start`,任何 `start` 支持的参数都可以通过 `npm run dev -- <参数>` 传入(注意中间的 `--`):

| 参数 | 说明 | 默认值 |
|---|---|---|
| `--config <路径>` | 指定配置文件路径(任意 JSON 文件) | `~/.syncx/config.json` |
| `--port <端口>` | P2P 同步端口(其他设备连接用) | `22000` |
| `--control-port <端口>` | Web UI / 控制 API 端口 | `8384` |
| `--host <地址>` | 控制服务绑定地址 | `0.0.0.0`(dev 脚本已默认;`127.0.0.1` 仅本机) |
| `--dev-vite <url>` | dev 模式:web 页面请求 302 重定向到该 vite dev server(HMR 由 vite 原生提供),控制端口只保留 API | dev 脚本已传 `http://127.0.0.1:5173` |

不传 `--dev-vite` 时,后端从 `dist/web/client.js` 提供前端 bundle,即生产行为 ——
此时必须先 `npm run build:web`,否则 `/client.js` 返回空内容导致页面白屏。

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

全局安装(`npm i -g @wangmingfa/syncx`)后直接用 `syncx`:

```bash
# 启动 daemon(前台;部署时配合 systemd/launchd 后台常驻)
syncx start [--config <路径>] [--port <端口>] [--control-port <端口>] [--host <主机>]

# 停止运行中的 daemon(优先经控制 API 优雅关闭,失败回退信号)
syncx stop [--config <路径>] [--control-port <端口>]

# 查看状态:daemon 运行状态、设备 ID 与共享目录数
syncx status [--config <路径>] [--control-port <端口>]
# daemon: running (pid 1234, up 1h02m)   ← daemon 未运行时显示 not running

# 生成系统服务模板
syncx install

# 查看用法 / 版本号
syncx --help
syncx --version
```

从源码运行时把 `syncx` 换成 `node dist/syncx.js`(需先 `npm run build`):

```bash
npm run build
node dist/syncx.js start
```

常用选项:

| 选项 | 说明 |
|---|---|
| `--config <path>` | 指定配置文件路径(默认 `~/.syncx/config.json`) |
| `--port <port>` | peer 同步端口(默认 22000) |
| `--control-port <port>` | Web UI/控制 API 端口(默认 8384) |
| `--host <host>` | 控制服务绑定地址(默认 `127.0.0.1`;`0.0.0.0` 暴露局域网) |
| `--expose-control` | 允许把控制 API 绑到非回环地址(需与 `--host` 同用;明文 HTTP,谨慎) |
| `--log-file <path>` | 同时把日志写入文件(默认仅输出到 stdout) |
| `-h, --help` | 查看全部命令与选项 |
| `-v, --version` | 查看当前版本号 |

## 双设备同步测试

仓库内置两种集成测试,自动化验证同步正确性:

```bash
npm test   # 含 test/integration/two-daemons.test.ts
```

`two-daemons.test.ts` 会 `spawn` 两个真实 daemon 进程(不同 configDir/端口/共享目录),通过 `peers` 相连,双向同步文件后断言两边一致——正是验证"同步服务是否正确"的方式。

手动体验双设备同步:写两个 config.json,`peers` 互指对方地址,分别启动两个 daemon,两边目录即自动互相同步。

## 许可证

MIT
