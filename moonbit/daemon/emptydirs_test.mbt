///|
/// 空目录盘点与清理的行为测试(真实盘面,/tmp 临时目录,黑盒 @daemon 全链路):
/// 扫描侧六条语义 + 删除侧安全不变式。两个函数对「空」的判据同源 —— 物理
/// 文件/软链等非目录条目、嵌套共享根、读不动的目录一律算内容。

///|
/// 建一个本测试专属的临时根目录。
async fn ed_root(tag : String) -> String {
  let root = "/tmp/syncx-mb-daemon-ed-\{tag}-\{@daemon.now_ms()}"
  @fs.mkdir(root, recursive=true, allow_exist=true)
  root
}

///|
/// 在 root 下建 rel 全链目录。
async fn ed_dir(root : String, rel : String) -> Unit {
  @fs.mkdir("\{root}/\{rel}", recursive=true, allow_exist=true)
}

///|
/// 在 root 下写 rel 文件(自动建父目录)。
async fn ed_file(root : String, rel : String, content : String) -> Unit {
  let abs = "\{root}/\{rel}"
  match abs.rev_find("/") {
    Some(i) => @fs.mkdir(abs[0:i].to_owned(), recursive=true, allow_exist=true)
    None => ()
  }
  @fs.write_file(abs, content, create_mode=CreateOrTruncate)
}

///|
async fn ed_exists(path : String) -> Bool {
  @fs.exists(path) catch { _ => false }
}

///|
async test "scan_empty_dirs: 叶子与父链全列,根自身不列,字典序" {
  let root = ed_root("chain")
  ed_dir(root, "a/b/c")
  ed_dir(root, "a/d")
  let scan = @daemon.scan_empty_dirs(root, @core.IgnoreRuleset::from_lines([]), [])
  assert_false(scan.truncated)
  // a、a/b、a/b/c、a/d 全列;a/d 与 a/b 同级但字典序在后
  assert_eq(scan.dirs.length(), 4)
  assert_eq(scan.dirs[0], "a")
  assert_eq(scan.dirs[1], "a/b")
  assert_eq(scan.dirs[2], "a/b/c")
  assert_eq(scan.dirs[3], "a/d")
  // 根自身永不列出:全空的根 → 空列表
  let empty_root = ed_root("root-only")
  let scan2 = @daemon.scan_empty_dirs(
    empty_root,
    @core.IgnoreRuleset::from_lines([]),
    [],
  )
  assert_eq(scan2.dirs.length(), 0)
  assert_false(scan2.truncated)
}

///|
async test "scan_empty_dirs: 文件在子树任一处则整链不列" {
  let root = ed_root("file")
  ed_dir(root, "a/b")
  ed_dir(root, "c/d")
  ed_file(root, "c/d/f.txt", "x")
  let scan = @daemon.scan_empty_dirs(root, @core.IgnoreRuleset::from_lines([]), [])
  // a 与 a/b 全空 → 列;c/d 有文件 → c、c/d 都不列
  assert_eq(scan.dirs.length(), 2)
  assert_true(scan.dirs.contains("a"))
  assert_true(scan.dirs.contains("a/b"))
}

///|
async test "scan_empty_dirs: 忽略目录自身不列,其内文件算父级内容" {
  let rules = @core.IgnoreRuleset::from_lines(["node_modules/"])
  // node_modules 里有文件 → 它的父级(除此之外全空)不可报空(反向对照)
  let root = ed_root("ignore-file")
  ed_dir(root, "proj/node_modules")
  ed_file(root, "proj/node_modules/lib.js", "x")
  let scan = @daemon.scan_empty_dirs(root, rules, [])
  // node_modules 自身不列(不同步的东西不提示清理),proj 也不列(其内有文件)
  assert_eq(scan.dirs.length(), 0)
  // 空的忽略目录同样不列,但不算内容:装着空忽略目录的父级仍可报空
  let root2 = ed_root("ignore-empty")
  ed_dir(root2, "proj/node_modules")
  let scan2 = @daemon.scan_empty_dirs(root2, rules, [])
  assert_eq(scan2.dirs.length(), 1)
  assert_eq(scan2.dirs[0], "proj")
}

///|
async test "scan_empty_dirs: 嵌套共享根是屏障,不进入不列出算内容" {
  let root = ed_root("nested")
  ed_dir(root, "inner/sub")
  ed_dir(root, "outer")
  let scan = @daemon.scan_empty_dirs(
    root,
    @core.IgnoreRuleset::from_lines([]),
    ["\{root}/inner"],
  )
  // inner 是别的共享的地盘:inner 与 inner/sub 都不列;outer 照常列
  assert_eq(scan.dirs.length(), 1)
  assert_eq(scan.dirs[0], "outer")
  // 仅装着嵌套根的父级同样不可报空;根自身永不列 → 空列表
  let root2 = ed_root("nested2")
  ed_dir(root2, "inner")
  let scan2 = @daemon.scan_empty_dirs(
    root2,
    @core.IgnoreRuleset::from_lines([]),
    ["\{root2}/inner"],
  )
  assert_eq(scan2.dirs.length(), 0)
  // 嵌套根是祖先/外层时不算屏障(严格含于本目录之内才屏障)
  let scan3 = @daemon.scan_empty_dirs(
    root,
    @core.IgnoreRuleset::from_lines([]),
    [root, "/somewhere/else"],
  )
  assert_true(scan3.dirs.contains("outer"))
}

///|
async test "scan_empty_dirs: 符号链接算内容,不递归不列出" {
  let root = ed_root("symlink")
  ed_dir(root, "d")
  let outside = ed_root("symlink-target")
  ed_file(outside, "target.txt", "real")
  @fs.symlink(target="\{outside}/target.txt", "\{root}/d/link")
  let scan = @daemon.scan_empty_dirs(root, @core.IgnoreRuleset::from_lines([]), [])
  // 链接不是目录:算内容,d 不列;链接目标也不会被递归进去
  assert_eq(scan.dirs.length(), 0)
}

///|
async test "scan_empty_dirs: 超出上限置 truncated" {
  let root = ed_root("limit")
  ed_dir(root, "a")
  ed_dir(root, "b")
  ed_dir(root, "c")
  let scan = @daemon.scan_empty_dirs(
    root,
    @core.IgnoreRuleset::from_lines([]),
    [],
    limit=2,
  )
  // 收集按遍历序封顶:最多 2 条入选,第三个空目录只贡献 truncated
  assert_eq(scan.dirs.length(), 2)
  assert_true(scan.truncated)
  // 未超上限时不截断
  let scan2 = @daemon.scan_empty_dirs(
    root,
    @core.IgnoreRuleset::from_lines([]),
    [],
    limit=3,
  )
  assert_eq(scan2.dirs.length(), 3)
  assert_false(scan2.truncated)
}

///|
async test "remove_empty_dirs: 父链一次清净、幂等、结果按深先序" {
  let root = ed_root("rm-chain")
  ed_dir(root, "a/b")
  ed_dir(root, "a/c")
  let rules = @core.IgnoreRuleset::from_lines([])
  // 父与子同时勾选:深路径先处理,整条链一次清完
  let results = @daemon.remove_empty_dirs(root, ["a", "a/b", "a/c"], rules, [])
  assert_eq(results.length(), 3)
  for r in results {
    assert_true(r.ok)
  }
  assert_false(ed_exists("\{root}/a"))
  // 重复请求:已不存在 → ok:true 幂等;结果仍按深先序
  let again = @daemon.remove_empty_dirs(root, ["a", "a/b"], rules, [])
  assert_eq(again.length(), 2)
  assert_eq(again[0].path, "a/b")
  assert_true(again[0].ok)
  assert_eq(again[1].path, "a")
  assert_true(again[1].ok)
}

///|
async test "remove_empty_dirs: 列出后塞入文件 → 中止该条且文件仍在" {
  let root = ed_root("stuff")
  ed_dir(root, "keep")
  ed_dir(root, "gone/sub")
  let rules = @core.IgnoreRuleset::from_lines([])
  let scan = @daemon.scan_empty_dirs(root, rules, [])
  assert_true(scan.dirs.contains("keep"))
  // 扫描与删除之间被塞进一个文件:删除前复核发现即中止该条,文件不得被删
  ed_file(root, "keep/new.txt", "surprise")
  let results = @daemon.remove_empty_dirs(root, ["keep", "gone", "gone/sub"], rules, [])
  assert_eq(results.length(), 3)
  for r in results {
    match r.path {
      "keep" => {
        assert_false(r.ok)
        assert_eq(r.reason, Some("目录内现在有文件,跳过"))
      }
      "gone" | "gone/sub" => assert_true(r.ok) // 其余条不受连累,照常删净
      _ => fail("意外路径 \{r.path}")
    }
  }
  // 塞进来的文件与宿主目录都原样保留
  assert_true(ed_exists("\{root}/keep/new.txt"))
  assert_true(ed_exists("\{root}/keep"))
  // gone 链删净
  assert_false(ed_exists("\{root}/gone"))
}

///|
async test "remove_empty_dirs: 越界、绝对路径、根自身一律拒绝" {
  let root = ed_root("unsafe")
  ed_dir(root, "a")
  let rules = @core.IgnoreRuleset::from_lines([])
  // 深度优先 + 同深字典序:"../outside" < "/etc"(同为 2 段),"" < "a"
  let results = @daemon.remove_empty_dirs(root, ["a", "", "/etc", "../outside"], rules, [])
  assert_eq(results.length(), 4)
  assert_eq(results[0].path, "../outside")
  assert_false(results[0].ok)
  assert_eq(results[0].reason, Some("路径越出共享目录"))
  assert_eq(results[1].path, "/etc")
  assert_false(results[1].ok)
  assert_eq(results[1].reason, Some("必须是共享目录内的相对路径"))
  assert_eq(results[2].path, "")
  assert_false(results[2].ok)
  assert_eq(results[2].reason, Some("不能删除共享目录本身"))
  // 正常条不受连累:a 删净
  assert_eq(results[3].path, "a")
  assert_true(results[3].ok)
  assert_false(ed_exists("\{root}/a"))
}

///|
async test "remove_empty_dirs: 忽略命中与嵌套根拒绝,共享根缺失如实报" {
  let root = ed_root("gates")
  ed_dir(root, "node_modules")
  ed_dir(root, "inner")
  let rules = @core.IgnoreRuleset::from_lines(["node_modules/"])
  let results = @daemon.remove_empty_dirs(
    root,
    ["node_modules", "inner"],
    rules,
    ["\{root}/inner"],
  )
  // 同深字典序:inner < node_modules
  assert_eq(results.length(), 2)
  assert_eq(results[0].path, "inner")
  assert_false(results[0].ok)
  assert_eq(results[0].reason, Some("属于其它共享目录,跳过"))
  assert_eq(results[1].path, "node_modules")
  assert_false(results[1].ok)
  assert_eq(
    results[1].reason,
    Some("已不在同步范围内(被忽略规则命中),跳过"),
  )
  assert_true(ed_exists("\{root}/node_modules"))
  // 共享根缺失:逐条如实报失败,绝不假称「已删除」
  let gone = @daemon.remove_empty_dirs(
    "/tmp/syncx-mb-daemon-ed-no-such-root",
    ["a", "b"],
    rules,
    [],
  )
  assert_eq(gone.length(), 2)
  for r in gone {
    assert_false(r.ok)
    assert_eq(r.reason, Some("共享目录不存在或不可读"))
  }
}

///|
async test "remove_empty_dirs: 绝不删文件,连带清掉的只有空目录" {
  let root = ed_root("no-unlink")
  ed_dir(root, "proj/node_modules/deep")
  ed_file(root, "proj/node_modules/deep/lib.js", "binary-ish")
  let rules = @core.IgnoreRuleset::from_lines(["node_modules/"])
  // proj 只装着空壳链 node_modules/deep?不 —— deep 里有文件,proj 不会被列为空;
  // 即便点名 proj,verifyEmpty 复核也会挡下,文件必须原样保留
  let scan = @daemon.scan_empty_dirs(root, rules, [])
  assert_eq(scan.dirs.length(), 0)
  let results = @daemon.remove_empty_dirs(root, ["proj"], rules, [])
  assert_eq(results.length(), 1)
  assert_false(results[0].ok)
  assert_true(ed_exists("\{root}/proj/node_modules/deep/lib.js"))
  // 空忽略目录会被删除父级时连带清掉(只 rmdir,链上全是空目录)
  let root2 = ed_root("no-unlink2")
  ed_dir(root2, "proj/node_modules")
  let results2 = @daemon.remove_empty_dirs(root2, ["proj"], rules, [])
  assert_eq(results2.length(), 1)
  assert_true(results2[0].ok)
  assert_false(ed_exists("\{root2}/proj"))
  assert_false(ed_exists("\{root2}/proj/node_modules"))
}
