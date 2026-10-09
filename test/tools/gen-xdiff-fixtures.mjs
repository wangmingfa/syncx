#!/usr/bin/env node
/**
 * 生成 xdiff 对拍语料:test/fixtures/xdiff-fixtures.json
 *
 * 用 `git diff --no-index -U3` 对每对语料取 hunk 头(0 基化后存 JSON)。运行期
 * 测试(test/xdiff-fixtures.test.ts)只读这份 JSON、只跑纯函数,CI 不需要装
 * git。语料构造或参照的 git 版本变更后,重跑本脚本再生成:
 *
 *   node test/tools/gen-xdiff-fixtures.mjs
 *
 * 注意:git 行记录按原始字节比较。语料里的 CRLF 用例两侧风格统一(归一化对
 * 结构无影响),与 git 的 hunk 头才能逐一对上;混排风格是本实现的显式偏差,
 * 不进语料。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'fixtures', 'xdiff-fixtures.json');

// —— 语料构造(全部确定性,不用随机)——

/** 带高频重复行(空行、"  }"、"};")的伪源码文件,贴近真实退化场景。 */
function buildBase(n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const m = i % 12;
    if (m === 0) lines.push('');
    else if (m === 5) lines.push('  }');
    else if (m === 9) lines.push('};');
    else lines.push(`const value_${i} = compute(${i}, ${i * 7});`);
  }
  return lines;
}

function joinLines(lines, eol = '\n') {
  if (lines.length === 0) return '';
  return lines.join(eol) + eol;
}

/** 简单 LCG:确定性伪随机,重跑生成同样的语料。 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const corpus = [];
const addCase = (name, left, right) => corpus.push({ name, left, right });

// 1. 大文件稀疏改动:140 处单行修改,D=280 > XDL_MAX_COST_MIN,走启发式/预算路径
{
  const lines = buildBase(2400);
  addCase('sparse-large-edits', joinLines(lines), joinLines(
    lines.map((l, i) => (i >= 100 && i <= 2199 && (i - 100) % 15 === 0 ? `${l} // tweaked-${i}` : l)),
  ));
}

// 2. 同一文件的单 token 修改:最小差异,验证不放大
{
  const lines = buildBase(1200);
  const right = [...lines];
  right[600] = right[600].replace('compute(', 'Compute(');
  addCase('single-token', joinLines(lines), joinLines(right));
}

// 3. 高频重复行密集:全部行来自 6 个串的小词池,触发 INVESTIGATE/clean_mmatch
{
  const rand = lcg(20261009);
  const pool = ['', '}', 'return;', 'if (x) {', '  y++;', '// eslint-disable'];
  const mk = () => Array.from({ length: 400 }, () => pool[Math.floor(rand() * pool.length)]);
  const left = mk();
  const right = [...left];
  for (let k = 0; k < 40; k++) {
    const p = 8 + k * 9;
    right[p] = pool[Math.floor(rand() * pool.length)];
  }
  addCase('dense-repeated-pool', joinLines(left), joinLines(right));
}

// 4. 纯新增(尾部追加)
{
  const lines = buildBase(300);
  addCase('pure-add-tail', joinLines(lines), joinLines(
    [...lines, ...Array.from({ length: 50 }, (_, k) => `added_${k}();`)],
  ));
}

// 5. 纯删除(中段删 50 行)
{
  const lines = buildBase(400);
  addCase('pure-delete-middle', joinLines(lines), joinLines(lines.toSpliced(120, 50)));
}

// 6. EOF 无换行:两侧最后一行内容相同但换行状态不同(行身份不同)
addCase('no-trailing-eol', 'alpha\nbeta\ngamma\n', 'alpha\nbeta\ngamma');
addCase('both-no-trailing-eol', 'alpha\nbeta', 'alpha\nbeta\ngamma');

// 7. CRLF(两侧风格统一):与 git 逐 hunk 对拍的前提
{
  const lines = buildBase(300);
  const right = lines.map((l, i) => (i >= 50 && i <= 90 && i % 5 === 0 ? `${l} // crlf-tweak` : l));
  addCase('crlf-uniform', joinLines(lines, '\r\n'), joinLines(right, '\r\n'));
}

// 8. 完全不同:两侧没有任何公共行
{
  const left = Array.from({ length: 80 }, (_, i) => `old_line_${i} = ${i * 3};`);
  const right = Array.from({ length: 65 }, (_, i) => `new line ${i}: ${i * 11}`);
  addCase('totally-different', joinLines(left), joinLines(right));
}

// 9. 完全相同:git 无输出,expected 为空
addCase('identical', joinLines(buildBase(200)), joinLines(buildBase(200)));

// 10. 聚簇改动:每簇连续改 3 行,考察 change_compact 滑动与 hunk 合并
{
  const lines = buildBase(500);
  const right = [...lines];
  for (let c = 0; c < 12; c++) {
    const start = 40 + c * 38;
    for (let k = 0; k < 3; k++) right[start + k] = `cluster_${c}_line_${k}();`;
  }
  addCase('clustered-edits', joinLines(lines), joinLines(right));
}

// 11. 空 vs 满、满 vs 空
addCase('empty-to-full', '', joinLines(buildBase(120)));
addCase('full-to-empty', joinLines(buildBase(120)), '');

// —— 跑 git,解析 hunk 头 ——

function parseHunks(diffOut) {
  const out = [];
  for (const line of diffOut.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const c1 = m[2] === undefined ? 1 : Number(m[2]);
    const c2 = m[4] === undefined ? 1 : Number(m[4]);
    out.push({
      // git 的头是 1 基;count 为 0(空文件)时起点记 0
      start1: c1 === 0 ? 0 : Number(m[1]) - 1,
      count1: c1,
      start2: c2 === 0 ? 0 : Number(m[3]) - 1,
      count2: c2,
    });
  }
  return out;
}

const tmp = mkdtempSync(join(tmpdir(), 'xdiff-fix-'));
const cases = [];
try {
  const gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
  for (let i = 0; i < corpus.length; i++) {
    const c = corpus[i];
    const p1 = join(tmp, `a${i}.txt`);
    const p2 = join(tmp, `b${i}.txt`);
    // 用 Buffer 原样写入,避免任何换行翻译
    writeFileSync(p1, Buffer.from(c.left, 'utf8'));
    writeFileSync(p2, Buffer.from(c.right, 'utf8'));
    let stdout = '';
    try {
      stdout = execFileSync(
        'git',
        ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-color', '-U3', '--', p1, p2],
        { encoding: 'utf8' },
      );
    } catch (e) {
      // git 对「有差异」返回 1,属预期;>1 才是真错误
      if (e.status !== 1) throw e;
      stdout = e.stdout ?? '';
    }
    cases.push({ name: c.name, left: c.left, right: c.right, expected: parseHunks(stdout) });
  }
  mkdirSync(join(here, '..', 'fixtures'), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ git: gitVersion, cases }, null, 2)}\n`, 'utf8');
  console.log(`已生成 ${cases.length} 条语料 → ${outPath}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
