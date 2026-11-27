/**
 * 由 Node 侧生成直发(ADR-0028)线上格式的 MoonBit fixture:
 * `moonbit/net/direct_fixture.mbt`。
 *
 * 为什么要对拍:直发的六条控制消息与 `direct-file-chunk` 二进制帧的字段名、
 * 键序、可选字段的有无,是 Node / Rust / MoonBit 三套手写类型「约定」对齐的。
 * 名字拼错不会有编译错误,症状只是对端把消息当成未知 kind 静默丢掉 —— 发出
 * 去了、但对方永远不确认。这里把 Node 真正发上线的那串字节固化下来,MoonBit
 * 侧断言「解码 → 重编码逐字节还原」;分片帧因 iv 随机只做解码验证。
 *
 * 数据源:直接吃 Rust 侧那份 `rust/crates/syncx-net/fixtures/direct-wire.json`
 * (由 rust/scripts/gen-direct-wire-fixture.mjs 生成)—— 三后端共用同一份
 * 线上格式事实源,不要在本脚本里另起炉灶再造消息字面量。
 *
 * 生成:node_modules/.bin/tsx moonbit/scripts/gen-direct-fixture.mjs
 *
 * 什么时候必须重跑:重跑了 rust/scripts/gen-direct-wire-fixture.mjs(即
 * src/net/wire.ts 的 ControlMessage union 或 src/direct.ts 的消息字面量改了
 * 字段 —— 改名、加字段、调顺序),MoonBit 侧就要跟着重跑本脚本;只跑一边,
 * 任何一侧抄错/漏改都无人发现。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '../../rust/crates/syncx-net/fixtures/direct-wire.json');
const outPath = join(here, '../net/direct_fixture.mbt');

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

/** MoonBit 字符串字面量转义(控制符 + 引号 + 反斜杠;非 ASCII 原样保留)。 */
function mbtEscape(s) {
  let out = '';
  for (const ch of s) {
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '"': out += '\\"'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      default: out += ch;
    }
  }
  return out;
}

const lines = [];
lines.push('// 由 moonbit/scripts/gen-direct-fixture.mjs 生成;数据源是');
lines.push('// rust/crates/syncx-net/fixtures/direct-wire.json(Node 直发线上格式');
lines.push('// 的唯一事实源)。改 src/direct.ts / src/net/wire.ts 的消息字段后必须');
lines.push('// 重跑生成脚本,三后端(Rust/MoonBit)一起刷新,别只做一边。');
lines.push('');
lines.push('// 六条 direct-* 控制消息:(用例名, Node 发上线的完整 wire 字符串)。');
lines.push('pub fn direct_wire_controls() -> Array[(String, String)] {');
lines.push('  [');
for (const c of fixture.controls) {
  lines.push(`    ("${mbtEscape(c.name)}", "${mbtEscape(c.wire)}"),`);
}
lines.push('  ]');
lines.push('}');
lines.push('');
lines.push('// direct-file-chunk 二进制帧对拍样本(key/iv 见 Rust fixture:iv 随机,');
lines.push('// 每次生成都不同 —— 只作「两侧都能解」的快照,不参与逐字节还原)。');
lines.push(`pub fn direct_wire_chunk_key_hex() -> String { "${fixture.chunk.keyHex}" }`);
lines.push(`pub fn direct_wire_chunk_frame_b64() -> String { "${fixture.chunk.frameBase64}" }`);
lines.push(`pub fn direct_wire_chunk_body_b64() -> String { "${fixture.chunk.bodyBase64}" }`);
lines.push(`pub fn direct_wire_chunk_id() -> String { "${mbtEscape(fixture.chunk.header.id)}" }`);
lines.push(`pub fn direct_wire_chunk_seq() -> Int64 { ${fixture.chunk.header.seq}L }`);
lines.push('');

writeFileSync(outPath, lines.join('\n'));
console.log(`写入 ${outPath}`);
console.log(`  控制消息 ${fixture.controls.length} 条,分片帧 ${fixture.chunk.frameBase64.length} 字符(base64)`);
