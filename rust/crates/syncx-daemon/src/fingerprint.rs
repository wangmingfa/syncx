//! 索引指纹:与 Node 侧 `src/index-fingerprint.ts` **逐字节相同**。
//!
//! 会话建立时双方先换一条几十字节的指纹,一致就省掉几百 KB 的全量索引互换。
//! 口径必须与上线过滤完全一致,否则会出现「指纹相等但全量其实不同」的漏同步:
//!
//!  - 占位条目被 `encodeIndex` 挡在线外,这里同样排除;
//!  - **mtime 必须排除**:它记的是「本机落盘时刻」,同一份内容在两台机器上必然不同;
//!  - `blocks` 顺序有意义,不能排序;
//!  - 版本向量按 deviceId 排序后序列化(JS 的 `Map` 迭代顺序取决于各机插入历史);
//!  - 条目按路径排序。
//!
//! **字段顺序也必须一致**:Node 用 `JSON.stringify` 序列化对象,顺序就是字面量顺序。
//! serde_json 默认按字母序输出,直接 `json!` 会得到另一串字节 —— 指纹永远对不上,
//! 优化静默失效。所以这里手工拼 JSON,顺序照抄 JS。

use sha2::{Digest, Sha256};

use crate::entry::StoredEntry;

/// 计算索引指纹(十六进制小写 sha256)。
pub fn index_fingerprint(entries: &[StoredEntry]) -> String {
    let mut canonical: Vec<&StoredEntry> = entries.iter().filter(|e| !e.placeholder).collect();
    canonical.sort_by(|a, b| a.path.cmp(&b.path));

    let mut body = String::from("[");
    for (i, entry) in canonical.iter().enumerate() {
        if i > 0 {
            body.push(',');
        }
        body.push_str(&canonical_entry(entry));
    }
    body.push(']');

    let mut hasher = Sha256::new();
    hasher.update(body.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 单条目的规范形态,字段顺序与 Node 的 `JSON.stringify({path, version, size,
/// deleted, blocks, ...(cdh && clens ? {cdh, clens} : {})})` 一致。
fn canonical_entry(entry: &StoredEntry) -> String {
    let mut pairs: Vec<(&String, u64)> = entry.version.iter().map(|(k, v)| (k, *v)).collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));

    let mut out = String::with_capacity(128);
    out.push_str("{\"path\":");
    out.push_str(&string(&entry.path));
    out.push_str(",\"version\":[");
    for (i, (device, count)) in pairs.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('[');
        out.push_str(&string(device));
        out.push(',');
        out.push_str(&count.to_string());
        out.push(']');
    }
    out.push_str("],\"size\":");
    out.push_str(&entry.size.to_string());
    out.push_str(",\"deleted\":");
    out.push_str(if entry.deleted { "true" } else { "false" });
    out.push_str(",\"blocks\":[");
    push_strings(&mut out, &entry.blocks);
    out.push(']');
    // 只有 cdh 与 clens 都在时才出线 —— 与 Node 的对象展开条件一致
    if let (Some(cdh), Some(clens)) = (&entry.cdh, &entry.clens) {
        out.push_str(",\"cdh\":[");
        push_strings(&mut out, cdh);
        out.push_str("],\"clens\":[");
        for (i, len) in clens.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&len.to_string());
        }
        out.push(']');
    }
    out.push('}');
    out
}

fn push_strings(out: &mut String, values: &[String]) {
    for (i, value) in values.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&string(value));
    }
}

fn string(value: &str) -> String {
    serde_json::to_string(value).expect("字符串必然可序列化")
}
