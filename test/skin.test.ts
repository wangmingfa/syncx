import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

const css = read('../web/style.css');
const indexHtml = read('../web/index.html');
const useSkin = read('../web/composables/useSkin.ts');

/** 取某个选择器对应的顶层规则块(不含嵌套),找不到返回 null。
 *  occurrence:同名选择器在全文件出现多次时取第几处(基础规则与玻璃覆盖规则会同名)。 */
function ruleBlock(selector: string, occurrence = 1): string | null {
  let at = -1;
  let from = 0;
  for (let i = 0; i < occurrence; i++) {
    at = css.indexOf(`${selector} {`, from);
    if (at === -1) return null;
    from = at + 1;
  }
  const end = css.indexOf('}', at);
  return end === -1 ? null : css.slice(at, end);
}

function tokensIn(block: string): Set<string> {
  return new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).filter((t): t is string => !!t));
}

const GLASS_LIGHT = "html[data-skin='glass']";
const GLASS_DARK = "html[data-skin='glass'][data-theme='dark']";
const PLAIN_DARK = "html[data-theme='dark'] {";

/** 玻璃深色块现已重定义浅色块的每一个 token(含 --radius/--glass-blur),无需豁免。 */
const SHARED_TOKENS = new Set<string>([]);

/** #rrggbb → WCAG 相对亮度。 */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** 前景 hex 压在不透明底 hex 上的 WCAG 对比度。 */
function contrast(fg: string, bg: string): number {
  const [x, y] = [luminance(fg), luminance(bg)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * 皮肤(skin)与主题(theme)是正交维度,靠三条纸质约定撑住,全部容易在重构中静默断裂:
 *  1. localStorage 键在 useSkin.ts 与 index.html 内联脚本两处手写,必须一致;
 *  2. 玻璃深色块必须重定义玻璃浅色块改过的每一个 token —— 漏一个就在深底上漏浅白;
 *  3. 块序不能动:玻璃浅色压在朴素深色之后(同特异度靠后写取胜),玻璃深色排最后
 *     (靠双属性特异度收尾),@supports 回退在全文件最末。
 */
describe('skin:板岩 / 液态玻璃两档皮肤', () => {
  it('index.html 首绘脚本与 useSkin 用同一个 localStorage 键', () => {
    const keyInComposable = useSkin.match(/const LS_KEY = '([^']+)'/)?.[1];
    expect(keyInComposable).toBeTruthy();
    expect(indexHtml).toContain(keyInComposable!);
    expect(indexHtml).toContain('dataset.skin');
  });

  it('玻璃深色块补齐了玻璃浅色块定义的每一个可翻色 token', () => {
    const light = ruleBlock(GLASS_LIGHT);
    const dark = ruleBlock(GLASS_DARK);
    expect(light).not.toBeNull();
    expect(dark).not.toBeNull();
    const missing = [...tokensIn(light!)].filter((t) => !tokensIn(dark!).has(t) && !SHARED_TOKENS.has(t));
    expect(missing).toEqual([]);
  });

  it('玻璃浅色的面板层是半透明的(材质定义所在,退回实底即失效)', () => {
    const light = ruleBlock(GLASS_LIGHT)!;
    for (const t of ['--card:', '--card-hi:', '--bg-soft:', '--border:', '--border-strong:']) {
      const decl = light.match(new RegExp(`${t}[^;]+`))?.[0] ?? '';
      expect(decl).toContain('/'); // rgb(r g b / a) 的 alpha 槽
    }
  });

  it('块序:朴素深色 → 玻璃浅色 → 玻璃深色 → @supports 回退', () => {
    const plainDark = css.indexOf(PLAIN_DARK);
    const glassLight = css.indexOf(`${GLASS_LIGHT} {`);
    const glassDark = css.indexOf(`${GLASS_DARK} {`);
    const supports = css.indexOf('@supports not (backdrop-filter');
    expect(plainDark).toBeGreaterThan(-1);
    expect(glassLight).toBeGreaterThan(plainDark);
    expect(glassDark).toBeGreaterThan(glassLight);
    expect(supports).toBeGreaterThan(glassDark);
  });

  it('板面元素吃到 backdrop-filter,且回退块给出近实底', () => {
    // 磨砂名单是多选择器规则(`html[data-skin='glass'] .card,` 起头,逐行一个选择器)
    const blur = css.match(/html\[data-skin='glass'\] \.card,[\s\S]*?\{([^}]*)\}/)?.[1] ?? '';
    expect(blur).toContain('backdrop-filter');
    const fallback = css.slice(css.indexOf('@supports not (backdrop-filter'));
    expect(fallback).toContain('--card: #f7f9fc');
    expect(fallback).toContain('--card: #1a2029');
  });

  it('动光底光:极光走 body::before,可漂移且尊重 prefers-reduced-motion', () => {
    const aurora = ruleBlock(`${GLASS_LIGHT} body::before`);
    expect(aurora).not.toBeNull();
    expect(aurora).toContain('position: fixed');
    // 光斑挂伪元素(而非 body)是为能 transform 漂移重排;body 只剩细噪数据 URI
    expect(aurora).toContain('radial-gradient');
    expect(css).toContain('@keyframes glass-aurora-drift');
    expect(css).toContain('@media (prefers-reduced-motion: no-preference)');
    // 深色极光要单独重给 body::before,否则深色页仍漂浅冷白光斑
    expect(css).toContain("html[data-skin='glass'][data-theme='dark'] body::before");
  });

  it('抬起面另开一档:弹窗/吐司吃 --glass-raised,内嵌子面不叠第二层雾', () => {
    // 弹窗垫的是暗遮罩,复用卡片那层薄 tint 会混成脏灰板 —— 里面 --muted 小字对比度归零
    // (实测败因)。抬起面必须近实,且深浅两档都要给(深色漏给 = 暗弹窗浮白板)。
    for (const block of [ruleBlock(GLASS_LIGHT)!, ruleBlock(GLASS_DARK)!]) {
      const alpha = block.match(/--glass-raised:\s*rgb\([^/]+\/\s*([\d.]+)\s*\)/)?.[1];
      expect(Number(alpha)).toBeGreaterThanOrEqual(0.8);
    }
    const raised = ruleBlock(`${GLASS_LIGHT} .modal`);
    expect(raised).toContain('background: var(--glass-raised)');
    // 吐司只收**普通胶囊**:alert 那颗是实色渐变板,吃抬起面会把白字丢在白雾上(见下一条用例)
    expect(ruleBlock(`${GLASS_LIGHT} .toast:not(.toast--alert)`)).toContain('background: var(--glass-raised)');
    // .empty 的底色是纸面时代写死的半透明白,玻璃档必须收掉(深色档它本是块白板)
    expect(ruleBlock(`${GLASS_LIGHT} .empty`)).toContain('background: transparent');

    // 抬起面 ≠ 万能:白 0.86 压在暗遮罩上仍会混出灰白底,次级文字要按**混色后**的底
    // 来验对比度(截图里弹窗灰字就栽在这一步)。全部数值从 CSS 现读,不写死第二份真相。
    /** 读某个规则块里某条声明的颜色(#rrggbb 或 rgb(r g b / a) 两种写法都认)。 */
    const colorOf = (src: string | null, token: string): { c: string; a: number } => {
      const decl = src?.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6}|rgb\\(([^)]+)\\))`, 'i'))?.[1];
      if (!decl) throw new Error(`CSS 里找不到 ${token} 的颜色值(规则块漏了还是改了写法)`);
      if (decl.startsWith('#')) return { c: decl, a: 1 };
      const n = decl.slice(4, -1).split(/[\s/]+/).filter(Boolean).map(Number);
      const [r = 0, g = 0, b = 0, a = 1] = n;
      return {
        c: `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`,
        a,
      };
    };
    const over = (top: { c: string; a: number }, bottom: string): string =>
      '#' + [1, 3, 5]
        .map((s) => Math.round(
          parseInt(top.c.slice(s, s + 2), 16) * top.a + parseInt(bottom.slice(s, s + 2), 16) * (1 - top.a),
        ).toString(16).padStart(2, '0'))
        .join('');
    const light = ruleBlock(GLASS_LIGHT)!;
    const dark = ruleBlock(GLASS_DARK)!;
    const surfaceUnder = (raised: string, overlay: string | null, page: string): string =>
      over(colorOf(raised, '--glass-raised'), over(colorOf(overlay, 'background'), page));
    const lightPage = colorOf(light, '--bg').c;
    // 选择器带 `html[data-skin=...]` 前缀,与基础 .modal-overlay 不同名,取第 1 处即是覆盖规则
    const lightSurface = surfaceUnder(light, ruleBlock(`${GLASS_LIGHT} .modal-overlay`), lightPage);
    expect(contrast(colorOf(light, '--muted').c, lightSurface)).toBeGreaterThanOrEqual(4.5);
    const darkSurface = surfaceUnder(dark, ruleBlock(`${GLASS_DARK} .modal-overlay`), colorOf(dark, '--bg').c);
    expect(contrast(colorOf(dark, '--muted').c, darkSurface)).toBeGreaterThanOrEqual(4.5);
  });

  it('高对比 alert 吐司不吃抬起面:白字必须有实色底托着', () => {
    // `.toast--alert` 是「品牌渐变实色 + 白字」的重要通知(配对/升级)。抬起面
    // --glass-raised 是 rgb(255 255 255 / .86) 的白雾:玻璃段只要有一条 .toast 规则没排除
    // 它,那颗就被刷成白雾底 + 白字,整条文字看不见(实测:上传安装包升级的提示就是这么哑的)。
    // 所以规则是「玻璃段里凡命中 .toast 的选择器,必须一律排除 .toast--alert」。
    const glass = css.slice(css.indexOf(GLASS_LIGHT)).replace(/\/\*[\s\S]*?\*\//g, '');
    const toastSelectors: string[] = [];
    for (const block of glass.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const sel of block[1]!.split(',')) {
        // `\.toast(?![\w-])` 只认真正的 .toast 类,不认 :not() 里那个 .toast--alert
        if (/\.toast(?![\w-])/.test(sel)) toastSelectors.push(sel.trim());
      }
    }
    // 磨砂名单 / 切面高光名单 / 抬起面底色 / 折射名单 —— 四处都点名了 .toast
    expect(toastSelectors).toHaveLength(4);
    for (const sel of toastSelectors) expect(sel).toMatch(/:not\(\.toast--alert\)\s*$/);
    // alert 自己的两条真相还在:实色渐变底 + 白字
    const alert = ruleBlock('.toast--alert')!;
    expect(alert).toContain('linear-gradient');
    expect(alert).toContain('color: #fff');
  });

  it('Tooltip 玻璃态:深色磨砂气泡 + 浅色字,用 !important 压过内联注入的半透明底', () => {
    // tooltip 复用 Popover 主题,App.vue 的半透明 Popover 底会盖掉它自带深气泡 →
    // 浅底配浅字直接糊掉;这里必须 !important 直写深色底 + 浅色字救回可读性。
    const tip = ruleBlock(`${GLASS_LIGHT} body .n-popover.n-tooltip`);
    expect(tip).not.toBeNull();
    expect(tip).toMatch(/background-color:[^;]+!important/);
    expect(tip).toMatch(/color:[^;]+!important/);
  });

  it(':root 仍是文件里第一个规则块(theme-tokens 抽取的前提,皮肤块不得插队)', () => {
    expect(css.indexOf(':root {')).toBeLessThan(css.indexOf(GLASS_LIGHT));
    expect(css.match(/:root\s*\{/g)?.length).toBe(1);
  });
});

/**
 * 顶栏那两个 20px 图标(主题 / 材质)。naive 的图标槽是写死 18px 的 flex 容器,
 * 会把更宽的 svg **静默收缩**回 18px(实测 width:18 / height:20)——「把图标放大」
 * 这件事在 DOM 里悄悄没发生,只能靠 class + flex:none 这一对同时在场来兜住。
 */
describe('顶栏 20px 图标:不被图标槽压回 18px', () => {
  it('每个 width="20" 的 svg 都挂 topbar-icon,且 style.css 给它 flex: none', () => {
    const topbar = read('../web/components/StatusTopbar.vue');
    const big = [...topbar.matchAll(/<svg\b[^>]*>/g)].map((m) => m[0]).filter((t) => /width="20"/.test(t));
    expect(big.length).toBeGreaterThanOrEqual(2);
    for (const tag of big) expect(tag).toContain('topbar-icon');
    expect(ruleBlock('.topbar .topbar-icon')).toContain('flex: none');
  });
});
