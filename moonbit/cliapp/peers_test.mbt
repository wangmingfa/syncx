///|
/// 出站拨号/重连/会话注册表/设备合并的纯逻辑测试(不发网络;端到端连接
/// 由冒烟验证覆盖)。

///|
test "reconnect_delay_ms:与 Node reconnectDelayMs 同曲线" {
  // 首连失败立即重试(0ms):避免双 daemon 同启互拒把建连推到 30s 边缘
  assert_eq(@cliapp.reconnect_delay_ms(0), 0)
  assert_eq(@cliapp.reconnect_delay_ms(1), 1000)
  assert_eq(@cliapp.reconnect_delay_ms(2), 2000)
  assert_eq(@cliapp.reconnect_delay_ms(3), 4000)
  assert_eq(@cliapp.reconnect_delay_ms(5), 16000)
  // 1000 * 2^5 = 32000 → 封顶 30s
  assert_eq(@cliapp.reconnect_delay_ms(6), 30000)
  assert_eq(@cliapp.reconnect_delay_ms(20), 30000)
}

///|
test "会话注册表:登记/查询/撤销,hello 覆盖元数据但保留已知 url" {
  let registry = @cliapp.PeerSessionRegistry::new()
  assert_eq(registry.size(), 0)
  // 出站拨号登记(url = 拨号地址)
  registry.register(
    "DEV-A",
    { version: None, platform: None, hostname: None, url: Some("ws://10.0.0.2:22000") },
  )
  assert_eq(registry.size(), 1)
  match registry.lookup("DEV-A") {
    Some(meta) => assert_eq(meta.url, Some("ws://10.0.0.2:22000"))
    None => panic()
  }
  // hello 覆盖元数据(version 恒有值),url 保留已知 Some
  registry.register_hello("DEV-A", "1.2.3", Some("darwin"), Some("host-a"))
  match registry.lookup("DEV-A") {
    Some(meta) => {
      assert_eq(meta.version, Some("1.2.3"))
      assert_eq(meta.platform, Some("darwin"))
      assert_eq(meta.hostname, Some("host-a"))
      assert_eq(meta.url, Some("ws://10.0.0.2:22000"))
    }
    None => panic()
  }
  // 无 url 历史的设备(入站会话先到):url 保持 None
  registry.register_hello("DEV-B", "1.2.3", None, None)
  match registry.lookup("DEV-B") {
    Some(meta) => assert_true(meta.url is None)
    None => panic()
  }
  // 撤销幂等(生命周期跟随会话)
  registry.unregister("DEV-A")
  assert_true(registry.lookup("DEV-A") is None)
  registry.unregister("DEV-A")
  assert_eq(registry.size(), 1)
}

///|
test "devices 合并:会话有/无两态,静态快照不被就地改写" {
  let registry = @cliapp.PeerSessionRegistry::new()
  let map_a : Map[String, Json] = Map([])
  map_a.set("deviceId", Json::string("DEV-A"))
  map_a.set("online", Json::boolean(false))
  map_a.set("folders", Json::array([]))
  let static_infos : Array[Json] = [Json::object(map_a)]
  // 无会话:快照原样回落(offline,无 version 等键)
  let merged = @cliapp.merge_device_status(static_infos, registry)
  match merged[0] {
    Object(obj) => {
      assert_true(obj.get("online") is Some(False))
      assert_true(obj.get("version") is None)
    }
    _ => panic()
  }
  // 会话活着:online=true + version/platform/hostname/url 逐字段上线
  registry.register(
    "DEV-A",
    {
      version: Some("0.4.1"),
      platform: Some("darwin"),
      hostname: Some("host-a"),
      url: Some("ws://10.0.0.2:22000"),
    },
  )
  let merged2 = @cliapp.merge_device_status(static_infos, registry)
  match merged2[0] {
    Object(obj) => {
      assert_true(obj.get("online") is Some(True))
      assert_true(obj.get("version") is Some(String("0.4.1")))
      assert_true(obj.get("platform") is Some(String("darwin")))
      assert_true(obj.get("hostname") is Some(String("host-a")))
      assert_true(obj.get("url") is Some(String("ws://10.0.0.2:22000")))
    }
    _ => panic()
  }
  // 合并是拷贝语义:静态快照仍是 offline 原样
  match static_infos[0] {
    Object(obj) => assert_true(obj.get("online") is Some(False))
    _ => panic()
  }
  // 元数据缺字段的会话:缺的键不上线(url None 不写键)
  registry.register(
    "DEV-A",
    { version: Some("0.4.1"), platform: None, hostname: None, url: None },
  )
  let merged3 = @cliapp.merge_device_status(static_infos, registry)
  match merged3[0] {
    Object(obj) => {
      assert_true(obj.get("online") is Some(True))
      assert_true(obj.get("version") is Some(String("0.4.1")))
      assert_true(obj.get("platform") is None)
      assert_true(obj.get("url") is None)
    }
    _ => panic()
  }
}

///|
test "hello 往返:make_hello → to_json → from_json" {
  let hello = @net.make_hello("DEV-SELF", Some("host-x"), Some("darwin"))
  let back = @net.ControlMessage::from_json(@net.ControlMessage::to_json(hello))
  assert_eq(back, hello)
  match hello {
    Hello(from_device_id~, version~, hostname~, platform~, runtime~) => {
      assert_eq(from_device_id, "DEV-SELF")
      assert_eq(version, @core.VERSION)
      assert_eq(hostname, Some("host-x"))
      assert_eq(platform, Some("darwin"))
      assert_eq(runtime, Some("moonbit"))
    }
    _ => panic()
  }
}
