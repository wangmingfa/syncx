// 由 moonbit/scripts/gen-direct-fixture.mjs 生成;数据源是
// rust/crates/syncx-net/fixtures/direct-wire.json(Node 直发线上格式
// 的唯一事实源)。改 src/direct.ts / src/net/wire.ts 的消息字段后必须
// 重跑生成脚本,三后端(Rust/MoonBit)一起刷新,别只做一边。

// 六条 direct-* 控制消息:(用例名, Node 发上线的完整 wire 字符串)。
pub fn direct_wire_controls() -> Array[(String, String)] {
  [
    ("text", "{\"type\":\"control\",\"payload\":{\"kind\":\"direct-text\",\"id\":\"dt-1\",\"fromDeviceId\":\"\",\"text\":\"你好，syncx 直发\\n第二行 \\\"quoted\\\" & <tag>\",\"createdAt\":1700000000000,\"version\":\"0.4.4\",\"hostname\":\"node-host\",\"platform\":\"linux\",\"runtime\":\"node\"}}"),
    ("file-offer-batch", "{\"type\":\"control\",\"payload\":{\"kind\":\"direct-file-offer\",\"id\":\"df-1\",\"fromDeviceId\":\"\",\"name\":\"季度报表 (1).xlsx\",\"size\":3145728,\"sha256\":\"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\",\"createdAt\":1700000001000,\"batchId\":\"b-1700000001000-1\",\"version\":\"0.4.4\",\"hostname\":\"node-host\",\"platform\":\"linux\",\"runtime\":\"node\"}}"),
    ("file-offer-single", "{\"type\":\"control\",\"payload\":{\"kind\":\"direct-file-offer\",\"id\":\"df-2\",\"fromDeviceId\":\"\",\"name\":\"photo.jpg\",\"size\":1,\"sha256\":\"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\",\"createdAt\":1700000002000,\"version\":\"0.4.4\",\"hostname\":\"node-host\",\"platform\":\"linux\",\"runtime\":\"node\"}}"),
    ("reply-accept-resume", "{\"type\":\"control\",\"payload\":{\"kind\":\"direct-reply\",\"id\":\"df-1\",\"fromDeviceId\":\"\",\"accept\":true,\"offset\":786432,\"version\":\"0.4.4\",\"hostname\":\"node-host\",\"platform\":\"linux\",\"runtime\":\"node\"}}"),
    ("reply-accept-fresh", "{\"type\":\"control\",\"payload\":{\"kind\":\"direct-reply\",\"id\":\"df-2\",\"fromDeviceId\":\"\",\"accept\":true,\"version\":\"0.4.4\",\"hostname\":\"node-host\",\"platform\":\"linux\",\"runtime\":\"node\"}}"),
    ("reply-reject", "{\"type\":\"control\",\"payload\":{\"kind\":\"direct-reply\",\"id\":\"df-3\",\"fromDeviceId\":\"\",\"accept\":false,\"reason\":\"对方拒绝了接收\",\"version\":\"0.4.4\",\"hostname\":\"node-host\",\"platform\":\"linux\",\"runtime\":\"node\"}}"),
    ("ack", "{\"type\":\"control\",\"payload\":{\"kind\":\"direct-ack\",\"id\":\"df-1\",\"fromDeviceId\":\"\",\"seq\":3,\"version\":\"0.4.4\",\"hostname\":\"node-host\",\"platform\":\"linux\",\"runtime\":\"node\"}}"),
    ("cancel", "{\"type\":\"control\",\"payload\":{\"kind\":\"direct-cancel\",\"id\":\"df-1\",\"fromDeviceId\":\"\",\"reason\":\"30 秒没有进展,已放弃\",\"version\":\"0.4.4\",\"hostname\":\"node-host\",\"platform\":\"linux\",\"runtime\":\"node\"}}"),
    ("result-ok", "{\"type\":\"control\",\"payload\":{\"kind\":\"direct-result\",\"id\":\"dt-1\",\"fromDeviceId\":\"\",\"ok\":true,\"version\":\"0.4.4\",\"hostname\":\"node-host\",\"platform\":\"linux\",\"runtime\":\"node\"}}"),
    ("result-fail", "{\"type\":\"control\",\"payload\":{\"kind\":\"direct-result\",\"id\":\"df-1\",\"fromDeviceId\":\"\",\"ok\":false,\"error\":\"文件校验失败(sha256 不一致)\",\"version\":\"0.4.4\",\"hostname\":\"node-host\",\"platform\":\"linux\",\"runtime\":\"node\"}}"),
  ]
}

// direct-file-chunk 二进制帧对拍样本(key/iv 见 Rust fixture:iv 随机,
// 每次生成都不同 —— 只作「两侧都能解」的快照,不参与逐字节还原)。
pub fn direct_wire_chunk_key_hex() -> String { "0707070707070707070707070707070707070707070707070707070707070707" }
pub fn direct_wire_chunk_frame_b64() -> String { "oSv7RuNg+n8aH2JNraX8W/ne8mHwToNOn+X0as1NcpDXtddbB+JDVUY71tNqQcqWiy7dU39ZeAyILY+OUMrBV6Pk/JwoHz7zi2g4OiFxGM4/yF8A+naqAIPzF+rOHHchEBFGtjQkA6FJ5dvBTNYx4l/DTmBinu1ZLO7ECzzs8McjwdCgFmqJtgilfXj7Vcooem5cu3/ZwTQVh8VqVBZNkp8xuby4nc7dfiAEGNypScuUQwrrG4NOrj794Tk+K1wLM3MZC/lNq/raMC7yWxtUjgsaebuCMZ4b5zYShGot3kOgCIOcn338Zshm+uQKXN0NjJ09xAKq3pQ8aVmOgCuf9KmBujQrpFHtD7NRSapm5nFDYaflju7TESd5xG4GHVwTjYEnyRKYJhwbBxUPln3kH4w9NE/tSfkHTJz/Fb9ND9JIChDJRky4Ku7GFrAWoYwkeA+G0qyfzy+RAfca2U/w7naTjh9xO5AnpmpWOqBx+qQXOfOGWyEdxrLLoEq9zDZNVhpeH7QVHt7NhmTwIqotvFZCCwWEjbrWyYQtSf3wzBv9Fe37u/LDpzxwq9FbWMvq0x/476u/Gezue4daUHQKk7t1aoGD7sxRC/62pX10v9v6VBeuHT1hPYisTxRnPneH7UJ2zRg0H/jDlwOKFBIbb9Xs+B64fbwNQQ9apT+vwIcLZA+80l70MM2hZ4NuPzhuIuUJUiY3oVGrGupnd9lQzKiYJGO488F/qmfj4L7pJpE154p1MUnDoB3TjvSTxrWXPREJAMWlnEVtztNe+0OsZnKToAcgU+oXon5IZ11JjbZXFGhEecrRqolNmbyMN41WVVaubiPlKaiAhMquJXLcxaZzm10CaSnj6rDvZmqiywFY8vr/+ngg8lFYw408XSrUgl033w74OxyX59rXi+G/EpZfpEpAy4qXIXnt4dgl0IoCnqZAsniXr9nJyY2eqe1hmvaNuvcxIQyxZSh7g2s1WzRoH5vMUk85fWKajqlMhq1FgOA=" }
pub fn direct_wire_chunk_body_b64() -> String { "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+foAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl9gYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1+f4CBgoOEhYaHiImKi4yNjo+QkZKTlJWWl5iZmpucnZ6foKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr/AwcLDxMXGx8jJysvMzc7P0NHS09TV1tfY2drb3N3e3+Dh4uPk5ebn6Onq6+zt7u/w8fLz9PX29/j5+gABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX2BhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5/gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp+goaKjpKWmp6ipqqusra6vsLGys7S1tre4ubq7vL2+v8DBwsPExQ==" }
pub fn direct_wire_chunk_id() -> String { "df-1" }
pub fn direct_wire_chunk_seq() -> Int64 { 4L }
