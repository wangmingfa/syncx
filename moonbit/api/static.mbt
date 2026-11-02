///|
/// 静态资源(dist/web)服务:
///   - 优先走 mocket 的 static_assets 中间件(mimetype 按 ext 映射);
///   - `/api` 子树强制跳过:dist 里万一有同名文件也不能遮住 API 路由;
///   - 目录不存在时所有探测落空,fallback 到占位页(见 server.mbt 的 `/` 路由)。
pub fn mount_static(app : @mocket.App, dist : String) -> Unit {
  let provider : DistProvider = DistProvider::new(dist)
  app.static_assets("/", provider)
  // 壳路径回 index.html:前端是路径路由,少放行一棵子树就是那条链接一刷新 404
  app.use_middleware(shell_middleware(dist))
}

///|
/// dist/web 的静态资源 provider:包装 mocket 的文件 provider,加 `/api` 屏蔽。
struct DistProvider {
  inner : @static_file.StaticFileProvider
}

///|
fn DistProvider::new(dist : String) -> DistProvider {
  { inner: @static_file.new(dist, fallthrough=true), }
}

///|
pub impl @mocket.ServeStaticProvider for DistProvider with fn get_meta(
  self,
  id : StringView,
) -> @mocket.StaticAssetMeta? {
  if id.has_prefix("/api") {
    return None
  }
  self.inner.get_meta(id)
}

///|
pub impl @mocket.ServeStaticProvider for DistProvider with fn get_contents(
  self,
  id : StringView,
) -> &Responder {
  self.inner.get_contents(id)
}

///|
pub impl @mocket.ServeStaticProvider for DistProvider with fn get_type(
  self,
  ext : String,
) -> String? {
  self.inner.get_type(ext)
}

///|
pub impl @mocket.ServeStaticProvider for DistProvider with fn get_encodings(
  self,
) -> Map[String, String] {
  self.inner.get_encodings()
}

///|
pub impl @mocket.ServeStaticProvider for DistProvider with fn get_index_names(
  self,
) -> Array[String] {
  self.inner.get_index_names()
}

///|
pub impl @mocket.ServeStaticProvider for DistProvider with fn get_fallthrough(_) -> Bool {
  true
}

///|
pub extend DistProvider with @mocket.ServeStaticProvider::{
  get_fallthrough,
  get_contents,
  get_type,
  get_encodings,
  get_meta,
  get_index_names,
}

///|
/// 回页面壳的全部路径。刻意逐条列出而不是 `starts_with('/')`:
/// 后者会把拼错的 API 路径也变成一张 200 的空页面
/// (与 Rust `routes/auth.rs::is_shell_path` 逐条一致)。
pub fn is_shell_path(path : String) -> Bool {
  match path {
    "/"
    | "/login"
    | "/compare"
    | "/terminal"
    | "/files"
    | "/fleet"
    | "/trash" => true
    _ =>
      path.has_prefix("/compare/") ||
      path.has_prefix("/terminal/") ||
      path.has_prefix("/files/") ||
      path.has_prefix("/fleet/") ||
      path.has_prefix("/trash/")
  }
}

///|
/// 读 dist 里的一个文件为文本;不存在/失败回 None。
async fn read_dist_file(dist : String, rel : String) -> String? {
  let content = @fs.read_file("\{dist}\{rel}").text() catch { _ => return None }
  Some(content)
}

///|
/// 页面壳中间件:壳路径回 index.html(dist 里没有就回占位页)。
/// static_assets 探不到文件时才会走到这里,真实文件永远优先。
fn shell_middleware(dist : String) -> @mocket.Middleware {
  (event, next) => {
    let path = event.req.url
    if event.req.http_method != "GET" || !is_shell_path(path) {
      return next()
    }
    match read_dist_file(dist, "/index.html") {
      Some(html) => @mocket.html(html)
      None => @mocket.html(index_html())
    }
  }
}
