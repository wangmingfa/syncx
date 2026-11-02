#!/usr/bin/env node
// 校验 moonbit/core/version.mbt 的 VERSION 与 package.json 一致。
// 两个版本号漂移会导致 GitHub Release 资产名与运行时报告的版本对不上,
// 自更新比较随之失效(ADR-0026 §4)。
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const src = readFileSync(new URL('../moonbit/core/version.mbt', import.meta.url), 'utf8');
const m = src.match(/pub const VERSION : String = "([^"]+)"/);
if (!m) {
  console.error('moonbit/core/version.mbt 里找不到 VERSION 常量');
  process.exit(1);
}
if (m[1] !== pkg.version) {
  console.error(`版本漂移: package.json=${pkg.version}, moonbit VERSION=${m[1]}`);
  process.exit(1);
}
console.log(`moonbit VERSION 与 package.json 一致 (${pkg.version})`);
