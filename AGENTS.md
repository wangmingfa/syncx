# AGENTS

## 提交信息规范

所有 git 提交信息必须使用中文撰写，包括：

- 提交标题（第一行）
- 提交正文（多行描述）
- 修复/特性前缀后跟中文说明

示例：

```
fix: 修复对端连接去重与断线重连

- 按 deviceId 计数限制每个对端最多两条连接
- 添加指数退避重连（1s–30s）
- 添加块请求超时重试（5s，最多 3 次）
```

禁止使用英文撰写提交信息。

## 前端样式归属

组件自有的样式写在组件自己的 `.vue` 文件里，不要放进 `web/style.css`。

判据是「整组自包含」：一组规则要么整体跟着模板走，要么整体留在 `style.css`，禁止把同一个
视觉单元劈成两地。只有满足下面之一才留在 `web/style.css`：

- 调用方对共享骨架的覆盖（如 `.modal.settings-modal`、`.modal-wide.history-modal`）——
  它们属于那个调用方，但必须能压过骨架。
- 跨组件共用的皮肤/主题段（`html[data-skin='glass'] …`）与共用动画
  （`.guide-*` 被 `DropOverlay.vue` 和弹窗骨架同时驱动）。

配套约定：

- 调用方覆盖一律写成 `.骨架类.自己的类` 双类提特异度，**不得**依赖文件顺序「后来者胜」。
  顺序并不可靠，也不可预期：`web/client.ts` 第 2 行先求值整棵组件图、第 3 行才
  `import './style.css'`，所以 style.css 实际**后**注入（复核办法：`npm run build:web` 后比较
  `dist/web/client.js` 里 `.modal-overlay{` 与 `.modal.fd-modal{` 的下标，前者明显更小）
  —— 一旦骨架规则被提了档（见下一条），平手的覆盖就会反过来。
- 类名由多个组件共写的样式块**不加 `scoped`**（如 `.modal-lead` 写在调用方模板里、
  `#footer` 里的按钮是调用方渲染的节点）：scoped 只认本组件模板的节点，这些节点会整块拿不到
  样式，同时还会把特异度抬一档，把调用方按双类写的覆盖打成「比注入顺序」。不加 scoped 依旧
  满足「样式放组件内」，搬完要在块首写明理由。
- 反过来，只有本组件自己写的类名就可以（也该）用 `scoped`，例如
  `web/components/ModalCloseButton.vue` 的 `.modal-close` / `.modal-close-x`：全仓只有它自己挂
  这两个类，没有调用方覆盖要照顾，抬那一档不伤任何人。此时跨组件的定位依赖（那颗角吃的是
  `ModalShell` 的 `.modal { position: relative }`）要在注释里点名，否则搬走之后就看不出关系。