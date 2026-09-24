<script setup lang="ts">
import ModalShell from './ModalShell.vue';
import LoginForm from '../LoginForm.vue';
import { gateOpen, gatePurpose, gateLocked, gateSuccess, gateDismiss } from '../utils/elevation';

/**
 * 敏感操作验证门(终端 / 文件管理器共用)。
 *
 * 弹窗本身没有状态:开不开、为了什么开、成功后做什么,全部来自
 * utils/elevation.ts 的模块级单例 —— 调用方只管 `ensureElevated(目的, 动作)`,
 * 这里负责把 LoginForm(elevate 模式)呈现出来并接住成功事件。
 * 也就是说同一个弹窗实例可以被任意页面的任意入口共享。
 */
</script>

<template>
  <ModalShell :open="gateOpen" title="敏感操作验证" :description="gatePurpose" :close-disabled="gateLocked" @close="gateDismiss()">
    <p class="gate-hint">
      即将使用高权限功能。请通过账号密码或控制令牌确认是本人操作;
      验证通过后 10 分钟内不再询问。
    </p>
    <LoginForm elevate @success="gateSuccess()" />
  </ModalShell>
</template>

<style scoped>
.gate-hint {
  margin: 0 0 16px;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.6;
}
</style>
