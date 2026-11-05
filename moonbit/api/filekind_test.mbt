///|
// 文件类别判定与文本嗅探的契约测试(api/filekind.mbt,对齐 Node file-kind.ts)。

///|
test "image_mime_of:后缀大小写不敏感,隐藏文件/无后缀不算" {
  assert_eq(@api.image_mime_of("x/a.PNG"), Some("image/png"))
  assert_eq(@api.image_mime_of("a.jpeg"), Some("image/jpeg"))
  assert_eq(@api.image_mime_of("b.svg"), Some("image/svg+xml"))
  assert_eq(@api.image_mime_of("x/.env"), None)
  assert_eq(@api.image_mime_of("noext"), None)
  assert_eq(@api.image_mime_of("movie.tiff"), None)
}

///|
test "compare_content_limit:图片 8MiB,其余 2MiB" {
  assert_eq(@api.compare_content_limit("shot.png"), 8L * 1024L * 1024L)
  assert_eq(@api.compare_content_limit("doc.txt"), 2L * 1024L * 1024L)
}

///|
test "decode_text:空文本/NUL 二进制/非法 UTF-8 三态" {
  assert_eq(@api.decode_text(@utf8.encode("")), Some(""))
  assert_eq(
    @api.decode_text(@utf8.encode("你好\n世界")),
    Some("你好\n世界"),
  )
  // NUL(哪怕在 8KB 之后? 前 8KB 探测窗内)→ 二进制
  let with_nul = @base64.decode("YWJjAGQ=") // "abc\0d"
  assert_true(@api.decode_text(with_nul) is None)
  // 非法 UTF-8 → 二进制(不谎报文本)
  let bad = @base64.decode("//4=") // 0xff 0xfe
  assert_true(@api.decode_text(bad) is None)
}
