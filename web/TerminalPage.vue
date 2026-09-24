<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { NButton } from 'naive-ui';
import ElevateGateModal from './components/ElevateGateModal.vue';
import { ensureElevated, idleExpired } from './utils/elevation';

/**
 * 浏览器内终端页(路由 /terminal):xterm.js + 后端 PTY 的完整终端,支持多会话。
 *
 * xterm.js 负责终端模拟的一切「交互还原」:VT100/xterm 转义序列、光标定位、
 * 颜色、全屏程序(vim/top)的界面刷新、选区复制、256 色与粗斜体;后端
 * node-pty 伪控制台负责进程侧的一切。两者之间只搬一条原始字节流 —— 这是
 * 与真实终端完全同构的分层,「看着像、用着也像」。
 *
 * 多会话模型:侧边栏列表 + 每会话一条独立 WS(后端一条连接一个 shell 进程,
 * 协议天然支持)。切走的会话不关闭 —— xterm 实例与 WS 都保活,后台进程继续
 * 跑、输出继续进缓冲,切回来接着看;这是标签式终端(VS Code / iTerm)的标准
 * 行为。会话随页面销毁而结束(刷新即关),刻意不持久化:恢复列表也恢复不了
 * 进程,列着死会话只会误导。
 *
 * 断线/退出后不清屏,保留现场便于回看;用「重连」开全新会话。
 */

type ConnState = 'connecting' | 'ready' | 'closed';

/** 侧边栏会话条目的响应式元数据(运行时句柄存在 runtime Map 里,见下)。 */
interface SessionMeta {
  id: number;
  name: string;
  state: ConnState;
  shellName: string;
  /** 完整 PTY / 受限管道(单文件分发降级)。 */
  ptyMode: boolean;
  /** 双击进入的重命名态。 */
  renaming: boolean;
}

/** 每个会话的运行时句柄:xterm 实例、自适应插件、WS 连接。 */
interface SessionRuntime {
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket | null;
}

/** 深底顶栏上 ghost 按钮的亮色描边/文字(n-button color 属性统一取用)。 */
const GHOST_COLOR = '#8fb3dd';

const sessions = ref<SessionMeta[]>([]);
const activeId = ref(0);
/**
 * 页面级状态机。'gated' = 登录有效但敏感操作未验证(首次进入,或闲置超时 /
 * 服务端把 WS 打回后回收了所有会话)—— 终端是整机 shell,提权过期就不再持有会话。
 */
const pageState = ref<'checking' | 'unauth' | 'gated' | 'ready'>('checking');

/** 运行时句柄按会话 id 存放,进响应式系统会被 Vue 深度代理,拖慢写入还可能扰内部状态。 */
const runtime = new Map<number, SessionRuntime>();
/** 每个会话的挂载容器(xterm.open 需要真实 DOM)。 */
const boxEls = new Map<number, HTMLElement>();

let nextId = 1;

function activeSession(): SessionMeta | undefined {
  return sessions.value.find((s) => s.id === activeId.value);
}

// ---- 会话生命周期 ----

/** 新建会话:压列表 → 激活 → 等 DOM 挂载 → 开 xterm + 连 WS。 */
async function createSession(): Promise<void> {
  if (pageState.value !== 'ready') return;
  const id = nextId++;
  sessions.value.push(reactive({ id, name: `终端 ${id}`, state: 'connecting', shellName: '', ptyMode: false, renaming: false }));
  activeId.value = id;
  await nextTick();
  const meta = sessions.value.find((s) => s.id === id);
  if (!meta) return;
  openTermFor(meta);
}

function openTermFor(meta: SessionMeta): void {
  const box = boxEls.get(meta.id);
  if (!box) return;

  const term = new Terminal({
    fontSize: 13.5,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    cursorBlink: true,
    scrollback: 5000,
    // 终端惯例深底:与站内主题无关,任何主题下终端都是深色的(与系统终端一致)
    theme: {
      background: '#10151c',
      foreground: '#d7dde6',
      cursor: '#d7dde6',
      selectionBackground: '#3a5f8f',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(box);
  try {
    fit.fit();
  } catch {
    /* 容器尚未布局完成时 fit 可能量到 0,激活时会再触发 */
  }

  // ---- 键盘:把「复制选区」从 Ctrl+C(=SIGINT)里拆出来,其余原样透传 ----
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // 有选区时 Ctrl+C = 复制(浏览器终端的通用约定),无选区时才是中断
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C') && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    // Ctrl+Shift+V / Cmd+V 粘贴(xterm 默认不绑,补齐系统终端习惯)
    if ((e.ctrlKey && e.shiftKey && (e.key === 'v' || e.key === 'V')) || (e.metaKey && (e.key === 'v' || e.key === 'V'))) {
      void navigator.clipboard.readText().then((text) => {
        if (text && meta.state === 'ready') sendTo(meta.id, { t: 'in', data: text });
      });
      return false;
    }
    return true;
  });

  term.onData((data) => {
    if (meta.state === 'ready') sendTo(meta.id, { t: 'in', data });
  });
  // 尺寸变化即上报(PTY 侧同步 ioctl,行编辑器/全屏程序立刻按新尺寸重排)
  term.onResize(({ cols, rows }) => sendTo(meta.id, { t: 'resize', cols, rows }));

  runtime.set(meta.id, { term, fit, ws: null });
  connectWs(meta);
  term.focus();
}

function connectWs(meta: SessionMeta): void {
  const rt = runtime.get(meta.id);
  if (!rt) return;
  meta.state = 'connecting';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/terminal`);
  rt.ws = ws;
  ws.onmessage = (ev) => {
    let msg: { t?: string; data?: string; shell?: string; pty?: boolean; code?: number | null };
    try {
      msg = JSON.parse(String(ev.data)) as typeof msg;
    } catch {
      return;
    }
    if (msg.t === 'out' && typeof msg.data === 'string') {
      rt.term.write(msg.data);
      return;
    }
    if (msg.t === 'ready') {
      meta.shellName = msg.shell ?? '';
      meta.ptyMode = msg.pty === true;
      meta.state = 'ready';
      if (meta.id === activeId.value) rt.term.focus();
      return;
    }
    if (msg.t === 'exit') {
      rt.term.write(`\r\n\x1b[33m—— shell 已退出(code ${msg.code ?? '—'}),会话结束 ——\x1b[0m\r\n`);
      meta.state = 'closed';
    }
  };
  ws.onclose = () => {
    if (meta.state === 'ready') {
      rt.term.write('\r\n\x1b[31m—— 连接已断开 ——\x1b[0m\r\n');
    }
    if (meta.state !== 'closed') meta.state = 'closed';
    rt.ws = null;
    // 403(提权过期)与普通断网在 WS 关闭时都表现为 code 1006,拿不到状态码 ——
    // 统一探一次提权:过期就回收全部会话并回到验证门,而不是留下重连失败循环
    void recheckElevation();
  };
}

function sendTo(id: number, msg: unknown): void {
  const rt = runtime.get(id);
  if (rt?.ws && rt.ws.readyState === WebSocket.OPEN) rt.ws.send(JSON.stringify(msg));
}

/** 重连当前会话:开一条新 WS,屏幕保留现场,新 shell 从提示符重新开始。 */
function reconnectActive(): void {
  const meta = activeSession();
  if (!meta || meta.state === 'connecting') return;
  const rt = runtime.get(meta.id);
  rt?.ws?.close();
  rt?.term.write('\r\n\x1b[36m—— 重新连接 ——\x1b[0m\r\n');
  connectWs(meta);
}

/** 删除会话:关 WS、杀后端 shell(dispose 触发连接清理)、移出列表。 */
function removeSession(id: number): void {
  const rt = runtime.get(id);
  rt?.ws?.close();
  rt?.term.dispose();
  runtime.delete(id);
  boxEls.delete(id);
  const idx = sessions.value.findIndex((s) => s.id === id);
  if (idx >= 0) sessions.value.splice(idx, 1);
  if (activeId.value === id) {
    // 激活相邻会话,避免指向已删除项
    const next = sessions.value[Math.max(0, idx - 1)];
    activeId.value = next ? next.id : 0;
  }
}

// ---- 会话切换 ----

function switchTo(id: number): void {
  if (id === activeId.value) return;
  activeId.value = id;
  void nextTick(() => {
    const rt = runtime.get(id);
    if (!rt) return;
    try {
      rt.fit.fit(); // 隐藏期间尺寸可能变过,激活即重排
    } catch {
      /* 容器刚显示,下一帧 ResizeObserver 会兜底 */
    }
    rt.term.focus();
  });
}

// 双击重命名:Enter/失焦提交,Esc 还原
function startRename(meta: SessionMeta): void {
  meta.renaming = true;
}
function commitRename(meta: SessionMeta, ev: Event): void {
  const input = ev.target as HTMLInputElement;
  const name = input.value.trim();
  if (name) meta.name = name;
  meta.renaming = false;
}
function cancelRename(meta: SessionMeta, ev: Event): void {
  (ev.target as HTMLInputElement).value = meta.name;
  meta.renaming = false;
}

function setBoxRef(id: number): (el: unknown) => void {
  return (el) => {
    if (el) boxEls.set(id, el as HTMLElement);
    else boxEls.delete(id);
  };
}

/** 登录态预检:WS 握手 401 时 onclose 只有 1006,拿不到原因 —— 先探一次 /api/status。 */
async function checkAuth(): Promise<boolean> {
  try {
    const res = await fetch('/api/status');
    return res.ok && res.status !== 401;
  } catch {
    return false;
  }
}

/** 提权预检:过门(首次进入 / 闲置超时后)必须先验证。 */
async function checkElevation(): Promise<boolean> {
  try {
    const res = await fetch('/api/elevate');
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

/** 提权预检/开闸统一走 ensureElevated:服务端权威校验,未提权则弹共享验证门,
 *  验证成功自动接续 startSessions。 */
function startSessions(): void {
  pageState.value = 'ready';
  void createSession();
}

/** 「重新验证」入口(占位按钮;终端页的门不可关,验证前页面保持被拦状态)。 */
function startGate(): void {
  void ensureElevated('打开浏览器内终端', startSessions, { locked: true });
}

/** 回收全部会话并弹验证门(闲置超时 / WS 被打回)。 */
function gateNow(): void {
  for (const id of [...runtime.keys()]) removeSession(id);
  pageState.value = 'gated';
  void ensureElevated('打开浏览器内终端', startSessions, { locked: true });
}

/** WS 被打回(或网络断开)后的复查:确认提权是否还有效。 */
async function recheckElevation(): Promise<void> {
  if (pageState.value !== 'ready') return;
  if (!(await checkElevation())) gateNow();
}

/** 新窗口直接打开时没有「上一页」可退,关窗兜底(与对比页同一约定)。 */
function onBack(): void {
  if (window.history.length > 1) window.history.back();
  else window.close();
}

function onWindowResize(): void {
  const meta = activeSession();
  const rt = meta ? runtime.get(meta.id) : undefined;
  if (!rt) return;
  try {
    rt.fit.fit();
  } catch {
    /* 忽略瞬时 0 尺寸 */
  }
}

onMounted(async () => {
  window.addEventListener('resize', onWindowResize);
  if (!(await checkAuth())) {
    pageState.value = 'unauth';
    return;
  }
  // 整页被门拦住:进入页面即弹敏感操作验证(不可关闭),验证成功自动开第一个会话
  pageState.value = 'gated';
  void ensureElevated('打开浏览器内终端', startSessions, { locked: true });

  // 闲置回收:超过 10 分钟没有任何操作,杀掉所有会话回到验证门。
  // 整机 shell 不该在无人看管的浏览器里一直开着 —— 这是本页对提权规则的落实。
  window.setInterval(() => {
    if (pageState.value === 'ready' && sessions.value.length > 0 && idleExpired()) {
      gateNow();
    }
  }, 20_000);
});

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize);
  for (const [, rt] of runtime) {
    rt.ws?.close();
    rt.term.dispose();
  }
  runtime.clear();
});
</script>

<template>
  <div class="term-page">
    <!-- 会话侧边栏:列表 + 新建;双击重命名,× 删除(未过验证门时不渲染) -->
    <aside v-if="pageState === 'ready'" class="term-side">
      <div class="term-side-head">
        <span>会话</span>
        <button type="button" class="term-side-add" title="新建终端会话" @click="createSession()">＋</button>
      </div>
      <div class="term-side-list">
        <div
          v-for="s in sessions"
          :key="s.id"
          class="term-side-item"
          :class="{ 'is-active': s.id === activeId }"
          @click="switchTo(s.id)"
        >
          <span
            class="term-dot"
            :class="{ 'is-ok': s.state === 'ready', 'is-wait': s.state === 'connecting' }"
            :title="s.state === 'ready' ? (s.ptyMode ? '运行中 · 完整终端' : '运行中 · 受限模式') : s.state === 'connecting' ? '连接中' : '已结束'"
          ></span>
          <input
            v-if="s.renaming"
            class="term-side-rename"
            :value="s.name"
            @click.stop
            @keydown.enter="commitRename(s, $event)"
            @keydown.esc="cancelRename(s, $event)"
            @blur="commitRename(s, $event)"
            @vue:mounted="((el: Element) => (el as HTMLInputElement).focus())"
          />
          <span v-else class="term-side-name" :title="`${s.name}(双击重命名)`" @dblclick.stop="startRename(s)">{{ s.name }}</span>
          <button type="button" class="term-side-del" title="关闭并删除会话" @click.stop="removeSession(s.id)">×</button>
        </div>
        <div v-if="sessions.length === 0" class="term-side-empty">暂无会话</div>
      </div>
    </aside>

    <div class="term-main">
      <header class="term-topbar">
        <!-- 顶栏是深底(终端页贯穿深色),naive 默认浅底主题下的 tertiary 按钮会看不清:
             ghost + 显式亮色描边/文字,保证任何终端页配色下都可读 -->
        <n-button size="small" ghost :color="GHOST_COLOR" @click="onBack()">← 返回</n-button>
        <span class="term-title">
          终端<template v-if="activeSession()"> · {{ activeSession()!.name }}</template>
        </span>
        <span
          v-if="activeSession()"
          class="term-state"
          :class="{
            'is-ok': activeSession()!.state === 'ready',
            'is-wait': activeSession()!.state === 'connecting',
            'is-bad': activeSession()!.state === 'closed',
          }"
        >
          {{ activeSession()!.state === 'ready' ? (activeSession()!.ptyMode ? '已连接 · 完整终端' : '已连接 · 受限模式') : activeSession()!.state === 'connecting' ? '连接中…' : '已断开' }}
        </span>
        <n-button size="small" ghost :color="GHOST_COLOR" :disabled="!activeSession() || activeSession()!.state === 'connecting'" @click="reconnectActive()">重连</n-button>
      </header>

      <div v-if="pageState === 'unauth'" class="term-unauth">
        未登录或会话已过期,请回到首页重新登录。
        <a href="/">返回 SYNCX</a>
      </div>
      <!-- 整页被验证门拦住:弹窗关掉后(或验证前)给一个占位与重试入口 -->
      <div v-else-if="pageState === 'gated'" class="term-unauth">
        终端需要敏感操作验证后才能使用。
        <n-button size="small" ghost :color="GHOST_COLOR" @click="startGate()">重新验证</n-button>
      </div>
      <div v-else-if="pageState === 'ready'" class="term-boxes">
        <div
          v-for="s in sessions"
          v-show="s.id === activeId"
          :key="s.id"
          :ref="setBoxRef(s.id)"
          class="term-box"
        ></div>
      </div>
    </div>

    <!-- 共享敏感操作验证门(模块级单例,验证成功自动接续 startSessions) -->
    <ElevateGateModal />
  </div>
</template>

<style scoped>
/* 终端是独立的全屏页面,自带样式:深底贯穿整页,侧边栏 + 终端区两栏 */
.term-page {
  position: fixed;
  inset: 0;
  display: flex;
  background: #10151c;
}

/* ---- 会话侧边栏 ---- */
.term-side {
  flex: none;
  width: 190px;
  display: flex;
  flex-direction: column;
  background: #0b0f15;
  border-right: 1px solid rgb(255 255 255 / 0.08);
  color: #d7dde6;
}

.term-side-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 8px;
  font-size: 12px;
  font-weight: 600;
  color: #8a95a8;
  letter-spacing: 0.05em;
}

.term-side-add {
  width: 22px;
  height: 22px;
  border: 1px solid rgb(255 255 255 / 0.18);
  border-radius: 6px;
  background: none;
  color: #d7dde6;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.term-side-add:hover {
  border-color: #8fb3dd;
  color: #8fb3dd;
}

.term-side-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.term-side-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  min-width: 0;
}

.term-side-item:hover {
  background: rgb(255 255 255 / 0.06);
}

.term-side-item.is-active {
  background: #1b2634;
  box-shadow: inset 2px 0 0 #8fb3dd;
}

.term-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #5a6472; /* closed:灰 */
}

.term-dot.is-ok {
  background: #46b877; /* ready:绿 */
}

.term-dot.is-wait {
  background: #d9a04c; /* connecting:黄 */
}

.term-side-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.term-side-rename {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  padding: 2px 6px;
  border: 1px solid #8fb3dd;
  border-radius: 5px;
  background: #10151c;
  color: #d7dde6;
  outline: none;
}

.term-side-del {
  flex: none;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: #8a95a8;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
}

.term-side-item:hover .term-side-del {
  opacity: 1; /* 删除键 hover 才出现,列表不显拥挤 */
}

.term-side-del:hover {
  color: #e08a8a;
  background: rgb(224 138 138 / 0.12);
}

.term-side-empty {
  padding: 10px 8px;
  font-size: 12px;
  color: #5a6472;
}

/* ---- 右侧主区:顶栏 + 终端 ---- */
.term-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.term-topbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid rgb(255 255 255 / 0.08);
  color: #d7dde6;
}

.term-title {
  font-weight: 600;
  font-size: 13.5px;
}

.term-state {
  margin-left: auto;
  font-size: 12px;
  color: #8a95a8;
}

.term-state.is-ok {
  color: #46b877;
}

.term-state.is-wait {
  color: #d9a04c;
}

.term-state.is-bad {
  color: #e08a8a;
}

.term-unauth {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #d7dde6;
  font-size: 14px;
}

.term-unauth a {
  color: #8fb3dd;
}

/* 会话容器叠放:v-show 切换可见性,隐藏会话的 xterm 与 WS 保持活性 */
.term-boxes {
  flex: 1;
  min-height: 0;
  position: relative;
}

.term-box {
  position: absolute;
  inset: 0;
  padding: 8px 12px 12px;
}

.term-box :deep(.xterm) {
  height: 100%;
}
</style>
