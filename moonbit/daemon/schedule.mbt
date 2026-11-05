///|
/// 同步时段的判定与状态下发(daemon 层职责:core/schedule.mbt 是纯模型,
/// 这层负责「墙上时间 → 民用时刻」的时区解释 + 横幅聚合)。对齐 Node
/// session-manager 的 scheduleVerdictFor / scheduleStates / scheduleBannerState /
/// checkScheduleTransitions 四件套:
///
///  - **判定只在后端做一份**:前端只渲染 scheduleStates/scheduleBanner ——
///    曾经前后端各写一份 isWithinSchedule,规则复杂化后必然漂移;
///  - **全局 ∩ 目录取交集**:全局是硬闸门,任一在窗口外即停摆,并给出
///    「被谁挡住」与下一个边界时刻(横幅据此写「23:00 自动恢复」);
///  - **临时放行期间一律视为窗口内**(同时解开全局与目录两层);
///  - 「工作日/休息日」MoonBit 后端尚未接节假日日历(全局缺口项),注入
///    core.weekday_workday_fallback 的退化口径 —— 与 Node「无日历数据」
///    完全一致,绝不为拉不到日历把目录锁死。

///|
/// 判定结论(与状态行分离;纯函数可离线对拍 Node)。
pub(all) struct ScheduleVerdict {
  inside : Bool
  overridden : Bool
  blocked_by : String?
  next_change_at : Int64?
}

///|
/// 核心判定(对应 Node scheduleVerdictFor):now 为 epoch 毫秒,按 zone 解释。
pub fn schedule_verdict(
  sync_schedule : @core.Schedule?,
  folder_schedule : @core.Schedule?,
  override_until : Int64?,
  now : Int64,
  zone : @time.Zone,
  is_workday : @core.IsWorkday,
) -> ScheduleVerdict {
  match override_until {
    Some(until) =>
      if until > now {
        return {
          inside: true,
          overridden: true,
          blocked_by: None,
          next_change_at: None,
        }
      }
    None => ()
  }
  let moment = civil_from_ms(now, zone)
  let global_next = @core.next_schedule_change(
    sync_schedule, moment, is_workday,
  )
  let folder_next = @core.next_schedule_change(
    folder_schedule, moment, is_workday,
  )
  if !@core.within_schedule(sync_schedule, moment, is_workday) {
    return {
      inside: false,
      overridden: false,
      blocked_by: Some("global"),
      next_change_at: earlier_of(global_next, folder_next, zone),
    }
  }
  if !@core.within_schedule(folder_schedule, moment, is_workday) {
    return {
      inside: false,
      overridden: false,
      blocked_by: Some("folder"),
      next_change_at: earlier_of(folder_next, global_next, zone),
    }
  }
  {
    inside: true,
    overridden: false,
    blocked_by: None,
    next_change_at: earlier_of(global_next, folder_next, zone),
  }
}

///|
/// 两个「下一次翻转」候选取更早者(均 None = 无约束)。
fn earlier_of(
  a : @core.CivilMoment?,
  b : @core.CivilMoment?,
  zone : @time.Zone,
) -> Int64? {
  match (a, b) {
    (Some(x), Some(y)) => {
      let mx = civil_to_ms(x, zone)
      let my = civil_to_ms(y, zone)
      Some(if mx < my { mx } else { my })
    }
    (Some(x), None) => Some(civil_to_ms(x, zone))
    (None, Some(y)) => Some(civil_to_ms(y, zone))
    (None, None) => None
  }
}

///|
/// epoch 毫秒 → 本机时区的民用时刻(用户填的是自己钟表上看到的时间,
/// 与 Node 按机器时区解释同口径)。
fn civil_from_ms(now : Int64, zone : @time.Zone) -> @core.CivilMoment {
  let zdt = @time.unix(now / 1000L, zone~) catch {
    _ => return @core.CivilMoment::new(1970, 1, 1, 0)
  }
  @core.CivilMoment::at(
    zdt.year(),
    zdt.month(),
    zdt.day(),
    zdt.hour(),
    zdt.minute(),
  )
}

///|
/// 民用时刻 → epoch 毫秒(按 zone 解释;跨夏令时边界的候选与 Node 的
/// Date 墙上时间换算有同样的既有偏差,取值只差一小时且只影响文案)。
fn civil_to_ms(moment : @core.CivilMoment, zone : @time.Zone) -> Int64 {
  let zdt = @time.date_time(
    moment.year,
    moment.month,
    moment.day,
    hour=moment.minutes / 60,
    minute=moment.minutes % 60,
    zone~,
  ) catch {
    _ => return 0L
  }
  zdt.to_unix_second() * 1000L
}

///|
/// 本机时区(懒加载一次;解析失败退 UTC —— 判定永远可用,时区错了最多
/// 窗口挪一两小时,不会锁死)。
fn SessionActor::local_zone_or_utc(self : SessionActor) -> @time.Zone {
  match self.local_zone {
    Some(zone) => zone
    None => {
      let zone = @time.local_zone() catch { _ => @time.utc_zone }
      self.local_zone = Some(zone)
      zone
    }
  }
}

///|
/// 单目录此刻的时段判定(do_scan 闸门等运行点用)。
fn SessionActor::schedule_verdict_now(
  self : SessionActor,
  folder : Folder,
) -> ScheduleVerdict {
  let zone = self.local_zone_or_utc()
  schedule_verdict(
    self.sync_schedule,
    folder.schedule,
    self.schedule_override_until,
    now_ms(),
    zone,
    @core.weekday_workday_fallback,
  )
}

///|
/// 现算全部目录的时段结论与横幅(结果缓存进 actor 字段,publish 直读;
/// Snapshot 与周期泵都会触发)。横幅归因与 Node 一致:手动暂停/全局暂停的
/// 目录各有自己的提示,不记进时段的账 —— 否则「用户自己按了暂停」会被
/// 横幅说成「因为时段所以不同步」。
fn SessionActor::refresh_schedule(self : SessionActor) -> Unit {
  let zone = self.local_zone_or_utc()
  let now = now_ms()
  let is_workday : @core.IsWorkday = @core.weekday_workday_fallback
  let rows : Array[ScheduleStateRow] = []
  let mut blocked = 0
  let mut any_active = false
  let mut next : Int64? = None
  for folder in self.folders {
    let v = schedule_verdict(
      self.sync_schedule,
      folder.schedule,
      self.schedule_override_until,
      now,
      zone,
      is_workday,
    )
    rows.push({
      id: folder.id,
      inside: v.inside,
      overridden: v.overridden,
      blocked_by: v.blocked_by,
      next_change_at: v.next_change_at,
      summary: @core.format_schedule_summary(folder.schedule),
    })
    if v.inside {
      if !folder.paused {
        any_active = true
      }
      continue
    }
    if folder.paused {
      continue
    }
    blocked = blocked + 1
    match v.next_change_at {
      Some(at) =>
        match next {
          Some(cur) => if at < cur { next = Some(at) }
          None => next = Some(at)
        }
      None => ()
    }
  }
  self.schedule_rows = rows
  let override_until : Int64? = match self.schedule_override_until {
    Some(until) => if until > now { Some(until) } else { None }
    None => None
  }
  // 放行中必须继续显示:横幅此刻的内容是「剩余时间 + 一键取消」,收起就等于
  // 让用户对一个看不见的定时开关。其余情况:确有目录因时段停摆、且没有任何
  // 目录在同步(多目录机器上「部分目录在时段外」是常态,常驻横幅是噪音)。
  let visible = match override_until {
    Some(_) => true
    None => blocked > 0 && !any_active
  }
  self.schedule_banner = Some({
    visible,
    blocked_by_schedule: blocked,
    total: self.folders.length(),
    next_change_at: next,
    override_until,
  })
}

///|
/// 时段状态巡检(60s 一拍,对齐 Node checkScheduleTransitions):签名变了
/// = 有目录进出窗口 —— 立即重算状态并补扫,不等下一轮常规节拍。首轮只
/// 登记基线(ApplySchedule 落地时会即时跑一遍)。
fn SessionActor::check_schedule_transitions(self : SessionActor) -> Unit {
  self.refresh_schedule()
  let mut signature = match self.schedule_override_until {
    Some(until) => if until > now_ms() { "override" } else { "" }
    None => ""
  }
  for row in self.schedule_rows {
    let mark = if row.inside { 1 } else { 0 }
    signature = "\{signature}|\{row.id}:\{mark}"
  }
  let flipped = self.schedule_signature != "" &&
    signature != self.schedule_signature
  self.schedule_signature = signature
  if !flipped {
    return
  }
  @log.info(
    "sync schedule window \{schedule_summary_text(self.schedule_rows)}",
    [],
  )
  // 进入窗口:把停摆期间的本地改动扫出来广播(重挂通道只互发索引,新文件
  // 要靠扫描发现)。窗口外/暂停目录 do_scan 自行退闸,全量补扫无害。
  self.publish()
  for folder in self.folders {
    if !folder.paused {
      let _ : Bool = self.rx.try_put(ScanFolder(folder.id)) catch { _ => false }
    }
  }
}

///|
/// 巡检日志摘要(哪些目录在窗口内/外/放行中;对齐 Node scheduleVerdictSummary)。
fn schedule_summary_text(rows : Array[ScheduleStateRow]) -> String {
  let buf = StringBuilder()
  for i, row in rows {
    if i > 0 {
      buf.write_string(" ")
    }
    if row.overridden {
      buf.write_string("\{row.id}=放行中")
    } else if row.inside {
      buf.write_string("\{row.id}=窗口内")
    } else {
      let who = match row.blocked_by {
        Some(b) => b
        None => "?"
      }
      buf.write_string("\{row.id}=窗口外(\{who})")
    }
  }
  buf.to_string()
}
