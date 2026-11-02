//! 定长分块、SHA-256 与 CDC 内容定义分块。对应 Node 侧 `src/blockstore.ts`。
//!
//! CDC 这块是整个移植里**最不能"差不多"**的部分:块哈希写进索引后,
//! 两端按哈希比对内容。边界只要差一个字节,块集合就对不上,症状是
//! "这个文件永远同步不动",而且不崩、不报错、日志干净。
//!
//! 两个必须逐位复刻的细节:
//!  1. `GEAR_TABLE` 用 mulberry32 + 固定种子 `0x9e3779b9` 生成 —— 种子一经写入
//!     源码即永久冻结,换了表就等于换了协议;
//!  2. 滚动指纹**必须带窗口移出项**。只留累入项时,同一个字节被循环移位 32 次
//!     后回到原值,改动带来的差分会永久旋转下去而不消失,其后每个边界都跟着错位
//!     (ADR-0019 记的"1 字节改写让整文件重传")。

/// 定长块大小:1 MiB。**协议常量**,与 Node 侧 `BLOCK_SIZE` 必须一致。
pub const BLOCK_SIZE: usize = 1024 * 1024;

/// CDC 块长下限:太短的碎片会让哈希列表本身成为索引/线路负担。
pub const CDC_MIN_CHUNK: usize = 256 * 1024;

/// CDC 块长上限,同时是「单个块响应」的体积上限(接收闸门按此拒绝超大块)。
pub const CDC_MAX_CHUNK: usize = 4 * 1024 * 1024;

/// 目标平均块长 ≈ 1 MiB(2^20 分之一命中)。
const CDC_MASK: u32 = (1 << 20) - 1;

/// 指纹窗口宽度:一个字节只对随后这么多字节内的边界判定有影响。
const BUZ_WINDOW: usize = 32;

/// 内容指纹滚动表:256 个 u32,mulberry32 固定种子确定性生成。
///
/// 种子 `0x9e3779b9`(黄金比例常数)是**协议的一部分**。Rust 侧每次进程启动
/// 重算这张表代价极小(256 次乘法),故不落盘也不 lazy-static。
fn gear_table() -> [u32; 256] {
    let mut a: u32 = 0x9e37_79b9;
    let mut table = [0u32; 256];
    for slot in table.iter_mut() {
        a = a.wrapping_add(0x6d2b_79f5);
        // 逐字符对齐 src/blockstore.ts 的 GEAR_TABLE:`Math.imul(..., 61 | t)` 里
        // 那个 `| t` 不能省,写成 `61` 会得到另一张表 —— 表一换,所有 CDC 边界
        // 全部错位,两端块集合永远对不上。
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        *slot = t ^ (t >> 14);
    }
    table
}

/// 带窗口移出项的 Buzhash 滚动指纹。
///
/// 折叠式:`fp_i = XOR_{d=0}^{W-1} rot^d(GEAR[b_{i-d}])`,由此得到逐步形式
/// `fp_i = rot1(fp_{i-1}) ^ GEAR[in] ^ rot^W(GEAR[out])`。
/// 32 位整数上 `rot^32` 是恒等,所以移出项就是 `GEAR[out]` 本身。
struct RollingFingerprint {
    gear: [u32; 256],
    /// 环形缓冲:槽位 `i & (W-1)` 存 W 个字节前进场的那个字节。
    entered: [u8; BUZ_WINDOW],
    fp: u32,
    seen: usize,
}

impl RollingFingerprint {
    fn new(gear: [u32; 256]) -> Self {
        Self {
            gear,
            entered: [0u8; BUZ_WINDOW],
            fp: 0,
            seen: 0,
        }
    }

    /// 吃进一个字节,返回滚动后的指纹。
    fn step(&mut self, byte: u8) -> u32 {
        let i = self.seen;
        self.seen += 1;
        let slot = i & (BUZ_WINDOW - 1);
        // 窗口还在填(前 W 个字节)时没有移出项
        let removal = if i >= BUZ_WINDOW {
            self.gear[self.entered[slot] as usize]
        } else {
            0
        };
        self.entered[slot] = byte;
        self.fp = self.fp.rotate_left(1) ^ self.gear[byte as usize] ^ removal;
        self.fp
    }
}

/// 按内容定义边界切块。返回每块的 `(offset, length)`,不复制字节 ——
/// 调用方用切片视图取内容,与 Node 的 `subarray` 语义一致。
///
/// 规则:距上一边界不足 `CDC_MIN_CHUNK` 不判边界;此后逐字节滚动指纹,
/// 低 20 位全 0 即收块(期望平均 ≈1 MiB),达 `CDC_MAX_CHUNK` 强制收块;
/// EOF 就是边界(末块可短)。
pub fn chunk_ranges(data: &[u8]) -> Vec<(usize, usize)> {
    let mut chunks = Vec::new();
    if data.is_empty() {
        return chunks;
    }
    let mut buz = RollingFingerprint::new(gear_table());
    let mut start = 0usize;
    for i in 0..data.len() {
        let fp = buz.step(data[i]);
        let len = i + 1 - start;
        if (len >= CDC_MIN_CHUNK && (fp & CDC_MASK) == 0)
            || len >= CDC_MAX_CHUNK
            || i + 1 == data.len()
        {
            chunks.push((start, len));
            start = i + 1;
        }
    }
    chunks
}

/// 定长分块:按 `BLOCK_SIZE` 直接切片,返回 `(offset, length)`。
pub fn split_ranges(data_len: usize) -> Vec<(usize, usize)> {
    let mut blocks = Vec::new();
    let mut offset = 0usize;
    while offset < data_len {
        let len = BLOCK_SIZE.min(data_len - offset);
        blocks.push((offset, len));
        offset += len;
    }
    blocks
}

/// 单块 SHA-256(十六进制小写),与 Node 侧 `hashBlock` 同口径。
pub fn hash_block(block: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(block);
    format!("{:x}", hasher.finalize())
}

/// 一次流式扫描得到的整份文件视图。对应 Node 侧 `FileViews`。
///
/// 三个视图必须来自**同一次读取**:分开读会让文件在两遍之间被改动,
/// 定长块与 CDC 块描述的是两份不同的字节,接收端按 CDC 取块、按定长验完整性,
/// 必然对不上。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileViews {
    pub size: u64,
    /// 定长块哈希(旧对端只认这个)。
    pub blocks: Vec<String>,
    /// CDC 块哈希;空文件为 `[]`。
    pub cdh: Vec<String>,
    /// CDC 块长,与 `cdh` 一一对应。
    pub clens: Vec<u64>,
}

/// 流式文件视图计算器:逐段喂字节,末尾 `finish()` 取结果。
///
/// 语义与 Node 侧 `hashFileViews` 逐字节等价(见其注释):定长视图按 1 MiB 窗口独立
/// 哈希;CDC 视图的滚动指纹跨窗口连续(移出项要读到前 32 字节的进场记录),块哈希
/// 用一个持续的 SHA-256 按片段喂 —— SHA-256 本身是流式折叠,分段 update 与整体
/// update 同值,边界落在窗口中间也只换个片段。
///
/// EOF 那一边界不在字节循环里判,而是 `finish()` 收尾:这样长度恰为窗口整数倍时
/// 也不会漏末块。
pub struct ViewHasher {
    buz: RollingFingerprint,
    /// 未凑满一个窗口的尾部字节。
    partial: Vec<u8>,
    blocks: Vec<String>,
    cdh: Vec<String>,
    clens: Vec<u64>,
    /// 已处理字节数,即多窗口处理时当前窗口的全局起始偏移。
    size: usize,
    /// 当前 CDC 块的全局起点。
    chunk_start: usize,
    chunk_hash: sha2::Sha256,
}

impl Default for ViewHasher {
    fn default() -> Self {
        Self::new()
    }
}

impl ViewHasher {
    pub fn new() -> Self {
        use sha2::Digest;

        Self {
            buz: RollingFingerprint::new(gear_table()),
            partial: Vec::with_capacity(BLOCK_SIZE),
            blocks: Vec::new(),
            cdh: Vec::new(),
            clens: Vec::new(),
            size: 0,
            chunk_start: 0,
            chunk_hash: sha2::Sha256::new(),
        }
    }

    /// 喂入一段字节。凑满一个 `BLOCK_SIZE` 窗口就处理掉,余量留到下次。
    pub fn push(&mut self, bytes: &[u8]) {
        let mut rest = bytes;
        while !rest.is_empty() {
            let need = BLOCK_SIZE - self.partial.len();
            let take = need.min(rest.len());
            self.partial.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.partial.len() < BLOCK_SIZE {
                break;
            }
            let window = std::mem::replace(&mut self.partial, Vec::with_capacity(BLOCK_SIZE));
            self.flush_window(&window);
        }
    }

    /// 处理一个窗口(可能短于 `BLOCK_SIZE`:只有 EOF 才短)。
    fn flush_window(&mut self, window: &[u8]) {
        use sha2::Digest;

        self.blocks.push(hash_block(window));

        let mut seg_start = 0usize;
        for (j, byte) in window.iter().enumerate() {
            let fp = self.buz.step(*byte);
            let len = self.size + j + 1 - self.chunk_start;
            if (len >= CDC_MIN_CHUNK && (fp & CDC_MASK) == 0) || len >= CDC_MAX_CHUNK {
                self.chunk_hash.update(&window[seg_start..=j]);
                let digest = std::mem::replace(&mut self.chunk_hash, sha2::Sha256::new());
                self.cdh.push(format!("{:x}", digest.finalize()));
                self.clens.push(len as u64);
                self.chunk_start = self.size + j + 1;
                seg_start = j + 1;
            }
        }
        self.chunk_hash.update(&window[seg_start..]);
        self.size += window.len();
    }

    /// 收尾:处理残留窗口,并把最后一个未收的 CDC 块按 EOF 边界收下。
    pub fn finish(mut self) -> FileViews {
        use sha2::Digest;

        if !self.partial.is_empty() {
            let window = std::mem::take(&mut self.partial);
            self.flush_window(&window);
        }
        if self.chunk_start < self.size {
            let digest = self.chunk_hash.finalize();
            self.cdh.push(format!("{:x}", digest));
            self.clens.push((self.size - self.chunk_start) as u64);
        }
        FileViews {
            size: self.size as u64,
            blocks: self.blocks,
            cdh: self.cdh,
            clens: self.clens,
        }
    }
}
