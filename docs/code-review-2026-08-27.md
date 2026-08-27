# syncx 代码审查报告（2026-08-27）

审查范围：`src/**`、`web/**`、`test/**`、`vite.config.ts`、`package.json`、`README.md`。
结论：测试套件（已跑通 12 个单测：discovery/ignore/peer-server-security）通过，但存在 **1 个功能完全失效的 bug、1 个逻辑错误 bug**，以及若干性能/健壮性/行为偏离问题。

---

## 🔴 严重（功能失效 / 逻辑错误）

### 1. mDNS 局域网自动发现完全失效
**文件**：`src/net/discovery.ts:80`
**代码**：
```ts
const text = Buffer.isBuffer(txt.data) ? txt.data.toString('utf8') : '';
```
**根因**：真实 `multicast-dns`（底层 `dns-packet@7`）对 TXT 记录解码后，`txt.data` 是 **`Buffer[]`（字符穿数组）**，而不是单个 `Buffer`。因此 `Buffer.isBuffer(txt.data)` 恒为 `false`，`text` 永远为空字符串，`/deviceId=([A-Z2-7]{10})/` 永远匹配不到 → `onPeerFound` 永不触发。

**已用真实 `dns-packet` 复现**：
```
TXT data typeof: Array
TXT data: [{"type":"Buffer","data":[100,101,118,...]}]   // deviceId=PEER234567
discovery.ts 取到的 text = ""  => 能否匹配 deviceId? false
```
**影响**：README 的主打特性"mDNS 自动发现局域网设备"在真实运行环境里**根本不工作**，只能靠手动 `peers` 配置回退。
**为何测试没发现**：`test/discovery.test.ts` 用单 `Buffer` 假对象，掩盖了真实数据类型。

**修复建议**：
```ts
const raw = txt.data;
const text = Array.isArray(raw)
  ? raw.map((b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b))).join('')
  : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
```

---

### 2. 运算符优先级 bug：每对端第二条入站连接被错误拒绝
**文件**：`src/cli.ts:564`
**代码**：
```ts
if (peerConnectionCount.get(remoteDeviceId) ?? 0 >= MAX_CONNECTIONS_PER_PEER) {
  socket.close();
  return;
}
```
**根因**：`>=` 优先级高于 `??`，表达式实际解析为 `count ?? (0 >= MAX)` = `count ?? false`。`0 >= 2` 为 `false`，于是：
- count 为 `undefined`（首连）→ `false` → 不关闭（正确）
- count 为 `1` → `1`（truthy）→ **错误关闭第二条入站**（设计允许最多 2 条：入站+出站各一）
- count 为 `2` → `2` → 关闭

**已用 node 复现**：
```
count= undefined  buggy=false  fixed=false
count= 1          buggy=1       fixed=false   <-- 此处应为 false，但错误地关闭
count= 2          buggy=2       fixed=true
```
**影响**：某设备已有一条入站连接时，其第二条入站（例如 mDNS 重播/重连）会被直接断开，与设计"每对端最多 2 条连接"矛盾，可能在部分重连/多路径场景导致连接建立不稳定。

**修复建议**：加括号
```ts
if ((peerConnectionCount.get(remoteDeviceId) ?? 0) >= MAX_CONNECTIONS_PER_PEER) {
```

---

## 🟠 中等（性能 / 行为偏离）

### 3. 块读取是 O(n²) I/O
**文件**：`src/main.ts` `readLocalBlock`（约 446–455 行，用于 `onBlockRequest` 服务侧）
```ts
const blocks = splitIntoBlocks(readFileSync(abs));   // 每次请求都读整个文件
const block = blocks[blockIndex];
```
对端每请求一个块，都把整个文件读进内存再切分取单块。1GB 文件 ≈ 1000 块 → 累计读取约 1TB。大文件同步会成为严重瓶颈。
**修复**：按偏移读取，例如
```ts
const start = blockIndex * BLOCK_SIZE;
const end = Math.min(start + BLOCK_SIZE, (statSync(abs)).size);
const block = readFileSync(abs, { start, end });
```

### 4. 冲突副本会跨设备传播
**文件**：`src/executor.ts` `applyConflict` + `src/scanner.ts` `walk`
冲突时生成 `*.sync-conflict-<ts>-<n>-<deviceId>.<ext>`，但 scanner 只跳过 `.syncx-tmp`，**不跳过冲突副本**。下一轮扫描会把它当作全新文件索引并同步给对端，冲突副本在所有设备间累积（与 Syncthing"冲突副本仅本地保留"的预期不符）。
**修复**：scanner 跳过 `*.sync-conflict-*`（或在 `filterIndexedEntries` / ignore 解析里默认忽略）。

### 5. 开发模式 Web UI 不可用
**文件**：`src/api.ts:163` + `package.json` `dev` 脚本
`npm run dev` 启动的 control server 从 `dist/web/client.js` 提供 `/client.js`，但 dev 下并未构建 web 产物（构建由 `vite build` 完成，vite dev 是独立服务）。打开日志打印的 `8384` 地址会 500，Web UI 打不开。
**修复**：dev 下先 `npm run build:web`，或让 control server 代理到 vite dev server，或在文档中明确 dev 前置步骤。

---

## 🟡 较低（设计 / 健壮性）

6. **48-bit Device ID**（`src/identity.ts:22`）：白名单 ACL 基于 48-bit 截断 ID，局域网内碰撞/伪造风险极低，但弱于完整公钥；握手已用完整公钥校验，后续可考虑把 ACL 过渡到完整公钥。
7. **`--expose-control` 暴露明文 HTTP 控制面**：令牌以明文传输、cookie 无 `Secure` 标记；`cli.ts` 已警告，但建议暴露时强制 TLS 或显著提示风险。
8. **`/login` 失败无反馈**（`src/api.ts:150`）：错误令牌也返回 200 的 UI 壳，用户无提示。
9. **FAT32 mtime 容差**（`src/scanner.ts`）：仅当 mtime 差 >2s 才回写索引，导致 2s 窗口内重复整文件哈希，轻微抖动。
10. **`decodeKxMessage` / `encodeKx` 在 `server.ts` 与 `client.ts` 各定义一份**（`src/net/server.ts:146`、`src/net/client.ts:99`）：轻微重复/不一致，建议统一到 `handshake.ts`。

---

## 总体评价
- 加密握手（Ed25519 双向签名 + X25519 ECDH + AES-256-GCM、路径越界/符号链接防护、块哈希校验、邀请码签名+时效+吊销、控制面令牌常量时间比较）设计扎实，未发现可直接被远程利用的安全漏洞。
- 主要风险集中在 **mDNS 发现（功能完全失效）** 与 **连接去重计数（逻辑错误）** 两个 bug，建议优先修复 #1、#2，其次处理 #3、#4 的性能/行为问题。
- 建议给 `discovery.ts` 增加**基于真实 `multicast-dns` 的集成测试**（或在单测里用 `Buffer[]` 形态的 TXT 数据），避免再次因假对象掩盖真实协议行为。

---

## 修复记录（2026-08-27 第二轮）

### ✅ #1 mDNS 自动发现失效 —— 已修复
- 文件：`src/net/discovery.ts`
- 做法：新增 `decodeTxtData(data)` 助手，统一处理 `Buffer` / `Buffer[]` / `string` 三种 TXT data 形态；`response` 处理器改用 `decodeTxtData(txt.data)`。
- 回归测试：`test/discovery.test.ts` 新增用例「parses TXT data shaped as Buffer[] (real dns-packet decode output)」，直接用 `Buffer[]` 形态数据，防止假对象再次掩盖真实协议行为。

### ✅ #2 运算符优先级 bug —— 已修复
- 文件：`src/cli.ts:564`（报告中曾误写为 `src/main.ts`）
- 做法：`count ?? 0 >= MAX` → `(count ?? 0) >= MAX_CONNECTIONS_PER_PEER`。
- 验证：node 复现确认修复后 `count=1` 返回 `false`（允许第二条入站），`count>=2` 才关闭；`tsc --noEmit` 通过。

### 验证结果
- `npx tsc --noEmit`：通过（exit 0）
- `vitest run test/discovery.test.ts test/ignore.test.ts test/integration/peer-server-security.test.ts`：
  - discovery / ignore 全过（含新增 Buffer[] 回归用例）
  - **预存失败（与本次修复无关）**：`peer-server-security.test.ts > fails with a clear error when the peer port is already in use` 期望 `startPeerServer` 同步抛错，但 `ws` 的 `listen()` 为异步，`wss.address()` 在构造时非 null，EADDRINUSE 实际走异步 `onError`。此问题独立于 #1/#2，未改动 `server.ts`，留待后续单独处理。
