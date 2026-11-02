//! 构建期注入版本号 + 校验前端产物存在。
//!
//! 两件事都故意做成**编译失败**而不是运行期告警:
//!
//! 1. 版本号:从仓库根 `package.json` 读 `version`,注入 `SYNCX_VERSION`。
//!    这是 ADR-0025 第 3 节定下的"单一来源"——npm 与 GitHub Release 永远同号。
//!    读不到就 panic,而不是回落到 Cargo.toml 的 `0.0.0`:那个值一旦漏出去,
//!    发布物会宣称自己是 0.0.0,自更新比较全部失效。
//!
//! 2. 前端产物:`rust-embed` 会把 `dist/web/` 整个编进去。目录缺失时它只会编出
//!    一个没有 client.js 的空壳二进——能启动、能开页面、然后白屏,而且控制台不报错。
//!    Node 侧踩过同一个坑(`src/favicon.ts` 的注释记着),故这里前置成编译错误。

use std::{env, fs, path::Path, path::PathBuf};

fn main() {
    let crate_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    // rust/crates/syncx-cli → 仓库根
    let repo_root = crate_dir
        .ancestors()
        .nth(3)
        .expect("syncx-cli 应位于 <repo>/rust/crates/syncx-cli")
        .to_path_buf();

    inject_version(&repo_root);
    inject_target(&repo_root);
    verify_web_bundle(&repo_root);

    // 产物变化时重跑本脚本,否则改了前端不重新嵌入。
    println!(
        "cargo:rerun-if-changed={}",
        repo_root.join("package.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        repo_root.join("dist/web/client.js").display()
    );
}

/// 从 package.json 抽出 `"version": "x.y.z"` 注入环境变量。
///
/// 不引入 serde_json 只为读一个字段:build-dependency 会连带把 serde 编进构建产物,
/// 而这个脚本只跑一次、只需要一个字符串。
fn inject_version(repo_root: &Path) {
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
}

/// 注入目标三元组,供自更新拼装资产名(ADR-0025 第 3 节:`syncx-v{version}-{target}`)。
///
/// 不直接用 `env!("TARGET")`:那是 Cargo 给**构建脚本**的环境变量,不会带到
/// 被编译的 crate 里;而在 lib/bin 里 `option_env!("TARGET")` 只有交叉编译的
/// `--target` 分支才有值,本机默认构建时为空。这里统一从构建脚本转一道。
fn inject_target(repo_root: &Path) {
    let target = match (env::var("TARGET"), env::var("HOST")) {
        (Ok(target), _) if !target.is_empty() => target,
        (_, Ok(host)) if !host.is_empty() => host,
        _ => panic!(
            "拿不到目标三元组(TARGET/HOST 均为空),无法为 {} 生成自更新资产名",
            repo_root.display()
        ),
    };
    println!("cargo:rustc-env=TARGET_TRIPLE={target}");
}

/// 在 JSON 文本里找**顶层** `"version"`。
///
/// 逐字符扫描并跟踪嵌套深度,而不是正则在全文里找第一个 `"version"`:依赖项里
/// 也有 `"version"` 键(虽则 package.json 的 dependencies 通常只写版本范围),
/// 命中子对象会静默取到错误的号。
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
                // 字符串刚结束、且处在顶层:看它是不是 "version" 这个键
                if depth == 1 && json[..i].ends_with("\"version") {
                    // 跳到冒号后的值
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

/// 校验前端产物存在且非空。
fn verify_web_bundle(repo_root: &Path) {
    let client = repo_root.join("dist/web/client.js");
    match fs::metadata(&client) {
        Ok(meta) if meta.len() > 0 => {}
        Ok(_) => panic!(
            "{} 存在但为空。空 bundle 会让页面白屏且控制台不报错(同 src/favicon.ts 记录的坑)。\
             先执行 `npm run build:web` 再编 Rust。",
            client.display()
        ),
        Err(_) => panic!(
            "缺少前端产物 {}。rust-embed 会把整个 dist/web 编进二进制,\
             缺了它只会得到一个能启动、能开页面、然后白屏的空壳。\n\
             先执行 `npm run build:web` 再编 Rust。",
            client.display()
        ),
    }
}
