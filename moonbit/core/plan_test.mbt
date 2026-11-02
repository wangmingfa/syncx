///|
// 传输规划对拍:期望值全部来自 Node 实现导出的 golden fixture
// (rust/crates/syncx-core/fixtures/plan.json),不是手写期望值。

const FIXTURE_PLAN_JSON : String = "{\"pathCases\":[{\"name\":\"absent-both\",\"local\":null,\"remote\":null,\"action\":null},{\"name\":\"local-only\",\"local\":{\"path\":\"/x\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"remote\":null,\"action\":{\"kind\":\"send\",\"path\":\"/x\",\"entry\":{\"path\":\"/x\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}}},{\"name\":\"remote-only\",\"local\":null,\"remote\":{\"path\":\"/x\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"action\":{\"kind\":\"receive\",\"path\":\"/x\",\"entry\":{\"path\":\"/x\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}}},{\"name\":\"equal\",\"local\":{\"path\":\"/x\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"remote\":{\"path\":\"/x\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"action\":null},{\"name\":\"local-newer\",\"local\":{\"path\":\"/x\",\"version\":{\"A\":2},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"remote\":{\"path\":\"/x\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"action\":{\"kind\":\"send\",\"path\":\"/x\",\"entry\":{\"path\":\"/x\",\"version\":{\"A\":2},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}}},{\"name\":\"remote-newer\",\"local\":{\"path\":\"/x\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"remote\":{\"path\":\"/x\",\"version\":{\"A\":2},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"action\":{\"kind\":\"receive\",\"path\":\"/x\",\"entry\":{\"path\":\"/x\",\"version\":{\"A\":2},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}}},{\"name\":\"conflict\",\"local\":{\"path\":\"/x\",\"version\":{\"A\":1,\"B\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"remote\":{\"path\":\"/x\",\"version\":{\"A\":1,\"C\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"action\":{\"kind\":\"conflict\",\"path\":\"/x\",\"local\":{\"path\":\"/x\",\"version\":{\"A\":1,\"B\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"remote\":{\"path\":\"/x\",\"version\":{\"A\":1,\"C\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}}},{\"name\":\"local-deleted-newer\",\"local\":{\"path\":\"/x\",\"version\":{\"A\":2},\"size\":100,\"deleted\":true,\"blocks\":[\"b1\"]},\"remote\":{\"path\":\"/x\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"action\":{\"kind\":\"delete\",\"path\":\"/x\"}},{\"name\":\"remote-deleted-newer\",\"local\":{\"path\":\"/x\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"remote\":{\"path\":\"/x\",\"version\":{\"A\":2},\"size\":100,\"deleted\":true,\"blocks\":[\"b1\"]},\"action\":{\"kind\":\"delete\",\"path\":\"/x\"}},{\"name\":\"local-deleted-equal\",\"local\":{\"path\":\"/x\",\"version\":{\"A\":1},\"size\":100,\"deleted\":true,\"blocks\":[\"b1\"]},\"remote\":{\"path\":\"/x\",\"version\":{\"A\":1},\"size\":100,\"deleted\":true,\"blocks\":[\"b1\"]},\"action\":null}],\"full\":{\"local\":{\"/conflict\":{\"path\":\"/conflict\",\"version\":{\"A\":1,\"B\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/local-newer\":{\"path\":\"/local-newer\",\"version\":{\"A\":2},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/local-only\":{\"path\":\"/local-only\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/remote-newer\":{\"path\":\"/remote-newer\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/same\":{\"path\":\"/same\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}},\"remote\":{\"/conflict\":{\"path\":\"/conflict\",\"version\":{\"A\":1,\"C\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/local-newer\":{\"path\":\"/local-newer\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/remote-newer\":{\"path\":\"/remote-newer\",\"version\":{\"A\":2},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/remote-only\":{\"path\":\"/remote-only\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/same\":{\"path\":\"/same\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}},\"actions\":[{\"kind\":\"conflict\",\"path\":\"/conflict\",\"local\":{\"path\":\"/conflict\",\"version\":{\"A\":1,\"B\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"remote\":{\"path\":\"/conflict\",\"version\":{\"A\":1,\"C\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}},{\"kind\":\"send\",\"path\":\"/local-newer\",\"entry\":{\"path\":\"/local-newer\",\"version\":{\"A\":2},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}},{\"kind\":\"send\",\"path\":\"/local-only\",\"entry\":{\"path\":\"/local-only\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}},{\"kind\":\"receive\",\"path\":\"/remote-newer\",\"entry\":{\"path\":\"/remote-newer\",\"version\":{\"A\":2},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}},{\"kind\":\"receive\",\"path\":\"/remote-only\",\"entry\":{\"path\":\"/remote-only\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}}]},\"delta\":{\"local\":{\"/conflict\":{\"path\":\"/conflict\",\"version\":{\"A\":1,\"B\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/local-newer\":{\"path\":\"/local-newer\",\"version\":{\"A\":2},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/local-only\":{\"path\":\"/local-only\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/remote-newer\":{\"path\":\"/remote-newer\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/same\":{\"path\":\"/same\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}},\"remote\":{\"/conflict\":{\"path\":\"/conflict\",\"version\":{\"A\":1,\"C\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/local-newer\":{\"path\":\"/local-newer\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/remote-newer\":{\"path\":\"/remote-newer\",\"version\":{\"A\":2},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/remote-only\":{\"path\":\"/remote-only\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"/same\":{\"path\":\"/same\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}},\"actions\":[{\"kind\":\"conflict\",\"path\":\"/conflict\",\"local\":{\"path\":\"/conflict\",\"version\":{\"A\":1,\"B\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]},\"remote\":{\"path\":\"/conflict\",\"version\":{\"A\":1,\"C\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}},{\"kind\":\"send\",\"path\":\"/local-newer\",\"entry\":{\"path\":\"/local-newer\",\"version\":{\"A\":2},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}},{\"kind\":\"receive\",\"path\":\"/remote-newer\",\"entry\":{\"path\":\"/remote-newer\",\"version\":{\"A\":2},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}},{\"kind\":\"receive\",\"path\":\"/remote-only\",\"entry\":{\"path\":\"/remote-only\",\"version\":{\"A\":1},\"size\":100,\"deleted\":false,\"blocks\":[\"b1\"]}}]}}"

///|
/// fixture 条目:fixture 里是 null 表示该侧没有条目。
fn parse_entry(value : Json) -> @core.IndexEntry? {
  match value {
    Null => None
    Object(obj) => {
      let version : @core.VersionVector = Map([])
      for device, count in json_object(obj["version"]) {
        version.set(device, json_number(count).to_int64())
      }
      let blocks : Array[String] = []
      for block in json_array(obj["blocks"]) {
        blocks.push(json_string(block))
      }
      Some({
        path: json_string(obj["path"]),
        version,
        size: json_number(obj["size"]).to_int64(),
        deleted: json_bool(obj["deleted"]),
        blocks,
        cdh: None,
        clens: None,
      })
    }
    _ => panic()
  }
}

///|
fn entry_equals_json(entry : @core.IndexEntry, value : Json) -> Bool {
  let obj = json_object(value)
  if entry.path != json_string(obj["path"]) {
    return false
  }
  if entry.size != json_number(obj["size"]).to_int64() {
    return false
  }
  if entry.deleted != json_bool(obj["deleted"]) {
    return false
  }
  let expected_blocks = json_array(obj["blocks"])
  if entry.blocks.length() != expected_blocks.length() {
    return false
  }
  for i in 0..<expected_blocks.length() {
    if entry.blocks[i] != json_string(expected_blocks[i]) {
      return false
    }
  }
  let expected_version = json_object(obj["version"])
  if entry.version.length() != expected_version.length() {
    return false
  }
  for device, count in expected_version {
    match entry.version.get(device) {
      Some(n) => if n != json_number(count).to_int64() { return false }
      None => return false
    }
  }
  true
}

///|
/// 与 fixture 的动作对象逐字段比对(kind/path/entry/local/remote)。
fn action_matches_json(action : @core.PlanAction, expected : Json) -> Bool {
  let obj = json_object(expected)
  if action.kind() != json_string(obj["kind"]) {
    return false
  }
  if action.path() != json_string(obj["path"]) {
    return false
  }
  match action {
    Send(entry=e, ..) => entry_equals_json(e, obj["entry"])
    Receive(entry=e, ..) => entry_equals_json(e, obj["entry"])
    Delete(..) => true
    Conflict(local_entry=l, remote_entry=r, ..) =>
      entry_equals_json(l, obj["local"]) && entry_equals_json(r, obj["remote"])
  }
}

///|
test "单路径规划对拍 Node" {
  let root = @json.parse(FIXTURE_PLAN_JSON) catch { _ => panic() }
  let cases = json_array(json_object(root)["pathCases"])
  assert_true(cases.length() > 0)
  for case in cases {
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
      // 有动作但 Node 判无动作 / 无动作但 Node 给出动作,都算对拍失败
      (None, _) => panic()
    }
  }
}

///|
/// 把 fixture 的对象形态索引转成按路径索引的 Map。
fn parse_index(value : Json) -> Map[String, @core.IndexEntry] {
  let out : Map[String, @core.IndexEntry] = Map([])
  for path, entry in json_object(value) {
    match parse_entry(entry) {
      Some(e) => out.set(path, e)
      None => panic()
    }
  }
  out
}

///|
/// 动作按 kind+path 排序后比较:规划顺序不是契约,动作集合才是。
fn actions_as_strings(actions : Array[@core.PlanAction]) -> Array[String] {
  let out : Array[String] = []
  for action in actions {
    out.push("\{action.kind()}:\{action.path()}")
  }
  out.sort()
  out
}

///|
fn expected_actions_as_strings(value : Json) -> Array[String] {
  let out : Array[String] = []
  for action in json_array(value) {
    let obj = json_object(action)
    out.push("\{json_string(obj["kind"])}:\{json_string(obj["path"])}")
  }
  out.sort()
  out
}

///|
test "全量规划对拍 Node" {
  let root = @json.parse(FIXTURE_PLAN_JSON) catch { _ => panic() }
  let full = json_object(json_object(root)["full"])
  let local_index = parse_index(full["local"])
  let remote_index = parse_index(full["remote"])
  let actions = @core.build_plan(local_index, remote_index)
  assert_eq(
    actions_as_strings(actions),
    expected_actions_as_strings(full["actions"]),
  )
}

///|
test "增量规划对拍 Node" {
  let root = @json.parse(FIXTURE_PLAN_JSON) catch { _ => panic() }
  let delta = json_object(json_object(root)["delta"])
  let local_index = parse_index(delta["local"])
  let remote_index = parse_index(delta["remote"])
  let actions = @core.build_delta_plan(local_index, remote_index)
  assert_eq(
    actions_as_strings(actions),
    expected_actions_as_strings(delta["actions"]),
  )
}

///|
/// 增量的定义性约束:全量包含「仅本机有」的路径,增量**必须**不包含。
///
/// 这条独立于 fixture 单独断言,因为它是 2026-09-16 那次两端无限互推事故的
/// 直接防线 —— 即使某天 fixture 生成器写错了,这条也必须红。
test "增量规划绝不回推对端消息未提及的路径" {
  let root = @json.parse(FIXTURE_PLAN_JSON) catch { _ => panic() }
  let full = json_object(json_object(root)["full"])
  let local_index = parse_index(full["local"])
  let remote_index = parse_index(full["remote"])
  let full_actions = actions_as_strings(
    @core.build_plan(local_index, remote_index),
  )
  let delta_actions = actions_as_strings(
    @core.build_delta_plan(local_index, remote_index),
  )
  let mut found = false
  for action in full_actions {
    if action == "send:/local-only" {
      found = true
    }
  }
  assert_true(
    found,
    msg="全量规划应回推仅本机有的路径,fixture 或实现有问题",
  )
  for action in delta_actions {
    assert_true(
      action != "send:/local-only",
      msg="增量规划不该回推对端消息里没提到的路径 —— 这正是无限互推的成因",
    )
  }
}

///|
/// CDC 视图判定:等长且非空才算有视图(与 Node rowToEntry/decodeIndex 同口径)。
test "has_cdc_view 只认等长且非空" {
  let entry : @core.IndexEntry = {
    path: "a",
    version: Map([("d", 1L)]),
    size: 1L,
    deleted: false,
    blocks: [],
    cdh: None,
    clens: None,
  }
  assert_true(!entry.has_cdc_view())
  let empty_cdh : @core.IndexEntry = {
    path: "a",
    version: Map([]),
    size: 1L,
    deleted: false,
    blocks: [],
    cdh: Some([]),
    clens: Some([]),
  }
  assert_true(!empty_cdh.has_cdc_view())
  let bad : @core.IndexEntry = {
    path: "a",
    version: Map([]),
    size: 1L,
    deleted: false,
    blocks: [],
    cdh: Some(["h1", "h2"]),
    clens: Some([100L]),
  }
  assert_true(!bad.has_cdc_view())
  let good : @core.IndexEntry = {
    path: "a",
    version: Map([]),
    size: 1L,
    deleted: false,
    blocks: [],
    cdh: Some(["h1", "h2"]),
    clens: Some([100L, 200L]),
  }
  assert_true(good.has_cdc_view())
}
