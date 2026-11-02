///|
// 测试共享的 JSON 读取辅助。黑盒测试文件共享同一命名空间,辅助函数只在此声明一次。
// 只读 golden fixture(rust/crates/syncx-core/fixtures/*.json,由 Node 实现导出),
// 不在此手写任何期望值。

///|
fn json_object(v : Json) -> Map[String, Json] {
  match v {
    Object(m) => m
    _ => panic()
  }
}

///|
fn json_array(v : Json) -> Array[Json] {
  match v {
    Array(items) => items
    _ => panic()
  }
}

///|
fn json_string(v : Json) -> String {
  match v {
    String(s) => s
    _ => panic()
  }
}

///|
fn json_number(v : Json) -> Double {
  match v {
    Number(n, ..) => n
    _ => panic()
  }
}

///|
fn json_bool(v : Json) -> Bool {
  match v {
    True => true
    False => false
    _ => panic()
  }
}
