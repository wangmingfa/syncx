///|
/// ConfigStore 等价物:config.json 的原子写 + 跨进程锁。
///
/// 语义对齐 Node `src/config.ts`(ADR-0025 §2,三端共享同一数据目录):
///   - **原子写**:先写 `<config>.tmp` 再 rename,绝不让并发读者
///     (syncx status / 另一后端)读到半截 JSON;
///   - **跨进程锁**:`<config>.lock` 以排他创建表示占用,持有者崩溃遗留的
///     陈旧锁(>30s)直接回收;争用上限 5s,超时报错而不是死等;
///   - **落盘盖戳**:每次写都盖 `formatVersion` + `generatedBy`
///     (「缺失即第 1 代」能成立的另一半:只认不写,代数永远不会前进)。
///
/// 读路径复用 api 包的 `load_config`(文件不存在/解析失败按全新配置处理)。

///|
/// 陈旧锁回收阈值(毫秒):超过即认为持有者已崩溃,直接删除重试。
pub const CONFIG_LOCK_STALE_MS : Int64 = 30_000L

///|
/// 锁争用上限(毫秒):临界区是微秒级的 load→改→save,5s 拿不到锁
/// 一定是出了别的问题(如 NFS 上的 create 行为异常),报错优于空转。
pub const CONFIG_LOCK_TIMEOUT_MS : Int64 = 5_000L

///|
/// 本进程的锁重入深度(configPath → 深度):同一进程内的嵌套 mutate
/// 不会自我死锁(与 Node 的 configLockDepth 同职责)。
let lock_depth : Map[String, Int32] = Map([])

///|
/// 读取配置:文件不存在/解析失败按全新配置处理(复用 api 包实现,
/// 行为与 Node 首次启动一致)。
pub async fn load_config_file(config_file : String) -> @core.Config {
  @api.load_config(config_file)
}

///|
/// 原子写配置:盖 `formatVersion` + `generatedBy` 戳后写临时文件,
/// 再同目录 rename(rename 是原子操作)。
pub async fn save_config_atomic(
  config_file : String,
  config : @core.Config,
) -> Unit raise CliError {
  config.format_version = @core.FORMAT_VERSION
  config.generated_by = Some(@core.VERSION)
  let tmp = "\{config_file}.tmp"
  @fs.write_file(tmp, config.to_json().stringify() + "\n") catch {
    e => raise CliError::Fatal("配置写入失败(\{tmp}):\{e}")
  }
  @fs.rename(tmp, config_file, replace=true) catch {
    e => {
      // 收尾尽力删掉半成品,不留脏 .tmp
      @fs.remove(tmp) catch {
        _ => ()
      }
      raise CliError::Fatal("配置落盘失败(\{config_file}):\{e}")
    }
  }
}

///|
/// 取跨进程配置锁。已存在则视为被占用:陈旧锁(>30s)回收后重试,
/// 否则短暂退避直到 5s 上限。
async fn acquire_config_lock(config_file : String) -> Unit raise CliError {
  let depth = lock_depth.get(config_file).unwrap_or(0)
  if depth > 0 {
    lock_depth.set(config_file, depth + 1)
    return
  }
  let lock_path = "\{config_file}.lock"
  let deadline = @async.now() + CONFIG_LOCK_TIMEOUT_MS
  for ;; {
    // 排他创建:已存在即失败,等价于 Node 的 `openSync(lockPath, 'wx')`。
    // 这里不区分「已存在」与「其他 I/O 错误」:后者重试也难自愈,
    // 到 5s 上限后如实报错(陈旧锁回收在每轮重试里都会先做一次)。
    let created : @fs.File? = Some(@fs.create(lock_path, allow_existing=false)) catch {
      _ => None
    }
    match created {
      Some(file) => {
        file.close()
        lock_depth.set(config_file, 1)
        return
      }
      None => {
        // 陈旧锁回收:持有者崩溃未释放且超过 30s,删除后重试
        reclaim_stale_lock(lock_path)
        if @async.now() > deadline {
          raise CliError::Fatal("获取配置锁超时: \{config_file}")
        }
        @async.sleep(2)
      }
    }
  }
}

///|
/// 陈旧锁回收:超过 30s 的锁文件直接删除(持有者已崩溃);
/// 删除失败(权限/竞态)不报错,交给下一轮重试。
async fn reclaim_stale_lock(lock_path : String) -> Unit noraise {
  // mtime 是 (秒, 纳秒);@async.now() 是毫秒
  let mtime : (Int64, Int32)? = Some(@fs.mtime(lock_path)) catch { _ => None }
  match mtime {
    Some((mtime_s, _)) =>
      if @async.now() - mtime_s * 1000L > CONFIG_LOCK_STALE_MS {
        @fs.remove(lock_path) catch {
          _ => ()
        }
      }
    None => ()
  }
}

///|
/// 释放配置锁:深度归零时删除锁文件;已不存在则忽略。
async fn release_config_lock(config_file : String) -> Unit noraise {
  let depth = lock_depth.get(config_file).unwrap_or(0)
  if depth <= 1 {
    @fs.remove("\{config_file}.lock") catch {
      _ => ()
    }
    lock_depth.remove(config_file)
  } else {
    lock_depth.set(config_file, depth - 1)
  }
}

///|
/// 串行化「加载 → 修改 → 保存」为一个临界区:持锁期间独占配置读写,
/// 避免 daemon 与 CLI 并发改配置时后写覆盖前写(与 Node mutateConfig
/// 同职责)。mutator 在内存 config 上原地修改,返回 true 才回写。
pub async fn mutate_config(
  config_file : String,
  mutator : (@core.Config) -> Bool,
) -> Result[Unit, String] {
  acquire_config_lock(config_file) catch {
    e => return Err(CliError::to_text(e))
  }
  let config = load_config_file(config_file)
  let changed = mutator(config)
  if changed {
    save_config_atomic(config_file, config) catch {
      e => {
        release_config_lock(config_file)
        return Err(CliError::to_text(e))
      }
    }
  }
  release_config_lock(config_file)
  Ok(())
}
