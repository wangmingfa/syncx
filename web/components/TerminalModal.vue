<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted } from 'vue';
import { NButton } from 'naive-ui';
import ModalShell from './ModalShell.vue';

/**
 * 浏览器内终端:WS /api/terminal,daemon 在对端 spawn 一个本机 shell,逐行 REPL。
 *
 * 无 PTY(不引 node-pty 原生依赖,保住单文件分发形态),所以 vim/top 等全屏交互
 * 程序不可用;定位是远程排障入口 —— 跑 ping / dir / curl 这类命令足够。
 * 输入行本地回显,输出按到达顺序追加;Ctrl+C / 中断按钮杀掉当前 shell 重开一个。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const output = ref('');
const input = ref('');
const running = ref(false); // 已连接且 shell 存活
const shellName = ref('');
const boxRef = ref<HTMLDivElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);

let ws: WebSocket | null = null;

const MAX_OUTPUT_CHARS = 200_000;

function append(text: string): void {
  output.value = output.value + text;
  if (output.value.length > MAX_OUTPUT_CHARS) {
    output.value = output.value.slice(-MAX_OUTPUT_CHARS);
  }
  void nextTick(() => {
    const box = boxRef.value;
    if (box) box.scrollTop = box.scrollHeight;
  });
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/terminal`);
  ws.onopen = () => {
    running.value = true;
  };
  ws.onmessage = (ev) => {
    let msg: { t?: string; data?: string; shell?: string; code?: number | null };
    try {
      msg = JSON.parse(String(ev.data)) as typeof msg;
    } catch {
      return;
    }
    if (msg.t === 'out' && typeof msg.data === 'string') append(msg.data);
    if (msg.t === 'ready' && msg.shell) {
      shellName.value = msg.shell;
      append(`—— ${msg.shell} 就绪(无 PTY:全屏交互程序不可用)——\n`);
    }
    if (msg.t === 'exit') {
      append(`\n—— shell 已退出(code ${msg.code ?? '—'})——\n`);
      running.value = false;
    }
  };
  ws.onclose = () => {
    running.value = false;
  };
}

function disconnect(): void {
  ws?.close();
  ws = null;
  running.value = false;
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      output.value = '';
      input.value = '';
      connect();
      void nextTick(() => inputRef.value?.focus());
    } else {
      disconnect();
    }
  },
);
onUnmounted(disconnect);

/** 回车:本地回显后把整行(含换行)发给 shell。 */
function submit(): void {
  const line = input.value;
  input.value = '';
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  append(`❯ ${line}\n`);
  ws.send(JSON.stringify({ t: 'in', data: line + '\n' }));
}

/** Ctrl+C:杀当前 shell 换个新的(无 PTY 下 ^C 无法直送前台进程组)。 */
function interrupt(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  append('^C\n');
  ws.send(JSON.stringify({ t: 'sigint' }));
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'c' && e.ctrlKey) {
    e.preventDefault();
    interrupt();
  }
}
</script>

<template>
  <ModalShell
    :open="open"
    title="终端"
    description="daemon 所在机器的本机 shell;Ctrl+C 重开一个干净会话"
    wide
    @close="emit('close')"
  >
    <div class="term-body" :class="{ 'is-down': !running }">
      <div ref="boxRef" class="term-output mono">{{ output }}<span v-if="!running" class="term-idle">{{ output ? '\n(未连接)' : '(未连接)' }}</span></div>
      <div class="term-input-row">
        <span class="term-prompt mono">❯</span>
        <input
          ref="inputRef"
          v-model="input"
          class="term-input mono"
          :placeholder="running ? '输入命令,回车执行' : '等待连接…'"
          spellcheck="false"
          autocomplete="off"
          :disabled="!running"
          @keydown="onKeydown"
          @keydown.enter.prevent="submit"
        />
        <n-button size="tiny" tertiary :disabled="!running" title="中断当前命令(重开 shell)" @click="interrupt">Ctrl+C</n-button>
      </div>
    </div>

    <template #footer>
      <n-button class="modal-cancel" @click="emit('close')">关闭</n-button>
    </template>
  </ModalShell>
</template>
