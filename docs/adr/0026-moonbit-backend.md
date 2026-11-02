# ADR-0026: MoonBit 后端(第三运行时)

- 日期:2026-11-01
- 状态:Accepted(基础层已落地;集成层进行中)
- 关联:ADR-0025(Rust 后端,共享其全部落盘契约)

## 背景

syncx 已有 Node(参考实现)与 Rust(生产形态)两个后端。再增加一个 MoonBit 后端,
验证 MoonBit 在服务端长驻程序(索引、同步协议、HTTP/WS API)上的工程可行性,
并为团队积累 MoonBit 生产经验。参考工程:`mvm`(版本管理器,CLI + 异步 + C FFI)、
`MoonUI`(跨平台 GUI,FFI 后端分层)。

## 决策

### 1. 与 Node/Rust 的关系:全量对齐 + 完整共享数据目录

功能范围一次性对齐 Rust 后端(索引/扫描/执行/对端协议/git 集成/备份/API/自更新)。
数据目录 `~/.syncx` 完全共享:

- **config.json**:实现同一 `formatVersion` 闸门(当前 = 1),超上限拒启,未知字段
  原样保留,落盘盖 `formatVersion` + `generatedBy` 戳。
- **syncx.pid**:单实例互斥,`backend` 字段取值扩为 `node | rust | moonbit`。
- **index-\*.db**:三端共用同一 SQLite schema。MoonBit 侧用 C FFI 绑定 sqlite3
  (vendored amalgamation),不做私有格式。

### 2. 代码组织

```
syncx/
├── src/                  Node 后端(参考实现)
├── rust/                 Rust 后端
├── moonbit/              MoonBit 后端(本 ADR)
│   ├── moon.mod          模块 wangmingfa/syncx,preferred_target = native
│   ├── core/             索引/版本向量/CDC/忽略规则/冲突判定/传输规划(无 I/O)
│   ├── sqlite/           sqlite3 C FFI 绑定(vendored sqlite3.c)
│   ├── net/              peer 服务端/客户端、握手、wire、mDNS
│   ├── daemon/           会话状态机、扫描、执行、调度、git、备份
│   ├── api/              mocket 路由 + WS 推送 + 内嵌前端
│   └── cli/              子命令、自更新、单二进制入口
└── .github/workflows/
    ├── publish.yml       npm 发布(现有)
    ├── rust-release.yml  Rust 多平台发布(现有)
    └── moonbit-release.yml  新增:MoonBit 多平台发布
```

技术选型:

| 能力 | 选型 | 备注 |
|---|---|---|
| HTTP/WS 服务端 | `oboard/mocket` | mongoose C 内核,native 目标 |
| 异步/子进程/文件 | `moonbitlang/async` | 与 mvm 同款 |
| JSON | `moonbitlang/core/json` | 未知字段保留自行处理 |
| SQLite | 自写 C FFI + vendored amalgamation | 三端共享 index-*.db |
| mDNS | C FFI 绑定单头库 `mdns.h` | `_syncx._tcp` 记录格式与 Node/Rust 对齐 |
| 错误处理 | `Result` + `?` | 参照 Rust 侧风格 |

### 3. 交叉编译边界:只打原生 runner

MoonBit native 无交叉编译工具链,发布矩阵用原生 runner(与 mvm 同策略):

| 目标 | runner |
|---|---|
| x86_64-unknown-linux-gnu | ubuntu-latest |
| aarch64-unknown-linux-gnu | ubuntu-24.04-arm |
| x86_64-apple-darwin | macos-13 |
| aarch64-apple-darwin | macos-15 |
| x86_64-pc-windows-msvc | windows-latest |
| aarch64-pc-windows-msvc | windows-11-arm |

资产命名与 Rust 完全一致:`syncx-v{version}-{target-triple}.tar.gz`(Windows `.zip`),
二进制名 `syncx-mb`,同 Release 附两空格格式的 `checksums.txt`。自更新因此可以与
Rust 共用同一套「查 Release → 匹配资产 → SHA-256 → 换入 → 健康标记回滚」逻辑。

### 4. 版本号单一来源

沿用 `package.json` 的 `version`:CI 在构建前 sed 注入(mvm 同款),npm、Rust、
MoonBit 三个 Release 资产永远同版本号,tag(`v*`)一次触发三条 workflow。

### 5. `/api/status` 与前端

`runtime` 字段扩为 `node | rust | moonbit`,`updateSource` 为 `github`。前端
`StatusData.runtime` 类型同步扩枚举;三形态共用同一套 UI,不做分支界面。

## 实现清单(分阶段提交)

1. ADR + `moonbit/` 骨架(五包 + 入口,`moon build --release` 通过)
2. `sqlite` 包:C FFI 绑定(open/prepare/step/bind/column)+ 行为测试
3. `core` 包:formatVersion 闸门、config.json 读写(未知字段保留)、索引模型
4. `net` 包:wire 协议对齐 `src/net/wire.ts`、握手、peer 服务端/客户端、mDNS
5. `daemon` 包:扫描、执行、调度、版本向量合并、git 集成、备份
6. `api` 包:mocket 路由、WS 状态推送、内嵌 `dist/web`
7. `cli` 包:子命令、GitHub Releases 自更新(看门狗 + 健康标记回滚)
8. `moonbit-release.yml` + 前端 `runtime` 枚举扩展
9. 与 Rust/Node 的对拍测试(golden fixtures)

## 后果

- 三套后端维护成本上升;用共享落盘契约(formatVersion 闸门)兜底先后运行安全。
- MoonBit 服务端生态(SQLite/mDNS)依赖自写 C 绑定,是本 ADR 最大技术风险;
  sqlite 绑定优先落地并先行对拍,风险前置暴露。
- 不做 MoonBit 交叉编译,arm 目标靠原生 arm runner,workflow 与 mvm 一致。

## 落地进度(2026-11-02)

已提交(全仓 `moon check --deny-warn` 零警告,202 项测试全绿):

| 层 | 内容 |
|---|---|
| sqlite | C FFI 绑定 + vendored amalgamation |
| core | formatVersion 闸门、config 逐字段清洗、schedule、版本向量、传输规划、忽略规则、CDC 分块、冲突命名、file_kind;fixtures 读盘对拍(与 Rust 共享同一批 golden) |
| net | wire 协议、设备身份 + 握手(mooncry 加密,官方向量对拍)、mDNS 发现、peer WS 传输层(两阶段握手、64MB 闸门) |
| daemon | 索引存储、扫描/执行引擎、索引指纹、git 集成、actor 会话循环、断点续传(PartialStore)、块重试/发送窗口/限速 |
| api | /health、/api/status、auth 会话票据(scrypt + HMAC)、folders/pause/devices/shutdown、dist/web 静态服务、/api/events WS 状态推送(差异驱动 + 30s ping) |
| cli | 主入口组装(参数面/ConfigStore/启动编排/update-swap 分发,冒烟通过)、GitHub Releases 自更新(资产名 syncx-mbt-v*,看门狗换入/回滚) |
| 发布 | moonbit-release.yml(6 原生 runner,资产名带 mbt 标识)+ 前端 runtime 枚举 + pack:local --backend |

**尚未落地(后续里程碑)**:
- 中转(ADR-0014 relay)与磁盘空间守卫
- 初始交换 2s 兜底全量定时器、认领台账、CDC 块请求/供应
- BlockSent 回账改为 socket 写完后(当前帧入队即回账,缺网络背压)
- syncx.pid 单实例互斥、信号优雅退出、gitignore/.syncxignore 规则载入、--log-file 落盘
- folderIdentity 收养、gitSync 接入 actor、孤儿索引回收
