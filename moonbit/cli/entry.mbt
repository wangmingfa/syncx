///|
/// `start` 命令的启动编排(对应 Node `src/cli.ts` 的 daemon 装配段与
/// Rust `syncx-cli/src/control/assembly.rs`,按 ADR-0026 做了裁剪)。
///
/// 步骤(顺序有语义,勿随意调换):
///   1. 解析配置路径(`--config` 优先于 `--config-dir`),确保数据目录存在;
///   2. 读 config.json,过 formatVersion 闸门(**必须**在打开任何
///      index-*.db、写任何数据文件之前,见 docs/adr/0025);
///   3. 首次运行写出默认配置(供后续热重载/另一后端读取);
///   4. 加载/生成设备身份(device.key)与控制令牌(control.token);
///   5. 起 actor(索引/扫描/执行)、PeerServer(数据面)、控制 API、mDNS 广播;
///   6. 常驻运行。信号退出尚未接线(TODO:moonbitlang/async/signal)。

///|
/// 进程退出(致命错误的统一出口;参数错误/闸门失败必须非零退出)。
extern "C" fn c_exit(code : Int32) -> Unit = "syncx_exit"

///|
/// 系统熵源随机字节(control.token 生成;失败返回 0 长度)。
extern "C" fn c_random_bytes(len : Int32) -> Bytes = "syncx_cli_random_bytes"

///|
/// 命令分发结果(main 按 argv 折算成它再分派)。
pub(all) enum CliMode {
  /// 自更新看门狗:作业文件路径(缺省空串)。必须先于一切初始化。
  UpdateSwap(String)
  /// 常驻运行。
  Start(StartArgs)
  /// 无参数:打印版本(与 Node 的「缺省 = start」不同,任务书指定缺省
  /// 打印版本;显式 `start` 才进 daemon)。
  Version
}

///|
/// 按原始 argv 折算分发模式。`argv` 不含程序名。
pub fn pick_mode(argv : Array[String]) -> Result[CliMode, String] {
  // 看门狗模式:不出现在帮助文本里,只在自更新时由旧二进制拉起,
  // 跑完即退,与日志/配置/身份都无关(对齐 Rust main.rs 的分发次序)。
  if argv.length() > 0 && argv[0] == "--update-swap" {
    return Ok(UpdateSwap(if argv.length() > 1 { argv[1] } else { "" }))
  }
  if argv.length() == 0 {
    return Ok(Version)
  }
  let command = argv[0]
  if command == "start" {
    return parse_start_args(argv[1:].to_owned()).map(args => Start(args))
  }
  if known_commands.contains(command) {
    return Err(
      "命令 \{command} 尚未在 MoonBit 后端实现(当前仅支持 start)",
    )
  }
  // Node 同款:第一个位置参数就是命令,不认识直接报错
  Err("unknown command: \{command}")
}

///|
/// `start` 主流程。致命错误打印 `[fatal]` 后以退出码 1 结束;
/// 正常路径常驻,不返回。
pub async fn run_start(args : StartArgs) -> Unit {
  // 1. 配置路径与数据目录(身份/令牌/索引等数据一律放配置文件所在目录)
  let config_file = resolve_config_path(args)
  let config_dir = parent_dir_of(config_file)
  @fs.mkdir(config_dir, recursive=true, allow_exist=true) catch {
    e => fatal("数据目录 \{config_dir} 创建失败:\{e}")
  }

  // 2. 读配置 + formatVersion 闸门(先于任何数据文件读写/创建)
  let config = load_config_file(config_file)
  @core.assert_format_version(config.format_version) catch {
    e => fatal(@core.FormatVersionError::to_text(e))
  }

  // 3. 首次运行写出默认配置(热重载与另一后端依赖文件存在;
  //    注意在闸门之后:闸门失败绝不落任何东西)
  if !(@fs.exists(config_file) catch { _ => false }) {
    save_config_atomic(config_file, config) catch {
      e => fatal(CliError::to_text(e))
    }
  }

  // 4. 设备身份与控制令牌
  let identity = load_or_create_identity(config_dir) catch {
    e => fatal(CliError::to_text(e))
  }
  let token = load_or_create_token(config_dir) catch {
    e => fatal(CliError::to_text(e))
  }

  // 5. 端口与 dev 态判定
  let control_host = args.host.unwrap_or("127.0.0.1")
  let control_port = args.control_port.unwrap_or(DEFAULT_CONTROL_PORT)
  let peer_port = args.port.unwrap_or(DEFAULT_PEER_PORT)
  let web_dist = @env.get_env_var("SYNCX_WEB_DIST")
  let dist_missing = match web_dist {
    Some(dist) => !(@fs.exists(dist) catch { _ => true })
    None => true
  }
  let dev = is_dev_mode(args, dist_missing)
  if dev {
    // 降级说明:api 包尚未支持 vite 代理(--dev-vite)与 dist 缺省占位页,
    // 行为与 Node 的「无 dist」分支一致(占位页),vite HMR 不生效。
    println(
      "[warn] dev 态(--dev-vite 或 dist/web 缺失):MoonBit 后端暂不支持 vite 代理,以静态资源/占位页降级运行",
    )
  }
  if args.log_file is Some(_) {
    // TODO(cli):接 --log-file 持久化日志(当前仅 stdout,与 Node 的 logger 不同)
    println("[warn] --log-file 尚未实现,日志仅输出到标准输出")
  }

  // 6. 装配:actor → PeerServer → API → mDNS → 常驻
  let specs = build_folder_specs(config_dir, config)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, identity.device_id, specs) catch {
      e => fatal("索引库打开失败:\{@daemon.IndexStoreError::to_text(e)}")
    }
    // 数据面:Secure 两阶段握手;server 引用由 handlers 的闭包在注册后补挂
    let mut server_ref : @net.PeerServer? = None
    let session_sinks : Map[String, Map[String, @async.Queue[@daemon.Outbound]]] = Map([],
    )
    let handlers : @net.PeerServerHandlers = {
      on_connect: device => {
        // 该设备被指派的每个目录各挂一条会话 + 一个出站泵
        match server_ref {
          Some(server) => {
            let per_device : Map[String, @async.Queue[@daemon.Outbound]] = Map([])
            session_sinks.set(device, per_device)
            for folder in config.shared_folders {
              if !folder.devices.contains(device) {
                continue
              }
              let folder_id = folder.folder_id()
              let sink : @async.Queue[@daemon.Outbound] = @async.Queue(
                kind=Unbounded,
              )
              per_device.set(folder_id, sink)
              let _ = handle.send(
                @daemon.Cmd::PeerOpen(
                  folder=folder_id,
                  remote_device_id=device,
                  sink~,
                ),
              )
              // 出站泵:Outbound 帧 → wire 消息(对齐 actor_test 的驱动层口径)
              group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
                let mut running = true
                while running {
                  let frame : @daemon.Outbound? = Some(sink.get()) catch {
                    _ => None
                  }
                  match frame {
                    Some(f) =>
                      server.send_message(
                        device,
                        outbound_to_wire(folder_id, f),
                      ) catch {
                        _ => running = false
                      }
                    None => running = false
                  }
                }
              }
            }
          }
          None => ()
        }
        ()
      },
      on_message: (device, message) => {
        // wire 消息按 folder 路由进 actor;Control(配对/hello)是另一里程碑
        match message_folder(message) {
          Some(folder) => {
            let _ = handle.send(
              @daemon.Cmd::PeerMessage(
                folder~,
                remote_device_id=device,
                message~,
              ),
            )
            // 索引到达后补一条 ApplyPlan(驱动层职责,同 actor_test)
            if message is Index(..) {
              let _ = handle.send(@daemon.Cmd::ApplyPlan(folder))
            }
          }
          None => ()
        }
      },
      on_binary: (_device, _data) => (), // 二进制信封:后续里程碑
      on_disconnect: device => {
        // 先关出站队列叫停泵,再摘会话
        match session_sinks.get(device) {
          Some(per_device) => {
            for pair in per_device {
              pair.1.close(clear=true)
              let _ = handle.send(
                @daemon.Cmd::PeerClose(folder=pair.0, remote_device_id=device),
              )
            }
            session_sinks.remove(device)
          }
          None => ()
        }
      },
      on_error: reason => println("[peer] \{reason}"),
    }
    let peer_server = @net.start_peer_server(
      @net.PeerHandshakeMode::Secure(identity),
      handlers,
      options=@net.PeerServerOptions::new(bind_host="0.0.0.0", port=peer_port),
    ) catch {
      e => fatal("peer 服务启动失败:\{@net.PeerError::to_text(e)}")
    }
    server_ref = Some(peer_server)
    group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
      peer_server.listen()
    }
    // mDNS 广播:组播环境不可用(沙箱/无网)只警告,不阻塞启动
    let discovery : @net.Discovery? = Some(
      @net.advertise(peer_port, identity.device_id),
    ) catch {
      e => {
        println(
          "[warn] mDNS 广播不可用:\{@net.DiscoveryError::to_text(e)}",
        )
        None
      }
    }
    match discovery {
      Some(discovery) =>
        group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
          for ;; {
            @async.sleep(2000)
            // TODO(cli):发现对端后建立出站连接(当前只记日志)
            discovery.browse(peer => {
              println(
                "[mdns] 发现对端 \{peer.device_id}(\{peer.address}:\{peer.port})",
              )
              ()
            })
          }
        }
      None => ()
    }
    // 文件系统监听驱动的扫描 + 定时兜底全扫(daemon::start_fs_watch,三端
    // 统一契约):每个未暂停目录一条 @fs.Watcher,事件只当触发器,判定仍走
    // 现有扫描管线;watcher 正常时按 fsWatchFallbackScanSecs(缺省 600s)兜底
    // 全扫,创建失败退回原扫描间隔(30s)并 warn 一次;fsWatchEnabled=false
    // 时为纯定时全扫(行为与旧版完全一致)。
    let watch_folders : Array[@daemon.FsWatchFolder] = []
    for folder in config.shared_folders {
      watch_folders.push({
        id: folder.folder_id(),
        root: folder.path,
        paused: folder.is_paused(),
      })
    }
    let _watch_stats = @daemon.start_fs_watch(
      group,
      handle,
      watch_folders,
      @daemon.FsWatchOptions::from_config(config),
    )
    // 启动横幅(控制端口绑定成功与否在 mocket 内部,绑定失败由 mocket 打印)
    println("syncx \{@core.VERSION} (moonbit backend) started")
    println("device: \{identity.device_id}")
    println("config dir: \{config_dir}")
    println("control UI: http://\{control_host}:\{control_port}")
    println("peer port: \{peer_port}")
    // 控制 API 常驻(serve 内部 listen 常驻,不返回)
    // 上传换入回调:识别/换入逻辑在 cli/upload.mbt(依赖方向 cli → api,
    // 回调在这里注入;api 包只见类型不见实现)
    let upload_inspect_fn : @api.UploadInspectFn = bytes => {
      inspect_uploaded_package(bytes)
    }
    let upload_swap_fn : @api.UploadSwapFn = bytes => {
      perform_upload_swap(bytes, config_dir)
    }
    let api_options = @api.ApiOptions::new(
      device_id=identity.device_id,
      control_token=token,
      config_file=Some(config_file),
      actor=Some(handle),
      // 全局设置快照(/api/status.settings;设置弹窗读取。MoonBit 尚无配置
      // 热重载,当前值为启动时折算 —— 与 actor 目录参数同一份 config)
      settings=Some(@api.settings_json(config)),
      // peer 数据面监听端口(/api/status.peerPort;启动参数折算,缺省 22000)
      peer_port=Some(peer_port),
      web_dist~,
      on_shutdown=Some(() => {
        // TODO(cli):优雅关闭(关 peer 连接、收尾索引);当前直接退出
        println("shutdown requested, exiting")
        let _ = handle.send(@daemon.Cmd::Shutdown)
        c_exit(0)
      }),
      dev_mode=dev,
      upload_inspect=Some(upload_inspect_fn),
      upload_swap=Some(upload_swap_fn),
    )
    @api.serve(api_options, "\{control_host}:\{control_port}")
  }
}

///|
/// 致命错误:打印后以退出码 1 结束进程(never returns)。
fn[T] fatal(message : String) -> T {
  eprintln("[fatal] \{message}")
  c_exit(1)
  // 不可达,仅为让调用点出现在值位置(catch 臂)
  panic()
}

///|
/// 读/建 `<configDir>/device.key`。文件形态与 Node/Rust 逐字一致
/// (`deviceId` / `publicKey` / `privateKey`),否则同一台机器换个后端
/// 就是另一台设备,既有配对全部失效。
async fn load_or_create_identity(
  config_dir : String,
) -> @net.DeviceIdentity raise CliError {
  let path = "\{config_dir}/device.key"
  if (@fs.exists(path) catch { _ => false }) {
    let raw = @fs.read_file(path) catch {
      e => raise CliError::Fatal("身份文件读取失败(\{path}):\{e}")
    }
    let value = @json.parse(raw.text()) catch {
      _ => raise CliError::Fatal("device.key 已损坏: \{path}")
    }
    return @net.DeviceIdentity::from_json(value) catch {
      e =>
        raise CliError::Fatal(
          "device.key 已损坏: \{@net.IdentityError::to_text(e)}",
        )
    }
  }
  let identity = @net.DeviceIdentity::generate() catch {
    e =>
      raise CliError::Fatal(
        "身份密钥生成失败:\{@net.IdentityError::to_text(e)}",
      )
  }
  @fs.write_file(path, identity.to_json().stringify() + "\n") catch {
    e => raise CliError::Fatal("身份文件写入失败(\{path}):\{e}")
  }
  @fs.chmod(path, 0o600) catch {
    _ => ()
  }
  println("设备身份已生成:\{identity.device_id}(\{path})")
  identity
}

///|
/// 读/建 `<configDir>/control.token`(0600)。空/纯空白令牌视同缺失
/// 重新生成(空串会让常量时间比较退化成恒等,等于把控制 API 开放出去)。
async fn load_or_create_token(config_dir : String) -> String raise CliError {
  let path = "\{config_dir}/control.token"
  if (@fs.exists(path) catch { _ => false }) {
    let raw = @fs.read_file(path) catch { _ => return regenerate_token(path) }
    let text : String = raw.text() catch { _ => return regenerate_token(path) }
    let token = text.trim().to_owned()
    if token != "" {
      return token
    }
    println("[warn] \{path} 内容为空,已重新生成令牌")
  }
  regenerate_token(path)
}

///|
/// 生成新令牌并落盘(24 字节熵源的 hex,与 Node 同长度)。
async fn regenerate_token(path : String) -> String raise CliError {
  let bytes = c_random_bytes(24)
  if bytes.length() != 24 {
    raise CliError::Fatal("系统熵源不可用,无法生成控制令牌")
  }
  let token = @hex.encode(bytes)
  @fs.write_file(path, token) catch {
    e => raise CliError::Fatal("令牌写入失败(\{path}):\{e}")
  }
  @fs.chmod(path, 0o600) catch {
    _ => ()
  }
  token
}

///|
/// 索引键的 16 位十六进制短哈希:sha1(key) 前 16 字符 —— 与 Node/Rust 的
/// `folderIndexPath` 逐字一致,共用同一数据目录时索引文件必须同名。
fn short_hash(key : String) -> String {
  let digest = @lib.sha1(@utf8.encode(key))
  @hex.encode(digest)[0:16].to_owned()
}

///|
/// 由配置折算 actor 的目录构造参数。索引/回收站/版本目录的命名与
/// Node/Rust 完全一致(`index-<hash>.db` / `trash/<hash>` / `versions/<hash>`)。
fn build_folder_specs(
  config_dir : String,
  config : @core.Config,
) -> Array[@daemon.FolderSpec] {
  let versions_per_path = Some(config.versions_per_path())
  let specs : Array[@daemon.FolderSpec] = []
  for folder in config.shared_folders {
    let hash = short_hash(folder.index_key())
    // TODO(cli):.gitignore / .syncxignore 规则载入(当前空规则集,
    // 硬忽略仍生效);folderIdentity 收养、gitSync、时段窗口也待接。
    specs.push({
      id: folder.folder_id(),
      root: folder.path,
      index_path: "\{config_dir}/index-\{hash}.db",
      trash_dir: "\{config_dir}/trash/\{hash}",
      versions_dir: Some("\{config_dir}/versions/\{hash}"),
      versions_per_path,
      rules: @core.IgnoreRuleset::from_lines([]),
      receive_only: folder.is_receive_only(),
      conflict_policy: conflict_policy_of(folder.conflict_policy),
      paused: folder.is_paused(),
      paused_files: folder.paused_files.unwrap_or([]),
      baseline_pending: true,
      max_bandwidth_kbps: folder.max_bandwidth_kbps,
    })
  }
  specs
}

///|
/// 冲突策略字面量 → 枚举(与 Node 的 'keep-both'/'newest-wins'/'local-wins'
/// 同字面;未知值回 KeepBoth,与「旧配置缺省」同口径)。
fn conflict_policy_of(value : String?) -> @daemon.ConflictPolicy {
  match value {
    Some("newest-wins") => @daemon.ConflictPolicy::NewestWins
    Some("local-wins") => @daemon.ConflictPolicy::LocalWins
    _ => @daemon.ConflictPolicy::KeepBoth
  }
}

///|
/// 取 wire 消息里的 folder 标识(路由进 actor 用);Control 面
/// (hello/配对/邀请)没有 folder,属配对面,后续里程碑接。
fn message_folder(message : @net.WireMessage) -> String? {
  match message {
    Index(folder~, ..) => Some(folder)
    IndexFingerprint(folder~, ..) => Some(folder)
    IndexAck(folder~) => Some(folder)
    IndexRequest(folder~) => Some(folder)
    BlockRequest(folder~, ..) => Some(folder)
    BlockResponse(folder~, ..) => Some(folder)
    Control(..) => None
  }
}

///|
/// Outbound 帧 → wire 消息(启动编排的驱动层编码,与 actor_test 的
/// `actor_outbound_to_wire` 同口径;文本信封与 daemon 侧解码对称)。
fn outbound_to_wire(
  folder : String,
  frame : @daemon.Outbound,
) -> @net.WireMessage {
  match frame {
    Entries(entries~, full~, relayed~) =>
      @net.WireMessage::Index(
        folder~,
        payload=@base64.encode(@utf8.encode(@net.encode_index(entries))),
        full=Some(full),
        relayed=Some(relayed),
      )
    BlockRequest(req) => @net.WireMessage::BlockRequest(folder~, payload=req)
    BlockResponse(resp) =>
      @net.WireMessage::BlockResponse(folder~, payload=resp)
    IndexFingerprint(fp) =>
      @net.WireMessage::IndexFingerprint(folder~, fingerprint=fp)
    IndexAck => @net.WireMessage::IndexAck(folder~)
    IndexRequest => @net.WireMessage::IndexRequest(folder~)
  }
}
