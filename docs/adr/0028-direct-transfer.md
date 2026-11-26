# 0028 设备间直发（文本 / 文件到收件箱）

状态：已实现（P0，Node 后端）

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

## 不变量与陷阱

- 直发不绑定目录，`attachPeerMessages` 原本按 `folder` 路由；`direct-file-chunk` 必须在 folder 查找**之前**分流，否则会被静默丢弃。
- `DeviceStatus.caps` 缺省 = 旧后端/旧对端，前端必须按「不支持」处理，不能默认成支持。
- `rust` / `moonbit` 后端当前未宣告 `direct1`，Node 端会正确禁用发送入口；它们对未知控制 kind 与二进制 kind 的静默丢弃行为保持不变。若将来三端都要支持，需同时补能力标签、消息解析与收件箱落盘，并逐字节互测。
- 发送方的 `directTransport()` 与接收侧总闸使用同一套判据；只靠对端宣告不够，未配对设备也能连上来发邀请，必须挡住它直接往收件箱塞文件。

## 后续（未做）

- P1：拖文件到设备卡、多选设备、保存到指定目录（需提权）、断点续传。
- P2：离线暂存待对方上线再投、多文件打包、图片粘贴。
