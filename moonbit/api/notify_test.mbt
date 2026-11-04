///|
/// 配置热重载通知的接线形状:写路由统一入口 —— 未接回调时无操作(单测/
/// 未装配 daemon 场景),接入后调用即达(cli 装配层的重载回调)。
async test "notify_config_changed:未接入无操作,接入后触发即达" {
  let fired : Ref[Int] = Ref(0)
  let options = @api.ApiOptions::new(
    device_id="notify-test",
    on_config_changed=Some(() => { fired.val = fired.val + 1 }),
  )
  // 未接入(缺省 None):无操作
  let bare = @api.ApiOptions::new(device_id="notify-test-bare")
  @api.notify_config_changed(bare)
  assert_eq(fired.val, 0)
  // 接入后:调用即触发,重复落盘重复触发
  @api.notify_config_changed(options)
  @api.notify_config_changed(options)
  assert_eq(fired.val, 2)
}
