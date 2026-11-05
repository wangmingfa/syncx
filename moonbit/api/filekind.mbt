///|
/// 文件类别判定:对比通道里哪些文件能「看图」、体积上限按类型分档。
/// 对齐 Node `src/file-kind.ts`:文本 2MiB(超过逐行读不动)、图片预览 8MiB
/// (截图/照片动辄好几 MB,2MiB 会把最需要「看一眼差在哪」的文件挡在门外)。
/// 后端各处(本机读取 / git rev 读取)必须用同一份,否则会出现
/// 「一侧说能预览、另一侧却拒绝回传」这类只在特定大小下暴露的不一致。

///|
pub const TEXT_COMPARE_MAX_BYTES : Int64 = 2L * 1024L * 1024L

///|
pub const IMAGE_PREVIEW_MAX_BYTES : Int64 = 8L * 1024L * 1024L

///|
/// 可预览图片的后缀 → MIME。只收**浏览器能直接解码**的格式(.tiff 这类即便
/// 后缀看着是图片也故意不在表里);`.svg` 在表里:既是图片又是可读文本。
/// 仅按后缀判定,不嗅探内容。
pub fn image_mime_of(file_path : String) -> String? {
  match ext_of(file_path) {
    "png" => Some("image/png")
    "jpg" | "jpeg" => Some("image/jpeg")
    "gif" => Some("image/gif")
    "webp" => Some("image/webp")
    "bmp" => Some("image/bmp")
    "ico" => Some("image/x-icon")
    "avif" => Some("image/avif")
    "svg" => Some("image/svg+xml")
    _ => None
  }
}

///|
/// 该文件在对比通道里的体积上限:图片走预览上限,其余按文本上限。
pub fn compare_content_limit(file_path : String) -> Int64 {
  match image_mime_of(file_path) {
    Some(_) => IMAGE_PREVIEW_MAX_BYTES
    None => TEXT_COMPARE_MAX_BYTES
  }
}

///|
/// 取路径最后一段的小写后缀(不含点)。隐藏文件(`.env`)、无后缀、以点
/// 开头的一律返回空串。
fn ext_of(file_path : String) -> String {
  let lower = file_path.to_lower()
  // 取最后一段(手工扫分隔符:不依赖 indexOf 系 API)
  let mut seg_start = 0
  let mut i = 0
  for ch in lower {
    if ch == '/' {
      seg_start = i + 1
    }
    i = i + 1
  }
  let base = lower[seg_start:lower.length()].to_owned()
  // 最后一个 '.' 之后;dot 在首位或无点 = 隐藏文件/无后缀
  let mut dot = -1
  let mut j = 0
  for ch in base {
    if ch == '.' {
      dot = j
    }
    j = j + 1
  }
  if dot <= 0 {
    return ""
  }
  base[dot + 1:base.length()].to_owned()
}

///|
/// 文本嗅探:空内容 = 空文本;前 8KB 含 NUL = 二进制;其余按严格 UTF-8 解码,
/// 解不动 = 二进制(与 Node decodeText 的「解码往返校验」同语义)。
pub fn decode_text(bytes : Bytes) -> String? {
  if bytes.length() == 0 {
    return Some("")
  }
  let probe = if bytes.length() < 8192 { bytes.length() } else { 8192 }
  for i in 0..<probe {
    if bytes[i].to_int() == 0 {
      return None
    }
  }
  Some(@utf8.decode(bytes)) catch {
    _ => None
  }
}

///|
/// 内容侧字段落到状态 map:图片给 base64 预览(与 text 并不互斥,`.svg` 两者
/// 都有),文本给 text,解不动 = binary(对齐 Node describeBytes)。
fn describe_bytes_into(
  map : Map[String, Json],
  rel_path : String,
  bytes : Bytes,
) -> Unit {
  match image_mime_of(rel_path) {
    Some(mime) =>
      if bytes.length() > 0 {
        let im : Map[String, Json] = Map([])
        im.set("mime", Json::string(mime))
        im.set("data", Json::string(@base64.encode(bytes)))
        map.set("image", Json::object(im))
      }
    None => ()
  }
  match decode_text(bytes) {
    Some(text) => map.set("text", Json::string(text))
    None => map.set("binary", Json::boolean(true))
  }
}

///|
/// rev 读取结果(@daemon.HeadRead)→ 对比弹窗单侧状态:缺失、读取失败、
/// 超限、正常(文本/二进制/图片),四态口径对齐 Node sideFromRevRead。
/// 「读取失败」不能谎报缺失 —— 那会把人支去查一个不存在的问题。
pub fn side_from_head_read(read : @daemon.HeadRead, rel_path : String) -> Json {
  let map : Map[String, Json] = Map([])
  match read {
    Absent => map.set("exists", Json::boolean(false))
    Error(err) => {
      map.set("exists", Json::boolean(false))
      map.set("error", Json::string(err))
    }
    Bytes(bytes) => {
      map.set("exists", Json::boolean(true))
      map.set("size", Json::number(bytes.length().to_double()))
      if bytes.length().to_int64() > compare_content_limit(rel_path) {
        // 超过体积上限:不回传内容,只给大小(弹窗降级为整文件覆盖)
        map.set("tooLarge", Json::boolean(true))
      } else {
        describe_bytes_into(map, rel_path, bytes)
      }
    }
  }
  Json::object(map)
}

///|
/// 本机盘上文件的一侧状态(工作区侧):缺失 / 非常规文件 / 超限 / 二进制 /
/// 图片都如实标记,对齐 Node readLocalFileForCompare 的口径;git 对比两侧
/// 不携带 version(版本向量是同步数据面字段)。读失败与缺失分开:糊成一种
/// 会把人支去修一个不存在的问题。
pub async fn side_from_local_disk(root : String, rel_path : String) -> Json {
  let map : Map[String, Json] = Map([])
  map.set("exists", Json::boolean(false))
  let abs = "\{root}/\{rel_path}"
  if !@fs.exists(abs) {
    return Json::object(map)
  }
  let kind = @fs.kind(abs) catch {
    _ => {
      map.set("error", Json::string("读取失败"))
      return Json::object(map)
    }
  }
  if kind != Regular {
    return Json::object(map)
  }
  let size = @fs.file_size(abs) catch {
    _ => {
      map.set("error", Json::string("读取失败"))
      return Json::object(map)
    }
  }
  let bytes = @fs.read_file(abs).binary() catch {
    _ => {
      map.set("error", Json::string("读取失败"))
      return Json::object(map)
    }
  }
  map.set("exists", Json::boolean(true))
  map.set("size", Json::number(size.to_double()))
  if size > compare_content_limit(rel_path) {
    map.set("tooLarge", Json::boolean(true))
  } else {
    describe_bytes_into(map, rel_path, bytes)
  }
  Json::object(map)
}
