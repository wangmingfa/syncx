import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

const css = read('../web/style.css');
const indexHtml = read('../web/index.html');
const useSkin = read('../web/composables/useSkin.ts');

/** 取某个选择器对应的顶层规则块(不含嵌套),找不到返回 null。 */
function ruleBlock(selector: string): string | null {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) return null;
  const end = css.indexOf('}', at);
  return end === -1 ? null : css.slice(at, end);
}

function tokensIn(block: string): Set<string> {
  return new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).filter((t): t is string => !!t));
}

const GLASS_LIGHT = "html[data-skin='glass']";
const GLASS_DARK = "html[data-skin='glass'][data-theme='dark']";
const PLAIN_DARK = "html[data-theme='dark'] {";

/** 两版玻璃浅色块都不重定义、深浅通用的 token(圆角与磨砂参数刻意共用)。 */
const SHARED_TOKENS = new Set(['--radius', '--glass-blur']);

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

  it(':root 仍是文件里第一个规则块(theme-tokens 抽取的前提,皮肤块不得插队)', () => {
    expect(css.indexOf(':root {')).toBeLessThan(css.indexOf(GLASS_LIGHT));
    expect(css.match(/:root\s*\{/g)?.length).toBe(1);
  });
});
