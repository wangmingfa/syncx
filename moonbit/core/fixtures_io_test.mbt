///|
// 读盘对拍:直接消费仓库根的共享 golden fixtures
// (rust/crates/syncx-core/fixtures/*.json,由 Node 实现导出,Rust tests/fixtures.rs
// 消费同一批文件)。与各 *_test.mbt 里的内嵌副本对拍互补 —— 内嵌版是快速回归,
// 这里是权威对拍:fixture 一处更新,Node/Rust/MoonBit 三端同时重新对拍。
//
// core 是纯逻辑包,不能有 I/O 依赖;但黑盒测试文件可以通过 moon.pkg 的
// `for "test"` 导入单独引入 fs 读盘。读盘必须真实通过,不许跳过。

///|
/// fixture 文件在仓库中的位置,按测试进程可能的 cwd 逐一尝试:
/// moon test 从模块根(moonbit/)起跑,兜底覆盖包目录与仓库根两种情况。
fn fixture_candidates(name : String) -> Array[String] {
  [
    "../rust/crates/syncx-core/fixtures/\{name}",
    "../../rust/crates/syncx-core/fixtures/\{name}",
    "rust/crates/syncx-core/fixtures/\{name}",
  ]
}

///|
/// 读入 fixture 原文并解析为 JSON。任何一步失败都直接失败 —— 缺文件不是可跳过项。
/// 与 daemon 的测试同款:同步上下文里直接调用 @fs,由 async 层桥接执行。
async fn read_fixture(name : String) -> Json {
  let mut path_hit = ""
  for cand in fixture_candidates(name) {
    if (@fs.exists(cand) catch { _ => false }) {
      path_hit = cand
      break
    }
  }
  if path_hit == "" {
    println(
      "找不到 fixture \{name}:请从仓库根或 moonbit/ 目录运行 moon test",
    )
    panic()
  }
  let text = @fs.read_file(path_hit).text()
  @json.parse(text) catch {
    _ => panic()
  }
}

///|
async test "版本向量对拍 Node(读盘 version.json)" {
  let root = read_fixture("version.json")
  let obj = json_object(root)
  // 比较
  let comparisons = json_array(obj["comparisons"])
  assert_true(comparisons.length() > 0)
  for case in comparisons {
    let c = json_object(case)
    let a = parse_vector(c["a"])
    let b = parse_vector(c["b"])
    let expected = match json_string(c["relation"]) {
      "equal" => @core.VersionRelation::Equal
      "a-newer" => @core.VersionRelation::ANewer
      "b-newer" => @core.VersionRelation::BNewer
      "concurrent" => @core.VersionRelation::Concurrent
      _ => panic()
    }
    assert_true(@core.compare_versions(a, b) == expected)
  }
  // 合并
  for case in json_array(obj["merges"]) {
    let c = json_object(case)
    let merged = @core.merge_versions(
      parse_vector(c["a"]),
      parse_vector(c["b"]),
    )
    assert_true(@core.vectors_equal(merged, parse_vector(c["merged"])))
  }
  // 自增
  for case in json_array(obj["increments"]) {
    let c = json_object(case)
    let input = parse_vector(c["input"])
    let result = @core.increment_version(input, json_string(c["device"]))
    assert_true(@core.vectors_equal(result, parse_vector(c["result"])))
    assert_true(@core.vectors_equal(input, parse_vector(c["input"])))
  }
}

///|
async test "单路径/全量/增量规划对拍 Node(读盘 plan.json)" {
  let root = json_object(read_fixture("plan.json"))
  // 单路径
  for case in json_array(root["pathCases"]) {
    let c = json_object(case)
    let local_entry = match c["local"] {
      Null => None
      v => parse_entry(v)
    }
    let remote_entry = match c["remote"] {
      Null => None
      v => parse_entry(v)
    }
    let actual = @core.plan_path("/x", local_entry, remote_entry)
    match (actual, c["action"]) {
      (None, Null) => ()
      (Some(action), expected) =>
        assert_true(
          action_matches_json(action, expected),
          msg="用例 \{json_string(c["name"])} 的规划动作不一致",
        )
      (None, _) => panic()
    }
  }
  // 全量
  let full = json_object(root["full"])
  let full_actions = @core.build_plan(
    parse_index(full["local"]),
    parse_index(full["remote"]),
  )
  assert_eq(
    actions_as_strings(full_actions),
    expected_actions_as_strings(full["actions"]),
  )
  // 增量
  let delta = json_object(root["delta"])
  let delta_actions = @core.build_delta_plan(
    parse_index(delta["local"]),
    parse_index(delta["remote"]),
  )
  assert_eq(
    actions_as_strings(delta_actions),
    expected_actions_as_strings(delta["actions"]),
  )
}

///|
async test "忽略规则判定对拍 Node(读盘 ignore.json)" {
  let root = json_object(read_fixture("ignore.json"))
  // 按名字预编译规则集
  let sets : Map[String, @core.IgnoreRuleset] = Map([])
  for set in json_array(root["ruleSets"]) {
    let obj = json_object(set)
    let lines : Array[String] = []
    for line in json_array(obj["lines"]) {
      lines.push(json_string(line))
    }
    sets.set(json_string(obj["name"]), @core.IgnoreRuleset::from_lines(lines))
  }
  // 规则判定
  let cases = json_array(root["cases"])
  assert_true(cases.length() > 0)
  for case in cases {
    let c = json_object(case)
    let set_name = json_string(c["set"])
    let rules = match sets.get(set_name) {
      Some(r) => r
      None => panic()
    }
    assert_true(
      rules.is_ignored(json_string(c["path"]), json_bool(c["isDir"])) ==
      json_bool(c["ignored"]),
      msg="规则集 \{set_name} 对 \{json_string(c["path"])} 的判定不一致",
    )
  }
  // 硬忽略
  for case in json_array(root["hardIgnored"]) {
    let c = json_object(case)
    assert_true(
      @core.is_hard_ignored(json_string(c["path"])) == json_bool(c["hard"]),
      msg="路径 \{json_string(c["path"])} 的硬忽略判定不一致",
    )
  }
}

///|
async test "定长块与 CDC 块对拍 Node(读盘 blocks.json)" {
  let root = json_object(read_fixture("blocks.json"))
  let cases = json_array(root["cases"])
  assert_true(cases.length() > 0)
  for case in cases {
    let c = json_object(case)
    let name = json_string(c["name"])
    let seed = json_number(c["seed"]).to_int()
    let size = json_number(c["size"]).to_int()
    let data = prng_bytes(seed.to_uint64(), size)
    assert_eq(data.length(), size, msg="用例 \{name}:PRNG 长度不符")
    // 定长块
    assert_eq(
      ranges_as_pairs(data, @core.split_ranges(size)),
      blocks_as_pairs(json_array(c["fixed"])),
      msg="用例 \{name}:定长块不一致",
    )
    // CDC 块
    assert_eq(
      ranges_as_pairs(data, @core.chunk_ranges(data)),
      blocks_as_pairs(json_array(c["cdc"])),
      msg="用例 \{name}:CDC 块不一致",
    )
  }
}

///|
async test "schedule 对拍(读盘 schedule.json)" {
  let top = fobj(Some(read_fixture("schedule.json")))
  let workdays : Array[String] = []
  for d in farr(top.get("workdays")) {
    workdays.push(fstr(Some(d)))
  }
  // workday 判定:fixture 给定的工作日集合(键格式 YYYY-MM-DD)
  let is_workday : @core.IsWorkday = fn(y, m, d) {
    let key = "\{y}-\{test_two_digits(m)}-\{test_two_digits(d)}"
    let mut hit = false
    for w in workdays {
      if w == key {
        hit = true
        break
      }
    }
    hit
  }
  for case in farr(top.get("cases")) {
    fixture_run_case(case, is_workday)
  }
}

///|
async test "文件类别判定对拍(读盘 file-kind.json)" {
  let root = json_object(read_fixture("file-kind.json"))
  let cases = json_array(root["cases"])
  assert_true(cases.length() > 0)
  for case in cases {
    let c = json_object(case)
    let path = json_string(c["path"])
    // MIME:fixture 里 null 表示不可预览
    match c["mime"] {
      Null =>
        assert_true(
          @core.image_mime_of(path) == None,
          msg="路径 \{path} 不应判定为可预览图片",
        )
      expected =>
        assert_true(
          @core.image_mime_of(path) == Some(json_string(expected)),
          msg="路径 \{path} 的 MIME 不一致",
        )
    }
    // 体积上限:图片走预览上限,其余按文本上限
    assert_eq(
      @core.compare_content_limit(path),
      json_number(c["limit"]).to_int64(),
      msg="路径 \{path} 的对比体积上限不一致",
    )
  }
  // 常量与 Node/Rust 对齐
  assert_eq(@core.TEXT_COMPARE_MAX_BYTES, 2097152L)
  assert_eq(@core.IMAGE_PREVIEW_MAX_BYTES, 8388608L)
}
