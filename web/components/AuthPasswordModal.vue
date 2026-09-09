<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NInput } from 'naive-ui';

const props = defineProps<{
  open: boolean;
  /** 轻提示(父级 useToast 提供)。 */
  notify: (msg: string, kind?: 'info' | 'alert') => void;
}>();
const emit = defineEmits<{ close: [] }>();

const mode = ref<'token' | 'password'>('token');
const username = ref('');
const busy = ref(false);
const password = ref('');
const confirm = ref('');

// 每次打开都回读当前认证模式(token / password)
watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    username.value = '';
    try {
      const res = await fetch('/api/auth');
      if (!res.ok) throw new Error(`auth ${res.status}`);
      const data = (await res.json()) as { mode?: 'token' | 'password' };
      mode.value = data.mode === 'password' ? 'password' : 'token';
    } catch {
      mode.value = 'token';
    }
  },
);

async function savePassword(): Promise<void> {
  if (busy.value) return;
  const u = username.value.trim();
  if (!u) {
    props.notify('请填写用户名');
    return;
  }
  if (password.value.length < 6) {
    props.notify('密码至少 6 位');
    return;
  }
  if (password.value !== confirm.value) {
    props.notify('两次输入的密码不一致');
    return;
  }
  busy.value = true;
  try {
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: password.value }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `http ${res.status}`);
    }
    mode.value = 'password';
    password.value = '';
    confirm.value = '';
    props.notify('登录密码已设置');
    emit('close');
  } catch (e) {
    props.notify(e instanceof Error ? e.message : '设置失败,请重试');
  } finally {
    busy.value = false;
  }
}

async function removePassword(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await fetch('/api/auth/password', { method: 'DELETE' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    mode.value = 'token';
    password.value = '';
    confirm.value = '';
    props.notify('已清除登录密码,恢复令牌登录');
    emit('close');
  } catch {
    props.notify('清除失败,请重试');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Transition name="guide">
    <div v-if="open" class="modal-overlay" @click.self="emit('close')">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <n-button quaternary circle class="modal-close" aria-label="关闭" @click="emit('close')">×</n-button>
        <h2 id="auth-title" class="modal-title">登录密码</h2>
        <p class="modal-lead">
          <template v-if="mode === 'password'">
            已启用账号密码登录。修改用户名请在下方一并输入。
          </template>
          <template v-else>
            当前使用 <span class="mono">control.token</span> 登录。设置后可用账号密码登录,不必再记那串令牌。
          </template>
        </p>

        <label class="field">
          <span class="field__label">用户名</span>
          <n-input v-model:value="username" autocomplete="username" placeholder="如 syncx" />
        </label>
        <label class="field">
          <span class="field__label">新密码</span>
          <n-input
            v-model:value="password"
            type="password"
            show-password-on="click"
            autocomplete="new-password"
            placeholder="至少 6 位"
          />
        </label>
        <label class="field">
          <span class="field__label">确认新密码</span>
          <n-input
            v-model:value="confirm"
            type="password"
            show-password-on="click"
            autocomplete="new-password"
            placeholder="再输入一次"
          />
        </label>

        <p class="confirm-note-extra">
          令牌始终是恢复通道:忘记密码时用 <span class="mono">control.token</span> 登录进来重设即可。
          修改或清除密码会让所有已登录页面重新登录。
        </p>

        <div class="modal-actions">
          <n-button
            v-if="mode === 'password'"
            class="modal-cancel"
            :disabled="busy"
            @click="removePassword"
          >清除密码</n-button>
          <n-button class="modal-cancel" :disabled="busy" @click="emit('close')">取消</n-button>
          <n-button type="primary" :loading="busy" @click="savePassword">保存</n-button>
        </div>
      </div>
    </div>
  </Transition>
</template>
