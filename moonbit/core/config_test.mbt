///|
// 配置契约测试:未知键往返、逐字段清洗、formatVersion 闸门。
test "未知键在读写往返中原样保留" {
  let raw = "{\"sharedFolders\":[{\"path\":\"/data\",\"id\":\"f1\",\"futureField\":{\"a\":1},\"anotherNew\":true}],\"futureTopLevel\":[1,2,3]}"
  let config = @core.parse_config(raw)
  assert_eq(config.shared_folders.length(), 1)
  let folder = config.shared_folders[0]
  assert_eq(folder.path, "/data")
  assert_eq(folder.id, Some("f1"))
  // 未知键进 extra,序列化时原样铺回
  assert_true(folder.extra.get("futureField") != None)
  assert_true(folder.extra.get("anotherNew") != None)
  assert_true(config.extra.get("futureTopLevel") != None)
  let json = config.to_json()
  let text = json.stringify()
  assert_true(text.contains("futureField"))
  assert_true(text.contains("anotherNew"))
  assert_true(text.contains("futureTopLevel"))
}

///|
test "坏字段只影响它自己,整份不失败" {
  let raw = "{\"maxSendKbps\":\"not-a-number\",\"paused\":true,\"sharedFolders\":[{\"path\":\"/a\"},{\"noPath\":1}]}"
  let config = @core.parse_config(raw)
  // maxSendKbps 非法 → 缺省;paused 合法 → 保留
  assert_eq(config.max_send_kbps, None)
  assert_eq(config.paused, Some(true))
  // 没 path 的目录整条丢弃
  assert_eq(config.shared_folders.length(), 1)
  assert_eq(config.shared_folders[0].path, "/a")
}

///|
test "非 JSON 整体退回默认配置" {
  let config = @core.parse_config("THIS IS NOT JSON{{{")
  assert_eq(config.shared_folders.length(), 0)
  assert_eq(config.format_version, @core.FORMAT_VERSION)
}

///|
test "formatVersion 闸门" {
  // 缺失/0 = 第 1 代,合法
  @core.assert_format_version(0)
  @core.assert_format_version(1)
  // 高于支持上限 → 抛错
  let failed = try {
    @core.assert_format_version(2)
    false
  } catch {
    Found(found, supported) => {
      assert_eq(found, 2)
      assert_eq(supported, 1)
      true
    }
  }
  assert_eq(failed, true)
}

///|
test "folder_id 与 index_key 的回退关系" {
  let raw = "{\"sharedFolders\":[{\"path\":\"/data\"},{\"path\":\"/two\",\"id\":\"f2\"},{\"path\":\"/three\",\"id\":\"f3\",\"instanceId\":\"i9\"}]}"
  let config = @core.parse_config(raw)
  assert_eq(config.shared_folders[0].folder_id(), "/data")
  assert_eq(config.shared_folders[1].folder_id(), "f2")
  // 没有 instanceId 时 index_key 回退到 folder_id
  assert_eq(config.shared_folders[1].index_key(), "f2")
  assert_eq(config.shared_folders[2].index_key(), "i9")
}

///|
test "peers 规范化:v4-mapped 前缀剥离 + 去重" {
  let raw = "{\"peers\":[\"ws://[::ffff:10.0.0.2]:22000\",\"ws://10.0.0.2:22000\",\"WS://HOST.example:23000\"]}"
  let config = @core.parse_config(raw)
  // 两条等价记录归一后只剩一条
  assert_eq(config.peers.length(), 2)
  assert_eq(config.peers[0], "ws://10.0.0.2:22000")
  assert_eq(config.peers[1], "ws://host.example:23000")
}

///|
test "日历覆盖清洗:非法日期与非法值剔除" {
  let raw = "{\"calendarOverrides\":{\"2026-10-01\":\"workday\",\"2026-02-30\":\"workday\",\"bad-key\":\"holiday\",\"2026-10-02\":\"nonsense\"}}"
  let config = @core.parse_config(raw)
  match config.calendar_overrides {
    Some(map) => {
      assert_eq(map.length(), 1)
      assert_eq(map.get("2026-10-01"), Some("workday"))
    }
    _ => panic()
  }
}

///|
test "分享记录清洗:时间倒挂的条目丢弃" {
  let raw = "{\"shares\":[{\"id\":\"s1\",\"folderId\":\"f\",\"path\":\"/p\",\"createdAt\":100,\"expiresAt\":200},{\"id\":\"s2\",\"folderId\":\"f\",\"path\":\"/p\",\"createdAt\":300,\"expiresAt\":200}]}"
  let config = @core.parse_config(raw)
  match config.shares {
    Some(records) => assert_eq(records.length(), 1)
    _ => panic()
  }
}

///|
test "gitStripCoAuthored:旧 JSON 无字段兼容 + 清洗往返" {
  // 旧配置没有该字段:缺省 None(= 行为不变),往返不新增键
  let legacy = @core.parse_config(
    "{\"sharedFolders\":[{\"path\":\"/data\",\"gitSync\":\"full\"}]}",
  )
  let folder = legacy.shared_folders[0]
  assert_eq(folder.git_sync, Some("full"))
  assert_eq(folder.strip_co_authored, None)
  let legacy_text = legacy.to_json().stringify()
  assert_false(legacy_text.contains("gitStripCoAuthored"))
  // 开启:Some(true),往返保留
  let on = @core.parse_config(
    "{\"sharedFolders\":[{\"path\":\"/data\",\"gitStripCoAuthored\":true}]}",
  )
  assert_eq(on.shared_folders[0].strip_co_authored, Some(true))
  assert_true(on.to_json().stringify().contains("\"gitStripCoAuthored\":true"))
  // 显式 false:照常保留(false 语义与缺省一致,落盘形态忠实)
  let off = @core.parse_config(
    "{\"sharedFolders\":[{\"path\":\"/data\",\"gitStripCoAuthored\":false}]}",
  )
  assert_eq(off.shared_folders[0].strip_co_authored, Some(false))
  assert_true(
    off.to_json().stringify().contains("\"gitStripCoAuthored\":false"),
  )
  // 非布尔垃圾 → 缺省(坏字段只影响它自己)
  let junk = @core.parse_config(
    "{\"sharedFolders\":[{\"path\":\"/data\",\"gitStripCoAuthored\":\"yes\",\"gitSync\":\"send\"}]}",
  )
  assert_eq(junk.shared_folders[0].strip_co_authored, None)
  assert_eq(junk.shared_folders[0].git_sync, Some("send"))
  assert_false(junk.to_json().stringify().contains("gitStripCoAuthored"))
}
