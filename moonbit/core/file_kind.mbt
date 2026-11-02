///|
/// 文件类别判定:哪些文件在对比弹窗里能「看图」而不是「看字」。
/// 对应 Node `src/file-kind.ts` 与 Rust `syncx-core/src/file_kind.rs`,
/// 三端共享同一份 golden fixture(rust/crates/syncx-core/fixtures/file-kind.json)。
///
/// 两条信息必须由同一处给出,否则会出现「本机说能预览、对端却拒绝回传」
/// 这类只在特定大小下暴露的不一致:
///  - `image_mime_of` —— 后缀 → MIME(同时就是「是不是可预览图片」的判据);
///  - `compare_content_limit` —— 该文件走哪个体积上限。

///|
/// 文本对比通道的体积上限。
pub const TEXT_COMPARE_MAX_BYTES : Int64 = 2L * 1024L * 1024L

///|
/// 图片预览通道的体积上限(两侧 base64 后 ×4/3,再一起进一份 JSON)。
pub const IMAGE_PREVIEW_MAX_BYTES : Int64 = 8L * 1024L * 1024L

///|
/// 取路径最后一段的小写后缀(不含点)。
///
/// 隐藏文件(`.env`)、无后缀、以点开头的一律返回空串 —— 与 Node/Rust 侧
/// `extOf` 同规则。注意只认 `/`:这是**相对路径**的语义,不是操作系统路径。
fn file_ext(file_path : String) -> String {
  // 最后一段:最后一个 '/' 之后
  let base_start : Int32 = match file_path.rev_find("/") {
    Some(i) => i + 1
    None => 0
  }
  // 后缀点必须落在最后一段内,且不在段首(`.env` 的点在 idx 0,不算后缀)
  match file_path.rev_find(".") {
    Some(dot) =>
      if dot > base_start {
        file_path[dot + 1:].to_owned().to_lower()
      } else {
        ""
      }
    None => ""
  }
}

///|
/// 可预览图片的后缀 → MIME。
///
/// 只收**浏览器能直接解码**的格式:`.tiff`(Chromium 不支持)这类即便后缀看着是
/// 图片也故意不在表里。`.svg` 在表里:它既是图片又是可读文本,前端两种视图都拿得到。
fn image_mime_table() -> Map[String, String] {
  Map([
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
    ("ico", "image/x-icon"),
    ("avif", "image/avif"),
    ("svg", "image/svg+xml"),
  ])
}

///|
/// 可预览图片的 MIME;不是(可预览的)图片返回 `None`。仅按后缀判定,不嗅探内容。
pub fn image_mime_of(file_path : String) -> String? {
  image_mime_table().get(file_ext(file_path))
}

///|
/// 该文件在对比通道里的体积上限:图片走预览上限,其余按文本上限。
pub fn compare_content_limit(file_path : String) -> Int64 {
  match image_mime_of(file_path) {
    Some(_) => IMAGE_PREVIEW_MAX_BYTES
    None => TEXT_COMPARE_MAX_BYTES
  }
}
