<script setup lang="ts">
import { ref } from 'vue';

// 登录失败原因:优先取外部传入,否则用本地校验结果。
const props = defineProps<{ error?: string }>();

const token = ref('');
const busy = ref(false);
const errorMsg = ref<string | undefined>(props.error);

async function submit(): Promise<void> {
  if (busy.value) return;
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
    const probe = await fetch('/api/status');
    if (probe.ok) {
      location.replace('/');
      return;
    }
    errorMsg.value = '令牌无效,请重试';
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
              <stop offset="0" stop-color="#4f8cff" />
              <stop offset="1" stop-color="#22d3ee" />
            </linearGradient>
          </defs>
          <rect width="32" height="32" rx="8" fill="url(#lg)" />
          <g fill="none" stroke="#04121c" stroke-width="2.4" stroke-linecap="round">
            <path d="M8.5 13H20" />
            <path d="M24 19H12" />
          </g>
          <path d="M20 10.5 24.5 13 20 15.5Z" fill="#04121c" />
          <path d="M12 16.5 7.5 19 12 21.5Z" fill="#04121c" />
        </svg>
        <div class="brand__text">
          <div class="brand__name">SYNCX</div>
          <div class="brand__sub">P2P LAN SYNC</div>
        </div>
      </div>

      <div class="login__title">Access Control</div>

      <form method="POST" action="/login" @submit.prevent="submit">
        <label class="field">
          <span class="field__label">控制令牌</span>
          <input
            id="token"
            v-model="token"
            name="token"
            type="password"
            autocomplete="current-password"
            spellcheck="false"
            placeholder="粘贴 ~/.syncx/control.token 的内容"
          >
        </label>

        <div v-if="errorMsg" class="login__error">{{ errorMsg }}</div>

        <button class="submit" type="submit" :disabled="busy">
          {{ busy ? '验证中…' : '验证并进入' }}
        </button>
      </form>

      <div class="login__foot">
        <span class="pulse"></span>
        令牌仅保存在服务器侧,不写入浏览器
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
}

/* ---------- 背景:网格 + 双色光晕 ---------- */

.login__bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.login__grid {
  position: absolute;
  inset: -1px;
  background-image:
    linear-gradient(to right, rgb(79 140 255 / 0.08) 1px, transparent 1px),
    linear-gradient(to bottom, rgb(79 140 255 / 0.08) 1px, transparent 1px);
  background-size: 34px 34px;
  -webkit-mask-image: radial-gradient(ellipse 85% 65% at 50% 0%, #000 35%, transparent 100%);
  mask-image: radial-gradient(ellipse 85% 65% at 50% 0%, #000 35%, transparent 100%);
}

.login__glow {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(520px 320px at 18% 10%, rgb(79 140 255 / 0.22), transparent 70%),
    radial-gradient(460px 300px at 84% 92%, rgb(34 211 238 / 0.15), transparent 70%);
}

/* ---------- 卡片 ---------- */

.login__card {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 400px;
  padding: 32px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: linear-gradient(180deg, rgb(31 35 49 / 0.92), rgb(20 23 31 / 0.92));
  backdrop-filter: blur(10px);
  box-shadow:
    0 30px 70px -24px rgb(0 0 0 / 0.85),
    inset 0 1px 0 rgb(255 255 255 / 0.05);
}

/* 顶部一条渐变高光,科技感的主要来源 */
.login__card::before {
  content: '';
  position: absolute;
  inset: -1px -1px auto -1px;
  height: 1px;
  border-radius: 16px 16px 0 0;
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
  font-weight: 500;
  letter-spacing: 0.22em;
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

.field input {
  font-family: var(--mono);
  letter-spacing: 0.05em;
}

.login__error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 9px 12px;
  font-size: 12.5px;
  color: #ffb4b4;
  background: rgb(255 107 107 / 0.08);
  border: 1px solid rgb(255 107 107 / 0.28);
  border-radius: 8px;
}

.login__error::before {
  content: '!';
  flex: none;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: rgb(255 107 107 / 0.22);
  font-family: var(--mono);
  font-size: 10px;
  line-height: 15px;
  text-align: center;
  color: #ff8f8f;
}

.submit {
  width: 100%;
  height: 46px;
  margin-top: 18px;
  border-radius: 10px;
  background: linear-gradient(100deg, var(--accent), var(--accent-2));
  color: #04121c;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0.06em;
  box-shadow: 0 10px 26px -12px rgb(79 140 255 / 0.9);
}

.submit:hover:not(:disabled) {
  filter: brightness(1.08);
  box-shadow: 0 14px 32px -12px rgb(79 140 255 / 1);
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
  box-shadow: 0 0 8px rgb(34 211 238 / 0.8);
  animation: pulse 1.8s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.35;
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
