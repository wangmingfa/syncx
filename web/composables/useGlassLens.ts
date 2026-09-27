import { buildLensMap } from '../liquidGlassSdf';

/**
 * 液态玻璃折射滤镜:一次性把共享 SVG <filter> 挂进文档,并做能力探测。
 *
 * 技法移植自 @wxperia/liquid-glass-vue(MIT)的 GlassFilter:
 * 一张圆角矩形 SDF 位移贴图(buildLensMap)喂给 feDisplacementMap,R/B 通道
 * 当法线用,红/绿/蓝三通道各差一档 scale(-26 / -28.6 / -31.2,即原库
 * aberrationIntensity=2 的 0.05 步进)做**色差**,screen 混合后微 blur 收边
 * —— 玻璃边缘因此把背景弯折并拆色,macOS 26 的「Liquid Glass」识别度全在
 * 这一步,纯 CSS 的 blur/saturate 模拟不出折射。
 * 原库的 EDGE_MASK 离散 alpha 门控链在其贴图为不透明时是恒等变换,已裁掉;
 * 折射强度改由贴图自身(边缘带以外全中性)承担。
 *
 * 挂载走 backdrop-filter 函数链**末尾**追加 url():先模糊后位移,且
 * backdrop-filter 只作用于背景,面板上的文字保持锐利(库用独立 warp span
 * 达到的同一效果,我们一个属性就拿到)。
 *
 * 能力探测失败 / Firefox(原库同样跳过:url 滤镜与 backdrop 的合成在 FF 上
 * 行为不靠谱)时**什么都不挂**,玻璃退回二版的纯磨砂观感 —— 降级零风险。
 */
export const GLASS_LENS_FILTER_ID = 'syncx-glass-lens';

let mounted = false;

/** 通道剥离矩阵(移植自 GlassFilter):取 RGB 之一 + 原 alpha。 */
const CHANNEL_MATRIX: Record<'R' | 'G' | 'B', string> = {
  R: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
  G: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
  B: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0',
};

export function mountGlassLens(): boolean {
  if (mounted) return true;
  if (typeof document === 'undefined') return false;
  if (/firefox/i.test(navigator.userAgent)) return false;

  const map = buildLensMap(128, 0.3, 0.17);
  const canvas = document.createElement('canvas');
  canvas.width = map.size;
  canvas.height = map.size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.putImageData(new ImageData(map.data, map.size, map.size), 0, 0);
  const href = canvas.toDataURL('image/png');

  const disp = (scale: number, ch: 'R' | 'G' | 'B', res: string): string =>
    `<feDisplacementMap in="SourceGraphic" in2="DM" scale="${scale}" xChannelSelector="R" yChannelSelector="B" result="${res}"/>` +
    `<feColorMatrix in="${res}" type="matrix" values="${CHANNEL_MATRIX[ch]}"/>`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute">` +
    `<defs><filter id="${GLASS_LENS_FILTER_ID}" x="-35%" y="-35%" width="170%" height="170%" color-interpolation-filters="sRGB">` +
    // none 拉伸:边缘带宽恒为面板尺寸的比例,小药丸与大弹窗的弯折都贴合各自轮廓
    `<feImage x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" href="${href}" result="DM"/>` +
    disp(-26, 'R', 'RC') +
    disp(-28.6, 'G', 'GC') +
    disp(-31.2, 'B', 'BC') +
    `<feBlend in="GC" in2="BC" mode="screen" result="GB"/>` +
    `<feBlend in="RC" in2="GB" mode="screen" result="RGB"/>` +
    `<feGaussianBlur in="RGB" stdDeviation="0.3"/>` +
    `</filter></defs></svg>`;

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  host.innerHTML = svg;
  document.body.appendChild(host);

  // 真探测:url 参与 backdrop-filter 链后计算值必须原样保留 url
  const probe = document.createElement('div');
  probe.style.backdropFilter = `blur(1px) url(#${GLASS_LENS_FILTER_ID})`;
  document.body.appendChild(probe);
  const ok = (getComputedStyle(probe).backdropFilter || '').includes('url');
  probe.remove();
  if (!ok) {
    host.remove();
    return false;
  }

  document.documentElement.dataset.glassLens = 'on';
  mounted = true;
  return true;
}
