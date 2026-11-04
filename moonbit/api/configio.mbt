///|
/// config.json 的最小读写访问。
///
/// ADR-0026:三端共享 `~/.syncx`,本层用 core 的逐字段清洗模型(parse_config
/// 保留未知键,to_json 铺回)做「读 → 改 → 整体回写」,字段名与 Node/Rust
/// 逐字对齐。并发口径:全部写路径都在同一事件循环里串行执行(load → 改 →
/// save 中间的 await 点只有 fs 自身,不存在两条路由交错改同一份的窗口),
/// 不需要额外的互斥锁;写盘走「临时文件 + rename」原子替换,读到半截
/// config.json 的窗口不复存在。目录身份等派生字段的生成仍在后续包
/// (见 add_folder_to_config 的注释)。

///|
/// 默认配置路径:`~/.syncx/config.json`(HOME 缺失时退相对路径,仅测试场景)。
pub fn default_config_path() -> String {
  let home = @env.get_env_var("HOME").unwrap_or("")
  if home == "" {
    ".syncx/config.json"
  } else {
    "\{home}/.syncx/config.json"
  }
}

///|
/// 读取配置。文件不存在/解析失败按全新配置处理(与 Node 首次启动同款)。
pub async fn load_config(config_file : String) -> @core.Config {
  let raw = @fs.read_file(config_file).text() catch {
    _ => return @core.Config::new()
  }
  @core.parse_config(raw)
}

///|
/// 回写配置:盖 `formatVersion` + `generatedBy` 戳(Node 同款,
/// generatedBy = 版本号单源 package.json 的值)。写盘走「临时文件 + rename」
/// 原子替换:rename 在同一文件系统内是原子的,读者要么看到旧全文、要么
/// 看到新全文,不会看到半截 JSON。
pub async fn save_config(config_file : String, config : @core.Config) -> Unit {
  config.format_version = @core.FORMAT_VERSION
  config.generated_by = Some(@core.VERSION)
  let tmp = "\{config_file}.tmp"
  @fs.write_file(
    tmp,
    config.to_json().stringify() + "\n",
    create_mode=CreateOrTruncate,
  )
  @fs.rename(tmp, config_file, replace=true)
}

///|
/// 目录路径规范化占位:去尾部 `/`,空串回 `/`。
fn normalize_root(path : String) -> String {
  if path == "" {
    "/"
  } else if path.length() > 1 && path.has_suffix("/") {
    path[0:path.length() - 1].to_owned()
  } else {
    path
  }
}

///|
/// 添加目录(最小语义,对齐 Node addFolder 的核心行为):
///   - 同路径已存在 → 合并设备列表,`created = false`;
///   - 新路径 → 追加目录条目,`created = true`(目录不存在时自动 mkdir);
///   - 同路径不同 id 是矛盾请求 → 报错(与 Rust mutate::add_folder 同文案)。
///
/// TODO(daemon):instanceId / folderIdentity 等派生字段、禁止嵌套与系统目录
/// 校验,待 daemon 里程碑接 read_folder_identity / resolve_path 后补齐。
pub fn add_folder_to_config(
  config : @core.Config,
  path : String,
  devices : Array[String],
  id : String?,
  receive_only : Bool,
) -> Result[Bool, String] {
  let path = normalize_root(path)
  for folder in config.shared_folders {
    if normalize_root(folder.path) != path {
      continue
    }
    // 同路径、不同 id 是矛盾请求:wire 按 id 路由会错乱
    match id {
      Some(id) =>
        if folder.folder_id() != id {
          return Err(
            "「\{path}」已经是共享目录(目录 ID 为 \{folder.folder_id()}),不能在同一路径上改用另一个目录 ID(\{id})",
          )
        }
      None => ()
    }
    for device in devices {
      if !folder.devices.contains(device) {
        folder.devices.push(device)
      }
    }
    return Ok(false)
  }
  // 无显式 id 时生成随机短 id(与 Node/Rust 的 short_id 同职责)
  let folder_id = match id {
    Some(id) => id
    None => short_id()
  }
  let folder : @core.SharedFolder = {
    path,
    devices,
    id: Some(folder_id),
    max_bandwidth_kbps: None,
    use_gitignore: None,
    remote: None,
    receive_only: if receive_only {
      Some(true)
    } else {
      None
    },
    instance_id: None,
    paused: None,
    schedule: None,
    git_sync: None,
    conflict_policy: None,
    strip_co_authored: None,
    on_demand: None,
    on_demand_dirs: None,
    paused_files: None,
    folder_identity: None,
    marker_checked: None,
    git_last_commit_hash: None,
    git_relay_pending: None,
    git_broadcast_pending: None,
    git_deferred_mirror: None,
    e2e_key: None,
    e2e_untrusted: None,
    extra: Map([]),
  }
  config.shared_folders.push(folder)
  Ok(true)
}
