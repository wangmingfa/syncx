///|
// 版本向量对拍:期望值全部来自 Node 实现导出的 golden fixture
// (rust/crates/syncx-core/fixtures/version.json),不是手写期望值。
// 红了只有两种可能:MoonBit 写错了,或 Node 侧语义变了,两种都必须人工确认。

const FIXTURE_VERSION_JSON : String = "{\"comparisons\":[{\"a\":{},\"b\":{},\"relation\":\"equal\"},{\"a\":{},\"b\":{\"A\":1},\"relation\":\"b-newer\"},{\"a\":{},\"b\":{\"A\":2},\"relation\":\"b-newer\"},{\"a\":{},\"b\":{\"A\":1,\"B\":1},\"relation\":\"b-newer\"},{\"a\":{},\"b\":{\"A\":2,\"B\":1},\"relation\":\"b-newer\"},{\"a\":{},\"b\":{\"A\":1,\"B\":2},\"relation\":\"b-newer\"},{\"a\":{},\"b\":{\"B\":1},\"relation\":\"b-newer\"},{\"a\":{},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"relation\":\"b-newer\"},{\"a\":{\"A\":1},\"b\":{},\"relation\":\"a-newer\"},{\"a\":{\"A\":1},\"b\":{\"A\":1},\"relation\":\"equal\"},{\"a\":{\"A\":1},\"b\":{\"A\":2},\"relation\":\"b-newer\"},{\"a\":{\"A\":1},\"b\":{\"A\":1,\"B\":1},\"relation\":\"b-newer\"},{\"a\":{\"A\":1},\"b\":{\"A\":2,\"B\":1},\"relation\":\"b-newer\"},{\"a\":{\"A\":1},\"b\":{\"A\":1,\"B\":2},\"relation\":\"b-newer\"},{\"a\":{\"A\":1},\"b\":{\"B\":1},\"relation\":\"concurrent\"},{\"a\":{\"A\":1},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"relation\":\"b-newer\"},{\"a\":{\"A\":2},\"b\":{},\"relation\":\"a-newer\"},{\"a\":{\"A\":2},\"b\":{\"A\":1},\"relation\":\"a-newer\"},{\"a\":{\"A\":2},\"b\":{\"A\":2},\"relation\":\"equal\"},{\"a\":{\"A\":2},\"b\":{\"A\":1,\"B\":1},\"relation\":\"concurrent\"},{\"a\":{\"A\":2},\"b\":{\"A\":2,\"B\":1},\"relation\":\"b-newer\"},{\"a\":{\"A\":2},\"b\":{\"A\":1,\"B\":2},\"relation\":\"concurrent\"},{\"a\":{\"A\":2},\"b\":{\"B\":1},\"relation\":\"concurrent\"},{\"a\":{\"A\":2},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"relation\":\"concurrent\"},{\"a\":{\"A\":1,\"B\":1},\"b\":{},\"relation\":\"a-newer\"},{\"a\":{\"A\":1,\"B\":1},\"b\":{\"A\":1},\"relation\":\"a-newer\"},{\"a\":{\"A\":1,\"B\":1},\"b\":{\"A\":2},\"relation\":\"concurrent\"},{\"a\":{\"A\":1,\"B\":1},\"b\":{\"A\":1,\"B\":1},\"relation\":\"equal\"},{\"a\":{\"A\":1,\"B\":1},\"b\":{\"A\":2,\"B\":1},\"relation\":\"b-newer\"},{\"a\":{\"A\":1,\"B\":1},\"b\":{\"A\":1,\"B\":2},\"relation\":\"b-newer\"},{\"a\":{\"A\":1,\"B\":1},\"b\":{\"B\":1},\"relation\":\"a-newer\"},{\"a\":{\"A\":1,\"B\":1},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"relation\":\"b-newer\"},{\"a\":{\"A\":2,\"B\":1},\"b\":{},\"relation\":\"a-newer\"},{\"a\":{\"A\":2,\"B\":1},\"b\":{\"A\":1},\"relation\":\"a-newer\"},{\"a\":{\"A\":2,\"B\":1},\"b\":{\"A\":2},\"relation\":\"a-newer\"},{\"a\":{\"A\":2,\"B\":1},\"b\":{\"A\":1,\"B\":1},\"relation\":\"a-newer\"},{\"a\":{\"A\":2,\"B\":1},\"b\":{\"A\":2,\"B\":1},\"relation\":\"equal\"},{\"a\":{\"A\":2,\"B\":1},\"b\":{\"A\":1,\"B\":2},\"relation\":\"concurrent\"},{\"a\":{\"A\":2,\"B\":1},\"b\":{\"B\":1},\"relation\":\"a-newer\"},{\"a\":{\"A\":2,\"B\":1},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"relation\":\"concurrent\"},{\"a\":{\"A\":1,\"B\":2},\"b\":{},\"relation\":\"a-newer\"},{\"a\":{\"A\":1,\"B\":2},\"b\":{\"A\":1},\"relation\":\"a-newer\"},{\"a\":{\"A\":1,\"B\":2},\"b\":{\"A\":2},\"relation\":\"concurrent\"},{\"a\":{\"A\":1,\"B\":2},\"b\":{\"A\":1,\"B\":1},\"relation\":\"a-newer\"},{\"a\":{\"A\":1,\"B\":2},\"b\":{\"A\":2,\"B\":1},\"relation\":\"concurrent\"},{\"a\":{\"A\":1,\"B\":2},\"b\":{\"A\":1,\"B\":2},\"relation\":\"equal\"},{\"a\":{\"A\":1,\"B\":2},\"b\":{\"B\":1},\"relation\":\"a-newer\"},{\"a\":{\"A\":1,\"B\":2},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"relation\":\"concurrent\"},{\"a\":{\"B\":1},\"b\":{},\"relation\":\"a-newer\"},{\"a\":{\"B\":1},\"b\":{\"A\":1},\"relation\":\"concurrent\"},{\"a\":{\"B\":1},\"b\":{\"A\":2},\"relation\":\"concurrent\"},{\"a\":{\"B\":1},\"b\":{\"A\":1,\"B\":1},\"relation\":\"b-newer\"},{\"a\":{\"B\":1},\"b\":{\"A\":2,\"B\":1},\"relation\":\"b-newer\"},{\"a\":{\"B\":1},\"b\":{\"A\":1,\"B\":2},\"relation\":\"b-newer\"},{\"a\":{\"B\":1},\"b\":{\"B\":1},\"relation\":\"equal\"},{\"a\":{\"B\":1},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"relation\":\"b-newer\"},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{},\"relation\":\"a-newer\"},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{\"A\":1},\"relation\":\"a-newer\"},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{\"A\":2},\"relation\":\"concurrent\"},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{\"A\":1,\"B\":1},\"relation\":\"a-newer\"},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{\"A\":2,\"B\":1},\"relation\":\"concurrent\"},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{\"A\":1,\"B\":2},\"relation\":\"concurrent\"},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{\"B\":1},\"relation\":\"a-newer\"},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"relation\":\"equal\"}],\"merges\":[{\"a\":{},\"b\":{},\"merged\":{}},{\"a\":{},\"b\":{\"A\":1},\"merged\":{\"A\":1}},{\"a\":{},\"b\":{\"A\":2},\"merged\":{\"A\":2}},{\"a\":{},\"b\":{\"A\":1,\"B\":1},\"merged\":{\"A\":1,\"B\":1}},{\"a\":{},\"b\":{\"A\":2,\"B\":1},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{},\"b\":{\"A\":1,\"B\":2},\"merged\":{\"A\":1,\"B\":2}},{\"a\":{},\"b\":{\"B\":1},\"merged\":{\"B\":1}},{\"a\":{},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"merged\":{\"A\":1,\"B\":1,\"C\":1}},{\"a\":{\"A\":1},\"b\":{},\"merged\":{\"A\":1}},{\"a\":{\"A\":1},\"b\":{\"A\":1},\"merged\":{\"A\":1}},{\"a\":{\"A\":1},\"b\":{\"A\":2},\"merged\":{\"A\":2}},{\"a\":{\"A\":1},\"b\":{\"A\":1,\"B\":1},\"merged\":{\"A\":1,\"B\":1}},{\"a\":{\"A\":1},\"b\":{\"A\":2,\"B\":1},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{\"A\":1},\"b\":{\"A\":1,\"B\":2},\"merged\":{\"A\":1,\"B\":2}},{\"a\":{\"A\":1},\"b\":{\"B\":1},\"merged\":{\"A\":1,\"B\":1}},{\"a\":{\"A\":1},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"merged\":{\"A\":1,\"B\":1,\"C\":1}},{\"a\":{\"A\":2},\"b\":{},\"merged\":{\"A\":2}},{\"a\":{\"A\":2},\"b\":{\"A\":1},\"merged\":{\"A\":2}},{\"a\":{\"A\":2},\"b\":{\"A\":2},\"merged\":{\"A\":2}},{\"a\":{\"A\":2},\"b\":{\"A\":1,\"B\":1},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{\"A\":2},\"b\":{\"A\":2,\"B\":1},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{\"A\":2},\"b\":{\"A\":1,\"B\":2},\"merged\":{\"A\":2,\"B\":2}},{\"a\":{\"A\":2},\"b\":{\"B\":1},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{\"A\":2},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"merged\":{\"A\":2,\"B\":1,\"C\":1}},{\"a\":{\"A\":1,\"B\":1},\"b\":{},\"merged\":{\"A\":1,\"B\":1}},{\"a\":{\"A\":1,\"B\":1},\"b\":{\"A\":1},\"merged\":{\"A\":1,\"B\":1}},{\"a\":{\"A\":1,\"B\":1},\"b\":{\"A\":2},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{\"A\":1,\"B\":1},\"b\":{\"A\":1,\"B\":1},\"merged\":{\"A\":1,\"B\":1}},{\"a\":{\"A\":1,\"B\":1},\"b\":{\"A\":2,\"B\":1},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{\"A\":1,\"B\":1},\"b\":{\"A\":1,\"B\":2},\"merged\":{\"A\":1,\"B\":2}},{\"a\":{\"A\":1,\"B\":1},\"b\":{\"B\":1},\"merged\":{\"A\":1,\"B\":1}},{\"a\":{\"A\":1,\"B\":1},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"merged\":{\"A\":1,\"B\":1,\"C\":1}},{\"a\":{\"A\":2,\"B\":1},\"b\":{},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{\"A\":2,\"B\":1},\"b\":{\"A\":1},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{\"A\":2,\"B\":1},\"b\":{\"A\":2},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{\"A\":2,\"B\":1},\"b\":{\"A\":1,\"B\":1},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{\"A\":2,\"B\":1},\"b\":{\"A\":2,\"B\":1},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{\"A\":2,\"B\":1},\"b\":{\"A\":1,\"B\":2},\"merged\":{\"A\":2,\"B\":2}},{\"a\":{\"A\":2,\"B\":1},\"b\":{\"B\":1},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{\"A\":2,\"B\":1},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"merged\":{\"A\":2,\"B\":1,\"C\":1}},{\"a\":{\"A\":1,\"B\":2},\"b\":{},\"merged\":{\"A\":1,\"B\":2}},{\"a\":{\"A\":1,\"B\":2},\"b\":{\"A\":1},\"merged\":{\"A\":1,\"B\":2}},{\"a\":{\"A\":1,\"B\":2},\"b\":{\"A\":2},\"merged\":{\"A\":2,\"B\":2}},{\"a\":{\"A\":1,\"B\":2},\"b\":{\"A\":1,\"B\":1},\"merged\":{\"A\":1,\"B\":2}},{\"a\":{\"A\":1,\"B\":2},\"b\":{\"A\":2,\"B\":1},\"merged\":{\"A\":2,\"B\":2}},{\"a\":{\"A\":1,\"B\":2},\"b\":{\"A\":1,\"B\":2},\"merged\":{\"A\":1,\"B\":2}},{\"a\":{\"A\":1,\"B\":2},\"b\":{\"B\":1},\"merged\":{\"A\":1,\"B\":2}},{\"a\":{\"A\":1,\"B\":2},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"merged\":{\"A\":1,\"B\":2,\"C\":1}},{\"a\":{\"B\":1},\"b\":{},\"merged\":{\"B\":1}},{\"a\":{\"B\":1},\"b\":{\"A\":1},\"merged\":{\"A\":1,\"B\":1}},{\"a\":{\"B\":1},\"b\":{\"A\":2},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{\"B\":1},\"b\":{\"A\":1,\"B\":1},\"merged\":{\"A\":1,\"B\":1}},{\"a\":{\"B\":1},\"b\":{\"A\":2,\"B\":1},\"merged\":{\"A\":2,\"B\":1}},{\"a\":{\"B\":1},\"b\":{\"A\":1,\"B\":2},\"merged\":{\"A\":1,\"B\":2}},{\"a\":{\"B\":1},\"b\":{\"B\":1},\"merged\":{\"B\":1}},{\"a\":{\"B\":1},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"merged\":{\"A\":1,\"B\":1,\"C\":1}},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{},\"merged\":{\"A\":1,\"B\":1,\"C\":1}},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{\"A\":1},\"merged\":{\"A\":1,\"B\":1,\"C\":1}},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{\"A\":2},\"merged\":{\"A\":2,\"B\":1,\"C\":1}},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{\"A\":1,\"B\":1},\"merged\":{\"A\":1,\"B\":1,\"C\":1}},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{\"A\":2,\"B\":1},\"merged\":{\"A\":2,\"B\":1,\"C\":1}},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{\"A\":1,\"B\":2},\"merged\":{\"A\":1,\"B\":2,\"C\":1}},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{\"B\":1},\"merged\":{\"A\":1,\"B\":1,\"C\":1}},{\"a\":{\"A\":1,\"B\":1,\"C\":1},\"b\":{\"A\":1,\"B\":1,\"C\":1},\"merged\":{\"A\":1,\"B\":1,\"C\":1}}],\"increments\":[{\"input\":{},\"device\":\"NEW\",\"result\":{\"NEW\":1}},{\"input\":{\"A\":1},\"device\":\"NEW\",\"result\":{\"A\":1,\"NEW\":1}},{\"input\":{\"A\":2},\"device\":\"NEW\",\"result\":{\"A\":2,\"NEW\":1}},{\"input\":{\"A\":1,\"B\":1},\"device\":\"NEW\",\"result\":{\"A\":1,\"B\":1,\"NEW\":1}},{\"input\":{\"A\":2,\"B\":1},\"device\":\"NEW\",\"result\":{\"A\":2,\"B\":1,\"NEW\":1}},{\"input\":{\"A\":1,\"B\":2},\"device\":\"NEW\",\"result\":{\"A\":1,\"B\":2,\"NEW\":1}},{\"input\":{\"B\":1},\"device\":\"NEW\",\"result\":{\"B\":1,\"NEW\":1}},{\"input\":{\"A\":1,\"B\":1,\"C\":1},\"device\":\"NEW\",\"result\":{\"A\":1,\"B\":1,\"C\":1,\"NEW\":1}}]}"

///|

///|
/// fixture 里的版本向量是 `{device: count}` 对象。
fn parse_vector(value : Json) -> @core.VersionVector {
  let out : @core.VersionVector = Map([])
  for key, v in json_object(value) {
    out.set(key, json_number(v).to_int64())
  }
  out
}

///|
test "版本向量比较对拍 Node" {
  let root = @json.parse(FIXTURE_VERSION_JSON) catch { _ => panic() }
  let obj = json_object(root)
  let cases = json_array(obj["comparisons"])
  assert_true(cases.length() > 0)
  let mut checked = 0
  for case in cases {
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
    let actual = @core.compare_versions(a, b)
    assert_true(actual == expected)
    checked += 1
  }
  assert_true(checked > 0)
}

///|
test "版本向量合并对拍 Node" {
  let root = @json.parse(FIXTURE_VERSION_JSON) catch { _ => panic() }
  let cases = json_array(json_object(root)["merges"])
  for case in cases {
    let c = json_object(case)
    let a = parse_vector(c["a"])
    let b = parse_vector(c["b"])
    let merged = @core.merge_versions(a, b)
    let expected = parse_vector(c["merged"])
    assert_true(@core.vectors_equal(merged, expected))
  }
}

///|
test "版本向量自增对拍 Node" {
  let root = @json.parse(FIXTURE_VERSION_JSON) catch { _ => panic() }
  let cases = json_array(json_object(root)["increments"])
  for case in cases {
    let c = json_object(case)
    let input = parse_vector(c["input"])
    let device = json_string(c["device"])
    let result = @core.increment_version(input, device)
    let expected = parse_vector(c["result"])
    assert_true(@core.vectors_equal(result, expected))
    // 输入向量不被修改
    assert_true(@core.vectors_equal(input, parse_vector(c["input"])))
  }
}
