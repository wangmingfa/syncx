///|
// 同步时段契约测试:与 Node/Rust 共享同一份 fixture
// (rust/crates/syncx-core/fixtures/schedule.json,内嵌为常量)逐条对拍,
// 另补民用日期算法(含闰年 2/29)与归一化上限截断的用例。

///|
/// fixture 原文(压缩为单行,内容与 rust/crates/syncx-core/fixtures/schedule.json 一致)。
const FIXTURE_JSON : String = "{\"workdays\":[\"2026-10-28\",\"2026-10-29\",\"2026-10-30\",\"2026-10-31\"],\"cases\":[{\"name\":\"undefined\",\"raw\":null,\"normalized\":null,\"unbounded\":true,\"summary\":\"\u5168\u5929\u540c\u6b65\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":true},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":true}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":null}]},{\"name\":\"empty-array\",\"raw\":[],\"normalized\":null,\"unbounded\":true,\"summary\":\"\u5168\u5929\u540c\u6b65\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":true},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":true}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":null}]},{\"name\":\"legacy-string\",\"raw\":\"22:00-08:00\",\"normalized\":[{\"days\":{\"kind\":\"any\"},\"windows\":[{\"from\":1320,\"to\":480}]}],\"unbounded\":false,\"summary\":\"\u6bcf\u5929 22:00\u201308:00\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":false},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":false}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1320}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1320}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1320}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1320}}]},{\"name\":\"legacy-same\",\"raw\":\"09:00-09:00\",\"normalized\":null,\"unbounded\":true,\"summary\":\"\u5168\u5929\u540c\u6b65\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":true},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":true}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":null}]},{\"name\":\"legacy-garbage\",\"raw\":\"nonsense\",\"normalized\":null,\"unbounded\":true,\"summary\":\"\u5168\u5929\u540c\u6b65\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":true},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":true}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":null}]},{\"name\":\"legacy-out-of-range\",\"raw\":\"25:00-08:00\",\"normalized\":null,\"unbounded\":true,\"summary\":\"\u5168\u5929\u540c\u6b65\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":true},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":true}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":null}]},{\"name\":\"workday-window\",\"raw\":[{\"days\":{\"kind\":\"workday\"},\"windows\":[{\"from\":\"09:00\",\"to\":\"18:00\"}]}],\"normalized\":[{\"days\":{\"kind\":\"workday\"},\"windows\":[{\"from\":540,\"to\":1080}]}],\"unbounded\":false,\"summary\":\"\u5de5\u4f5c\u65e5 09:00\u201318:00\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":true},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":false}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080}}]},{\"name\":\"any-with-overnight\",\"raw\":[{\"days\":{\"kind\":\"any\"},\"windows\":[{\"from\":1320,\"to\":480}]}],\"normalized\":[{\"days\":{\"kind\":\"any\"},\"windows\":[{\"from\":1320,\"to\":480}]}],\"unbounded\":false,\"summary\":\"\u6bcf\u5929 22:00\u201308:00\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":false},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":false}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1320}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1320}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1320}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1320}}]},{\"name\":\"dow-subset\",\"raw\":[{\"days\":{\"kind\":\"dow\",\"days\":[1,3,5]},\"windows\":[{\"from\":600,\"to\":700}]}],\"normalized\":[{\"days\":{\"kind\":\"dow\",\"days\":[1,3,5]},\"windows\":[{\"from\":600,\"to\":700}]}],\"unbounded\":false,\"summary\":\"\u5468\u4e00\u3001\u5468\u4e09\u3001\u5468\u4e94 10:00\u201311:40\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":false},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":false}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":600}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":600}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":null}]},{\"name\":\"dow-all-seven-collapses\",\"raw\":[{\"days\":{\"kind\":\"dow\",\"days\":[0,1,2,3,4,5,6]},\"windows\":[{\"from\":600,\"to\":700}]}],\"normalized\":[{\"days\":{\"kind\":\"any\"},\"windows\":[{\"from\":600,\"to\":700}]}],\"unbounded\":false,\"summary\":\"\u6bcf\u5929 10:00\u201311:40\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":false},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":true}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":600}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":600}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":600}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":600}}]},{\"name\":\"dow-empty-collapses\",\"raw\":[{\"days\":{\"kind\":\"dow\",\"days\":[]},\"windows\":[{\"from\":600,\"to\":700}]}],\"normalized\":[{\"days\":{\"kind\":\"any\"},\"windows\":[{\"from\":600,\"to\":700}]}],\"unbounded\":false,\"summary\":\"\u6bcf\u5929 10:00\u201311:40\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":false},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":true}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":600}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":600}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":600}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":600}}]},{\"name\":\"flat-window-shorthand\",\"raw\":[{\"days\":{\"kind\":\"any\"},\"from\":\"08:00\",\"to\":\"10:00\"}],\"normalized\":[{\"days\":{\"kind\":\"any\"},\"windows\":[{\"from\":480,\"to\":600}]}],\"unbounded\":false,\"summary\":\"\u6bcf\u5929 08:00\u201310:00\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":false},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":false}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":600}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":600}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":480}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":480}}]},{\"name\":\"zero-length-window-is-unbounded\",\"raw\":[{\"days\":{\"kind\":\"workday\"},\"windows\":[{\"from\":540,\"to\":540}]}],\"normalized\":[{\"days\":{\"kind\":\"workday\"},\"windows\":[{\"from\":540,\"to\":540}]}],\"unbounded\":true,\"summary\":\"\u5168\u5929\u540c\u6b65\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":true},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":true}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":null},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":null}]},{\"name\":\"dedupes-windows\",\"raw\":[{\"days\":{\"kind\":\"any\"},\"windows\":[{\"from\":540,\"to\":600},{\"from\":540,\"to\":600},{\"from\":660,\"to\":720}]}],\"normalized\":[{\"days\":{\"kind\":\"any\"},\"windows\":[{\"from\":540,\"to\":600},{\"from\":660,\"to\":720}]}],\"unbounded\":false,\"summary\":\"\u6bcf\u5929 09:00\u201310:00\u300111:00\u201312:00\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":false},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":true}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":600}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":540}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":540}}]},{\"name\":\"drops-bad-windows\",\"raw\":[{\"days\":{\"kind\":\"any\"},\"windows\":[{\"from\":\"abc\",\"to\":600},{\"from\":700,\"to\":800}]}],\"normalized\":[{\"days\":{\"kind\":\"any\"},\"windows\":[{\"from\":700,\"to\":800}]}],\"unbounded\":false,\"summary\":\"\u6bcf\u5929 11:40\u201313:20\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":true},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":false}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":700}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":700}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":800}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":700}}]},{\"name\":\"two-rules-or\",\"raw\":[{\"days\":{\"kind\":\"workday\"},\"windows\":[{\"from\":\"09:00\",\"to\":\"18:00\"}]},{\"days\":{\"kind\":\"offday\"},\"windows\":[{\"from\":\"10:00\",\"to\":\"20:00\"}]}],\"normalized\":[{\"days\":{\"kind\":\"workday\"},\"windows\":[{\"from\":540,\"to\":1080}]},{\"days\":{\"kind\":\"offday\"},\"windows\":[{\"from\":600,\"to\":1200}]}],\"unbounded\":false,\"summary\":\"\u5de5\u4f5c\u65e5 09:00\u201318:00\uff1b\u4f11\u606f\u65e5 10:00\u201320:00\",\"evaluations\":[{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079,\"dow\":3,\"allowed\":true},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1410,\"dow\":3,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":29,\"minutes\":30,\"dow\":4,\"allowed\":false},{\"year\":2026,\"month\":10,\"day\":31,\"minutes\":780,\"dow\":6,\"allowed\":true},{\"year\":2026,\"month\":11,\"day\":1,\"minutes\":660,\"dow\":0,\"allowed\":true}],\"nextChanges\":[{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":539},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":540},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":720},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080}},{\"from\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1079},\"next\":{\"year\":2026,\"month\":10,\"day\":28,\"minutes\":1080}}]}]}"

// ---- fixture 驱动的对拍 ------------------------------------------------

///|
/// 测试内联工具:join / 两位数字补零(包内私有函数对 _test.mbt 不可见)。
fn test_join(parts : Array[String], sep : String) -> String {
  let buf = StringBuilder()
  for i, part in parts {
    if i > 0 {
      buf.write_string(sep)
    }
    buf.write_string(part)
  }
  buf.to_string()
}

///|
fn test_two_digits(n : Int32) -> String {
  if n < 10 {
    "0\{n}"
  } else {
    "\{n}"
  }
}

///|
fn parse_json(text : String) -> Json {
  @json.parse(text) catch {
    _ => panic()
  }
}

///|
fn check(cond : Bool, msg : String) -> Unit {
  if !cond {
    println(msg)
    panic()
  }
}

///|
fn fobj(v : Json?) -> Map[String, Json] {
  match v {
    Some(Object(o)) => o
    _ => panic()
  }
}

///|
fn fstr(v : Json?) -> String {
  match v {
    Some(String(s)) => s
    _ => panic()
  }
}

///|
fn fint(v : Json?) -> Int32 {
  match v {
    Some(Number(n, ..)) => n.to_int()
    _ => panic()
  }
}

///|
fn fbool(v : Json?) -> Bool {
  match v {
    Some(True) => true
    _ => false
  }
}

///|
fn farr(v : Json?) -> Array[Json] {
  match v {
    Some(Array(a)) => a
    _ => panic()
  }
}

///|
fn fany(v : Json?) -> Json {
  match v {
    Some(j) => j
    None => panic()
  }
}

///|
fn fmoment(o : Map[String, Json]) -> @core.CivilMoment {
  @core.CivilMoment::new(
    fint(o.get("year")),
    fint(o.get("month")),
    fint(o.get("day")),
    fint(o.get("minutes")),
  )
}

///|
/// fixture 的 `normalized` 字段是严格形态(无脏数据),按它精确还原期望值。
fn fixture_days(v : Json?) -> @core.DayPredicate {
  let obj = fobj(v)
  let kind = fstr(obj.get("kind"))
  if kind == "any" {
    @core.Any
  } else if kind == "workday" {
    @core.Workday
  } else if kind == "offday" {
    @core.Offday
  } else if kind == "dow" {
    let days : Array[Int32] = []
    for item in farr(obj.get("days")) {
      days.push(fint(Some(item)))
    }
    @core.Dow(days)
  } else {
    panic()
  }
}

///|
fn fixture_schedule(v : Json?) -> @core.Schedule? {
  match v {
    Some(Array(rules)) => {
      let out : Array[@core.ScheduleRule] = []
      for rule in rules {
        let obj = fobj(Some(rule))
        let windows : Array[@core.ScheduleWindow] = []
        for w in farr(obj.get("windows")) {
          let pair = fobj(Some(w))
          windows.push({
            from: fint(pair.get("from")),
            to: fint(pair.get("to")),
          })
        }
        out.push({ days: fixture_days(obj.get("days")), windows, })
      }
      Some(out)
    }
    Some(Null) | None => None
    _ => panic()
  }
}

///|
/// 调试用:把归一化结果打回可读文本,断言失败时便于定位。
fn describe_schedule(schedule : @core.Schedule?) -> String {
  match schedule {
    None => "None"
    Some(rules) => {
      let parts : Array[String] = []
      for r in rules {
        let days = match r.days {
          Any => "Any"
          Workday => "Workday"
          Offday => "Offday"
          Dow(list) => {
            let items : Array[String] = []
            for d in list {
              items.push("\{d}")
            }
            let joined = test_join(items, ",")
            "Dow(\{joined})"
          }
        }
        let windows : Array[String] = []
        for w in r.windows {
          windows.push("\{w.from}-\{w.to}")
        }
        let window_text = test_join(windows, ",")
        parts.push("\{days} \{window_text}")
      }
      test_join(parts, ";")
    }
  }
}

///|
fn describe_moment(m : @core.CivilMoment?) -> String {
  match m {
    Some(x) => "\{x.year}-\{x.month}-\{x.day} \{x.minutes} 分"
    None => "None"
  }
}

///|
fn fixture_run_case(case : Json, is_workday : @core.IsWorkday) -> Unit {
  let obj = fobj(Some(case))
  let name = fstr(obj.get("name"))
  let actual = @core.normalize_schedule(fany(obj.get("raw")))
  let expected = fixture_schedule(obj.get("normalized"))
  if actual != expected {
    println("用例 \{name}:归一化结果不一致")
    println("  实际:\{describe_schedule(actual)}")
    println("  期望:\{describe_schedule(expected)}")
    panic()
  }
  check(
    @core.schedule_is_unbounded(actual) == fbool(obj.get("unbounded")),
    "用例 \{name}:unbounded 判定不一致",
  )
  check(
    @core.format_schedule_summary(actual) == fstr(obj.get("summary")),
    "用例 \{name}:摘要文案不一致(实际 \{@core.format_schedule_summary(actual)})",
  )
  for eval in farr(obj.get("evaluations")) {
    let e = fobj(Some(eval))
    let moment = fmoment(e)
    // 星期几必须两侧同口径 —— 这是唯一会静默错位的字段(差一天不报错)
    check(
      moment.day_of_week() == fint(e.get("dow")),
      "用例 \{name}:\{moment.year}-\{moment.month}-\{moment.day} 的星期几不一致",
    )
    check(
      @core.within_schedule(actual, moment, is_workday) ==
      fbool(e.get("allowed")),
      "用例 \{name}:\{moment.year}-\{moment.month}-\{moment.day} \{moment.minutes} 分的允许判定不一致",
    )
  }
  for change in farr(obj.get("nextChanges")) {
    let c = fobj(Some(change))
    let now = fmoment(fobj(c.get("from")))
    let next = @core.next_schedule_change(actual, now, is_workday)
    match c.get("next") {
      Some(Null) =>
        check(
          next == None,
          "用例 \{name}:\{now.minutes} 分之后应无翻转点",
        )
      Some(v) => {
        let expected_next = fmoment(fobj(Some(v)))
        check(
          next == Some(expected_next),
          "用例 \{name}:\{now.minutes} 分之后的下一翻转点不一致(实际 \{describe_moment(next)})",
        )
      }
      None => check(next == None, "用例 \{name}:应无翻转点")
    }
  }
}

///|
test "schedule fixture 对拍(与 Node/Rust 同一份 schedule.json)" {
  let data = parse_json(FIXTURE_JSON)
  let top = fobj(Some(data))
  let workdays : Array[String] = []
  for d in farr(top.get("workdays")) {
    workdays.push(fstr(Some(d)))
  }
  // workday 判定:fixture 给定的工作日集合(键格式 YYYY-MM-DD)
  let is_workday : @core.IsWorkday = fn(y, m, d) {
    let key = "\{y}-\{test_two_digits(m)}-\{test_two_digits(d)}"
    let mut hit = false
    for w in workdays {
      if w == key {
        hit = true
        break
      }
    }
    hit
  }
  for case in farr(top.get("cases")) {
    fixture_run_case(case, is_workday)
  }
}

// ---- 民用日期算法(Howard Hinnant)---------------------------------------

///|
test "days_from_civil/civil_from_days:纪元天数锚点与互逆" {
  assert_eq(@core.days_from_civil(1970, 1, 1), 0L)
  assert_eq(@core.days_from_civil(2024, 2, 29), 19782L)
  assert_eq(@core.days_from_civil(2026, 10, 28), 20754L)
  assert_eq(@core.days_from_civil(2000, 2, 29), 11016L)
  assert_eq(@core.days_from_civil(1900, 3, 1), -25508L)
  assert_eq(@core.days_from_civil(2100, 2, 28), 47540L)
  let dates : Array[(Int32, Int32, Int32)] = [
    (1970, 1, 1),
    (1969, 12, 31),
    (2023, 2, 28),
    (2023, 3, 1),
    (2024, 2, 28),
    (2024, 2, 29),
    (2024, 3, 1),
    (2000, 2, 29),
    (1900, 2, 28),
    (1900, 3, 1),
    (2100, 2, 28),
    (2100, 3, 1),
    (2028, 2, 29),
    (2028, 3, 1),
  ]
  for (y, m, d) in dates {
    check(
      @core.civil_from_days(@core.days_from_civil(y, m, d)) == (y, m, d),
      "\{y}-\{m}-\{d} 的日期换算应互逆",
    )
  }
}

///|
test "闰年边界:闰年 2 月 29 天,世纪平年 2 月 28 天" {
  // 2024(普通闰年)、2000(被 400 整除的闰年):2/28 → 3/1 差 2 天
  assert_eq(
    @core.days_from_civil(2024, 3, 1) - @core.days_from_civil(2024, 2, 28),
    2L,
  )
  assert_eq(
    @core.days_from_civil(2000, 3, 1) - @core.days_from_civil(2000, 2, 28),
    2L,
  )
  // 2023(平年)、1900(被 100 整除但不被 400 整除的平年):差 1 天
  assert_eq(
    @core.days_from_civil(2023, 3, 1) - @core.days_from_civil(2023, 2, 28),
    1L,
  )
  assert_eq(
    @core.days_from_civil(1900, 3, 1) - @core.days_from_civil(1900, 2, 28),
    1L,
  )
}

///|
test "day_of_week 与 JS Date.getDay 同口径" {
  let dow = fn(y : Int32, m : Int32, d : Int32) {
    @core.CivilMoment::new(y, m, d, 0).day_of_week()
  }
  assert_eq(dow(1970, 1, 1), 4) // 周四
  assert_eq(dow(1969, 12, 31), 3) // 周三
  assert_eq(dow(2024, 2, 29), 4) // 闰日周四
  assert_eq(dow(2026, 10, 28), 3) // 周三
  assert_eq(dow(2026, 10, 31), 6) // 周六
  assert_eq(dow(2026, 11, 1), 0) // 周日
  assert_eq(dow(2000, 1, 1), 6) // 周六
  assert_eq(dow(2028, 2, 29), 2) // 闰日周二
  assert_eq(dow(2100, 2, 28), 0) // 周日
}

// ---- 窗口判定 ------------------------------------------------------------

///|
test "within_window:含头不含尾,from == to 不设限,跨午夜拆两段" {
  // 09:00–18:00
  let w : @core.ScheduleWindow = { from: 540, to: 1080, }
  check(!@core.within_window(w, 539), "08:59 不在")
  check(@core.within_window(w, 540), "09:00 在(含头)")
  check(@core.within_window(w, 1079), "17:59 在")
  check(!@core.within_window(w, 1080), "18:00 不在(不含尾)")
  // from == to = 这一条不设限
  let free : @core.ScheduleWindow = { from: 540, to: 540, }
  check(@core.within_window(free, 0), "from == to 零点也在")
  check(@core.within_window(free, 1439), "from == to 23:59 也在")
  // 跨午夜 22:00–08:00
  let night : @core.ScheduleWindow = { from: 1320, to: 480, }
  check(@core.within_window(night, 1410), "23:30 在")
  check(@core.within_window(night, 100), "01:40 在")
  check(!@core.within_window(night, 720), "12:00 不在")
}

// ---- 归一化 --------------------------------------------------------------

///|
test "normalize 上限截断:规则与窗口各取前 8 条" {
  // 10 条规则 → 只留前 8 条
  let buf = StringBuilder()
  buf.write_string("[")
  for i in 0..<10 {
    if i > 0 {
      buf.write_string(",")
    }
    buf.write_string(
      "{\"days\":{\"kind\":\"any\"},\"windows\":[{\"from\":0,\"to\":60}]}",
    )
  }
  buf.write_string("]")
  match @core.normalize_schedule(parse_json(buf.to_string())) {
    Some(rules) => {
      assert_eq(rules.length(), @core.SCHEDULE_MAX_RULES)
      for r in rules {
        assert_eq(r.windows.length(), 1)
      }
    }
    None => panic()
  }
  // 一条规则 10 个窗口 → 只留前 8 个
  let buf2 = StringBuilder()
  buf2.write_string("[{\"days\":{\"kind\":\"any\"},\"windows\":[")
  for i in 0..<10 {
    if i > 0 {
      buf2.write_string(",")
    }
    buf2.write_string("{\"from\":\{i},\"to\":\{i + 60}}")
  }
  buf2.write_string("]}]")
  match @core.normalize_schedule(parse_json(buf2.to_string())) {
    Some(rules) => {
      assert_eq(rules.length(), 1)
      let windows = rules[0].windows
      assert_eq(windows.length(), @core.SCHEDULE_MAX_WINDOWS)
      assert_eq(windows[0].from, 0)
      assert_eq(windows[@core.SCHEDULE_MAX_WINDOWS - 1].from, 7)
    }
    None => panic()
  }
}

///|
test "normalize:days 字符串简写与非法 kind 归一" {
  let raw = parse_json(
    "[{\"days\":\"workday\",\"windows\":[{\"from\":600,\"to\":700}]},{\"days\":\"offday\",\"windows\":[{\"from\":600,\"to\":700}]},{\"days\":\"nonsense\",\"windows\":[{\"from\":600,\"to\":700}]}]",
  )
  match @core.normalize_schedule(raw) {
    Some(rules) => {
      assert_eq(rules.length(), 3)
      check(
        rules[0].days == @core.Workday,
        "days=\"workday\" 应归一为 Workday",
      )
      check(
        rules[1].days == @core.Offday,
        "days=\"offday\" 应归一为 Offday",
      )
      check(rules[2].days == @core.Any, "非法 kind 应归一为 Any")
    }
    None => panic()
  }
}

///|
test "parse_clock 数字边界:0 ≤ n < 1440 且向下取整,越界丢弃" {
  let raw = parse_json(
    "[{\"days\":{\"kind\":\"any\"},\"windows\":[{\"from\":540.7,\"to\":1439.9},{\"from\":1440,\"to\":1441},{\"from\":-1,\"to\":10},{\"from\":\"23:59\",\"to\":\"00:00\"}]}]",
  )
  match @core.normalize_schedule(raw) {
    Some(rules) => {
      let windows = rules[0].windows
      // 540.7 → 540、1439.9 → 1439;1440 / -1 越界丢弃;"23:59"/"00:00" 文本可解析
      assert_eq(windows.length(), 2)
      assert_eq(windows[0].from, 540)
      assert_eq(windows[0].to, 1439)
      assert_eq(windows[1].from, 1439)
      assert_eq(windows[1].to, 0)
    }
    None => panic()
  }
}

///|
test "next_change:跨午夜窗口跨过闰日(2/29 → 3/1)" {
  // 2028-02-29(周二)23:30,窗口每天 23:00–次日 08:00:
  // 下一翻转点是次日(3 月 1 日)08:00,日期换算必须正确跨过闰日
  let schedule : @core.Schedule = [
    { days: Any, windows: [{ from: 1380, to: 480, }], },
  ]
  let is_workday : @core.IsWorkday = fn(_y, _m, _d) { true }
  let now = @core.CivilMoment::at(2028, 2, 29, 23, 30)
  let next = @core.next_schedule_change(Some(schedule), now, is_workday)
  check(
    next == Some(@core.CivilMoment::new(2028, 3, 1, 480)),
    "闰日跨午夜翻转点(实际 \{describe_moment(next)})",
  )
}

///|
test "常量与 Node/Rust 对齐" {
  assert_eq(@core.SCHEDULE_MAX_RULES, 8)
  assert_eq(@core.SCHEDULE_MAX_WINDOWS, 8)
  assert_eq(@core.MINUTES_PER_DAY, 1440)
}
