//! golden fixture 对拍:每个用例的期望值都来自跑 Node 实现,不是手写。
//!
//! 红了只有两种可能:Rust 写错了,或 Node 侧语义变了。两种都要人看,
//! **不存在"顺手把期望值改成现在的输出"这种处理方式** —— 那等于把对拍变成自拍。

use std::collections::BTreeMap;

use serde::Deserialize;
use syncx_core::blockstore;
use syncx_core::file_kind;
use syncx_core::ignore;
use syncx_core::plan::{self, IndexEntry, PlanAction};
use syncx_core::schedule::{self, CivilMoment, IsWorkday, Schedule};
use syncx_core::version::{self, VersionRelation, VersionVector};

fn fixture(name: &str) -> serde_json::Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/");
    let text = std::fs::read_to_string(format!("{path}{name}")).unwrap_or_else(|e| {
        panic!(
            "读不到 fixture {name}: {e};先跑 `node_modules/.bin/tsx rust/scripts/gen-fixtures.mjs`"
        )
    });
    serde_json::from_str(&text).expect("fixture 应是合法 JSON")
}

/// 版本向量在 fixture 里是 `{device: count}` 对象;转成 BTreeMap。
fn parse_vector(value: &serde_json::Value) -> VersionVector {
    value
        .as_object()
        .expect("版本向量应是对象")
        .iter()
        .map(|(k, v)| (k.clone(), v.as_u64().expect("计数应是整数")))
        .collect()
}

/* ============================ 版本向量 ============================ */

#[test]
fn version_comparisons_match_node() {
    let data = fixture("version.json");
    let cases = data["comparisons"]
        .as_array()
        .expect("comparisons 应是数组");
    assert!(!cases.is_empty(), "fixture 不应为空");

    for case in cases {
        let a = parse_vector(&case["a"]);
        let b = parse_vector(&case["b"]);
        let expected = match case["relation"].as_str().expect("relation 应是字符串") {
            "equal" => VersionRelation::Equal,
            "a-newer" => VersionRelation::ANewer,
            "b-newer" => VersionRelation::BNewer,
            "concurrent" => VersionRelation::Concurrent,
            other => panic!("未知关系 {other}"),
        };
        assert_eq!(
            version::compare_versions(&a, &b),
            expected,
            "a={a:?} b={b:?}"
        );
    }
}

#[test]
fn version_merges_match_node() {
    let data = fixture("version.json");
    for case in data["merges"].as_array().expect("merges 应是数组") {
        let a = parse_vector(&case["a"]);
        let b = parse_vector(&case["b"]);
        let merged = version::merge_versions(&a, &b);
        // 用字符串比较而不是再解析一遍 JSON,避免键序差异造成假失败
        let expected = parse_vector(&case["merged"]);
        assert_eq!(merged, expected);
    }
}

#[test]
fn version_increments_match_node() {
    let data = fixture("version.json");
    for case in data["increments"].as_array().expect("increments 应是数组") {
        let input = parse_vector(&case["input"]);
        let device = case["device"].as_str().expect("device 应是字符串");
        let result = version::increment_version(&input, device);
        assert_eq!(result, parse_vector(&case["result"]));
    }
}

/* ============================ 传输规划 ============================ */

#[derive(Deserialize)]
struct FixtureEntry {
    path: String,
    version: BTreeMap<String, u64>,
    size: u64,
    deleted: bool,
    blocks: Vec<String>,
}

fn parse_entry(value: &serde_json::Value) -> Option<IndexEntry> {
    if value.is_null() {
        return None;
    }
    let raw: FixtureEntry = serde_json::from_value(value.clone()).expect("条目应是合法结构");
    Some(IndexEntry {
        path: raw.path,
        version: raw.version,
        size: raw.size,
        deleted: raw.deleted,
        blocks: raw.blocks,
        cdh: None,
        clens: None,
    })
}

fn action_to_json(action: &PlanAction) -> serde_json::Value {
    serde_json::to_value(action).expect("PlanAction 应可序列化")
}

#[test]
fn plan_path_matches_node() {
    let data = fixture("plan.json");
    let cases = data["pathCases"].as_array().expect("pathCases 应是数组");
    assert!(!cases.is_empty());

    for case in cases {
        let local = parse_entry(&case["local"]);
        let remote = parse_entry(&case["remote"]);
        let actual = plan::plan_path("/x", local.as_ref(), remote.as_ref());
        let expected = &case["action"];

        match (actual, expected.is_null()) {
            (None, true) => {}
            (Some(action), false) => {
                assert_eq!(
                    action_to_json(&action),
                    *expected,
                    "用例 {} 的规划动作不一致",
                    case["name"].as_str().unwrap_or("?")
                );
            }
            (None, false) => panic!("用例 {}:Rust 判无动作,Node 给出动作", case["name"]),
            (Some(action), true) => {
                panic!("用例 {}:Rust 给出 {action:?},Node 判无动作", case["name"])
            }
        }
    }
}

/// 把 fixture 的对象形态索引转回 Map(按路径)。
fn parse_index(value: &serde_json::Value) -> BTreeMap<String, IndexEntry> {
    value
        .as_object()
        .expect("索引应是对象")
        .iter()
        .map(|(k, v)| (k.clone(), parse_entry(v).expect("索引条目不应为 null")))
        .collect()
}

/// 动作按 kind+path 排序后比较:规划顺序不是契约,动作集合才是。
fn normalize_actions(value: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = value
        .as_array()
        .expect("actions 应是数组")
        .iter()
        .map(|a| {
            format!(
                "{}:{}",
                a["kind"].as_str().unwrap_or("?"),
                a["path"].as_str().unwrap_or("?")
            )
        })
        .collect();
    out.sort();
    out
}

fn actions_as_strings(actions: &[PlanAction]) -> Vec<String> {
    let mut out: Vec<String> = actions
        .iter()
        .map(|a| {
            let kind = match a {
                PlanAction::Send { .. } => "send",
                PlanAction::Receive { .. } => "receive",
                PlanAction::Delete { .. } => "delete",
                PlanAction::Conflict { .. } => "conflict",
            };
            format!("{kind}:{}", a.path())
        })
        .collect();
    out.sort();
    out
}

#[test]
fn build_plan_matches_node() {
    let data = fixture("plan.json");
    let full = &data["full"];
    let local = parse_index(&full["local"]);
    let remote = parse_index(&full["remote"]);

    let actions = plan::build_plan(&local, &remote);
    assert_eq!(
        actions_as_strings(&actions),
        normalize_actions(&full["actions"])
    );
}

#[test]
fn build_delta_plan_matches_node() {
    let data = fixture("plan.json");
    let delta = &data["delta"];
    let local = parse_index(&delta["local"]);
    let remote = parse_index(&delta["remote"]);

    let actions = plan::build_delta_plan(&local, &remote);
    assert_eq!(
        actions_as_strings(&actions),
        normalize_actions(&delta["actions"])
    );
}

/// 增量的定义性约束:全量包含「仅本机有」的路径,增量**必须**不包含。
///
/// 这条独立于 fixture 单独断言,因为它是 2026-09-16 那次两端无限互推事故的
/// 直接防线 —— 即使某天 fixture 生成器写错了,这条也必须红。
#[test]
fn delta_plan_never_includes_paths_absent_from_remote_message() {
    let data = fixture("plan.json");
    let full = &data["full"];
    let local = parse_index(&full["local"]);
    let remote = parse_index(&full["remote"]);

    let delta = actions_as_strings(&plan::build_delta_plan(&local, &remote));
    let full_actions = actions_as_strings(&plan::build_plan(&local, &remote));

    assert!(
        full_actions.contains(&"send:/local-only".to_string()),
        "全量规划应回推仅本机有的路径,fixture 或实现有问题"
    );
    assert!(
        !delta.iter().any(|a| a == "send:/local-only"),
        "增量规划不该回推对端消息里没提到的路径 —— 这正是无限互推的成因"
    );
}

/* ============================ 忽略规则 ============================ */

#[test]
fn ignore_rules_match_node() {
    let data = fixture("ignore.json");
    let sets = data["ruleSets"].as_array().expect("ruleSets 应是数组");
    let mut compiled: BTreeMap<String, ignore::IgnoreRuleset> = BTreeMap::new();
    for set in sets {
        let name = set["name"].as_str().expect("name 应是字符串").to_string();
        let lines: Vec<String> = set["lines"]
            .as_array()
            .expect("lines 应是数组")
            .iter()
            .map(|l| l.as_str().expect("规则应是字符串").to_string())
            .collect();
        compiled.insert(name, ignore::IgnoreRuleset::from_lines(&lines));
    }

    let cases = data["cases"].as_array().expect("cases 应是数组");
    assert!(!cases.is_empty());
    let mut checked = 0usize;
    for case in cases {
        let set_name = case["set"].as_str().expect("set 应是字符串");
        let rules = compiled
            .get(set_name)
            .unwrap_or_else(|| panic!("未知规则集 {set_name}"));
        let path = case["path"].as_str().expect("path 应是字符串");
        let is_dir = case["isDir"].as_bool().expect("isDir 应是布尔");
        let expected = case["ignored"].as_bool().expect("ignored 应是布尔");

        assert_eq!(
            rules.is_ignored(path, is_dir),
            expected,
            "规则集 {set_name} 对 {path:?}(isDir={is_dir})的判定不一致"
        );
        checked += 1;
    }
    assert!(checked > 0, "应至少核对一条用例");
}

#[test]
fn hard_ignore_matches_node() {
    let data = fixture("ignore.json");
    for case in data["hardIgnored"]
        .as_array()
        .expect("hardIgnored 应是数组")
    {
        let path = case["path"].as_str().expect("path 应是字符串");
        let expected = case["hard"].as_bool().expect("hard 应是布尔");
        assert_eq!(ignore::is_hard_ignored(path), expected, "路径 {path:?}");
    }
}

/* ============================ 分块与哈希 ============================ */

/// 复刻 Node 侧 `prngBytes`:mulberry32,固定种子,逐字节推进。
///
/// 位运算必须与 JS 完全一致:JS 的 `Math.imul` 是 32 位有符号乘法,`>>>` 是无符号右移。
/// Rust 里用 `wrapping_mul` + `>>`(u32 上就是逻辑右移)对应。
///
/// **`61 | t` 里那个 `| t` 不能省**:写 `61` 是另一个分布,两边就喂不进同一份字节。
/// 它与 `src/blockstore.ts` 的 `GEAR_TABLE` 里那一行必须**逐字符**对应 ——
/// 这张表决定了 CDC 边界,Gear 表换一个字节就等于换协议。
fn prng_bytes(seed: u32, length: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(length);
    let mut a = seed;
    for _ in 0..length {
        a = a.wrapping_add(0x6d2b_79f5);
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        out.push(((t ^ (t >> 14)) & 0xff) as u8);
    }
    out
}

/// 从 fixture 读 `[{length, sha256}]`。
fn expected_blocks(value: &serde_json::Value) -> Vec<(usize, String)> {
    value
        .as_array()
        .expect("块列表应是数组")
        .iter()
        .map(|b| {
            (
                b["length"].as_u64().expect("length 应是整数") as usize,
                b["sha256"].as_str().expect("sha256 应是字符串").to_string(),
            )
        })
        .collect()
}

#[test]
fn block_hashing_matches_node() {
    let data = fixture("blocks.json");
    let cases = data["cases"].as_array().expect("cases 应是数组");
    assert!(!cases.is_empty());

    for case in cases {
        let name = case["name"].as_str().expect("name 应是字符串");
        let seed = case["seed"].as_u64().expect("seed 应是整数") as u32;
        let size = case["size"].as_u64().expect("size 应是整数") as usize;
        let data_bytes = prng_bytes(seed, size);

        // PRNG 必须先对齐,否则后面比的是两份不同内容,失败信息会误导人
        assert_eq!(data_bytes.len(), size, "用例 {name}:PRNG 长度不符");

        let fixed: Vec<(usize, String)> = blockstore::split_ranges(data_bytes.len())
            .into_iter()
            .map(|(off, len)| (len, blockstore::hash_block(&data_bytes[off..off + len])))
            .collect();
        assert_eq!(
            fixed,
            expected_blocks(&case["fixed"]),
            "用例 {name}:定长块不一致"
        );

        let cdc: Vec<(usize, String)> = blockstore::chunk_ranges(&data_bytes)
            .into_iter()
            .map(|(off, len)| (len, blockstore::hash_block(&data_bytes[off..off + len])))
            .collect();
        assert_eq!(
            cdc,
            expected_blocks(&case["cdc"]),
            "用例 {name}:CDC 块不一致"
        );
    }
}

/// CDC 的定义性约束:块长必须落在 [MIN, MAX] 内(末块可短),且拼接即原文。
///
/// 独立于 fixture 断言:即使 PRNG 哪天两侧跑偏,长度约束也必须成立。
#[test]
fn cdc_chunk_lengths_respect_bounds() {
    let data = prng_bytes(42, 8 * 1024 * 1024);
    let ranges = blockstore::chunk_ranges(&data);
    assert!(!ranges.is_empty());

    let mut total = 0usize;
    let last = ranges.len() - 1;
    for (idx, (off, len)) in ranges.iter().enumerate() {
        assert_eq!(*off, total, "块起始偏移必须连续(拼接即原文)");
        total += len;
        if idx != last {
            assert!(
                *len >= blockstore::CDC_MIN_CHUNK && *len <= blockstore::CDC_MAX_CHUNK,
                "第 {idx} 块长度 {len} 越界"
            );
        }
        assert!(*len > 0, "不应产生空块");
    }
    assert_eq!(total, data.len(), "块总长必须等于原文长度");
}

/* ============================ 文件类别 ============================ */

#[test]
fn file_kind_matches_node() {
    let data = fixture("file-kind.json");
    for case in data["cases"].as_array().expect("cases 应是数组") {
        let path = case["path"].as_str().expect("path 应是字符串");
        let expected_mime = case["mime"].as_str();
        assert_eq!(
            file_kind::image_mime_of(path),
            expected_mime,
            "路径 {path:?} 的 MIME"
        );
        let expected_limit = case["limit"].as_u64().expect("limit 应是整数");
        assert_eq!(
            file_kind::compare_content_limit(path),
            expected_limit,
            "路径 {path:?} 的体积上限"
        );
    }
}

/* ============================ 同步时段 ============================ */

fn parse_schedule(value: &serde_json::Value) -> Option<Schedule> {
    if value.is_null() {
        return None;
    }
    serde_json::from_value(value.clone()).ok()
}

#[test]
fn schedule_normalization_matches_node() {
    let data = fixture("schedule.json");
    let workdays: Vec<String> = data["workdays"]
        .as_array()
        .expect("workdays 应是数组")
        .iter()
        .map(|d| d.as_str().expect("workday 应是字符串").to_string())
        .collect();

    let is_workday: Box<IsWorkday> = Box::new(move |y: i32, m: u32, d: u32| {
        let key = format!("{y:04}-{m:02}-{d:02}");
        workdays.iter().any(|w| w == &key)
    });

    for case in data["cases"].as_array().expect("cases 应是数组") {
        let name = case["name"].as_str().expect("name 应是字符串");
        let raw = &case["raw"];
        let actual = schedule::normalize_schedule(raw);
        let expected = parse_schedule(&case["normalized"]);
        assert_eq!(actual, expected, "用例 {name}:归一化结果不一致");

        assert_eq!(
            schedule::schedule_is_unbounded(actual.as_ref()),
            case["unbounded"].as_bool().expect("unbounded 应是布尔"),
            "用例 {name}:是否有约束的判定不一致"
        );

        assert_eq!(
            schedule::format_schedule_summary(actual.as_ref()),
            case["summary"].as_str().expect("summary 应是字符串"),
            "用例 {name}:摘要文案不一致"
        );

        for eval in case["evaluations"]
            .as_array()
            .expect("evaluations 应是数组")
        {
            let moment = CivilMoment::new(
                eval["year"].as_i64().expect("year") as i32,
                eval["month"].as_u64().expect("month") as u32,
                eval["day"].as_u64().expect("day") as u32,
                eval["minutes"].as_u64().expect("minutes") as u32,
            );
            // 星期几必须两侧同口径 —— 这是唯一会静默错位的字段(差一天不报错)
            assert_eq!(
                moment.day_of_week(),
                eval["dow"].as_u64().expect("dow") as u32,
                "用例 {name}:{moment:?} 的星期几不一致"
            );
            assert_eq!(
                schedule::within_schedule(actual.as_ref(), &moment, is_workday.as_ref()),
                eval["allowed"].as_bool().expect("allowed 应是布尔"),
                "用例 {name}:{moment:?} 的允许判定不一致"
            );
        }

        for change in case["nextChanges"]
            .as_array()
            .expect("nextChanges 应是数组")
        {
            let from = &change["from"];
            let now = CivilMoment::new(
                from["year"].as_i64().expect("year") as i32,
                from["month"].as_u64().expect("month") as u32,
                from["day"].as_u64().expect("day") as u32,
                from["minutes"].as_u64().expect("minutes") as u32,
            );
            let actual_next =
                schedule::next_schedule_change(actual.as_ref(), &now, is_workday.as_ref());
            if change["next"].is_null() {
                assert_eq!(actual_next, None, "用例 {name}:{now:?} 之后应无翻转点");
            } else {
                let n = &change["next"];
                let expected_next = CivilMoment::new(
                    n["year"].as_i64().expect("year") as i32,
                    n["month"].as_u64().expect("month") as u32,
                    n["day"].as_u64().expect("day") as u32,
                    n["minutes"].as_u64().expect("minutes") as u32,
                );
                assert_eq!(
                    actual_next,
                    Some(expected_next),
                    "用例 {name}:{now:?} 之后的下一个翻转点不一致"
                );
            }
        }
    }
}

/* ============================ 跨语言常量 ============================ */

/// `FORMAT_VERSION` 必须与 Node 侧一致 —— 两端共用同一数据目录,
/// 代数不同就意味着结构不同,而那一端的闸门会直接拒绝启动。
#[test]
fn format_version_matches_node() {
    let config_ts = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../src/config.ts");
    let text = std::fs::read_to_string(config_ts).expect("应能读到 Node 侧 config.ts");

    let needle = "export const FORMAT_VERSION = ";
    let idx = text
        .find(needle)
        .unwrap_or_else(|| panic!("{config_ts} 里找不到 {needle}"));
    let rest = &text[idx + needle.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let node_version: u64 = digits
        .parse()
        .unwrap_or_else(|_| panic!("FORMAT_VERSION 后面应是整数,实际是 {digits:?}"));

    assert_eq!(
        syncx_core::FORMAT_VERSION,
        node_version,
        "Rust 与 Node 的 FORMAT_VERSION 不一致:两端共用同一数据目录,代数必须同步 bump"
    );
}
