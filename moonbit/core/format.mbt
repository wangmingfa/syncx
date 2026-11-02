///|
/// 落盘格式代数(ADR-0025 §2)。三端共享同一数据目录,`formatVersion` 是唯一的
/// 版本契约:高于本端支持上限时必须拒绝启动,绝不降级读取。
pub const FORMAT_VERSION : Int32 = 1

///|
/// 数据目录由更新版本生成。启动路径捕获后打印指引并非零退出。
pub(all) suberror FormatVersionError {
  Found(Int32, Int32)
}

///|
pub fn FormatVersionError::to_text(self : FormatVersionError) -> String {
  match self {
    Found(found, supported) =>
      "数据目录由更新版本生成(formatVersion \{found},本版本最高支持 \{supported})。\n请升级 syncx 后再运行;降级运行会损坏索引数据。"
  }
}

///|
/// 闸门。缺失(本字段引入前的配置)按第 1 代处理 —— 那是合法值,不是脏数据。
pub fn assert_format_version(
  format_version : Int32,
) -> Unit raise FormatVersionError {
  let found = if format_version == 0 { 1 } else { format_version }
  if found > FORMAT_VERSION {
    raise Found(found, FORMAT_VERSION)
  }
}
