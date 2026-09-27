/**
 * 液态玻璃折射位移贴图生成器(纯数学,无 DOM,可单测)。
 *
 * 语义按 SVG feDisplacementMap:采样点 P' = P(x + scale*(R-0.5), y + scale*(B-0.5)),
 * 所以贴图里 R 通道存「表面法线 x」、B 通道存「表面法线 y」,中性值 0.5(=不位移);
 * 只有靠边一条带子里法线才离开中性值 —— 背景在面板正中直线透过、只在边缘弯折,
 * 这正是「玻璃厚度感」的来源,纯 blur 永远模拟不出来。
 *
 * 法线取自圆角矩形 SDF 的梯度:平面段法线沿主轴,圆角段沿 clamp 后的斜向;
 * 强度 t 由到边界距离经 smoothstep 衰减(0=远 centro,1=贴上缘)。
 * 贴图按 preserveAspectRatio="none" 拉伸到任意面板:边缘带宽恒为元素尺寸的
 * 固定比例,小药丸/大弹窗的弯折看起来都「贴合轮廓」。
 */

export interface LensMap {
  size: number;
  /** RGBA 逐行排列,长度 = size*size*4(ImageData 构造要求精确 ArrayBuffer 背书) */
  data: Uint8ClampedArray<ArrayBuffer>;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const smoothstep = (v: number): number => v * v * (3 - 2 * v);

export function buildLensMap(size = 128, cornerRatio = 0.3, bandRatio = 0.17): LensMap {
  const data = new Uint8ClampedArray(size * size * 4);
  const half = size / 2;
  const bandN = bandRatio * 2; // 归一化坐标下半边长 1,带宽比例换算
  for (let y = 0; y < size; y++) {
    const py = (y + 0.5) / half - 1;
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / half - 1;
      // 圆角矩形 SDF(半边长 1,圆角 cornerRatio):<0 在形内
      const qx = Math.abs(px) - (1 - cornerRatio);
      const qy = Math.abs(py) - (1 - cornerRatio);
      const k = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const sd = k + Math.min(Math.max(qx, qy), 0) - cornerRatio;
      // 边缘强度:形内距边 band 宽起算,形外恒 1(滤镜区域本来就外扩 35%)
      const t = sd >= 0 ? 1 : smoothstep(clamp01(1 + sd / bandN));
      let nx = 0;
      let ny = 0;
      if (k > 1e-6) {
        nx = (Math.max(qx, 0) / k) * Math.sign(px);
        ny = (Math.max(qy, 0) / k) * Math.sign(py);
      } else if (qx > qy) {
        nx = Math.sign(px);
      } else {
        ny = Math.sign(py);
      }
      const i = (y * size + x) * 4;
      data[i] = Math.round(127.5 + 127.5 * nx * t);
      data[i + 1] = 128;
      data[i + 2] = Math.round(127.5 + 127.5 * ny * t);
      data[i + 3] = 255;
    }
  }
  return { size, data };
}
