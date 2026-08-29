declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/**
 * CSS 副作用导入(client.ts 里 `import './style.css'`)。
 * TS 不认识 .css,没有这条声明 `tsc --noEmit` 会报 TS2882。
 * 构建由 vite 处理(lib 模式把样式抽出来,再由 inlineCssIntoJs 内联回 JS),不走 tsc。
 */
declare module '*.css';
