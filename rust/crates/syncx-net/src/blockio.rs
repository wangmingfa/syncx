//! 单文件的块读写与供块。对应 Node 侧 `src/peer.ts` 里供块/落块的那部分。
//!
//! 这里只做**单文件**的字节搬运与校验,不碰索引、不碰冲突判定 —— 那些属于 daemon
//! (清单第 5 项)。分层的理由:块层是纯函数式的读写 + 哈希,可以脱离会话单测。
//!
//! 两条必须守住的不变量:
//!  1. **落盘前逐块校验哈希**。对端不可信,块内容也可能在磁盘上被改过;哈希不过
//!     就整文件重来,而不是写一半留下混合内容。
//!  2. **先写临时文件再原子重命名**。中断同步不能留下半截图,否则下一轮会把它当
//!     「本机新编辑」推回对端,一个断线变成两端数据互踩。

use std::path::{Path, PathBuf};

use syncx_core::blockstore::{hash_block, split_ranges};

use crate::wire::WireError;

/// 单个块在文件里的位置(定长口径)。
pub struct BlockRange {
    pub offset: usize,
    pub length: usize,
}

/// 定长分块的位置表。空文件返回空表(零块的条目本身是合法的)。
pub fn fixed_ranges(file_len: u64) -> Vec<BlockRange> {
    split_ranges(file_len as usize)
        .into_iter()
        .map(|(offset, length)| BlockRange { offset, length })
        .collect()
}

/// 计算文件的定长块哈希列表(十六进制小写)。
///
/// 流式读取:只保留一个块的缓冲,不为整个文件分配内存。
pub async fn hash_file_blocks(path: &Path) -> std::io::Result<Vec<String>> {
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(path).await?;
    let len = file.metadata().await?.len();
    let mut hashes = Vec::new();
    let mut buf = vec![0u8; syncx_core::blockstore::BLOCK_SIZE];

    for range in fixed_ranges(len) {
        let mut filled = 0usize;
        while filled < range.length {
            let read = file.read(&mut buf[filled..range.length]).await?;
            if read == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "文件在分块计算途中被截断",
                ));
            }
            filled += read;
        }
        hashes.push(hash_block(&buf[..range.length]));
    }
    Ok(hashes)
}

/// 读一个定长块。
pub async fn read_block(path: &Path, range: &BlockRange) -> std::io::Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(range.offset as u64))
        .await?;
    let mut buf = vec![0u8; range.length];
    file.read_exact(&mut buf).await?;
    Ok(buf)
}

/// 把一组块按顺序拼成一个文件(临时文件 + fsync + 原子重命名)。
///
/// 返回实际写入的字节数。哈希校验由调用方在 `fetch` 时逐块做过,这里再校验一次
/// 是**有意的重复**:这是数据落盘前的最后一道门,代价只是一次 SHA-256。
pub async fn write_blocks(
    path: &Path,
    blocks: &[(BlockRange, Vec<u8>)],
) -> Result<u64, BlockIoError> {
    use tokio::io::AsyncWriteExt;

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temp = temp_path(path);
    {
        let mut file = tokio::fs::File::create(&temp).await?;
        let mut written = 0u64;
        for (range, bytes) in blocks {
            if bytes.len() != range.length {
                let _ = tokio::fs::remove_file(&temp).await;
                return Err(BlockIoError::LengthMismatch {
                    expected: range.length,
                    actual: bytes.len(),
                });
            }
            file.write_all(bytes).await?;
            written += bytes.len() as u64;
        }
        file.flush().await?;
        file.sync_all().await?;
        tokio::fs::rename(&temp, path).await?;
        Ok(written)
    }
}

/// 校验一个块的内容是否与声明的哈希一致。
pub fn verify_block(expected_hash: &str, bytes: &[u8]) -> bool {
    hash_block(bytes) == expected_hash
}

/// 同目录下的临时文件名。
///
/// 必须与目标**同目录**:跨目录的 rename 可能跨文件系统,那就退化成拷贝而不是
/// 原子替换,中断仍会留下半截图。
fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    path.with_file_name(format!(".{name}.syncx-part"))
}

/// 块 I/O 错误。
#[derive(Debug, thiserror::Error)]
pub enum BlockIoError {
    #[error("块读写失败:{0}")]
    Io(#[from] std::io::Error),
    #[error("块长度不符:期望 {expected},实际 {actual}")]
    LengthMismatch { expected: usize, actual: usize },
    #[error("块哈希校验失败:{0}")]
    HashMismatch(String),
    #[error("线路错误:{0}")]
    Wire(#[from] WireError),
}
