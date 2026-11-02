///|
// CDC 分块与哈希对拍:期望值全部来自 Node 实现导出的 golden fixture
// (rust/crates/syncx-core/fixtures/blocks.json)。
//
// PRNG 必须与 Node 侧 `prngBytes` 逐字符对齐(mulberry32,`Math.imul` 语义 =
// 32 位回绕乘法),否则后面比的是两份不同内容,失败信息会误导人。

const FIXTURE_BLOCKS_JSON : String = "{\"cases\":[{\"name\":\"empty\",\"seed\":1,\"size\":0,\"fixed\":[],\"cdc\":[]},{\"name\":\"one-byte\",\"seed\":2,\"size\":1,\"fixed\":[{\"length\":1,\"sha256\":\"149488d869cbef080602a371ab0d39d97af103fb726aaeb02ccd36c06f494e5d\"}],\"cdc\":[{\"length\":1,\"sha256\":\"149488d869cbef080602a371ab0d39d97af103fb726aaeb02ccd36c06f494e5d\"}]},{\"name\":\"sub-block\",\"seed\":3,\"size\":65536,\"fixed\":[{\"length\":65536,\"sha256\":\"ca68af75dd9b4ea19519022815494d812e7f94c0d49c13acca6c7e417668885b\"}],\"cdc\":[{\"length\":65536,\"sha256\":\"ca68af75dd9b4ea19519022815494d812e7f94c0d49c13acca6c7e417668885b\"}]},{\"name\":\"exact-block\",\"seed\":4,\"size\":1048576,\"fixed\":[{\"length\":1048576,\"sha256\":\"9ee6ceb0ccb83618ad6bf80fc0167a66b4023b59b5b31d8a0102da6304ad3a03\"}],\"cdc\":[{\"length\":861580,\"sha256\":\"bf21d3e5cbc4da7c30bec28181839120970e32957cbf61f9cd0bd544d50eab1b\"},{\"length\":186996,\"sha256\":\"047f0422ebda681c1b235e79f17b8dc93ce91f056ecbe63fd3ca44c8ea2029e0\"}]},{\"name\":\"block-plus-one\",\"seed\":5,\"size\":1048577,\"fixed\":[{\"length\":1048576,\"sha256\":\"2e0ff1b998035a349993fda4bfc6764de4b47249efd325c4814dd6de1bfe8b65\"},{\"length\":1,\"sha256\":\"49994461d6b46390f014c8c5275a8591ef8764760afe2739cee23f6fbe285778\"}],\"cdc\":[{\"length\":1048577,\"sha256\":\"7ee6178b4a47fa6c9f0e36a8377553f98dce8f0524beefcf3813e4c8ac667337\"}]},{\"name\":\"three-blocks\",\"seed\":6,\"size\":3158073,\"fixed\":[{\"length\":1048576,\"sha256\":\"837df33fc9688a08eb28d0ed72e2c63269ed18204b6af777aa6a60a391724230\"},{\"length\":1048576,\"sha256\":\"4e7ebec7a200b3400ca34c7420a82bd84372af7ed9c6a04ff548c33ffd2a0bfa\"},{\"length\":1048576,\"sha256\":\"aacbcbba2dcfa27c3ae29734a51bc154a50ebbc1a15de1f43096def67db25b1a\"},{\"length\":12345,\"sha256\":\"060feefa1df948b47857900fe92ec143cb3f109dae4ae42665a2463039c03835\"}],\"cdc\":[{\"length\":293470,\"sha256\":\"72bc7a6c279fb69d58553b8fc565bba533c7aaec13db07182b321f80eb680f76\"},{\"length\":1190083,\"sha256\":\"6f987b2df787b94678a4cb1e976d10c812fca940dcce172efa7d5c7beb1486f6\"},{\"length\":1360805,\"sha256\":\"8ccaad88a605a4ce9adfc8a30a38d2d0a381d4426020d308b1a64ada6017585d\"},{\"length\":313715,\"sha256\":\"3bcab014446b6655d370a7a2bf6f2c451f41f9771cf363280476cfcfeec2e3a1\"}]},{\"name\":\"cdc-small\",\"seed\":7,\"size\":307200,\"fixed\":[{\"length\":307200,\"sha256\":\"2e603accae926d5795d2a38a4846c69f0fbcbdb026703083198892b944c5d895\"}],\"cdc\":[{\"length\":307200,\"sha256\":\"2e603accae926d5795d2a38a4846c69f0fbcbdb026703083198892b944c5d895\"}]},{\"name\":\"cdc-medium\",\"seed\":8,\"size\":4194304,\"fixed\":[{\"length\":1048576,\"sha256\":\"1b97eae9ff192e0d308e7ea1b1048f37a0b5c7b9f5d6138670718a6eabbcb603\"},{\"length\":1048576,\"sha256\":\"2f0a0fb40f59b14a49d0db4881655469b089cfc4ae6952a22304bf118da7352e\"},{\"length\":1048576,\"sha256\":\"96b69fc122d5be06c12d07e56961392f324c019be31e896e7cd61f99cc814e63\"},{\"length\":1048576,\"sha256\":\"bd833536a3bc5fa0fcb4d23891c1338985b221fcafc3767bda6c8fb075ced5d2\"}],\"cdc\":[{\"length\":1799559,\"sha256\":\"13795501e569f0d78d7f7e2b4ebc5b1e2480b677596b879cd5c2197a5b6420bc\"},{\"length\":1248327,\"sha256\":\"c6289ffbfb6642154d9f66ad62980239e6fbde658b567149fb4b6fd9844a96ca\"},{\"length\":704745,\"sha256\":\"302ea669d2cab1232c9d91947257d832faf0d41773a9d6132fd4b89cbe726b89\"},{\"length\":394744,\"sha256\":\"7eae62bbaa8a27db231fd75975c464e106f96ee239a7947c04b850c6d40bb3de\"},{\"length\":46929,\"sha256\":\"e758b47a2389db6b88d9d18f8a314ec2855b53836c72389e8e2c5149044277dc\"}]},{\"name\":\"cdc-large\",\"seed\":9,\"size\":12582912,\"fixed\":[{\"length\":1048576,\"sha256\":\"ee1b79389d039aa4f631ac1d71197688eea0e151f23bf78ea3ae3155eaa68961\"},{\"length\":1048576,\"sha256\":\"e6f14d9c5d13c5508939dd243dd7e0f5fcc1301cc5f3c6a2b71119ef0370ca84\"},{\"length\":1048576,\"sha256\":\"b4c5e0dbae5016b804ae5272156f646c512ef5650f9ad1ac937238e291ef7f65\"},{\"length\":1048576,\"sha256\":\"6676b6da0a126d2dc31986843e1a1ea0848429934bd607adaac87497d4d19857\"},{\"length\":1048576,\"sha256\":\"60b63a8eca83105ebb118307acce41c113a9c7ab3c8b6510b19f5c26d44efb3a\"},{\"length\":1048576,\"sha256\":\"7f6273aa09c2563c1faf4b21ebff9a9cc3f7f621d36b40afd3d260fa1aba0f3a\"},{\"length\":1048576,\"sha256\":\"89d5a146e89078007764feabb6676996175637ca3ff045a4f91e38d696effba8\"},{\"length\":1048576,\"sha256\":\"5058c9aa3988bf25992a12591b7345b2b2b0460b5dbde2dbc272efc29a018389\"},{\"length\":1048576,\"sha256\":\"74097510e5f72f21aa6701286921430c4a430d927443834f2979241d27d1c31f\"},{\"length\":1048576,\"sha256\":\"cba018b12b1178e44c864db1b97a86dc932568d8f05b61cac4393c05f7ff9a62\"},{\"length\":1048576,\"sha256\":\"2d6e5debc8366ccfa8f9189aae3c9bb945696adfbede4b67d15cebed0d53523b\"},{\"length\":1048576,\"sha256\":\"3efe693c31d1c265bcc3fa6bbfdcba2f7c7ecf824d8e13928f3b043891befc96\"}],\"cdc\":[{\"length\":1225079,\"sha256\":\"40f822513a74564b8b2d0aa9da9cd59757821e67265ce2885d04f3fcae517b87\"},{\"length\":1083440,\"sha256\":\"0b7934c8538187b124c4ed984b3c85ef5a456ba2baff6de9731613d7b43389a4\"},{\"length\":2459637,\"sha256\":\"3c134a45ca73ebe1de32ede31909688793ea69699f38f2031df7dd921cb0a1b9\"},{\"length\":1964542,\"sha256\":\"d0692e2a8a2bbe83a1df68db0cd01ca220e87c3914071b871a30018b44fbb096\"},{\"length\":881453,\"sha256\":\"5b63a806cd353875c6aaec168278db219d10f290fa7ef01479f4ddef0ea2143b\"},{\"length\":562719,\"sha256\":\"6a3c184c2113087c5cf386ebf65b9ac4da38a5ef1494a8ad437ce7911a710791\"},{\"length\":1137528,\"sha256\":\"b193327aa16b6bce5095c5f1fe7e8ccb8d0c11f7f1a9e97f37e827872513e98d\"},{\"length\":1254728,\"sha256\":\"93fce26d2baf3cd6649afb90b029ff9ae9256a6e2ff209f5d416a5223ea2c9f6\"},{\"length\":1259905,\"sha256\":\"ef171ab72f75d82e2a408886dfa53dd6171bf8a8148725d89549a0562954291a\"},{\"length\":330460,\"sha256\":\"d8057fe777f6034e1ab4448389447e15582cc9228d81832141aaa034d029fd94\"},{\"length\":311774,\"sha256\":\"1c5fbfc8adb10df4960627167a03ace8dbe6a5df407756e6159e9f0e0a4db308\"},{\"length\":111647,\"sha256\":\"6e159562339166f943621611499a01f2a5f3f3010e3c4a923cc49ba61590f41e\"}]}]}"

///|
/// mulberry32:固定种子,逐字节推进。32 位运算在 UInt64 里做完再截断。
fn prng_bytes(seed : UInt64, length : Int32) -> Bytes {
  let mut a = seed
  Bytes::makei(length, _ => {
    a = (a + 0x6D2B79F5UL) & 0xFFFFFFFFUL
    let mut t = ((a ^ (a >> 15)) * (1UL | a)) & 0xFFFFFFFFUL
    t = ((t + (((t ^ (t >> 7)) * (61UL | t)) & 0xFFFFFFFFUL)) & 0xFFFFFFFFUL) ^
      t
    ((t ^ (t >> 14)) & 0xFFUL).to_byte()
  })
}

///|
/// 期望块列表 `[{length, sha256}]` → 实际算出的 (length, sha256) 列表。
fn blocks_as_pairs(blocks : Array[Json]) -> Array[(Int32, String)] {
  let out : Array[(Int32, String)] = []
  for block in blocks {
    let obj = json_object(block)
    out.push((json_number(obj["length"]).to_int(), json_string(obj["sha256"])))
  }
  out
}

///|
fn ranges_as_pairs(
  data : Bytes,
  ranges : Array[(Int32, Int32)],
) -> Array[(Int32, String)] {
  let out : Array[(Int32, String)] = []
  for pair in ranges {
    let (offset, len) = pair
    out.push((len, @core.hash_block(data[offset:offset + len].to_owned())))
  }
  out
}

///|
test "定长块与 CDC 块对拍 Node" {
  let root = @json.parse(FIXTURE_BLOCKS_JSON) catch { _ => panic() }
  let cases = json_array(json_object(root)["cases"])
  assert_true(cases.length() > 0)
  for case in cases {
    let c = json_object(case)
    let name = json_string(c["name"])
    let seed = json_number(c["seed"]).to_int()
    let size = json_number(c["size"]).to_int()
    let data = prng_bytes(seed.to_uint64(), size)
    // PRNG 必须先对齐,否则后面比的是两份不同内容
    assert_eq(data.length(), size, msg="用例 \{name}:PRNG 长度不符")
    // 定长块
    let fixed = ranges_as_pairs(data, @core.split_ranges(size))
    assert_eq(
      fixed,
      blocks_as_pairs(json_array(c["fixed"])),
      msg="用例 \{name}:定长块不一致",
    )
    // CDC 块
    let cdc = ranges_as_pairs(data, @core.chunk_ranges(data))
    assert_eq(
      cdc,
      blocks_as_pairs(json_array(c["cdc"])),
      msg="用例 \{name}:CDC 块不一致",
    )
  }
}

///|
/// CDC 的定义性约束:块长必须落在 [MIN, MAX] 内(末块可短),且拼接即原文。
///
/// 独立于 fixture 断言:即使 PRNG 哪天两侧跑偏,长度约束也必须成立。
test "CDC 块长落在约束区间且拼接即原文" {
  let data = prng_bytes(42, 8 * 1024 * 1024)
  let ranges = @core.chunk_ranges(data)
  assert_true(ranges.length() > 0)
  let mut total = 0
  let last = ranges.length() - 1
  for i in 0..<ranges.length() {
    let (offset, len) = ranges[i]
    assert_eq(offset, total, msg="块起始偏移必须连续(拼接即原文)")
    total += len
    if i != last {
      assert_true(
        len >= @core.CDC_MIN_CHUNK && len <= @core.CDC_MAX_CHUNK,
        msg="第 \{i} 块长度 \{len} 越界",
      )
    }
    assert_true(len > 0, msg="不应产生空块")
  }
  assert_eq(total, data.length(), msg="块总长必须等于原文长度")
}

///|
/// 纯 ASCII 串 → Bytes(`Bytes::of_string` 是 UTF-16 编码,这里只用测试向量)。
fn ascii_bytes(s : String) -> Bytes {
  let arr : Array[Byte] = []
  for c in s {
    arr.push(c.to_uint().to_byte())
  }
  Bytes::from_array(arr[0:arr.length()])
}

///|
/// SHA-256 标准测试向量:实现自写(moonbitlang/core 未提供),必须先过公开向量。
test "SHA-256 已知向量" {
  assert_eq(
    @core.hash_block(ascii_bytes("")),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  )
  assert_eq(
    @core.hash_block(ascii_bytes("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  )
  assert_eq(
    @core.hash_block(
      ascii_bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    ),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  )
}

///|
/// ViewHasher 的三个视图必须与「整文件一次性算」的独立口径一致,
/// 且分段喂入(窗口边界落在 push 中间)不改变结果。
test "ViewHasher 分段喂入与整体计算一致" {
  let data = prng_bytes(7, 3 * 1024 * 1024 + 12345)
  // 独立口径:定长块按 split_ranges,CDC 按 chunk_ranges
  let hasher = @core.ViewHasher::new()
  hasher.push(data)
  let whole = hasher.finish()
  assert_eq(whole.size, data.length().to_int64())
  // 定长块
  let expect_blocks : Array[String] = []
  for pair in @core.split_ranges(data.length()) {
    let (offset, len) = pair
    expect_blocks.push(@core.hash_block(data[offset:offset + len].to_owned()))
  }
  assert_eq(whole.blocks, expect_blocks)
  // CDC 块
  let expect_cdh : Array[String] = []
  let expect_clens : Array[Int64] = []
  for pair in @core.chunk_ranges(data) {
    let (offset, len) = pair
    expect_cdh.push(@core.hash_block(data[offset:offset + len].to_owned()))
    expect_clens.push(len.to_int64())
  }
  assert_eq(whole.cdh, expect_cdh)
  assert_eq(whole.clens, expect_clens)
  // 分段喂入:窗口边界切在任意位置结果不变
  let hasher2 = @core.ViewHasher::new()
  let mut pos = 0
  let cuts = [1, 1000000, 1048576, 1048577, 2097153, 3145728, data.length()]
  for cut in cuts {
    hasher2.push(data[pos:cut].to_owned())
    pos = cut
  }
  let split = hasher2.finish()
  assert_eq(split.blocks, whole.blocks)
  assert_eq(split.cdh, whole.cdh)
  assert_eq(split.clens, whole.clens)
}
