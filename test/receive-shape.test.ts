import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 接收侧的内存形状由「管线里根本没有整文件缓冲」这件事保证,而不是靠某个 if。
 * 所以这里钉的是**结构**:块从网络到磁盘只有一条通道 —— 执行器的落盘句柄。
 *
 * 曾经破坏它的两种写法都留过痕迹,都禁止回退:
 *  - 待接收项自带 `blocks: Buffer[]`(O(文件) 常驻,收完还要 concat);
 *  - 落地前 `Buffer.concat(blocks)` 一次拼回整份文件再写盘(1.5GB 实测顶爆 V8 堆)。
 * 行为侧的守卫在别处:executor 的 192MB 落地用例追踪 Buffer.concat 的最大拼接长度,
 * 这条测试管的是「那种代码根本不该再出现在接收路径上」。
 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('接收路径的内存形状', () => {
  it('the peer pipeline holds no block list of its own', () => {
    const src = read('../src/peer.ts');
    // 带左括号才算是调用:注释里点名旧实现是允许的,也是有用的历史
    expect(src).not.toMatch(/Buffer\.concat\(/);
    // 待接收项只允许通过句柄转交块;自己攒一份 blocks/received 就是回到 O(文件)
    expect(src).toMatch(/handle:\s*ReceiveHandle/);
    expect(src).not.toMatch(/^\s*blocks:\s*Buffer\[\]/m);
  });

  it('the executor lands bytes as they arrive, never a reassembled file', () => {
    const src = read('../src/executor.ts');
    expect(src).not.toMatch(/Buffer\.concat\(/);
    // 旧的整文件接收入口(调用方先把块攒齐再交出来)必须真的不存在,不是「别用」
    expect(src).not.toMatch(/applyReceive/);
    expect(src).toMatch(/writeSync\(\s*handle,\s*data,\s*written/); // 5 参随机写
  });
});
