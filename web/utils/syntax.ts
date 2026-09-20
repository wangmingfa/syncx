/**
 * 语法高亮:文件内容对比弹窗的两栏代码着色。
 *
 * 四个刻意的取舍:
 *  1. **按扩展名显式指定语言,不做自动探测** —— `highlightAuto` 会把注册的语言全跑一遍
 *     再挑分数最高的,几千行的文件上很贵;而且猜错语言(把 JSON 当 JS 染)比不着色更难读。
 *  2. **只注册用得到的语言**(core + 逐语言 import)。`dist/syncx.js` 是把前端内嵌进去的
 *     单文件产物,多引一门语言就是多一份下载量,所以不走 `highlight.js` 主入口(那个会把
 *     近 200 门语言全注册上)。语言表按「体积 × 常见度」挑过:swift / scss / php / csharp /
 *     ruby 这五门未压缩合计 76KB、在局域网同步的个人文件里又少见,一律不引(见 LANG_BY_EXT)。
 *  3. **整份高亮后按行切开,不逐行高亮** —— 逐行会让跨行结构失准:块注释只有第一行变色、
 *     多行字符串的后半截沦为普通文本,比不着色更难看。切开时的 span 修补见 splitHighlightedLines。
 *  4. **有硬上限** —— 超过 MAX_HIGHLIGHT_CHARS 直接放弃着色(见 highlightLines)。
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { extOf } from './file-icon.js';

// 逐门注册。名字要与下面的 LANG_BY_EXT 里的值一致(hljs 的 registerLanguage 用的是
// 自己的语言名,不是扩展名)。
for (const [name, def] of Object.entries({
  bash, c, cpp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin,
  lua, markdown, python, rust, sql, typescript, xml, yaml,
})) {
  hljs.registerLanguage(name, def);
}

/**
 * 扩展名 → hljs 语言名。
 *
 * 两个刻意的近似(都不算「猜」,是这类文件的事实上的主体语法):
 *  - `.vue` 走 `xml`:hljs 没有 vue 语言,而 SFC 的骨架就是标签;
 *  - `.mbt` / `.mbti` 走 `rust`:MoonBit 的语法与 Rust 高度相似,比不着色好得多;
 *  - `.scss` / `.sass` 走 `css`、`.kt` 走 `java`:同族语法,只少了各自方言里的少数关键字。
 *
 * 没有对应语言的一律**不进表**:既包括没引的那几门(swift / php / cs / rb),
 * 也包括没人认领的扩展名(.bat/.cmd/.ps1/.less) —— 留着纯文本,好过用一门不搭界的语言乱染。
 */
const LANG_BY_EXT: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  vue: 'xml',
  mbt: 'rust', mbti: 'rust',
  rs: 'rust',
  py: 'python', pyi: 'python', pyw: 'python',
  go: 'go',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'java',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  lua: 'lua',
  html: 'xml', htm: 'xml', xhtml: 'xml', svg: 'xml', xml: 'xml',
  css: 'css', scss: 'css', sass: 'css', styl: 'css',
  json: 'json', json5: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  sql: 'sql',
  diff: 'diff', patch: 'diff',
};

/** 无扩展名的常见文件名(小写整名匹配)。 */
const LANG_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  '.env': 'ini',
};

/**
 * 这个路径该用哪门语言高亮;没有对应语言时返回 null(调用方退回纯文本)。
 * `dir/.env` 这类无扩展名的也要认,所以基名先过一遍。
 */
export function languageFor(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return 'ini';
  const named = LANG_BY_NAME[base];
  if (named) return named;
  const lang = LANG_BY_EXT[extOf(base)];
  return lang && hljs.getLanguage(lang) ? lang : null;
}

/** 高亮的字符上限:再大就整份放弃着色(全量跑 hljs 会占住主线程,而对比本身要即时)。 */
export const MAX_HIGHLIGHT_CHARS = 200_000;

/** 在 v-html 里安全地显示纯文本:内容是文件内容,必须自己转义(见 FileDiffModal 的说明)。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 把 hljs 输出的整份 HTML 按 `\n` 切成「行 HTML」。
 *
 * 为什么不能直接 `split('\n')`:hljs 的 token 可以跨行(块注释、多行字符串、JSX 片段),
 * 它输出的 `<span class="hljs-comment">` 自然也会跨行。视图是逐行渲染的,直接切开会
 * 让后半截的行丢掉行首那个开标签 —— 那些行不但不着色,浏览器还会把后面所有内容
 * (含下一行的行号、按钮)一路当成注释染下去。
 *
 * 所以切开时同步维护一个「当前仍未闭合的 span 栈」:每行**行首补上**栈里的开标签、
 * **行尾把栈补空**(补 `栈深` 个闭合标签)。注意行尾补的数量是**结束时的栈深**,
 * 不能写「本行新增了几个开标签」—— 行内完全可能先闭合掉行首补进来的那个、再开一个新的
 * (块注释结束 + 字符串开始),这种净增量为 0 的行照样要多补一个 `</span>`。
 * 行内标签本身是平衡的(hljs 保证),所以按出现顺序压栈出栈即可,不需要真正的 HTML 解析器。
 */
export function splitHighlightedLines(html: string): string[] {
  const out: string[] = [];
  let open: string[] = [];
  for (const line of html.split('\n')) {
    const stack = [...open];
    const re = /<span\b[^>]*>|<\/span>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m[0] === '</span>') stack.pop();
      else stack.push(m[0]);
    }
    out.push(open.join('') + line + '</span>'.repeat(stack.length));
    open = stack;
  }
  return out;
}

/**
 * 逐行高亮。
 *
 * @param lines 已按 `\n` 切好的行(调用方保证与差异视图的行号同源,见 FileDiffModal)。
 * @returns 与 `lines` 一一对应的 HTML 行数组;不着色(语言未知 / 超限 / 高亮抛错)时 null。
 *
 * 高亮是**锦上添花**,任何异常都退回纯文本 —— 绝不能因为染色失败让对比看不了。
 */
export function highlightLines(lines: string[], lang: string | null): string[] | null {
  if (!lang || lines.length === 0) return null;
  const code = lines.join('\n');
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    const { value } = hljs.highlight(code, { language: lang, ignoreIllegals: true });
    const out = splitHighlightedLines(value);
    // 行数对不上说明 hljs 的行为与预期不符(理论上不会):宁可不着色,也不要错行
    return out.length === lines.length ? out : null;
  } catch {
    return null;
  }
}

/** 路径 + 整份文本 → 行 HTML 数组(null = 不着色,退回纯文本)。 */
export function highlightText(text: string, path: string): string[] | null {
  const lang = languageFor(path);
  if (!lang) return null;
  const norm = text.replace(/\r\n?/g, '\n');
  const body = norm.endsWith('\n') ? norm.slice(0, -1) : norm;
  return highlightLines(body === '' ? [] : body.split('\n'), lang);
}
