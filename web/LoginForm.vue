<script setup lang="ts">
defineProps<{ error?: string }>();
</script>

<template>
  <div class="container">
    <h1>syncx 登录</h1>
    <div v-if="error" class="error">{{ error }}</div>
    <div class="card">
      <div class="muted">控制 token(保存在服务器侧,不写入浏览器)</div>
      <form method="POST" action="/login">
        <input name="token" type="password" placeholder="输入控制 token">
        <button type="submit">登录</button>
      </form>
    </div>
  </div>
</template>
