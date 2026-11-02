///|
/// 索引指纹(对应 Rust `syncx-daemon/src/fingerprint.rs`、Node
/// `src/index-fingerprint.ts`)。
///
/// 会话建立时双方先换一条几十字节的指纹,一致就省掉几百 KB 的全量索引互换。
/// 口径必须与上线过滤完全一致,否则会出现「指纹相等但全量其实不同」的漏同步:
///
///  - 占位条目被 encodeIndex 挡在线外,这里同样排除;
///  - **mtime 必须排除**:它记的是「本机落盘时刻」,同一份内容在两台机器上必然不同;
///  - `blocks` 顺序有意义,不能排序;
///  - 版本向量按 deviceId 排序后序列化(JS 的 `Map` 迭代顺序取决于各机插入历史);
///  - 条目按路径排序。
///
/// **字段顺序也必须一致**:Node 用 `JSON.stringify` 序列化对象,顺序就是字面量
/// 顺序。所以这里手工拼 JSON,顺序照抄 JS。失败方向是安全的:指纹相等要求内容
/// 完全一致(跳过 = plan 必为空);任何不一致都退回「发全量」的旧路径,
/// 最多少省一次,绝不漏同步。

///|
/// 计算索引指纹(十六进制小写 sha256)。
pub fn index_fingerprint(entries : Array[Entry]) -> String {
  let canonical : Array[Entry] = []
  for e in entries {
    if !e.placeholder {
      canonical.push(e)
    }
  }
  canonical.sort_by((a, b) => compare_string(a.path, b.path))
  let body = StringBuilder()
  body.write_char('[')
  for i, entry in canonical {
    if i > 0 {
      body.write_char(',')
    }
    body.write_string(canonical_entry(entry))
  }
  body.write_char(']')
  // 复用 core 的 SHA-256(与 Node crypto.createHash / Rust sha2 同一算法)
  @core.hash_block(@utf8.encode(body.to_string()))
}

///|
/// 单条目的规范形态,字段顺序与 Node 的 `JSON.stringify({path, version, size,
/// deleted, blocks, ...(cdh && clens ? {cdh, clens} : {})})` 一致。
fn canonical_entry(entry : Entry) -> String {
  // 版本向量按 deviceId 排序:Map 的迭代顺序取决于插入历史,直接遍历两端必不同
  let keys : Array[String] = []
  for key, _ in entry.version {
    keys.push(key)
  }
  keys.sort()
  let out = StringBuilder()
  out.write_string("{\"path\":")
  out.write_string(json_string(entry.path))
  out.write_string(",\"version\":[")
  for i, key in keys {
    if i > 0 {
      out.write_char(',')
    }
    out.write_char('[')
    out.write_string(json_string(key))
    out.write_char(',')
    out.write_string(int64_text(entry.version[key]))
    out.write_char(']')
  }
  out.write_string("],\"size\":")
  out.write_string(int64_text(entry.size))
  out.write_string(",\"deleted\":")
  out.write_string(if entry.deleted { "true" } else { "false" })
  out.write_string(",\"blocks\":[")
  for i, block in entry.blocks {
    if i > 0 {
      out.write_char(',')
    }
    out.write_string(json_string(block))
  }
  out.write_char(']')
  // 只有 cdh 与 clens 都在时才出线 —— 与 Node 的对象展开条件一致
  match (entry.cdh, entry.clens) {
    (Some(cdh), Some(clens)) => {
      out.write_string(",\"cdh\":[")
      for i, hash in cdh {
        if i > 0 {
          out.write_char(',')
        }
        out.write_string(json_string(hash))
      }
      out.write_string("],\"clens\":[")
      for i, len in clens {
        if i > 0 {
          out.write_char(',')
        }
        out.write_string(int64_text(len))
      }
      out.write_char(']')
    }
    _ => ()
  }
  out.write_char('}')
  out.to_string()
}

///|
/// 字符串比较(-1/0/1),供 sort_by 用。
fn compare_string(a : String, b : String) -> Int32 {
  if a < b {
    -1
  } else if a > b {
    1
  } else {
    0
  }
}

///|
/// 整数十进制文本(JSON number,不带小数点 —— 带「.0」字节就对不上了)。
fn int64_text(value : Int64) -> String {
  value.to_string()
}

///|
/// JSON 字符串序列化,转义规则与 `JSON.stringify` / serde_json 一致:
/// 只转义 `"`、`\` 与控制字符,其余(含非 ASCII)原样输出。
fn json_string(value : String) -> String {
  let out = StringBuilder()
  out.write_char('"')
  for c in value {
    match c {
      '"' => out.write_string("\\\"")
      '\\' => out.write_string("\\\\")
      '\u{8}' => out.write_string("\\b")
      '\u{9}' => out.write_string("\\t")
      '\u{A}' => out.write_string("\\n")
      '\u{C}' => out.write_string("\\f")
      '\u{D}' => out.write_string("\\r")
      _ =>
        if c < '\u{20}' {
          // 其它控制字符:4 位小写十六进制 \u00xx
          let code = c.to_int()
          let digits = "0123456789abcdef".to_array()
          out.write_string("\\u00")
          out.write_char(digits[(code >> 4) & 0xF])
          out.write_char(digits[code & 0xF])
        } else {
          out.write_char(c)
        }
    }
  }
  out.write_char('"')
  out.to_string()
}
