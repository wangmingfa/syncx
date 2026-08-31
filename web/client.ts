import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

// 客户端入口(纯 CSR):挂载 Vue 实例,状态由 /api/status 拉取,
// 交互(手动扫描/重连/增删目录)走 JSON API + fetch + 局部刷新 + toast。
// 注:SSR 回退页会把初始状态注入 window.__SYNCX_DATA__。
// 用 globalThis 转型读取,同时兼容「带 DOM 的 web 配置」与「无 DOM 的 node 配置」,
// 避免重复声明 window 触发类型冲突。
const data = (globalThis as { __SYNCX_DATA__?: unknown }).__SYNCX_DATA__;
createApp(App, { page: 'status', data }).mount('#app');
