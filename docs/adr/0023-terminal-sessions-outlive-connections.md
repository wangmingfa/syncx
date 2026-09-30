# ADR-0023: Terminal sessions outlive the connection

## Status

已决定(Accepted 2026-09-30),**尚未实现** —— 本文件兼作设计文档,文末「实现清单」是后续实施面的清单。
它反转一条已记档的决策:`web/TerminalPage.vue:21-22` 的头注释写着「会话随页面销毁而结束(刷新即关),
刻意不持久化:恢复列表也恢复不了进程,列着死会话只会误导」。

## Context

浏览器内终端现在是「一条 WS = 一个 PTY shell」的直连模型,三处结构决定了刷新即失忆:

- **服务端**:`ws.on('close')` 直接杀 shell(`src/api/terminal.ts:265` PTY 分支、`:295` 回退管道分支)——
  连接断开与进程死亡被绑成同一件事。
- **协议**:WS URL 固定 `/api/terminal`,不带任何会话身份(`web/TerminalPage.vue:145`)——
  服务端没有「接回哪个 shell」的入口。
- **客户端**:标签页列表与 id 计数器只在内存(`web/TerminalPage.vue:64`),页面卸载即失忆。

代价由用户承担:刷新一次,正在跑的构建、开着的 vim、`cd` 到的目录全部随 shell 消失 —— 而这些恰是
终端里最贵、最难重建的状态。原先不持久化的理由(「恢复列表也恢复不了进程,列着死会话只会误导」)
依赖一个前提:**进程必死**。本设计让进程不死,该前提消失,所以决策反转。

保活窗的取值不需要新发明:服务端已有「闲置 10 分钟 / 绝对 1 小时」的存活门,而闲置窗本来就照提权
TTL 对齐(`src/api/terminal.ts:41-46` 的注释)—— 超过 10 分钟无人操作,前端也不得不重新过验证门,
把 shell 留在一个已经回门的页面之后没有意义。分离会话直接复用这条已有的线。

## Decision

### 1. 会话与连接分离

服务端引入会话注册表 `Map<sid, TerminalSession>`:

```ts
interface TerminalSession {
  id: string;              // randomBytes(8).toString('hex');出现在 WS URL 里,当作能力凭据看待
  proc: PtyProcess | ChildProcess;
  pty: boolean;            // 完整 PTY / 受限管道(降级路径与今天相同)
  buffer: Buffer[];        // 回放环形缓冲,见 §4;有没有连接都往里写
  bufferBytes: number;
  ws: WebSocket | null;    // 附件。null = 分离
  lastTouch: number;       // attached = 最后一条入站帧;detached = 分离时刻
  createdAt: number;       // 绝对上限的基准
}
```

- **连接的断开只意味着分离**:ws 的 close 只置 `ws = null` 并刷新 `lastTouch`,不碰进程。
- **显式结束帧**:客户端新增 `{t:'kill'}`(删标签、重开、回门回收时发),服务端杀进程 + 摘登记。
  这是「用户真的要它死」的唯一入口。
- **重连即接管**:带 `?session=<sid>` 的升级请求命中注册表时,若旧连接还在就关掉旧连接(**不杀进程**),
  新连接成为附件,先收 `ready` 再收回放。晚到者胜 —— 复制页签、崩溃恢复这类「同一会话两条连接」
  的场景不需要仲裁。
- **未知 sid 一律 `{t:'gone'}` 并关闭,绝不 spawn**。这是负向契约:否则「随便一个 id 都起到新 shell」,
  回放与接管语义全部失效。必须有用例钉住。

### 2. 协议增量(最小)

| 方向 | 帧 | 变化 |
| --- | --- | --- |
| c→s | `{t:'kill'}` | 新增:结束本会话(杀进程 + 摘登记) |
| c→s | `{t:'in'}` / `{t:'resize'}` / `{t:'sigint'}` / `{t:'ping'}` | 不变 |
| s→c | `{t:'ready', shell, pty, session, reattached?}` | 增字段:`session` 恒有;`reattached:true` 仅接管时 |
| s→c | `{t:'out', data}` | 复用:回放与实时输出同一种帧,客户端零区分 |
| s→c | `{t:'exit', code}` | 不变(管道模式 `sigint` 重开 shell 时 sid 不变) |
| s→c | `{t:'gone', session}` | 新增:请求的会话已不存在(daemon 重启 / 超窗回收),随后关闭 |

连接身份走 URL 查询参数:`ws://host/api/terminal?session=<sid>`。`src/api.ts:120-141` 的升级处解析后
传给 `hub.handle(ws, { session })`(`src/api/deps.ts:240-243` 的接口签名同步放宽)。

### 3. 保活窗与回收

一条规则取代原来的两条:会话在 `now - lastTouch >= idleMs`(attached 的 lastTouch 是最后入站帧,
detached 是分离时刻)或 `now - createdAt >= maxLifetimeMs` 时被回收 —— 杀进程、关连接、摘登记。
也就是**分离会话的保活窗 = 附着的闲置窗 = 10 分钟**(`TERMINAL_IDLE_MS`,对齐提权 TTL),
绝对上限仍是 1 小时。`reapStale` 的判定对象从「连接」换成「会话」,纯函数与测试一起改。

调试旋钮 `SYNCX_TERMINAL_IDLE_MS` / `SYNCX_TERMINAL_MAX_LIFETIME_MS`(照 `readDriftKnobs` 先例,
只在建 hub 时读)—— bench 要在几秒里验证保活窗与回收,不能真等 10 分钟。

### 4. 回放缓冲

每会话一个常驻环形缓冲(默认 ~256KB):输出只在附加时转发给 ws,但**任何时候都写入缓冲**;
超限丢头,并按第一个换行对齐(避免把半条转义序列放给新终端)。attach 时整段以一条 `{t:'out'}` 补发。

不做服务端无头终端(见 Alternatives);保真边界如实写进 Consequences。

### 5. 重绘助推

2026-09-30 实测(真 node-pty + `trap 'echo GOT_WINCH' WINCH` 的 bash,**同尺寸 resize 不产生 SIGWINCH,
改了尺寸才产生**,两组对照都验过)。所以重连后客户端在 ready(reattached) 时发两帧
`{t:'resize', cols, rows-1}` + `{t:'resize', cols, rows}` —— 保证至少一次真实尺寸变化,强制全屏程序
整屏重画。不加这步,回放里只有增量输出,vim/htop 的中途刷新会花屏。

### 6. 客户端

- **持久化到 `sessionStorage`**(键 `syncx.terminal.tabs`,`{v:1, tabs:[{name, sid}], activeIdx}`):
  刷新、同页签导航存活,关页签即清 —— 与「服务端会话本就是每连接一份」的现语义对齐。
  不用 localStorage:多窗口会共享同一批 sid 并互相抢占。
- **恢复流程**:过完提权门后,有存档则按名字/sid 逐个重建标签并带 `?session=` 连(恢复中走
  connecting 态;拿到 sid 立即回写);无存档照旧开一个默认会话。存档里 sid 为 null 的标签
  (刷新时还在连接中)按新会话连。
- **死亡兜底**:attach 拿回 `gone`(daemon 重启、超窗回收)→ 该标签**原地开新会话**并写黄字
  「原会话已结束」。标签布局恢复,但不假装进程还在。shell 自己退出(收到 `exit`)不自动重开,
  保留现状。
- **「重连」语义分叉**:连接还在 → 重开(发 kill,与今天一致);连接已断 → 带 sid 重接
  (保活窗内就能接回原进程),gone 再走死亡兜底。
- **`gateNow()` 清空持久化**:回门 = 全部会话已被杀,回来一切重来,不留死标签。

## Alternatives

- **服务端无头终端(`@xterm/headless` + `@xterm/addon-serialize`)**:attach 时序列化出完整屏面 + 回滚,
  保真最高(全屏程序也精确)。代价:新运行时依赖(构建是 `packages:'bundle'`,除 node-pty 外全部内联,
  单文件体积 + 每会话常驻解析的 CPU)。不取,但 attach 协议对它是开放的 —— 回放来源换成 serialize
  输出即可,协议与客户端都不用动。
- **客户端 serialize(`pagehide` 时把 xterm 状态存 sessionStorage)**:与回放会双画(重放整段 vs 已恢复
  画面),只补增量需要给 out 帧加序号;复杂度不划算,且依赖 pagehide 可靠执行(崩溃恢复拿不到)。否。
- **不持久化(现状)**:被本 ADR 反转,理由见 Context。

## Consequences

- **会话不跨 daemon 重启**(进程本来就随 daemon 死):带旧 id 重连 → `gone` → 原地新会话。
  这是设计边界,不是缺陷。
- **分离期最多白留一个 shell ≤10 分钟**:新增的暴露面;窗口与提权 TTL 对齐,显式删除与回门都走 kill;
  daemon 退出(`hub.close()`)照旧全杀。
- **回放保真有限**:行式程序基本无损;全屏程序中途刷新靠重绘助推重画,极端情况下有一瞬残影。
- **复制页签会拷贝 sessionStorage**:两条连接带同一 sid,后到接管,先到的页面变「已断开」。
  可接受,不仲裁。
- **会话数不设上限**:与现状一致(今天也是一条连接一个 shell),既有的回收门照旧兜底。

## 实现清单(尚未实现)

按依赖顺序:

1. `src/api/terminal.ts`:会话注册表 + attach/detach/kill + 回放缓冲 + 重绘(Decision §1/§4/§5);
   `reapStale` 判定对象换会话;两个环境旋钮。
2. `src/api.ts`(:117-145)解析 `?session=`;`src/api/deps.ts`(:240-243)`handle` 签名放宽。
   `src/cli.ts` 的构造不变。
3. `web/TerminalPage.vue`:持久化 / 恢复 / 新帧(`gone` / `kill` / `reattached`)/ 语义分叉 /
   头注释(`:21-22`)改写。
4. 测试:
   - `test/terminal-hub.test.ts`:「用户主动关闭即杀」「闲置到点杀」两条改成新契约;新增 ——
     分离不杀 / 窗内重连带回同一进程与回放、超窗回收后同 id→gone、抢占接管、kill 帧、
     回放上限与行对齐、退出即消失、未知 id 不 spawn、绝对上限对分离同样生效。
   - `test/terminal-reaper.test.ts`:目标形状改会话。
   - `test/terminal-degrade.test.ts`:「用户关闭回退会话同样杀掉 shell」改分离;补管道模式带 id 重连。
   - **负向对照**:临时把 close 改回 kill,新用例必须变红。
5. `bench/terminal-reattach-bench.mjs`(新增;一次性临时 config 的 daemon,不碰在跑实例):
   真 shell `cd /tmp && echo $$` → 断开 → 带 id 重连 → 回放含上一步输出、`pwd`=/tmp、`$$` 同 pid;
   trap WINCH 验重绘助推送达;kill 帧后同 id → gone;保活窗调 2s 后 pid 从进程表消失;错误 id → gone。
6. 文档:`CONTEXT.md` 词条 **Terminal Session**(与 Drift 条目同区);`README.md` 终端段
   (:285-291)与 FAQ;`ROADMAP.md`(:52);本文件 Status 改「已实现」。
7. 闸门:`npm run typecheck`、`npx vitest run`、`npm run build:web`;浏览器真机 —— 两标签、改名、`cd`
   → 刷新 → 两标签都回来、`$$`/`pwd` 不变、回放可见、名字与激活页签保持。
