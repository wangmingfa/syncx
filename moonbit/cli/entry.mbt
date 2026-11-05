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
/// status 数据面镜像的拉取节拍(ms):后台任务每秒经 Cmd 与 actor 往返一次
/// 拉快照。取 1s:前端状态帧由差异驱动的 ws 推送 + 兜底 tick 消费,1–2s 的
/// 镜像滞后不可感知(任务书给的窗口是 1–2s),而聚合开销随会话空闲趋近于零。
const STATUS_MIRROR_TICK_MS : Int32 = 1000

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
  // 0. 日志装配(先于一切可记日志的步骤):--log-file 传了走文件形态
  //    (对齐 Node:日志进文件、不再刷 stdout),没传走 stdout 形态
  //    (Information+,保持既有行为不回归)
  match args.log_file {
    Some(path) => @log.init_file(path)
    None => @log.init_print()
  }
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
  // 配置热重载的共享单元格:api 写路由成功落盘后,回调重读盘上配置灌进来;
  // 所有「现读」读者(fs-watch 对账 / 拨号监督 / 镜像循环 / 会话面重建 /
  // 出站泵)从这里拿最新值,不再持有启动快照
  let config_cell : Ref[@core.Config] = Ref(config)

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
    @log.warn(
      "dev 态(--dev-vite 或 dist/web 缺失):MoonBit 后端暂不支持 vite 代理,以静态资源/占位页降级运行",
      [],
    )
  }

  // 6. 装配:actor → PeerServer → API → mDNS → 常驻
  let specs = build_folder_specs(config_dir, config)
  @async.with_task_group() <| group => {
    // 本地提交通知的注入点(actor 创建早于镜像循环,先挂占位回调,镜像循环
    // 就绪后换上真投递):actor 检测到新提交 → 这里 → 镜像台账广播
    let git_notify_sink : Ref[async (@net.ControlMessage) -> Unit] = Ref(_ => ())
    let handle = @daemon.start_session_actor(group, identity.device_id, specs, on_git_notify=notify => {
      let emit = git_notify_sink.val
      emit(notify)
    }) catch {
      e => fatal("索引库打开失败:\{@daemon.IndexStoreError::to_text(e)}")
    }
    // 同步时段上下文先行入队(周期泵 60s 巡检之前,横幅首帧就有值)
    let _ = handle.send(schedule_cmd(config))
    // 数据面:Secure 两阶段握手;server 引用由 handlers 的闭包在注册后补挂。
    // 会话注册表:对端元数据(hello 宣告)生命周期跟随会话,/api/status.devices
    // 的在线态从这里拉(device_status provider 在装配段回填)。
    let registry : PeerSessionRegistry = PeerSessionRegistry::new()
    let mut server_ref : @net.PeerServer? = None
    let session_sinks : Map[String, Map[String, @async.Queue[@daemon.Outbound]]] = Map([],
    )
    // 发送闭包登记表 + 客户端连接 closer 表(配置热重载:设备不再共享任何
    // 目录时由会话面对账主动掐线)+ git 镜像循环(通知结算/中继;flush
    // 常驻 ~2s 一拍)。镜像循环每次 flush 现读配置单元格。
    let senders : PeerSenders = PeerSenders::new()
    let closers : Map[String, () -> Unit] = Map([])
    let mirror : GitMirror = GitMirror::new(
      config_of=() => config_cell.val,
      config_file~,
      registry~,
      senders~,
      handle~,
    )
    // 本地提交广播接到镜像台账:在线即发、离线挂账补投、ack 销账
    git_notify_sink.val = notify => mirror.on_local_git_notify(notify)
    group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
      mirror_flush_loop(mirror)
    }
    let handlers : @net.PeerServerHandlers = {
      on_connect: device => {
        match server_ref {
          Some(server) => {
            // 发送闭包登记(镜像中继与会话面重建都按它寻址;断开钩子摘除)
            senders.register(device, msg => {
              server.send_message(device, msg) catch {
                _ => return false
              }
              true
            })
            // 该设备被指派的每个目录各挂一条会话 + 一个出站泵(投递走本条
            // 入站连接;目录清单现读配置单元格 —— 热重载后新连接自动带上新目录)
            spawn_session_pumps(
              group,
              handle,
              config_cell.val,
              device,
              session_sinks,
              msg => senders.send_to(device, msg),
            )
            // 会话登记 + 主动 hello 宣告(版本/平台/主机名;生命周期跟随会话)
            registry.register(device, {
              version: None,
              platform: None,
              hostname: None,
              url: None,
            })
            server.send_message(
              device,
              @net.WireMessage::Control(
                payload=@net.make_hello(
                  identity.device_id,
                  @api.local_hostname(),
                  Some(@api.platform_name()),
                ),
              ),
            ) catch {
              _ => ()
            }
          }
          None => ()
        }
      },
      on_message: (device, message) => {
        // hello 解析进会话注册表;git 提交通知/回执走镜像循环(处理到即回
        // 回执);其余 Control 维持丢弃(TODO:notify 扫描触发 / 中继);
        // 数据面消息按 folder 路由进 actor
        handle_peer_message(
          registry,
          handle,
          identity.device_id,
          Some(mirror),
          device,
          message,
          msg => {
            match server_ref {
              Some(server) =>
                server.send_message(
                  device,
                  @net.WireMessage::Control(payload=msg),
                ) catch {
                  _ => ()
                }
              None => ()
            }
          },
        )
      },
      on_binary: (_device, _data) => (), // 二进制信封:后续里程碑
      on_disconnect: device => {
        // 先关出站队列叫停泵(每目录补发 PeerClose),再摘会话(元数据随之失效)
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
        senders.unregister(device)
        registry.unregister(device)
      },
      on_error: reason => {
        @log.error("peer 连接错误 {Reason}", [Json::string(reason)])
      },
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
    // 出站拨号 + 断线重连:监督循环每拍现读配置单元格的 peers 清单做 diff ——
    // 新增 URL 补起常驻拨号循环(设备登记路由的「立即建连」由这个节拍承担,
    // 配置热重载即插即拔),被移除的 URL 由循环自身在重拨点退出后从名册摘除
    // (地址学习与 mDNS 建连是后续包)
    let dialed : Map[String, Bool] = Map([])
    group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
      for ;; {
        for peer_url in config_cell.val.peers {
          if !dialed.contains(peer_url) {
            dialed.set(peer_url, true)
            let url = peer_url
            group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
              outbound_peer_loop(
                registry,
                identity,
                config_cell,
                handle,
                group,
                session_sinks,
                senders,
                closers,
                mirror,
                url,
                peer_port,
                url2 => config_cell.val.peers.contains(url2),
                () => dialed.remove(url),
              )
            }
          }
        }
        @async.sleep(DIAL_SUPERVISOR_TICK_MS)
      }
    }
    // mDNS 广播:组播环境不可用(沙箱/无网)只警告,不阻塞启动
    let discovery : @net.Discovery? = Some(
      @net.advertise(peer_port, identity.device_id),
    ) catch {
      e => {
        @log.warn("mDNS 广播不可用:{Detail}", [
          Json::string(@net.DiscoveryError::to_text(e)),
        ])
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
    // 统一契约):目录清单以供应者闭包给定,对账循环每拍现读配置单元格 ——
    // 配置热重载后目录增删/暂停切换即插即拔;watcher 正常时按
    // fsWatchFallbackScanSecs(缺省 600s)兜底全扫,创建失败退回原扫描间隔
    // (30s)并 warn 一次;fsWatchEnabled=false 时为纯定时全扫。
    // 事件过滤谓词与扫描同源(对齐 Node 7419b03):忽略范围的事件在触发
    // 重扫之前丢弃。规则集与 build_folder_specs 里喂给 actor 的完全一致
    // (当前同为空规则集 + 硬忽略闸门;那个 TODO 落地时此处必须一并换,
    // 两处共用同一套行来源,绝不允许监听层判据漂移出扫描管线)。
    let watch_event_filter = @daemon.event_ignore_filter(
      @core.IgnoreRuleset::from_lines([]),
    )
    let _watch_stats = @daemon.start_fs_watch(
      group,
      handle,
      () => {
        let folders : Array[@daemon.FsWatchFolder] = []
        for folder in config_cell.val.shared_folders {
          folders.push({
            id: folder.folder_id(),
            root: folder.path,
            paused: folder.is_paused() || config_cell.val.is_paused(),
            filter: Some(watch_event_filter),
          })
        }
        folders
      },
      @daemon.FsWatchOptions::from_config(config),
    )
    // 启动横幅(控制端口绑定成功与否在 mocket 内部,绑定失败由 mocket 打印):
    // 行内容与顺序对齐 Node src/cli.ts 启动段,LAN 地址走 api 包的 C FFI 包装。
    // --log-file 形态下照样进文件(统一走 @log,无需特判)。
    // 绝对路径展示:--config-dir 常传相对值(dev 脚本 ../.syncx-dev),日志里
    // 看绝对路径才好核对;realpath 失败(目录异常)回退原值
    let lan = @api.lan_addresses()
    let banner = build_banner_lines(
      @fs.realpath(config_dir) catch {
        _ => config_dir
      },
      control_host,
      control_port,
      peer_port,
      identity.device_id,
      lan,
      args.dev_vite_url,
      token,
    )
    for line in banner {
      @log.info(line, [])
    }
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
      // 全局设置快照(/api/status.settings;设置弹窗读取):启动时折算,
      // 之后每次配置热重载回调重建 —— 与目录集同一份新鲜配置
      settings=Some(@api.settings_json(config)),
      // peer 数据面监听端口(/api/status.peerPort;启动参数折算,缺省 22000)
      peer_port=Some(peer_port),
      // 设备清单快照(/api/status.devices;设备卡与「已配对设备」徽标数据源),
      // 设备增删路由成功后重建 —— 对应 Node 的内存态 + statusHub.notify
      device_infos=@api.device_infos_json(config),
      web_dist~,
      on_shutdown=Some(() => {
        // TODO(cli):优雅关闭(关 peer 连接、收尾索引);当前直接退出
        @log.info("shutdown requested, exiting", [])
        let _ = handle.send(@daemon.Cmd::Shutdown)
        c_exit(0)
      }),
      dev_mode=dev,
      upload_inspect=Some(upload_inspect_fn),
      upload_swap=Some(upload_swap_fn),
    )
    // 设备清单动态提供器:静态快照 + 会话注册表的合并视图(先构造后回填,
    // 打破闭包对 api_options 的自引用;单线程 async 无锁)
    api_options.device_status = Some(() => {
      merge_device_status(api_options.device_infos, registry)
    })
    // status 数据面镜像(syncProgress / traffic):供块租约、在途接收与流量
    // 账本都只在 actor 任务上,而 status_json 是同步函数 —— 后台任务每
    // STATUS_MIRROR_TICK_MS 经 Cmd 与 actor 往返一次拉快照(带回执,确保此前的
    // 命令都已结算)写进单元格,下面的 provider 读单元格折算。开销:每秒一次
    // 队列往返 + 聚合读(聚合是 actor 既有 publish 产物,只遍历会话内存表,
    // 空闲时近乎零,不额外扫盘)。镜像初值:空数组 / 零值 —— 首帧到达前的
    // 兜底,与「未接 provider」的 api 单测口径一致。
    let progress_cell : Ref[Array[@daemon.SyncProgress]] = Ref([])
    let traffic_cell : Ref[@daemon.TrafficStats] = Ref({
      sent: 0L,
      received: 0L,
      samples: [],
    })
    group.spawn_bg(allow_failure=true, no_wait=true) <| () => {
      for ;; {
        @async.sleep(STATUS_MIRROR_TICK_MS)
        let snap = handle.sync_snapshot()
        progress_cell.val = snap.progress
        traffic_cell.val = snap.traffic
      }
    }
    api_options.sync_progress = Some(() => progress_cell.val)
    api_options.traffic = Some(() => traffic_cell.val)
    // 配置热重载回调:任何写路由成功落盘后触发(Node 的 configWatcher +
    // reload 语义收拢成一个同步入口)。职责面:
    //   1. 重读盘上配置灌进共享单元格 —— 镜像循环 / fs-watch 对账 / 拨号
    //      监督全部现读,随之生效;
    //   2. 通知 actor 按新目录参数集重建目录态(新增开索引首扫、移除拆会话、
    //      保留目录就地更新运行期字段;全局 paused 折算在内);
    //   3. 刷新 status 的 settings/devices 快照;
    //   4. 会话面对账:在线设备的每目录 sinks 重建(新目录接入、移除目录
    //      摘除;重复 PeerOpen 由 actor 的重连顶替语义收敛),不再共享任何
    //      目录的既有连接主动掐线(server/client 两侧;对端自动重连)。
    // 单线程事件循环内同步执行,必须轻:只读配置 + 发命令 + 改内存表,
    // 不做 git / 网络动作。
    api_options.on_config_changed = Some(() => {
      let fresh = load_config_file(config_file)
      config_cell.val = fresh
      let _ = handle.send(
        @daemon.Cmd::Reconfigure(specs=build_folder_specs(config_dir, fresh)),
      )
      // 全局时段规则 / 临时放行不在目录参数集里,单独投递(重启后按同一
      // 到期时刻收住;放行取消即刻收口)
      let _ = handle.send(schedule_cmd(fresh))
      api_options.settings = Some(@api.settings_json(fresh))
      api_options.device_infos = @api.device_infos_json(fresh)
      // git 台账恢复:热重载写入的盘上 pending 记录采纳进内存(与重启同
      // 语义;内存已有的目录以内存为准)
      mirror.adopt_pending()
      for device in registry.devices() {
        close_session_sinks(session_sinks, device)
        spawn_session_pumps(group, handle, fresh, device, session_sinks, msg => {
          senders.send_to(device, msg)
        })
      }
      let shared : Map[String, Bool] = Map([])
      for folder in fresh.shared_folders {
        for d in folder.devices {
          shared.set(d, true)
        }
      }
      let stale : Array[String] = []
      for device in registry.devices() {
        if !shared.contains(device) {
          stale.push(device)
        }
      }
      for device in stale {
        senders.unregister(device)
        registry.unregister(device)
        match server_ref {
          Some(server) => server.close_device(device)
          None => ()
        }
        match closers.get(device) {
          Some(closer) => closer()
          None => ()
        }
      }
    })
    @api.serve(api_options, "\{control_host}:\{control_port}")
  }
}

///|
/// 启动横幅行(纯函数,便于单测):行内容与顺序逐字对齐 Node src/cli.ts
/// 的启动段。LAN 地址与令牌由调用方注入(config dir 先折算成展示形态)。
/// 地址口径(自查 Node 后照抄):
///   - control UI:0.0.0.0 = localhost + 全部 LAN IPv4;--host 指定具体
///     地址时只列该地址(监听 127.0.0.1 时列局域网地址无意义);
///   - peer sync:localhost + LAN **无条件列出**(Node 侧此列表不按 bind
///     host 收闸,照抄其不对称口径)。
/// 令牌仅随 dev mode(--dev-vite)两行打出 —— 生产启动不打明文令牌,终端
/// 日志常被截图/粘进 issue(Node 同口径,注释原文见 cli.ts:1293)。
pub fn build_banner_lines(
  config_dir : String,
  control_host : String,
  control_port : Int32,
  peer_port : Int32,
  device_id : String,
  lan_addresses : Array[String],
  dev_vite_url : String?,
  token : String,
) -> Array[String] {
  let lines : Array[String] = []
  // config dir 一行带过(用户特意要保留的一行)
  lines.push("config dir: \{config_dir}")
  // control UI 地址列表(token 文件位置一并交代,Node 同款)
  lines.push("control UI (token in \{config_dir}/control.token):")
  let host_disp = if control_host == "0.0.0.0" {
    "localhost"
  } else {
    control_host
  }
  lines.push("  http://\{host_disp}:\{control_port}")
  if control_host == "0.0.0.0" {
    for lan in lan_addresses {
      lines.push("  http://\{lan}:\{control_port}")
    }
  }
  // dev mode 两行 + 登录令牌:仅 --dev-vite 显式传入时(键同 Node args.devViteUrl)
  match dev_vite_url {
    Some(url) => {
      lines.push(
        "dev mode: 访问 \{control_port} 端口的页面会自动重定向到 vite dev server \{url}(HMR 已启用)",
      )
      lines.push(
        "  请用 \{url} 打开 Web UI;生产构建(不带 --dev-vite)才由 \{control_port} 端口直接提供页面",
      )
      lines.push("  登录令牌(control.token):\{token}")
    }
    None => ()
  }
  lines.push(
    "syncx daemon started (device \{device_id}, peer port \{peer_port})",
  )
  // peer sync 列表(数据面):localhost + LAN 无条件,Node 不对称口径照抄
  lines.push("peer sync (ws://ip:port):")
  lines.push("  ws://localhost:\{peer_port}")
  for lan in lan_addresses {
    lines.push("  ws://\{lan}:\{peer_port}")
  }
  lines
}

///|
/// 致命错误:打印后以退出码 1 结束进程(never returns)。
fn[T] fatal(message : String) -> T {
  @log.critical("fatal: {Message}", [Json::string(message)])
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
  @log.info("设备身份已生成 {DeviceId}({Path})", [
    Json::string(identity.device_id),
    Json::string(path),
  ])
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
    @log.warn("{Path} 内容为空,已重新生成令牌", [Json::string(path)])
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
    // 硬忽略仍生效);folderIdentity 收养待接。
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
      // 暂停闸:目录级或全局暂停(config.paused,Node 同语义)任一命中;
      // 配置热重载:全局暂停开关经重建目录集即刻生效。
      paused: folder.is_paused() || config.is_paused(),
      paused_files: folder.paused_files.unwrap_or([]),
      baseline_pending: true,
      max_bandwidth_kbps: folder.max_bandwidth_kbps,
      // gitSync 模式与 Co-Authored-By 剔除开关:装配层只做折算透传,
      // 检测/镜像/中继三闸由 daemon 侧 git_sync_plan 推导(见 git.mbt)。
      git_sync: @daemon.git_sync_mode_of(folder.git_sync),
      git_strip_co_authored: folder.strip_co_authored.unwrap_or(false),
      // 同步时段:归一化后透传(坏片段退化成不设限,绝不锁死);全局规则
      // 与临时放行经 Cmd::ApplySchedule 注入(见 start 后的投递点)。
      schedule: @core.normalize_schedule_opt(folder.schedule),
    })
  }
  specs
}

///|
/// 向 actor 投递同步时段上下文(全局规则 + 临时放行到期时刻):启动与每次
/// 配置热重载后都要投 —— override 落盘的是「到期时刻」,重启/热重载后按
/// 同一时刻收住,不存在「重启白放行」。
fn schedule_cmd(config : @core.Config) -> @daemon.Cmd {
  @daemon.Cmd::ApplySchedule(
    sync_schedule=@core.normalize_schedule_opt(config.sync_schedule),
    override_until=config.schedule_override_until,
  )
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
    // git 提交通知:载荷本身就是 ControlMessage::GitCommitNotify 变体,
    // 原样包进 Control 帧外发(对端 handle_peer_message 里对称解包)。
    GitCommitNotify(notify) => @net.WireMessage::Control(payload=notify)
  }
}
