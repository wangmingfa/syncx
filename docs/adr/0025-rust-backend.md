# ADR-0025: Rust 后端与 Node 后端共存于同一数据目录

## Status

已决定(Accepted 2026-10-31),**尚未实现** —— 本文件是对外方案与硬约束,文末「实现清单」是后续实施面的清单。

## Context

syncx 目前是单一 Node.js 实现:`src/` 约 25k 行 TypeScript,产出 `dist/syncx.js` 单文件,
命令 `syncx` 启动 daemon + Control API + Web UI,`web/` 的 Vue 3 前端由 vite 构建后
以字符串形式内联进该单文件(`scripts/build-single.mjs`)。

目标是为项目增加一套 Rust 后端,最终能打包成各平台原生可执行文件并发布到 GitHub Release,
同时保留 Node 单文件产物。Rust 侧必须**完整实现现有全部功能**,不是一个子集。

这带来三个必须在动手前定死的决策,否则越往后越难回头:

1. **两个后端的数据目录关系**。最初设想是各自独立目录(`~/.syncx-rs`),用一次性 `migrate`
   子命令搬运。但用户的实际用法是「停掉 Node 就用 Rust 跑起来」——需要的是**无缝切换**,
   不是迁移。于是改为共用同一个数据目录,并在**同一时刻只允许一个后端持有它**。
2. **谁能挡住「旧版本读写了新版本的数据」**。共用目录意味着 schema 必须是两个后端共同遵守的契约。
   只在一边冻结是不够的:先由新版本写过、再由旧版本写入,数据会静默损坏。
3. **Rust 形态下的自更新来源**。现有 `selfupdate.ts` 下载的是 npm tgz;Rust 产物是原生二进制,
   不能沿用。

## Decision

### 1. 共用同一个数据目录,单实例互斥

```
~/.syncx/          ← Node 与 Rust 共用,路径解析规则完全不变
```

`--config-dir` / `--config` / 默认 `~/.syncx` 的解析逻辑两边一致,**锁按 configDir 隔离**:
`syncx.pid` 本来就在 configDir 内,因此 `.syncx-dev` 与 `~/.syncx` 天然互不干扰。

复用现有的 `syncx.pid` 作为互斥载体,不引入 flock —— flock 在 Windows 与 NFS 上语义不一,
而现有的「pid 存活探测」已经够用。

```jsonc
// <configDir>/syncx.pid
{
  "pid": 12345,
  "backend": "rust",          // 新增字段;node 侧对未知字段宽容
  "version": "0.5.0",
  "startedAt": 1790000000000,
  "hostname": "AALQHUYOGA"
}
```

启动判定顺序:

| 步骤 | 条件 | 动作 |
|---|---|---|
| 1 | `syncx.pid` 不存在 | 继续启动 |
| 2 | 解析失败 / 无 `pid` | 视为陈旧锁,删除后继续 |
| 3 | `pid` 对应的进程不存活 | 视为陈旧锁,删除后继续 |
| 4 | 进程存活 | **拒绝启动**,退出码 1,报出 `backend` / `pid` / `version` |

拒绝时必须指明对方身份,让用户知道该用哪条命令停掉:

```
另一个后端正在运行(backend=rust, pid=12345, version=0.5.0)。
请先执行 `syncx-rs stop` 再启动本版本。
```

反向同理(`backend=node` → `syncx stop`)。

**Node 侧改动约为十行**:读取 pid 记录后,若 `backend === 'rust'`,把错误文案换掉;
其余存活判定逻辑不变。

**已知残余风险**:`kill -9` 后 pid 文件残留,若该 PID 被系统复用给无关进程,
会被误判为「有后端在跑」。现有代码已有同样的风险面,本次不扩大;
缓解手段(比对进程启动时间)需要读 `/proc/<pid>/stat` 或 `ps -o lstart`,
跨平台成本高于收益,暂不实现。

### 2. `formatVersion` 闸门:唯一的落盘契约

`config.json` 增加两个字段,职责严格分开:

```jsonc
{
  "generatedBy": "0.6.1",   // 仅供排查:最后写入的版本,不参与任何判定
  "formatVersion": 3        // 强制闸门:落盘格式代数,单调递增
}
```

**不使用软件版本号做闸门**:版本号与落盘结构无关(一个 bugfix 不改结构却会被挡住),
且 Node 的 `0.x` 与 Rust 的版本号无法用 semver 比大小。`formatVersion` 是两边共享的整数,
天生可比。

#### bump 规则(硬约束)

| 改动 | 是否 +1 |
|---|---|
| 新增列、改列语义、改 JSON 字段含义、改文件名规则 | **必须 +1** |
| 新增 API、改 UI、改调度算法、修 bug、改日志 | 不 bump |

规则的含义:**同一 `formatVersion` 内,两个后端落盘的 schema 必然完全一致。**
这直接消掉了「A 版本写了 B 版本不认识的列」的可能性,也正因如此,
`INSERT OR REPLACE` 现有的「未列出的列被重置」语义不再有风险,无需改造。

#### 闸门位置

必须早于**任何**文件读写:

```
解析参数 → 读 config.json → 校验 formatVersion
  ├─ formatVersion > 本端支持上限 → 报错退出(码 1),不打开任何 index-*.db
  └─ formatVersion < 本端支持下限 → 就地迁移 + 回写
```

报错文案必须能指导行动:

```
数据目录由更新版本生成(formatVersion 3,本版本最高支持 2)。
请升级 syncx 后再运行;降级运行会损坏索引数据。
```

#### 三条必须承认的边界

1. **闸门只对实现了它的版本生效。** 现有 Node 不认该字段。因此需要先发一个 Node 版本作为
   「基座」(写入并校验 `formatVersion`),之后才允许 Rust 落盘。
2. **它不防「同代内的私改」。** 同一 `formatVersion` 下若某端多写了列却没 bump,闸门发现不了。
   这只能靠本 ADR 的硬约束约束开发者,无法由代码强制。
3. **它与单实例锁互补而非替代。** 锁防「同时运行」,闸门防「先后运行」。两者都要有。

### 3. 自更新只走 GitHub Releases

Rust 形态不下载 npm tgz。现有 `self-binary-request` / `self-binary-response`
(P2P 互传安装包)在 Rust 侧**不声明该能力**,收到请求时回 `data: undefined`
——现有 Node 代码已按缺省处理,不会崩。

| 环节 | 做法 |
|---|---|
| 版本查询 | `latest` 取 `GET /releases/latest`;预发布通道取列表中 `prerelease=true` 的最高版本 |
| 资产匹配 | 文件名固定 `syncx-v{version}-{target-triple}.tar.gz`(Windows 为 `.zip`);Rust 用编译期 `TARGET` 拼装,不做模糊匹配 |
| 校验 | 同 Release 附 `checksums.txt`,下载后比对 SHA-256 |
| 换入 | `self-replace` 做原子替换(含 Windows 占用场景);失败保留 `.old` |
| 重启 | 以原 argv 与原工作目录 re-exec,父进程先优雅关闭端口 |
| 回滚 | 新进程写「健康标记」,超时未写则换回 `.old`(沿用 `rollback.ts` 的思路) |

`/api/status` 增加只读字段,前端据此切换文案与按钮,不维护两套 UI:

```jsonc
{
  "runtime": "rust",            // node | rust
  "updateSource": "github",     // npm | github
  "updateAvailable": { "latest": "0.5.1", "url": "https://github.com/..." }
}
```

前端改动限于三处:顶栏更新入口、设置里的检查更新、上传安装包弹窗
(最后一项在 Rust 形态下不渲染,它天然只服务于 npm 载体)。

**版本号单一来源**:`build.rs` 读 `package.json` 的 `version` 注入 `SYNCX_VERSION`,
现有 `release.mjs` + tag 流程不变,npm 与 GitHub Release 永远同一版本号。

### 4. 代码组织

```
syncx/
├── src/                 Node 后端(保留,作为参考实现与回归基线)
├── web/                 前端(两端共用,零改动)
├── rust/
│   └── crates/
│       ├── syncx-core/   索引/版本向量/CDC 分块/忽略规则/冲突判定/传输规划(无 I/O)
│       ├── syncx-net/    peer 服务端与客户端、握手、wire、mDNS
│       ├── syncx-daemon/ session 状态机、扫描、执行、调度、git、备份
│       ├── syncx-api/    axum 路由 + WS 状态推送 + 内嵌前端
│       └── syncx-cli/    子命令、自更新、单二进制入口
└── .github/workflows/
    ├── publish.yml       现有 npm 发布
    └── rust-release.yml  新增:多平台矩阵 → GitHub Release
```

分层约定:

- **`syncx-core` 无 I/O**,纯逻辑,直接对拍 Node 实现(`insta` 快照 + Node 导出的 golden fixtures)。
- **`syncx-net` 以协议为中心**,`serde` 模型逐字对齐 `src/net/wire.ts`,包括
  `full?: boolean` 缺省按增量、控制消息里 `entryVersion` 而非 `version` 这类历史坑。
- **`syncx-daemon` 用 actor 模型取代事件循环**。Node 里「一次同步决策不被并发打断」
  是靠单线程隐式保证的;Rust 里把核心状态收进一个持有 `mpsc::Sender<Cmd>` 的 actor,
  所有状态变更串行进入同一 task。只读快照(`/api/status`、WS 推送)用
  `Arc<StatusSnapshot>` 原子替换,避免持锁序列化。磁盘 I/O、git 命令、PTY 一律
  `spawn_blocking` 后回投递结果。
- **`syncx-api` / `syncx-cli` 是薄壳**,handler 只做参数转换。

### 5. 技术栈

| 能力 | Node 现状 | Rust 选型 | 备注 |
|---|---|---|---|
| 异步运行时 | libuv | `tokio` | |
| HTTP | `node:http` + 手写路由 | `axum` | |
| 对端 WebSocket | `ws` | `tokio-tungstenite` | 需自行实现 64MB 帧上限 |
| 状态推送 WS | `ws` | `axum::extract::ws` | 与 HTTP 同端口 |
| JSON | `JSON` | `serde` / `serde_json` | 未知字段必须保留(见下) |
| SQLite | `node:sqlite` | `rusqlite` + `bundled` | **静态链接**,介质不依赖系统库;schema 与现有完全一致 |
| mDNS | `multicast-dns` | `mdns-sd` | 需验证 `_syncx._tcp` 记录格式兼容 |
| PTY | `node-pty`(可选,失败回退管道) | `portable-pty` | 保留「失败降级」分支 |
| 加密 | `node:crypto` | `ed25519-dalek` / `x25519-dalek` / `aes-gcm` / `sha2` / `hmac` / `hkdf` | 纯 Rust,不依赖 OpenSSL |
| 日志 | `pino` | `tracing` + `tracing-subscriber` | 输出 JSON 行 |
| 前端内嵌 | esbuild 字符串内联 | `rust-embed` | `build.rs` 校验产物存在,缺失即编译失败 |
| CLI | 手写 `args.ts` | `clap` | 11 个现有子命令一一对应 |
| 自更新下载 | `fetch` | `reqwest`(rustls) | |
| 时间/时区 | `Date` | `chrono` + `chrono-tz` | 同步时段与节假日 |
| 错误 | 手写 | `thiserror` / `anyhow` | |
| 版本号语义 | 手写 | `semver` | |
| 测试 | `vitest` | 内置 `#[test]` + `insta` | |

**有意不引入**:`notify`(文件监听,先保持轮询扫描,避免行为漂移)、`sqlx`
(同步 SQLite 足够,`rusqlite` + `spawn_blocking` 更简单)、任何 OpenSSL 依赖。

### 6. `config.json` 的读写约束

共用一个 config 目录后,**任一端都不得抹掉自己不认识的字面字段**。Rust 侧:

```rust
#[derive(Serialize, Deserialize)]
struct Config {
    // ... 已知字段
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,  // 原样保留并回写
}
```

**已确认并已修复**:`loadConfig`(`src/config.ts:548`)原先不是「解析后保留原对象」,
而是逐字段挑拣后重建新对象;`mutateConfig`(`:749`)的路径是 `loadConfig → mutator →
saveConfig` 整体回写。于是未知键会在**第一次 `mutateConfig` 时被静默抹掉** ——
而 `mutateConfig` 在 6 个文件里有 49 处调用,几乎覆盖全部用户操作,这不是边界情况而是必然。

修复方式是在返回对象开头 `...parsed` 铺开原始字段,**已知字段的清洗逻辑保持在其后覆盖**
(顺序不能反:反过来的话手改坏的 `maxSendKbps: -5` 会绕过 `sanitizeCount` 直接进内存)。
`test/config.test.ts` 两条用例钉住该约束:「未知键跨 mutate 周期保留」与
「已知字段仍被清洗」。`typecheck` 与全量测试通过。

### 7. 协议互通是验收门槛

「不共存」是**本机**的事,不影响 wire 互通。同一局域网内 Node 机器与 Rust 机器
必须能正常配对与同步,这是判断「功能完整实现」的唯一可信标准。

- 从 Node 侧导出 golden JSON:握手帧、每类 `ControlMessage`、索引增量/全量、
  块请求响应、配置、索引库行。
- `rust/tests/protocol_compat.rs` 用 `insta` 逐条断言可反序列化,且再序列化后
  **语义等价**(不比对键序)。
- CI 起一个 Node daemon 与一个 Rust daemon,跑双向 E2E:Node→Rust、Rust→Node、Rust→Rust。

## Consequences

- **切换后端不需要迁移、不需要改路径、不需要改配置。** 停掉一个、启动另一个即可,
  数据目录里的 config、索引库、历史、版本、回收站全部继续可用。
- **两个后端的 schema 被 `formatVersion` 绑成同一代。** 在 bump 之前,
  任何一端都不能私自加列;这是本方案最主要的长期约束,也是它换来的唯一保障。
- **降级运行被明确拒绝,而不是降级容忍。** 用户升级到新 `formatVersion` 后若回滚旧版本,
  服务不再启动并给出可执行提示。这与单实例锁是同一种态度:不猜、不静默降级。
- **混合局域网里的升级路径被显式分流。** Node 机器仍可从 Node 机器拉包升级;
  Rust 机器只认 GitHub;两者都不会尝试从对方拉二进制。
- **实现工作量大且集中。** 约 25k 行 TS 的全量重写,`session-manager`(4748 行)的
  actor 化是风险最集中的部分;协议互通与 golden fixtures 是唯一可信的验收方式。

## 实现清单

1. Node 侧:写入 `formatVersion` / `generatedBy` 并加闸门(基座版本);`syncx.pid` 增加 `backend`;
   补「未知键保留」测试。
2. `rust/` workspace 骨架:五 crate + `build.rs`(读 `package.json` 版本、校验
   `dist/web/client.js` 存在)+ `rust-embed`,先做到 `cargo build` 出可运行的 `--version`。
3. `syncx-core` + golden fixtures + `insta` 对拍。
4. `syncx-net`:握手、wire、mDNS、块传输;Rust↔Rust 全量同步跑通。
5. `syncx-daemon`:actor、扫描、执行、冲突、版本;Node↔Rust 双向同步跑通。
6. `syncx-api`:114 个端点 + WS 推送 + 前端内嵌;Web UI 在两个后端上功能一致。
7. `syncx-cli`:全子命令、GitHub 自更新、PTY、git 同步、周报、分享链接。
8. `.github/workflows/rust-release.yml`:矩阵构建
   (linux-musl x86_64/aarch64、darwin x86_64/aarch64、windows-msvc x86_64/aarch64)+
   `checksums.txt` + Release 上传。
