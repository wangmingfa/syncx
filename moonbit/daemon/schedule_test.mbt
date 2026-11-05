///|
// 同步时段(daemon 层)契约测试:纯判定对拍 Node scheduleVerdictFor 的
// fixture 语义(全局 ∩ 目录、放行、边界换算);actor 链路测 ApplySchedule
// → 状态快照落地。时区固定 UTC —— 民用时刻与 epoch 的换算退化为恒等式,
// 用 core.days_from_civil 直接折算,测试不依赖运行机器的时区。

///|
/// UTC 语境下「某天第几分钟」的 epoch 毫秒(测试专用换算)。
fn utc_ms(year : Int32, month : Int32, day : Int32, minutes : Int32) -> Int64 {
  let days = @core.days_from_civil(year, month, day)
  (days * 1440L + minutes.to_int64()) * 60L * 1000L
}

///|
async test "时段判定:目录窗口外 → blockedBy=folder,边界换算成 epoch" {
  // fixture dow-subset:周一/三/五 10:00–11:40;2026-10-28(周三)09:00 窗口外
  let schedule = @core.normalize_schedule(
    @json.parse(
      "[{\"days\":{\"kind\":\"dow\",\"days\":[1,3,5]},\"windows\":[{\"from\":600,\"to\":700}]}]",
    ),
  )
  let now = utc_ms(2026, 10, 28, 540)
  let v = @daemon.schedule_verdict(
    None,
    schedule,
    None,
    now,
    @time.utc_zone,
    @core.weekday_workday_fallback,
  )
  assert_false(v.inside)
  assert_true(v.blocked_by is Some("folder"))
  assert_eq(v.next_change_at, Some(utc_ms(2026, 10, 28, 600)))
  // 同窗口内(10:30):窗口内,下一次翻转 = 11:40 收口
  let v = @daemon.schedule_verdict(
    None,
    schedule,
    None,
    utc_ms(2026, 10, 28, 630),
    @time.utc_zone,
    @core.weekday_workday_fallback,
  )
  assert_true(v.inside)
  assert_eq(v.next_change_at, Some(utc_ms(2026, 10, 28, 700)))
}

///|
async test "时段判定:全局窗口外 → blockedBy=global;放行期一律窗口内" {
  // fixture legacy-string:每天 22:00–08:00(跨午夜),09:00 在窗口外
  let global = @core.normalize_schedule(@json.parse("\"22:00-08:00\""))
  let now = utc_ms(2026, 10, 28, 540)
  let v = @daemon.schedule_verdict(
    global,
    None,
    None,
    now,
    @time.utc_zone,
    @core.weekday_workday_fallback,
  )
  assert_false(v.inside)
  assert_true(v.blocked_by is Some("global"))
  assert_eq(v.next_change_at, Some(utc_ms(2026, 10, 28, 1320)))
  // 临时放行:全局 + 目录两层一起解,无边界文案
  let v = @daemon.schedule_verdict(
    global,
    global,
    Some(now + 60_000L),
    now,
    @time.utc_zone,
    @core.weekday_workday_fallback,
  )
  assert_true(v.inside)
  assert_true(v.overridden)
  assert_true(v.next_change_at is None)
}

///|
async test "ApplySchedule:放行落地状态快照,取消即收口" {
  let root = actor_fresh_root("schedule")
  let spec = actor_make_spec(root)
  @async.with_task_group() <| group => {
    let handle = @daemon.start_session_actor(group, "dev-a", [spec])
    let future = @daemon.now_ms() + 600_000L
    let _ = handle.send(
      @daemon.Cmd::ApplySchedule(
        sync_schedule=None,
        override_until=Some(future),
      ),
    )
    let snap = handle.sync_snapshot()
    assert_eq(snap.folders.length(), 1)
    let rows = snap.schedule_states
    assert_eq(rows.length(), 1)
    assert_true(rows[0].inside)
    assert_true(rows[0].overridden)
    let banner = snap.schedule_banner.unwrap()
    assert_true(banner.visible)
    assert_eq(banner.override_until, Some(future))
    // 取消放行:overridden 收口;无时段规则 → 窗口内,横幅不可见
    let _ = handle.send(
      @daemon.Cmd::ApplySchedule(sync_schedule=None, override_until=None),
    )
    let snap = handle.sync_snapshot()
    assert_false(snap.schedule_states[0].overridden)
    assert_true(snap.schedule_states[0].inside)
    assert_false(snap.schedule_banner.unwrap().visible)
    let _ = handle.send(@daemon.Cmd::Shutdown)
  }
}
