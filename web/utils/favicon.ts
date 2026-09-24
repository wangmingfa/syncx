/**
 * favicon 数字角标:把待处理事项数(邀请 + 冲突 + 错误)画到标签页图标上,
 * 后台挂着也能扫一眼知道有没有事、有几件。0 时恢复原始图标。
 *
 * 实现:把 /favicon.svg 画进 64×64 canvas,右下角叠一个红色圆泡写数字,
 * 导出 dataURL 换到 <link rel="icon">。SVG 不能直接 createImageBitmap(Chrome 不支持),
 * 走 <img> + decode() 解码;加载失败时兜底画一个纯色底,角标信息不丢。
 */

const ORIG_HREF = '/favicon.svg';
const SIZE = 64;
const MAX_SHOWN = 99;

let baseImage: HTMLImageElement | null = null;
let baseFailed = false;

function loadBase(): Promise<HTMLImageElement | null> {
  if (baseImage) return Promise.resolve(baseImage);
  if (baseFailed) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      baseImage = img;
      resolve(img);
    };
    img.onerror = () => {
      baseFailed = true; // 只试一次,失败后直接画兜底底色
      resolve(null);
    };
    img.src = ORIG_HREF;
  });
}

function iconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  return link;
}

function draw(count: number, img: HTMLImageElement | null): void {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (img) {
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
  } else {
    // 兜底底色:与 brand 渐变近似,保证角标永远有可辨识的载体
    ctx.fillStyle = '#3d76b6';
    ctx.beginPath();
    ctx.roundRect(0, 0, SIZE, SIZE, 14);
    ctx.fill();
  }
  // 红色圆泡:右下角,直径约 40%
  const r = 13;
  const cx = SIZE - r - 3;
  const cy = SIZE - r - 3;
  ctx.fillStyle = '#e5484d';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = 2;
  ctx.stroke();
  const label = count > MAX_SHOWN ? '99+' : String(count);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${count > 9 ? 12 : 15}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy + 1);

  const link = iconLink();
  link.type = 'image/png';
  link.href = canvas.toDataURL('image/png');
}

/** 把角标更新为 count;0 = 恢复原始图标。异步画(需先解码 SVG),多次调用按最后一次为准。 */
let latest = 0;
let pendingDraw = false;
export function setFaviconCount(count: number): void {
  latest = count;
  if (count <= 0) {
    const link = iconLink();
    link.type = 'image/svg+xml';
    link.href = ORIG_HREF;
    return;
  }
  if (pendingDraw) return;
  pendingDraw = true;
  void loadBase().then((img) => {
    pendingDraw = false;
    draw(latest, img); // 画的是调用时序里最新的一次
  });
}
