import { describe, expect, it } from 'vitest';
import {
  MAX_HIGHLIGHT_CHARS,
  escapeHtml,
  highlightLines,
  highlightText,
  languageFor,
  splitHighlightedLines,
} from '../web/utils/syntax.js';
import { diffText } from '../web/utils/text-diff.js';

describe('languageFor:按扩展名选语言', () => {
  it('常见代码后缀', () => {
    expect(languageFor('src/a.ts')).toBe('typescript');
    expect(languageFor('a/b/c.js')).toBe('javascript');
    expect(languageFor('main.rs')).toBe('rust');
    expect(languageFor('Dockerfile')).toBe('dockerfile');
    expect(languageFor('dir/.env')).toBe('ini');
  });

  it('两个刻意的近似:.vue 走 xml、.mbt 走 rust', () => {
    // hljs 没有 vue / moonbit 语言;这两个是「主体语法一致」的近似,不是乱猜
    expect(languageFor('App.vue')).toBe('xml');
    expect(languageFor('main.mbt')).toBe('rust');
    // 同族语法就近复用:.scss 用 css、.kt 用 java(省下这两门的独立语言包)
    expect(languageFor('a.scss')).toBe('css');
    expect(languageFor('a.kt')).toBe('kotlin');
  });

  it('没有对应语言的一律返回 null(宁可不着色,不要乱染)', () => {
    expect(languageFor('a.log')).toBeNull();
    expect(languageFor('a.txt')).toBeNull();
    expect(languageFor('run.bat')).toBeNull();
    expect(languageFor('Makefile')).toBeNull();
    // 没引的那几门语言(体积大又少见,见 syntax.ts 的说明)
    expect(languageFor('a.swift')).toBeNull();
    expect(languageFor('a.php')).toBeNull();
    expect(languageFor('a.cs')).toBeNull();
    expect(languageFor('a.rb')).toBeNull();
  });
});

describe('escapeHtml', () => {
  it('把会被当成标签的字符转成实体(模板里走 v-html,这层不能漏)', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('a & b "c" \'d\'')).toBe('a &amp; b &quot;c&quot; &#39;d&#39;');
  });
});

describe('splitHighlightedLines:跨行 token 的 span 修补', () => {
  it('行内标签原样保留', () => {
    expect(splitHighlightedLines('<span class="k">a</span>')).toEqual(['<span class="k">a</span>']);
  });

  it('跨行 span:每行都补上行首开标签与行尾闭标签', () => {
    expect(splitHighlightedLines('<span class="c">x\ny</span>')).toEqual([
      '<span class="c">x</span>',
      '<span class="c">y</span>',
    ]);
  });

  it('跨行 + 行内嵌套:栈按出现顺序进出', () => {
    const html = '<span class="c">a<span class="b">b\nc</span>d</span>';
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="c">a<span class="b">b</span></span>',
      '<span class="c"><span class="b">c</span>d</span>',
    ]);
  });

  it('每一行的开闭标签都是平衡的(否则染色会漏到行外去)', () => {
    const html = '<span class="c">注释\n还在注释</span>code<span class="s">"字符串\n跨行"\n</span>tail';
    for (const line of splitHighlightedLines(html)) {
      expect(count(line, /<span\b/g)).toBe(count(line, /<\/span>/g));
    }
  });
});

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/** 去掉标签并反转义,用来核对「高亮没有吃掉/改动任何一个字符」。 */
function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('highlightLines / highlightText', () => {
  it('未知语言不着色', () => {
    expect(highlightLines(['a'], null)).toBeNull();
    expect(highlightText('a = 1', 'a.log')).toBeNull();
  });

  it('超过上限不着色(全量跑 hljs 会占住主线程)', () => {
    const huge = `const a = 1;\n`.repeat(Math.ceil(MAX_HIGHLIGHT_CHARS / 13) + 10);
    expect(highlightText(huge, 'a.ts')).toBeNull();
  });

  it('行数与原文本严格一致,且逐行内容逐字符可还原', () => {
    const src = ['// 注释', 'const a = "x < y & z";', '', 'export function f(b: number) { return b + 1; }'];
    const lines = highlightText(src.join('\n'), 'a.ts');
    expect(lines).not.toBeNull();
    expect(lines!.length).toBe(src.length);
    expect(lines!.map(plain)).toEqual(src);
  });

  it('跨行块注释:每一行都被染色(证明是整份高亮后切行,不是逐行高亮)', () => {
    const lines = highlightText('/* 第一行\n   第二行\n   第三行 */\nconst a = 1;', 'a.ts')!;
    expect(lines[0]).toContain('hljs-comment');
    expect(lines[1]).toContain('hljs-comment');
    expect(lines[2]).toContain('hljs-comment');
    expect(lines[3]).not.toContain('hljs-comment');
  });

  it('CRLF 与结尾换行不改变行数', () => {
    expect(highlightText('a\r\nb\r\n', 'a.ts')!.length).toBe(2);
    expect(highlightText('a\nb', 'a.ts')!.length).toBe(2);
    // 空文件没有可着色的行 → 与「没有对应语言」一样走 null(不着色)这条路
    expect(highlightText('', 'a.ts')).toBeNull();
  });

  it('高亮行号与 diff 行号同源(行号索引不会错位)', () => {
    const left = 'const a = 1;\r\nconst b = 2;\r\n';
    const right = 'const a = 1;\nconst c = 3;\n';
    const rows = diffText(left, right).rows;
    const hlLeft = highlightText(left, 'a.ts')!;
    const hlRight = highlightText(right, 'a.ts')!;
    for (const row of rows) {
      if (row.leftNo !== undefined) expect(hlLeft[row.leftNo - 1], `左侧第 ${row.leftNo} 行`).toBeDefined();
      if (row.rightNo !== undefined) expect(hlRight[row.rightNo - 1], `右侧第 ${row.rightNo} 行`).toBeDefined();
    }
  });
});
