//! 构建期注入版本号:从仓库根 `package.json` 读 `version`,注入 `SYNCX_VERSION`。
//!
//! 版本号**单一来源**(ADR-0025 第 3 节):npm 与 GitHub Release 永远同号。读不到就 panic
//! 而不是回落到 Cargo.toml 的 `0.0.0` —— 那个值一旦漏出去,发布物会宣称自己是 0.0.0,
//! 自更新比较全部失效,而且是静默失效。
//!
//! 放在 `syncx-core` 而不是 CLI:所有 crate 都要报告版本(配置里的 `generatedBy`、
//! `/api/status`、`--version`),而 build script 的 `rustc-env` 只作用于它自己那个 crate。
//! 注入在最底层,上层用 `syncx_core::version_string()` 取。

use std::{env, fs, path::PathBuf};

fn main() {
    let crate_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    // rust/crates/syncx-core → 仓库根
    let repo_root = crate_dir
        .ancestors()
        .nth(3)
        .expect("syncx-core 应位于 <repo>/rust/crates/syncx-core")
        .to_path_buf();
    let manifest = repo_root.join("package.json");

    let text = fs::read_to_string(&manifest).unwrap_or_else(|e| {
        panic!(
            "读不到 {}: {e}\n版本号必须来自仓库根的 package.json(见 docs/adr/0025 第 3 节)",
            manifest.display()
        )
    });
    let version = extract_version(&text)
        .unwrap_or_else(|| panic!("{} 里找不到顶层 version 字段", manifest.display()));
    println!("cargo:rustc-env=SYNCX_VERSION={version}");
    println!("cargo:rerun-if-changed={}", manifest.display());
}

/// 在 JSON 文本里找**顶层** `"version"`。
///
/// 逐字符扫描并跟踪嵌套深度,而不是正则在全文里找第一个 `"version"`:依赖项里
/// 也有 `"version"` 键,命中子对象会静默取到错误的号。
fn extract_version(json: &str) -> Option<String> {
    let bytes = json.as_bytes();
    let mut depth = 0usize;
    let mut i = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_string = false;
                if depth == 1 && json[..i].ends_with("\"version") {
                    let rest = &json[i + 1..];
                    let colon = rest.find(':')?;
                    let after = rest[colon + 1..].trim_start();
                    if let Some(stripped) = after.strip_prefix('"') {
                        let end = stripped.find('"')?;
                        return Some(stripped[..end].to_string());
                    }
                }
            }
            i += 1;
            continue;
        }
        match c {
            b'"' => in_string = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
        i += 1;
    }
    None
}
