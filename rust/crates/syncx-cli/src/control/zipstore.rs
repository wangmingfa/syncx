//! 最小 ZIP 写入器 + 「打包暂存区」,对应 Node 的 `src/zip.ts` 与
//! `src/api/routes/direct.ts` 里那段暂存逻辑(ADR-0028 第 16 条)。
//!
//! 只做 **store**(方法 0,不压缩),两个理由与 Node 侧一致:
//!  - 直发的瓶颈是链路与往返,不是 CPU;压缩会让「100MB 上限」的语义变模糊
//!    (包内体积 ≠ 源文件体积),而判定必须可预期;
//!  - store 可以纯流式:边读边写、边算 CRC,任何一个文件都不必整个读进内存。
//!
//! 写出的包与 Node 的 `writeZip` 逐字段同构(数据描述符 + UTF-8 名 + 中央目录),
//! 因此两个后端产出的 .zip 在解压侧没有区别(时间戳除外:两边都取本机时间)。

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use chrono::{Datelike, Local, Timelike};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 一次打包最多塞这么多,与直发单文件上限同口径。
pub const ZIP_MAX_BYTES: u64 = 100 * 1024 * 1024;
/// 暂存目录的保鲜期:用户打开发送弹窗后又关掉,不能把文件永久留在 `.tmp` 里。
const STAGING_TTL: Duration = Duration::from_secs(2 * 60 * 60);

const LOCAL_SIG: u32 = 0x0403_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
const DESCRIPTOR_SIG: u32 = 0x0807_4b50;
/// bit 3 = 长度/CRC 写在数据之后;bit 11 = 文件名是 UTF-8。
const FLAGS: u16 = 0x0808;

/// 读文件时的块大小:与直发分片同值,纯粹为了两处行为一致、好对照。
const READ_BUF: usize = 256 * 1024;

/// 暂存区在一次进程里只有一个写者(路由是多线程的),读写清单必须串起来,
/// 否则并发上传会互相覆盖 `manifest.json`。
static STAGE_LOCK: Mutex<()> = Mutex::new(());

pub struct ZipEntry {
    /// 包内路径:只支持同级文件名(分隔符会被替换掉)。
    pub name: String,
    /// 源文件绝对路径。
    pub path: PathBuf,
    /// 源文件大小,用于发现「打包过程中被改动」。
    pub size: u64,
}

pub struct ZipResult {
    pub size: u64,
    pub sha256: String,
}

/// `manifest.json` 的一条(Node 同结构:键名就是这三个单词,无需 camelCase)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub name: String,
    /// 暂存文件名(`000.dat` 这种),真实名字只在清单里,避免路径穿越。
    pub file: String,
    pub size: u64,
}

#[derive(Debug, Deserialize, Serialize)]
struct Manifest {
    #[serde(default)]
    entries: Vec<ManifestEntry>,
}

/// 用户可见的体量文案:与 Node 的 `fmtBytes` 同格式(1 位小数)。
pub fn human_bytes(n: u64) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / 1024.0 / 1024.0)
    }
}

/// 批次号:与前端 `crypto.randomUUID()` 同字符集,同时挡住路径穿越。
pub fn batch_ok(batch: &str) -> bool {
    !batch.is_empty()
        && batch.len() <= 64
        && batch
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 暂存根目录:`<configDir>/inbox/.tmp`(与直发暂存同一处)。
pub fn staging_root(config_dir: &Path) -> PathBuf {
    config_dir.join("inbox").join(".tmp")
}

pub fn batch_dir(root: &Path, batch: &str) -> PathBuf {
    root.join(format!("zip-{batch}"))
}

/* ============================ 暂存 ============================ */

fn read_manifest(dir: &Path) -> Vec<ManifestEntry> {
    let Ok(text) = fs::read_to_string(dir.join("manifest.json")) else {
        return Vec::new();
    };
    let Ok(manifest) = serde_json::from_str::<Manifest>(&text) else {
        return Vec::new();
    };
    // 逐条校验:清单可能被旧版本或人手改过,不能无条件相信里面的文件名。
    manifest
        .entries
        .into_iter()
        .filter(|e| is_slot(&e.file) && e.size > 0)
        .collect()
}

fn is_slot(file: &str) -> bool {
    file.len() == 7
        && file.ends_with(".dat")
        && file[..3].chars().all(|c| c.is_ascii_digit())
}

fn write_manifest(dir: &Path, entries: &[ManifestEntry]) {
    let manifest = Manifest {
        entries: entries.to_vec(),
    };
    if let Ok(text) = serde_json::to_string_pretty(&manifest) {
        let _ = fs::write(dir.join("manifest.json"), text);
    }
}

/// 清掉上次没打完的暂存目录:只删真被遗弃的(超过保鲜期),正在传的别动。
pub fn sweep_staging(root: &Path) {
    let Ok(list) = fs::read_dir(root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in list.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with("zip-") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if now
            .duration_since(modified)
            .is_ok_and(|age| age > STAGING_TTL)
        {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// 把一个上传文件放进批次暂存目录,返回这一批当前累计的文件数。
pub fn stage_entry(
    root: &Path,
    batch: &str,
    name: &str,
    size: u64,
    bytes: &[u8],
) -> io::Result<usize> {
    let _guard = STAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    fs::create_dir_all(root)?;
    sweep_staging(root);
    let dir = batch_dir(root, batch);
    fs::create_dir_all(&dir)?;
    let mut entries = read_manifest(&dir);
    // 槽位取现有最大值 +1:清单被清过但 .dat 还在时也不会互相覆盖。
    let next = entries
        .iter()
        .filter_map(|e| e.file[..3].parse::<u32>().ok())
        .max()
        .map(|max| max + 1)
        .unwrap_or(0);
    let slot = format!("{next:03}.dat");
    fs::write(dir.join(&slot), bytes)?;
    entries.push(ManifestEntry {
        name: name.to_string(),
        file: slot,
        size,
    });
    write_manifest(&dir, &entries);
    Ok(entries.len())
}

/// 读一批暂存清单(按上传顺序)。
pub fn staged_entries(config_dir: &Path, batch: &str) -> Vec<ManifestEntry> {
    let _guard = STAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_manifest(&batch_dir(&staging_root(config_dir), batch))
}

/// 丢弃一批暂存(打包成功后源文件已经进包,留着只是占地)。
pub fn drop_batch(config_dir: &Path, batch: &str) {
    let _guard = STAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _ = fs::remove_dir_all(batch_dir(&staging_root(config_dir), batch));
}

/// 包名:去掉路径分隔符,补 `.zip` 后缀,空则给个按本机时间的默认名。
pub fn archive_name(raw: Option<&str>) -> String {
    let fallback = {
        let now = Local::now();
        format!(
            "打包-{:04}{:02}{:02}-{:02}{:02}",
            now.year(),
            now.month(),
            now.day(),
            now.hour(),
            now.minute()
        )
    };
    let base: String = raw
        .unwrap_or("")
        .chars()
        .map(|c| if c == '/' || c == '\\' { '_' } else { c })
        .take(120)
        .collect();
    let name = base.trim();
    let name = if name.is_empty() { fallback } else { name.to_string() };
    if name.to_ascii_lowercase().ends_with(".zip") {
        name
    } else {
        format!("{name}.zip")
    }
}

/* ============================ 写入 ============================ */

/// 包内只放同级文件名:`../` 或 `a/b` 这种路径要么是调用方出错,要么是攻击。
fn entry_name(raw: &str, used: &mut HashSet<String>) -> String {
    let flat: String = {
        let mut out = String::new();
        let mut last_sep = false;
        for c in raw.chars() {
            if c == '/' || c == '\\' {
                if !last_sep {
                    out.push('_');
                }
                last_sep = true;
            } else {
                out.push(c);
                last_sep = false;
            }
        }
        let trimmed = out.trim();
        if trimmed.is_empty() {
            "file".to_string()
        } else {
            trimmed.to_string()
        }
    };
    let mut name = flat.clone();
    let mut n = 1;
    while used.contains(&name.to_lowercase()) {
        name = match flat.rfind('.') {
            Some(dot) if dot > 0 => format!("{} ({n}){}", &flat[..dot], &flat[dot..]),
            _ => format!("{flat} ({n})"),
        };
        n += 1;
    }
    used.insert(name.to_lowercase());
    name
}

const CRC_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
};

/// 增量 CRC-32:入参是「未取反」的中间值,首块传 0xffffffff,末块再取反。
fn crc32_update(mut crc: u32, buf: &[u8]) -> u32 {
    for byte in buf {
        crc = CRC_TABLE[((crc ^ *byte as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    crc
}

/// MS-DOS 时间戳:ZIP 的老格式只有它,秒的精度是 2 秒。
fn dos_stamp() -> (u16, u16) {
    let now = Local::now();
    let year = now.year().max(1980) as u16;
    let time =
        ((now.hour() as u16) << 11) | ((now.minute() as u16) << 5) | (now.second() as u16 / 2);
    let date = ((year - 1980) << 9) | ((now.month() as u16) << 5) | now.day() as u16;
    (time, date)
}

/// 边写边算指纹与长度:整包 sha256 是直发提议要用的。
struct Sink {
    file: BufWriter<File>,
    hasher: Sha256,
    offset: u64,
}

impl Sink {
    fn put(&mut self, buf: &[u8]) -> io::Result<()> {
        self.file.write_all(buf)?;
        self.hasher.update(buf);
        self.offset += buf.len() as u64;
        Ok(())
    }
}

/// 写一个 store 模式的 zip,返回包大小、整包 sha256 与实际条目名。
///
/// 源文件在读取过程中变短/变长直接报错,而不是产出一个损坏的包 ——
/// 「看起来发出去了,对方解压报错」比当场失败难查得多。
pub fn write_zip(dest: &Path, entries: &[ZipEntry]) -> io::Result<ZipResult> {
    let file = File::create(dest)?;
    let mut sink = Sink {
        file: BufWriter::new(file),
        hasher: Sha256::new(),
        offset: 0,
    };
    let (time, date) = dos_stamp();
    let mut used: HashSet<String> = HashSet::new();
    let mut central: Vec<u8> = Vec::new();

    for entry in entries {
        let name = entry_name(&entry.name, &mut used);
        let name_bytes = name.as_bytes();
        let local_offset = sink.offset;

        let mut local = [0u8; 30];
        local[0..4].copy_from_slice(&LOCAL_SIG.to_le_bytes());
        local[4..6].copy_from_slice(&20u16.to_le_bytes()); // 需要 2.0 才能解
        local[6..8].copy_from_slice(&FLAGS.to_le_bytes());
        // 8..10 = 0:store(不压缩)
        local[10..12].copy_from_slice(&time.to_le_bytes());
        local[12..14].copy_from_slice(&date.to_le_bytes());
        // 14..26 的 CRC / 压缩后大小 / 原始大小留 0,交给数据描述符。
        local[26..28].copy_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        sink.put(&local)?;
        sink.put(name_bytes)?;

        let mut source = File::open(&entry.path)?;
        let mut buf = vec![0u8; READ_BUF];
        let mut crc = 0xffff_ffffu32;
        let mut written = 0u64;
        loop {
            let n = source.read(&mut buf)?;
            if n == 0 {
                break;
            }
            crc = crc32_update(crc, &buf[..n]);
            written += n as u64;
            sink.put(&buf[..n])?;
        }
        if written != entry.size {
            return Err(io::Error::other(format!(
                "打包时源文件大小变了:{} ({} → {written} 字节)",
                entry.name, entry.size
            )));
        }
        let final_crc = crc ^ 0xffff_ffff;

        let mut descriptor = [0u8; 16];
        descriptor[0..4].copy_from_slice(&DESCRIPTOR_SIG.to_le_bytes());
        descriptor[4..8].copy_from_slice(&final_crc.to_le_bytes());
        descriptor[8..12].copy_from_slice(&(written as u32).to_le_bytes());
        descriptor[12..16].copy_from_slice(&(written as u32).to_le_bytes());
        sink.put(&descriptor)?;

        let mut record = [0u8; 46];
        record[0..4].copy_from_slice(&CENTRAL_SIG.to_le_bytes());
        record[4..6].copy_from_slice(&20u16.to_le_bytes()); // version made by
        record[6..8].copy_from_slice(&20u16.to_le_bytes()); // version needed
        record[8..10].copy_from_slice(&FLAGS.to_le_bytes());
        // 10..12 = store
        record[12..14].copy_from_slice(&time.to_le_bytes());
        record[14..16].copy_from_slice(&date.to_le_bytes());
        record[16..20].copy_from_slice(&final_crc.to_le_bytes());
        record[20..24].copy_from_slice(&(written as u32).to_le_bytes());
        record[24..28].copy_from_slice(&(written as u32).to_le_bytes());
        record[28..30].copy_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        // 30..42:extra / comment / 盘号 / 属性全 0
        record[42..46].copy_from_slice(&(local_offset as u32).to_le_bytes());
        central.extend_from_slice(&record);
        central.extend_from_slice(name_bytes);
    }

    let cd_offset = sink.offset;
    let cd_size = central.len() as u32;
    sink.put(&central)?;

    let mut eocd = [0u8; 22];
    eocd[0..4].copy_from_slice(&EOCD_SIG.to_le_bytes());
    // 4..8:本盘号 / 中央目录所在盘 = 0
    eocd[8..10].copy_from_slice(&(entries.len() as u16).to_le_bytes());
    eocd[10..12].copy_from_slice(&(entries.len() as u16).to_le_bytes());
    eocd[12..16].copy_from_slice(&cd_size.to_le_bytes());
    eocd[16..20].copy_from_slice(&(cd_offset as u32).to_le_bytes());
    sink.put(&eocd)?;

    let size = sink.offset;
    sink.file.flush()?;
    let hasher = std::mem::replace(&mut sink.hasher, Sha256::new());
    Ok(ZipResult {
        size,
        sha256: hex::encode(hasher.finalize()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "syncx-zip-{tag}-{}-{}",
            std::process::id(),
            Local::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 只解自己写的包:顺着 EOCD 找中央目录,逐条核对名字/大小/CRC。
    fn read_central(path: &Path) -> Vec<(String, u32, u32)> {
        let bytes = fs::read(path).unwrap();
        let eocd = bytes.len() - 22;
        assert_eq!(
            u32::from_le_bytes(bytes[eocd..eocd + 4].try_into().unwrap()),
            EOCD_SIG
        );
        let count = u16::from_le_bytes(bytes[eocd + 10..eocd + 12].try_into().unwrap());
        let cd_size = u32::from_le_bytes(bytes[eocd + 12..eocd + 16].try_into().unwrap()) as usize;
        let cd_offset = u32::from_le_bytes(bytes[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
        assert_eq!(cd_offset + cd_size, eocd, "中央目录与 EOCD 应严丝合缝");
        let mut at = cd_offset;
        let mut out = Vec::new();
        for _ in 0..count {
            assert_eq!(
                u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()),
                CENTRAL_SIG
            );
            let crc = u32::from_le_bytes(bytes[at + 16..at + 20].try_into().unwrap());
            let size = u32::from_le_bytes(bytes[at + 24..at + 28].try_into().unwrap());
            let name_len = u16::from_le_bytes(bytes[at + 28..at + 30].try_into().unwrap()) as usize;
            let name = String::from_utf8(bytes[at + 46..at + 46 + name_len].to_vec()).unwrap();
            out.push((name, crc, size));
            at += 46 + name_len;
        }
        out
    }

    #[test]
    fn store_zip_roundtrips_entries() {
        let dir = temp_dir("roundtrip");
        let a = dir.join("a.bin");
        let b = dir.join("b.txt");
        let a_data = vec![7u8; 1000];
        let b_data = b"hello zip".to_vec();
        fs::write(&a, &a_data).unwrap();
        fs::write(&b, &b_data).unwrap();
        let dest = dir.join("out.zip");
        let result = write_zip(
            &dest,
            &[
                ZipEntry {
                    name: "a.bin".into(),
                    path: a.clone(),
                    size: a_data.len() as u64,
                },
                ZipEntry {
                    name: "b.txt".into(),
                    path: b.clone(),
                    size: b_data.len() as u64,
                },
            ],
        )
        .unwrap();
        assert_eq!(result.size, fs::metadata(&dest).unwrap().len());
        assert_eq!(
            result.sha256,
            hex::encode(Sha256::digest(fs::read(&dest).unwrap()))
        );

        let central = read_central(&dest);
        assert_eq!(central.len(), 2);
        assert_eq!(central[0].0, "a.bin");
        assert_eq!(central[0].2, a_data.len() as u32);
        assert_eq!(
            central[0].1,
            crc32_update(0xffff_ffff, &a_data) ^ 0xffff_ffff
        );
        assert_eq!(central[1].2, b_data.len() as u32);
    }

    #[test]
    fn names_are_flattened_and_deduped() {
        let mut used = HashSet::new();
        assert_eq!(entry_name("../etc/passwd", &mut used), ".._etc_passwd");
        assert_eq!(entry_name("  ", &mut used), "file");
        assert_eq!(entry_name("a.txt", &mut used), "a.txt");
        assert_eq!(entry_name("A.TXT", &mut used), "A (1).TXT");
        assert_eq!(entry_name("a.txt", &mut used), "a (2).txt");
    }

    #[test]
    fn staging_collects_files_in_order() {
        let dir = temp_dir("stage");
        let root = staging_root(&dir);
        assert_eq!(stage_entry(&root, "batch-1", "one.txt", 3, b"abc").unwrap(), 1);
        assert_eq!(stage_entry(&root, "batch-1", "two.txt", 2, b"de").unwrap(), 2);
        let entries = staged_entries(&dir, "batch-1");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "one.txt");
        assert_eq!(entries[0].file, "000.dat");
        assert_eq!(entries[1].file, "001.dat");
        assert!(staged_entries(&dir, "no-such-batch").is_empty());
        drop_batch(&dir, "batch-1");
        assert!(!batch_dir(&root, "batch-1").exists());
    }

    #[test]
    fn archive_names_and_batches_are_validated() {
        assert!(batch_ok("3f2a-uuid_1"));
        assert!(!batch_ok(""));
        assert!(!batch_ok("../etc"));
        assert!(!batch_ok(&"a".repeat(65)));
        assert_eq!(archive_name(Some("报告")), "报告.zip");
        assert_eq!(archive_name(Some("a/b.zip")), "a_b.zip");
        assert_eq!(archive_name(Some("x.ZIP")), "x.ZIP");
        assert!(archive_name(None).starts_with("打包-"));
        assert!(archive_name(Some("   ")).ends_with(".zip"));
    }
}
