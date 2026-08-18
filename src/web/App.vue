<script setup lang="ts">
import StatusPage from './StatusPage.vue';
import LoginForm from './LoginForm.vue';

const props = defineProps<{ page: string; data: unknown }>();
const data = props.data as { status?: unknown; error?: string } | null;

const pageKind = props.page === 'status' ? 'status' : 'login';
</script>

<template>
  <div id="app">
    <StatusPage v-if="pageKind === 'status' && data?.status" :status="data.status as any" :message="(data as any)?.message" />
    <LoginForm v-else :error="(data as any)?.error" />
  </div>
</template>
