import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

// 客户端入口(纯 CSR):挂载 Vue 实例,状态由 /api/status 拉取,
// 交互(手动扫描/重连/增删目录)走 JSON API + fetch + 局部刷新 + toast。
// 注:此文件在浏览器运行,tsconfig 无 DOM lib,故用 declare 声明 window。
declare const window: { __SYNCX_DATA__?: unknown };

const data = window.__SYNCX_DATA__;
createApp(App, { page: 'status', data }).mount('#app');
