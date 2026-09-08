<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { NInput, NButton, NTabs, NTab } from 'naive-ui';

// 登录失败原因:优先取外部传入,否则用本地校验结果。
const props = defineProps<{ error?: string }>();

/**
 * 两种登录方式:
 * - password:已设置账号密码,默认展示用户名 + 密码
 * - token:未设置(或用户手动切换),用 control.token 登录 —— 也是忘记密码时的恢复通道
 */
type Mode = 'password' | 'token';

const mode = ref<Mode>('token');
/** 服务端是否已设置账号密码:决定是否显示「账号密码 / 控制令牌」切换器 */
const hasPassword = ref(false);
const ready = ref(false);
const username = ref('');
const password = ref('');
const token = ref('');
const busy = ref(false);
const errorMsg = ref<string | undefined>(props.error);

onMounted(async () => {
  try {
    const res = await fetch('/api/auth');
    if (res.ok) {
      const data = (await res.json()) as { mode?: Mode };
      if (data.mode === 'password') {
        hasPassword.value = true;
        mode.value = 'password';
      }
    }
  } catch {
    // 拉取失败就退回令牌登录,不阻塞用户
  } finally {
    ready.value = true;
  }
});

/** 切换登录方式:只切视图,不清已输入的内容,方便来回对照。 */
function switchMode(next: string): void {
  if (mode.value === next) return;
  mode.value = next as Mode;
  errorMsg.value = undefined;
}

function go(): void {
  if (busy.value) return;
  if (mode.value === 'password') void submitPassword();
  else void submitToken();
}

/** 登录成功后统一用 /api/status 复检:部分失败响应也是 200 页面壳,没有错误信号。 */
async function probeAndEnter(failMsg: string): Promise<void> {
  const probe = await fetch('/api/status');
  if (probe.ok) {
    location.replace('/');
    return;
  }
  errorMsg.value = failMsg;
}

async function submitPassword(): Promise<void> {
  const u = username.value.trim();
  const p = password.value;
  if (!u || !p) {
    errorMsg.value = '请输入用户名和密码';
    return;
  }

  busy.value = true;
  errorMsg.value = undefined;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      errorMsg.value = data.error ?? '登录失败,请重试';
      return;
    }
    await probeAndEnter('登录失败,请重试');
  } catch {
    errorMsg.value = '网络异常,请重试';
  } finally {
    busy.value = false;
  }
}

async function submitToken(): Promise<void> {
  const value = token.value.trim();
  if (!value) {
    errorMsg.value = '请输入控制令牌';
    return;
  }

  busy.value = true;
  errorMsg.value = undefined;
  try {
    // 依然走原生 POST /login:成功时服务端下发 HttpOnly cookie,
    // fetch 会自动存储;失败时服务端返回的是 200 页面壳(无错误信号),
    // 因此用 /api/status 复检来判定是否真的登录成功。
    await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(value)}`,
      redirect: 'follow',
    });
    await probeAndEnter('令牌无效,请重试');
  } catch {
    errorMsg.value = '网络异常,请重试';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login">
    <div class="login__bg" aria-hidden="true">
      <div class="login__grid"></div>
      <div class="login__glow"></div>
    </div>

    <div class="login__card">
      <div class="brand">
        <svg class="brand__mark" viewBox="0 0 32 32" aria-hidden="true">
          <defs>
            <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#4a7fc0" />
              <stop offset="1" stop-color="#2bb6ac" />
            </linearGradient>
          </defs>
          <rect width="32" height="32" rx="9" fill="url(#lg)" />
          <g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round">
            <path d="M8.5 13H20" />
            <path d="M24 19H12" />
          </g>
          <path d="M20 10.5 24.5 13 20 15.5Z" fill="#fff" />
          <path d="M12 16.5 7.5 19 12 21.5Z" fill="#fff" />
        </svg>
        <div class="brand__text">
          <div class="brand__name">SYNCX</div>
          <div class="brand__sub">P2P LAN SYNC</div>
        </div>
      </div>

      <div class="login__title">Access Control</div>

      <!-- 登录方式切换:仅在已设置账号密码时出现,未设置时固定令牌登录 -->
      <n-tabs
        v-if="hasPassword"
        class="login__tabs"
        type="segment"
        size="small"
        :value="mode"
        @update:value="switchMode"
      >
        <n-tab name="password">账号密码</n-tab>
        <n-tab name="token">控制令牌</n-tab>
      </n-tabs>

      <form @submit.prevent="go">
        <template v-if="mode === 'password'">
          <label class="field">
            <span class="field__label">用户名</span>
            <n-input
              v-model:value="username"
              autocomplete="username"
              placeholder="登录用户名"
            />
          </label>
          <label class="field">
            <span class="field__label">密码</span>
            <n-input
              v-model:value="password"
              type="password"
              show-password-on="click"
              autocomplete="current-password"
              placeholder="登录密码"
              @keyup.enter="go"
            />
          </label>
        </template>

        <label v-else class="field">
          <span class="field__label">控制令牌</span>
          <n-input
            v-model:value="token"
            type="password"
            show-password-on="click"
            autocomplete="current-password"
            placeholder="粘贴 ~/.syncx/control.token 的内容"
          />
        </label>

        <div v-if="errorMsg" class="login__error">{{ errorMsg }}</div>

        <n-button
          class="submit"
          type="primary"
          attr-type="submit"
          :loading="busy"
          :disabled="!ready"
          block
        >登录</n-button>
      </form>

      <div class="login__foot">
        <span class="pulse"></span>
        <span>
          <template v-if="mode === 'password'">
            忘记密码? 切到控制令牌登录,进入后可在「登录密码」里重设
          </template>
          <template v-else>
            想用账号密码登录?先用令牌进入,再到「登录密码」里设置
          </template>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 24px;
  overflow: hidden;
  background:
    radial-gradient(620px 420px at 16% 8%, rgb(74 127 192 / 0.1), transparent 70%),
    radial-gradient(560px 400px at 86% 94%, rgb(43 182 172 / 0.08), transparent 70%),
    var(--bg);
}

/* ---------- 背景:极淡网格 ---------- */

.login__bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.login__grid {
  position: absolute;
  inset: -1px;
  background-image:
    linear-gradient(to right, rgb(74 127 192 / 0.05) 1px, transparent 1px),
    linear-gradient(to bottom, rgb(74 127 192 / 0.05) 1px, transparent 1px);
  background-size: 34px 34px;
  -webkit-mask-image: radial-gradient(ellipse 80% 60% at 50% 40%, #000 30%, transparent 100%);
  mask-image: radial-gradient(ellipse 80% 60% at 50% 40%, #000 30%, transparent 100%);
}

/* ---------- 卡片 ---------- */

.login__card {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 400px;
  padding: 32px;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: var(--card);
  box-shadow:
    0 1px 2px rgba(22, 32, 52, 0.05),
    0 30px 70px -28px rgba(22, 32, 52, 0.28);
}

/* 顶部一道极淡渐变高光,呼应品牌 */
.login__card::before {
  content: '';
  position: absolute;
  inset: -1px -1px auto -1px;
  height: 2px;
  border-radius: 18px 18px 0 0;
  background: linear-gradient(90deg, transparent, var(--accent), var(--accent-2), transparent);
}

/* ---------- 品牌头 ---------- */

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand__mark {
  width: 38px;
  height: 38px;
  flex: none;
}

.brand__name {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.2em;
  color: var(--text);
}

.brand__sub {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--muted);
  text-transform: uppercase;
}

.login__title {
  margin-top: 26px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--muted);
}

/* ---------- 登录方式切换(NTabs segment) ---------- */

.login__tabs {
  margin-top: 14px;
}

/* ---------- 表单 ---------- */

.field {
  display: block;
  margin-top: 14px;
}

.field__label {
  display: block;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}

.login__error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 9px 12px;
  font-size: 12.5px;
  color: var(--offline);
  background: rgb(217 107 107 / 0.08);
  border: 1px solid rgb(217 107 107 / 0.28);
  border-radius: 9px;
}

.login__error::before {
  content: '!';
  flex: none;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: rgb(217 107 107 / 0.18);
  font-family: var(--mono);
  font-size: 10px;
  line-height: 15px;
  text-align: center;
  color: var(--offline);
}

.submit {
  margin-top: 18px;
}

/* ---------- 页脚 ---------- */

.login__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 20px;
  font-size: 11.5px;
  color: var(--muted);
}

.pulse {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-2);
  box-shadow: 0 0 0 3px rgb(43 182 172 / 0.16);
  animation: pulse 1.8s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.4;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .pulse {
    animation: none;
    opacity: 0.9;
  }
}

@media (max-width: 480px) {
  .login {
    padding: 16px;
  }

  .login__card {
    padding: 24px 20px;
  }
}
</style>
