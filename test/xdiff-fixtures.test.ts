import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gitStyleHunks } from '../web/utils/text-diff.js';

/**
 * 与 git xdiff 的对拍:语料与期望 hunk 头由 test/tools/gen-xdiff-fixtures.mjs
 * 预先用 `git diff --no-index -U3` 生成,这里只跑纯函数 —— CI 不需要装 git。
 * 语料文件缺失时整组跳过( freshly cloned 且没跑生成脚本也能过其余测试)。
 */
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'xdiff-fixtures.json');

interface FixtureHunk {
  start1: number;
  count1: number;
  start2: number;
  count2: number;
}

interface FixtureCase {
  name: string;
  left: string;
  right: string;
  expected: FixtureHunk[];
}

describe.skipIf(!existsSync(fixturePath))('xdiff 语料对拍(git -U3)', () => {
  const { git, cases } = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    git: string;
    cases: FixtureCase[];
  };

  it(`语料由 git 生成:${git}`, () => {
    expect(git).toContain('git version');
  });

  for (const c of cases) {
    it(`与 git 一致:${c.name}`, () => {
      expect(gitStyleHunks(c.left, c.right)).toEqual(c.expected);
    });
  }
});
