import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildLensMap } from '../web/liquidGlassSdf.js';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

const px = (map: ReturnType<typeof buildLensMap>, x: number, y: number): [number, number, number, number] => {
  const i = (y * map.size + x) * 4;
  return [map.data[i]!, map.data[i + 1]!, map.data[i + 2]!, map.data[i + 3]!];
};

/**
 * 折射位移贴图是「一眼假不假」的核心资产:feDisplacementMap 按
 * P'=P+scale*(通道值-0.5) 采样,所以中性必须是 0.5(≈128),法线只在边缘带里
 * 离开中性 —— 这两条错了,背景要么整片糊糊地乱飘,要么边缘根本不弯。
 * 观感没法在这里验,数学语义可以在这里钉死。
 */
describe('liquidGlassSdf:圆角矩形 SDF 折射贴图', () => {
  it('形状与缓冲合法', () => {
    const map = buildLensMap(64);
    expect(map.size).toBe(64);
    expect(map.data).toHaveLength(64 * 64 * 4);
    for (let i = 3; i < map.data.length; i += 4) expect(map.data[i]).toBe(255); // 位移贴图集不透明
  });

  it('正中是中性的:背景直线透过,不整体位移', () => {
    const map = buildLensMap(128);
    const [r, g, b] = px(map, 64, 64);
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(b - 128)).toBeLessThanOrEqual(1);
    expect(g).toBe(128);
  });

  it('边缘带上法线把通道推到底:右边 R→255、左边 R→0、下边 B→255', () => {
    const map = buildLensMap(128);
    expect(px(map, 127, 64)[0]).toBeGreaterThanOrEqual(250); // 右缘 nx=+1
    expect(px(map, 0, 64)[0]).toBeLessThanOrEqual(6); // 左缘 nx=-1
    expect(px(map, 64, 127)[2]).toBeGreaterThanOrEqual(250); // 下缘 ny=+1
    expect(px(map, 64, 0)[2]).toBeLessThanOrEqual(6); // 上缘 ny=-1
    // 平直段不该串通道:右缘的 B 保持中性
    expect(Math.abs(px(map, 127, 64)[2] - 128)).toBeLessThanOrEqual(1);
  });

  it('带内有 smoothstep 衰减,斜角两通道联动', () => {
    const map = buildLensMap(128, 0.3, 0.17);
    // 右缘向内 20px(带宽 ~0.34*64≈21.8px)处应已回到中性附近
    const inner = px(map, 127 - 24, 64);
    expect(Math.abs(inner[0] - 128)).toBeLessThanOrEqual(4);
    // 右上 45° 方向:R 偏小、B 偏大(法线斜向),两者都离开中性
    const corner = px(map, 120, 8);
    expect(corner[0]).toBeGreaterThan(150);
    expect(corner[2]).toBeLessThan(110);
  });
});

/** 滤镜注入与 CSS 挂钩的契约(源码断言,不跑浏览器)。 */
describe('glassLens:共享滤镜注入契约', () => {
  const lens = read('../web/composables/useGlassLens.ts');
  const css = read('../web/style.css');
  const app = read('../web/App.vue');

  it('滤镜 id 三处一致:常量、CSS url() 引用', () => {
    expect(lens).toContain("GLASS_LENS_FILTER_ID = 'syncx-glass-lens'");
    expect(css).toContain('url(#syncx-glass-lens)');
  });

  it('三通道色差:三条 feDisplacementMap 的 scale 逐个错开', () => {
    const scales = [...lens.matchAll(/disp\((-[\d.]+)/g)].map((m) => Number(m[1]));
    expect(scales).toHaveLength(3);
    expect(new Set(scales).size).toBe(3); // 同值就没有色散
  });

  it('Firefox 与能力探测都拦:探测不过就不挂 data-glass-lens', () => {
    expect(lens).toContain('firefox');
    expect(lens).toContain('backdropFilter');
    expect(lens).toContain("document.documentElement.dataset.glassLens = 'on'");
    // 探测失败的分支必须把已插入的滤镜撤走
    expect(lens).toMatch(/if \(!ok\) \{\s*host\.remove\(\)/);
  });

  it('CSS 只在 data-glass-lens=on 时给浮层接 url(),名单不含垫底大卡片', () => {
    const at = css.indexOf("html[data-skin='glass'][data-glass-lens='on']");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf('}', at));
    expect(block).toContain('.modal');
    expect(block).toContain('body .n-popover');
    expect(block).not.toContain('.card,');
    expect(block).toContain('var(--glass-blur) url(#syncx-glass-lens)');
  });

  it('App.vue 在玻璃档挂载且幂等首屏即触发', () => {
    expect(app).toContain('mountGlassLens');
    expect(app).toMatch(/watch\(skinMode, \(m\) => m === 'glass' && mountGlassLens\(\), \{ immediate: true \}\)/);
  });
});
