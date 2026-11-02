//! 文件类别判定:哪些文件在对比弹窗里能「看图」而不是「看字」。
//! 对应 Node 侧 `src/file-kind.ts`。
//!
//! 两条信息必须由同一处给出,否则会出现「本机说能预览、对端却拒绝回传」
//! 这类只在特定大小下暴露的不一致:
//!  - `image_mime_of` —— 后缀 → MIME(同时就是「是不是可预览图片」的判据);
//!  - `compare_content_limit` —— 该文件走哪个体积上限。

/// 文本对比通道的体积上限。
pub const TEXT_COMPARE_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// 图片预览通道的体积上限(两侧 base64 后 ×4/3,再一起进一份 JSON)。
pub const IMAGE_PREVIEW_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// 可预览图片的后缀 → MIME。
///
/// 只收**浏览器能直接解码**的格式:`.tiff`(Chromium 不支持)这类即便后缀看着是
/// 图片也故意不在表里 —— 放进去只会得到一个坏图标的 `<img>`。
/// `.svg` 在表里:它既是图片又是可读文本,前端两种视图都拿得到。
const IMAGE_MIME: [(&str, &str); 9] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
    ("ico", "image/x-icon"),
    ("avif", "image/avif"),
    ("svg", "image/svg+xml"),
];

/// 取路径最后一段的小写后缀(不含点)。
///
/// 隐藏文件(`.env`)、无后缀、以点开头的一律返回空串 —— 与 Node 侧 `extOf` 同规则。
/// 注意只认 `/`:这是**相对路径**的语义(Node 侧同样只切 `/`),不是操作系统路径。
fn ext_of(file_path: &str) -> &str {
    let base = match file_path.rfind('/') {
        Some(idx) => &file_path[idx + 1..],
        None => file_path,
    };
    match base.rfind('.') {
        Some(idx) if idx > 0 => &base[idx + 1..],
        _ => "",
    }
}

/// 可预览图片的 MIME;不是(可预览的)图片返回 `None`。仅按后缀判定,不嗅探内容。
pub fn image_mime_of(file_path: &str) -> Option<&'static str> {
    let ext = ext_of(file_path).to_ascii_lowercase();
    IMAGE_MIME
        .iter()
        .find(|(suffix, _)| *suffix == ext)
        .map(|(_, mime)| *mime)
}

/// 该文件在对比通道里的体积上限:图片走预览上限,其余按文本上限。
pub fn compare_content_limit(file_path: &str) -> u64 {
    if image_mime_of(file_path).is_some() {
        IMAGE_PREVIEW_MAX_BYTES
    } else {
        TEXT_COMPARE_MAX_BYTES
    }
}
