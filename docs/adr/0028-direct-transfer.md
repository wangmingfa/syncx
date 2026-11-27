# 0028 设备间直发（文本 / 文件到收件箱）

状态：已实现（P0 + P1 群发 / 拖拽多文件 / 另存到指定目录 / 断点续传 + P2 离线排队 / 粘贴图片 / 多文件成组 / 可选打包成 zip + P3 跨重启续传，Node 后端；Rust 已移植，2026-11-27 功能对齐；MoonBit 已移植，2026-11-27 —— 除 zip 打包与「另存到指定目录」，对应入口按能力声明回 503，前端按 `status.direct.zip === false` 根本不会触发）

## 背景

两台已配对设备之间偶尔要临时共享一段文本或一个文件。放进共享目录太重（索引、版本向量、忽略规则、冲突副本），走对方控制端口又要重做鉴权与加密。现有 P2P 会话已经完成 Ed25519 验签与 X25519/AES-GCM 加密，直接复用它最省。

## 决定

1. **通道**：复用既有 P2P 会话，不新增端口、不建临时共享目录。新增 `direct1` 能力标签（`src/handshake.ts`），只有对端在 kx 中宣告 `direct1` + `binary1` 且本机已与之互信（`isPeerAllowed`）时才允许发送/接收。未宣告的旧设备 UI 禁用并提示升级。
2. **协议**：控制帧只传元数据（`direct-text` / `direct-file-offer` / `direct-reply` / `direct-ack` / `direct-cancel` / `direct-result`），文件字节走新的二进制帧 `direct-file-chunk`（kind 字节 3，`header={id,seq}`，body 为 256KB 明文切片）。未知 kind / 未知帧按既有策略静默丢弃。
3. **身份**：归属一律取 ws 连接 handshake 验签过的 `hopDeviceId`，**不信消息体里的 `fromDeviceId`**（那个字段只由 `withSelfInfo` 注入版本/主机名）。
4. **落盘**：全部在 `<configDir>/inbox/`（`messages/` / `files/` / `.tmp/` / `index.json`），**永不写共享目录**；不进索引、不产生墓碑或版本向量、不会触发同步冲突。重名文件自动加 `(n)` 后缀，绝不覆盖。
5. **确认与完整性**：文本直接入箱并回执；文件先提议，用户点「接收」后才开分片传输。接收方按序写临时文件、逐序更新 sha256、累积 ack；收齐后校验指纹，通过才 rename 到正式路径。失败/拒绝/掉线一律清理临时文件，不留半成品。
6. **重传**：发送窗口 4 片（约 1MB），5s 未确认重发单片，最多 3 次；30s 无进展整体失败。乱序分片最多缓存 32 片（8MB），超出的靠 ack 驱动重传。最后一片**只回 `direct-result` 不回 ack**：ack 会让发送方在同一调用栈里 pump，造成接收侧哈希被二次消费。
7. **状态**：`/api/status` 只下发 `direct.{inbox,pending,transfers}` 元数据（文本仅 120 字预览），正文按需从 `/api/direct/inbox/:id/content` 取；变更走既有 `statusHub` 推送，不另开通道。
8. **限流**：文本 ≤64KB、单文件 ≤100MB、收件箱软配额 512MB；HTTP 上传边流边算指纹（LAN HTTP 下浏览器没有 `crypto.subtle`，指纹必须由 daemon 算）。
9. **群发**：发送弹窗列出所有在线且支持 `direct1` 的设备做多选，默认勾选从卡片点进来时的那台，发送前可随时改。`POST /api/direct/text|file` 接受 `deviceIds[]`（同时兼容旧的 `deviceId`），单次最多 20 台；每台独立投送、独立结果与状态，某台离线不影响其它台。文件只暂存一次，由 `src/direct.ts` 按路径引用计数，最后一笔结束才删暂存文件。
10. **多文件与拖拽**：文件从单选改成队列（一次最多 20 个、单文件 ≤100MB），把文件拖到在线设备卡即打开发送弹窗并预填、自动切到文件页。逐文件顺序投送，一个失败继续下一个；全部成功才关弹窗，有失败则留队列供重试。`web/composables/directDropTarget.ts` 用模块级标记协调设备卡与页面级 `DropOverlay`：拖到卡片时遮罩让路并阻止冒泡，避免 `.tgz` 被误判成安装包上传。
11. **另存到指定目录**：待确认卡上的「另存到…」让接收方把文件落到 daemon 机器的任意目录（`POST /api/direct/reply` 新增可选 `saveTo`）。这条入口要过提权门（与终端/文件管理器共用 `ensureElevated`，验证成功后自动接续这次接收），服务端再独立校验一次：必须绝对路径、必须是已存在目录、拒绝根目录与用户主目录本身、拒绝共享目录（含子目录、按 `realpath` 判符号链接）、拒绝数据目录与系统目录（`src/direct-save-path.ts`）。落点用 `uniqueFilePath(name, saveDir)` 保证不覆盖；收件箱只留一条 `external: true` 的回执（`path` 指向用户目录），删回执**不删**真实文件。目录不创建、不写进共享目录，因此同样不进索引、不产生墓碑。
12. **断点续传**：链路断开时不再把在途传输判死 —— 接收方关句柄但保留半截临时文件（`paused`），发送方关句柄但保留暂存文件与已确认片号（`paused` + `resuming`）。新会话建立后 `session-manager` 调 `direct.onPeerOnline(deviceId, tx)`（定时器另有 3s 一次的重提议兜底），发送方用**同一个 id** 重发 `direct-file-offer`；接收方认出这条暂停记录（同来源、同大小、同 sha256）就直接续，不再次要求用户确认：重建 sha256（把已落盘的前缀重新喂一遍，`Hash` 状态不可序列化）、用 `r+` 打开半截文件、在 `direct-reply` 里带上 `offset = 已落盘字节数`。发送方只接受「本轮确实是续传」且对齐到片边界的 offset，然后把 `acked/nextSeq` 挪到对应片号继续 pump。窗口 10 分钟（`DIRECT_RESUME_TTL_MS`），超时清理半截并判失败；只有传过字节的传输才进入暂停，未确认的提议仍随掉线作废。
    续传**跨 daemon 重启**：`<configDir>/inbox/resume.json` 记下进出站各自的半截条目（发送侧：暂存路径 + 已确认字节 + 组号；接收侧：来源 + 指纹 + 已收字节 + 另存目录）。台账不是等「暂停」才写，而是**传输一开始就写** —— 进程被 kill -9 时没有 `close()` 可走，只能靠提前落下的这一笔。重启后 `loadResume()` 把还新鲜的条目恢复成 `paused`：发送侧立刻（下一次探测通道时）重新提议，接收侧等对方提议上门再报 offset。可续多远以**盘上文件长度**为准（不信任台账里的 `bytesDone`），落盘永远是整片顺序写，长度不是片边界就说明有问题，直接丢弃重来。没有「现取会话通道」能力的嵌入方（测试、库用法）保持旧语义：不落台账、退出即清理。

13. **离线排队**：目标设备离线时不再直接报错退场 —— 文本与文件都进本机队列（`<configDir>/inbox/queue.json` + `.tmp` 里的暂存文件），设备上线（`onPeerOnline`）或定时器探到现取通道可用时按入队顺序补发。排队窗口 24 小时（`DIRECT_QUEUE_TTL_MS`），条数 ≤20、文件总量 ≤512MB；`close()` 对排队项**不**回收暂存文件，重启后 `loadQueue()` 原样恢复。在线但版本过旧 / 已不在互信列表的设备仍然立刻报错，且设备上线时若判定发不了（`failQueued`），要把它名下的排队项当场判失败，而不是等满 24 小时给一句「设备未上线」。发送弹窗把离线设备也列出来（标「离线·排队」），全选离线目标时主按钮改文案「排队发送」；服务端每个目标回 `queued` 标志，前端据此区分「已发出」与「已排队」。排队项在收件箱里可以「取消排队」（`POST /api/direct/cancel`），终态是 `canceled` 而不是 `failed` —— 用户主动撤掉的东西不该被染成红色错误。
14. **粘贴图片直发**：发送弹窗任意位置按 Ctrl/⌘+V，剪贴板里的图片直接进文件队列并切到文件页，省掉「先存盘再选文件」这一步。浏览器给的 blob 名字常是 `image.png`，统一按「粘贴-年月日-时分秒」重命名（同批第 2 张起加 `-2`），扩展名按 MIME 定（`web/utils/format.ts` 的 `pastedImageName`）。只认 `kind === 'file'` 且 `type` 为 `image/*` 的条目，纯文本粘贴一律不拦 —— 不 `preventDefault`，textarea 的默认行为保持不变。监听挂在 **document** 上而不是弹窗 DOM：刚打开弹窗时焦点可能还在设备卡的「发送」按钮上，事件不会经过弹窗；代价是要自己判「本弹窗是最上层」（`.modal-overlay` 末位里含 `.send-modal`），否则叠着收件箱/提权门时会把它们的粘贴截走。发送中不处理粘贴。
15. **多文件成组**：一次「发送 N 个文件」由前端生成一个批次号（`db-<base36 时间>-<随机>`），随 `/api/direct/file?batch=` 传到 daemon，再写进每条 `direct-file-offer.batchId`。接收方按 `batchId` 把待确认项合并成一张卡（标题「N 个文件」+ 合计大小 + 文件清单），一次「全部接收 / 拒绝 / 另存到」由 `POST /api/direct/reply { batchId }` 逐条下发 —— 底层仍是 N 条独立的单文件传输，所以进度、续传、失败重试全都沿用既有路径，只是确认动作合并了。打包默认**不做**（接收方要的是文件本身，多一步解压比多点几次「接收」更麻烦），需要时在弹窗里勾「打包成一个压缩包发送」，见下条。旧发送端不带 `batchId`，接收方退回逐条确认，行为与升级前完全一致。

16. **可选打包**（勾选后，只对「一次 ≥2 个文件」生效）：每个文件先 `POST /api/direct/file?zip=<batch>` 落进 `<configDir>/inbox/.tmp/zip-<batch>/`（`000.dat` 这样的槽名 + `manifest.json` 记原名/大小），再由 `POST /api/direct/zip { batch, deviceIds, name? }` 打成 **store 模式**（不压缩）的 zip 一次性投送。选择 store 的理由：直发的瓶颈是链路不是 CPU，压缩还会让「100MB」的语义变得不可预期；store 能纯流式写，任何文件都不必整读进内存。包用数据描述符（本地头 flag bit 3）把 CRC 与长度写在数据之后，UTF-8 名字靠 flag bit 11（实测 macOS 的 `ditto`/Archive Utility 与 Python `zipfile` 都能正确还原中文名，系统自带的老 `unzip` 命令行只认本地编码、会显示乱码，属其自身限制）。包体上限沿用单文件 100MB；暂存目录在打包后立刻删除，**抛弃的暂存**超过 2 小时由下一次打包顺带清掉。接收方对这一步完全无感——它收到的就是一个普通 `.zip`。

## 不变量与陷阱

- 直发不绑定目录，`attachPeerMessages` 原本按 `folder` 路由；`direct-file-chunk` 必须在 folder 查找**之前**分流，否则会被静默丢弃。
- `DeviceStatus.caps` 缺省 = 旧后端/旧对端，前端必须按「不支持」处理，不能默认成支持。
- `direct1` 三端（Node / Rust / MoonBit）都宣告：能力是承诺，MoonBit 是在直发状态机落地、`on_binary` 真正接上 `handle_chunk` 之后才宣告的。旧后端/未移植端不宣告，对端 UI 正确禁用发送入口；各后端自己对未知控制 kind 与二进制 kind 的静默丢弃行为保持不变。
- 跨后端的线上格式靠**一份 Node 生成的 fixture** 三方钉住：`rust/scripts/gen-direct-wire-fixture.mjs` 用真实的 `JSON.stringify` 产出 `rust/crates/syncx-net/fixtures/direct-wire.json`，Rust 侧断言解码后重新编码逐字节还原（键序、大小写、可选字段的有无），Node 侧（`test/direct-wire.test.ts`）把同一批字节喂回当前状态机；MoonBit 侧的 `moonbit/scripts/gen-direct-fixture.mjs` 直接吃同一份 JSON 产出 `moonbit/net/direct_fixture.mbt`，`direct_fixture_test.mbt` 做同样的逐字节还原断言。只做其中一边不够：fixture 抄错（改了字段却没重跑脚本）时，另外两边照样全绿。改 `src/direct.ts` 或 `src/net/wire.ts` 的字段必须重跑生成脚本（Rust 与 MoonBit 两个都要）。
- 发送方的 `directTransport()` 与接收侧总闸使用同一套判据；只靠对端宣告不够，未配对设备也能连上来发邀请，必须挡住它直接往收件箱塞文件。
- 群发的多笔文件投送共用同一个暂存路径，**不能在各笔结束时各自 `rmSync`**；`sourceRefs` 降到 0 才删，否则第一台收完就把后面几台待读的文件删了。
- 设备卡 drop 必须 `stopPropagation`，否则 `.tgz` 拖到卡片会同时冒到 window 的 `DropOverlay` 被当成安装包预检；拖拽悬停态由 `setDirectDropTarget()` 单向通知遮罩让路，两边的 `dropEffect` 不能各设各的。
- 另存目录的校验只认 **daemon 的** `process.platform` 与文件系统：浏览器可能在另一台机器上（远程打开控制台），读 `navigator` 会给出错误平台的占位符与错误判断。UI 的路径示例按 `status.platform` 给。
- 另存目录在「确认接收」时校验一次，之后传输期间不再复核 —— 所以校验只能比落盘更严，不能更松：共享目录/数据目录一旦放行，几分钟后就可能落进会被同步的位置。目录被删掉属于正常失败路径（rename 报错 → 传输标失败），不需要提前拦截。
- `external` 回执的 `path` 是用户盘上的真实文件，`remove()` 必须跳过删除；`external` 缺省（旧索引）按收件箱文件处理，即仍然删。
- 提权窗口的续期只在路径校验**通过后**发生：错误输入不该延长 10 分钟的提权时效。
- 续传位置必须由**接收方**说了算（`direct-reply.offset`），发送方自己的 `acked` 可能落后一整片（ack 丢了但字节已落盘）。发送方只在 `resuming` 为真时接受非 0 offset：新投送若收到非 0 偏移说明对方状态不干净，宁可失败也不能静默跳字节（`sha256` 会在最后兜住，但那时已经白传一遍）。
- offset 必须对齐 `DIRECT_CHUNK_BYTES`：接收方按片顺序落盘，半截只可能停在片边界；对不齐就说明这份半截不可信，丢弃重来。
- `onPeerOffline` 先看 `getTransport(deviceId)` 是否还有活会话：同一设备存在备份连接时，关掉的往往只是备胎，不能把健康传输打成暂停。
- `close()` 不再一刀切删半截：具备续传能力时，`transferring` 的入站/出站先转 `paused` 再退出（半截文件、暂存文件都留着），否则「重启后续传」等于没做。没传过字节的入站提议与还没被确认的出发提议照旧清掉 —— 它们重启后没有任何续接价值。
- 续传台账在**传输开始**时就要落盘，不能等「暂停」那一刻：kill -9 / 断电没有 `close()`，只有提前写下的条目能让重启后的进程知道「这台机器上还有半截」。每条传输只在开始/暂停/结束时写一次，不按分片写（分片进度由接收方的 `offset` 说了算，发送侧存的那个数只是给人看的）。
- 重启后入站的可续距离以**盘上文件长度**为准，台账里的 `bytesDone` 只作参考：崩溃可能发生在「写完一片」与「更新台账」之间。长度必须是整片倍数且小于总大小，否则删掉重来（崩在校验与 rename 之间时文件已满，续不了）。
- 群发共用一份暂存文件（`sourceRefs` 计数），所以清理过期条目时**只有没人再引用这条路径**才能删；否则会顺手删掉另一笔还在等的传输的源文件。
- 台账只在有半截时存在：清空就删文件。留一份空账会让人以为还有东西在等。
- 排队项的 `sourcePath` 在 `close()` 时**不能**被回收：那是重启后要继续投递的唯一副本，删了队列就成了指向空文件的死记录。反过来，非排队项照旧清理。
- `flushQueued` 必须**先置 `offering` 再发控制帧**：文本的 `direct-result` 可能在同一调用栈里回来并把状态改成 `done`，发完再赋值会把已完成覆盖回 `offering`（单测实测过）。
- 排队项不受 `onPeerOffline` 影响（`state === 'queued'` 直接跳过）：它本来就在等设备上线，链路断不断与它无关。
- 队列不是无限仓库：条数/字节上限在**入队前**检查（`checkQueueRoom`），并且新投送把 `outgoing` 挤出容量时只淘汰非排队项 —— 用户明确交代要等的东西不能被「最近 30 条」顺手清掉。
- 排队窗口从**入队时间**算，不从最后一次尝试算；退回队列（控制帧没发出去）不重置 `queuedAt`，否则一台反复上线下线的设备能把内容无限期挂着。
- 粘贴监听必须挂在 document 上并校验「自己是最上层」：挂 `.modal` 会漏掉「焦点还在触发按钮上」的情形；不判层叠则会隔着收件箱/提权门把图片塞进底下的发送弹窗。
- 粘贴只在**图片文件**存在时才 `preventDefault()`：拦住纯文本粘贴会让 textarea 收不到内容。
- 粘贴的图片要重新命名：直接用浏览器给的 `image.png`，一次粘多张在接收方就是一堆同名文件，只能靠 `(1)`、`(2)` 区分。
- 成组只影响**展示与确认**，不影响传输：每条文件仍是独立 id、独立分片账本。任何一条失败只让那一条变红，不会连坐整组。
- `replyBatch` 只处理**同一发送方**的同组项（按 `from` 收紧）：组号由发送端生成，正常不会撞；万一撞了，也不能把 accept 发给另一台设备。
- 单条 `reply` 与批量 `replyBatch` 共用同一个 `replyOne` 实现：分成两份的那天，两条路径的行为就会悄悄不一致。
- 批次号在入队时也要落盘（`queue.json` 的 `batchId`），否则离线排队重启后同一批会散成 N 张卡。
- `id` 与 `batchId` 同时给 = 含混请求，直接 400：一个请求只能表达一种意图，否则「到底处理了几条」说不清。
- 旧对端兼容：老接收方没有 `offset` 字段，收到重提议时会以「同 id 已存在」为由忽略（新发送方 2 分钟提议超时后失败）；老发送方收到带 `offset` 的 accept 只会浪费前几片带宽，不会写错数据。

## 后续（未做）

- **Rust 后端已与 Node 对齐**（2026-11-27）：`resume.json` 跨重启续传与 `/api/direct/zip` 打包都已移植，两个缺口关闭。打包的暂存区与 zip 结构与 Node 同形（`inbox/.tmp/zip-<batch>/manifest.json`、store 模式 + 数据描述符），产物经系统 `unzip -t` 校验；能力由 `/api/status` 的 `direct.zip` 声明，前端不再按 runtime 猜。唯一有意的差异：空批次时 Node 回 404，Rust 回 400（`OpError` 只有「没这项能力 / 这次失败」两态，为一条罕见分支扩枚举不划算；前端只读 `message`，观感一致）。
- **移植到 MoonBit 后端（已落地，2026-11-27）**：前置的帧加密与二进制信封先一步关闭（见 ADR-0026），本日把状态机与 HTTP 面全部补齐，三后端功能对齐（除下述刻意缺口）：
  - `moonbit/direct/`（types/service/persist/ops/api）：分片账本（窗口 4 / 乱序缓存 32 片 / 累积 ack）、`resume.json` + `queue.json` + `index.json` 三件套（键序与 Node 逐字对齐）、断点续传（offset 只认 resuming 态、整片对齐、fresh 按 `max(pausedAt, mtime)`）、离线排队（24h / ≤20 条 / ≤512MB / 上线补发 + 定时探测）、收件箱（引用计数删暂存、rename 前验 sha256）。
  - `moonbit/api/direct.mbt`：8 条 `/api/direct` 路由全部注册（zip 也注册，回 503）；查询串手动解析（mocket 的 `query()` 会折叠重复键，多设备投送靠重复 `deviceIds`）；body 与查询串双兼容取目标设备；上传体整读（mocket 上限调到 128MiB）、指纹一次算完 —— 与自更新上传同口径。
  - cliapp 装配（`cliapp/directwire.mbt` + entry/peers 接线）：`DirectChannels` 现取通道表 + `DirectBoxes` 入站串行箱（单队列单泵，处理顺序与 Node 单线程事件循环一致）+ `on_peer_online` 补发 / `on_peer_offline` 半截转暂停；`direct1` 随之宣告。MoonBit 的 `close()` 未接优雅关闭（shutdown 直接退出），半截文件留给下次启动的 `loadResume` 按「盘上长度」口径收 —— 台账本来就提前落盘，语义不丢。
  - **刻意缺口**：zip 打包与「另存到指定目录」（saveTo）未实现，对应入口回 503；`status.direct.zip = false`，前端按能力声明门控，不会触发。前端零改动。
  - 对拍：`moonbit/scripts/gen-direct-fixture.mjs` 直接吃 Rust 侧那份 `direct-wire.json`（三后端共用同一份事实源），产出 `moonbit/net/direct_fixture.mbt`；`direct_fixture_test.mbt` 断言六类控制消息**解码 → 重编码逐字节还原**、分片帧同 key 解码头体一致。此前踩过一处：MoonBit 的 `Json::number` 缺省走 Double 编码，大整数（时间戳/字节数）可能变科学计数法，`set_u64` 一律显式给十进制 repr 钉死。
