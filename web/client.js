import { createApp } from 'vue';
import App from './App.vue';
const data = window.__SYNCX_DATA__;
createApp(App, { page: 'status', data }).mount('#app');
