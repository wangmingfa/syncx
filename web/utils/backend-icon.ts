/**
 * 后端运行时形态 → 后端标识图标类别。纯函数,便于单测(与 os-icon.ts 同构:
 * 图标组件只管画,「该画哪一个」的判定留在这里)。
 *
 * 只认 ADR-0025 定义的三种形态,其余(含缺省)一律返回 null —— **不画**:
 *  - `runtime` 是随控制消息新增的字段,旧版本对端不发(undefined);
 *  - 此时画任何一枚都会让用户以为「对端就是那个后端」,而事实是「不知道」。
 *    一批旧设备同屏全画成 Node 尤其误导。
 *
 * 与 os-icon 同一取舍:刻意不做大小写 / 别名归一化 —— `'Node'` 落到 null 是
 * 正确行为,真出现变体说明上游已经坏了,悄悄兜住反而藏起 bug。
 */
export type BackendIconKind = 'node' | 'rust' | 'moonbit';

export function backendIconKind(runtime: string | undefined): BackendIconKind | null {
  switch (runtime) {
    case 'node':
      return 'node';
    case 'rust':
      return 'rust';
    case 'moonbit':
      return 'moonbit';
    default:
      return null;
  }
}

/** 后端标识的可读名称(工具提示 / 无障碍文本)。形状 + 颜色是主通道,这行是兜底。 */
export function backendIconLabel(runtime: string | undefined): string {
  switch (backendIconKind(runtime)) {
    case 'node':
      return 'Node.js';
    case 'rust':
      return 'Rust';
    case 'moonbit':
      return 'MoonBit';
    default:
      return '未知后端';
  }
}
