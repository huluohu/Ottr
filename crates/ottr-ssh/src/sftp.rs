//! Spike #4（Task 8）：SFTP 并行分块传输 + 断点续传。
//!
//! Phase 1 的 ottr-transfer crate 直接继承本模块（接口与 journal 语义不变）。
//!
//! ## 设计（简报 Step 1）
//!
//! - 远端 `stat` 取文件长度，按 [`CHUNK_SIZE`]（1 MiB）切块；
//! - `chunks` 个并发 worker 共享**同一条 SFTP 子系统通道**（一个
//!   [`RawSftpSession`]，`&self` 方法可并发调用、按请求 id 配对响应），
//!   每个 worker 处理自己的 chunk：chunk 内再按服务器报文上限（探测
//!   `limits@openssh.com`，缺省 256 KiB）切成子请求，用 `try_join_all`
//!   在同一通道上流水线化（in-flight ≈ chunks × 4 ≈ 16，与 russh-sftp
//!   高层 File 的 `max_concurrent_reads=16` 同量级）。这正是 spike 验证点：
//!   **单通道请求流水线深度**是否是 SFTP 吞吐瓶颈（对比 `--chunks 1` 与
//!   `--chunks 4`，见 examples/sftp_spike.rs）；
//! - journal：每完成一个 chunk 向 journal 文件追加一行该 chunk 的起始
//!   offset；重启时扫描 journal，已完成 chunk 直接跳过。
//!
//! ## journal 正确性不变量（Phase 1 ottr-transfer 必须保持）
//!
//! **journal 行只在 chunk 数据完整写入目标文件之后追加**：
//! - 下载：本地 `write_all_at`（pwrite，到 OS 页缓存）返回后；
//! - 上传：该 chunk 全部远端 write 请求的 ack（Status Ok）返回后。
//!
//! 由此推出两个方向：
//!
//! 1. journal 中的 offset ⇒ 该 chunk 一定已完整写盘。`kill -9` 只杀进程、
//!    不丢页缓存，因此进程级中断无需 fsync；机器级崩溃才需要 fsync
//!    （正式版再议，spike 不做）。
//! 2. 写了一半（partial chunk）被杀 ⇒ 该 offset 必不在 journal ⇒ 重启后
//!    **整个 chunk 重传**，幂等覆盖原 offset 区间。**绝不允许 journal 先行、
//!    数据后补**——那会让 partial chunk 被永久跳过，文件静默损坏。
//!
//! journal 格式：每行一个十进制 offset（chunk 起始字节），无其他内容。
//!
//! ## spike 简化（如实注明）
//!
//! - 进度/续传日志直接 `println!`（Task 8 裁定要求进程日志含
//!   `resume from chunk N`），Phase 1 应换成 tracing / 回调；
//! - 错误统一映射为 crate [`Error::Protocol`]，无结构化重试分类；
//! - chunk 内子请求完成到 worker 写盘之间有 join 屏障（每 chunk 一轮），
//!   4 worker 错峰后通道基本不空转；更细粒度的无屏障流水线是 Phase 1
//!   优化项，不属本 spike 验证范围。

use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures::future::try_join_all;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::RawSftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};

use crate::russh_impl::SshSession;
use crate::{Error, Result};

/// chunk 粒度（简报规定 1 MiB）。journal 记录的是 chunk 起始 offset，
/// 续传粒度即 chunk 粒度。
pub const CHUNK_SIZE: u64 = 1024 * 1024;

/// 进度日志频率（每 N 个已完成 chunk 一行）。
const PROGRESS_EVERY: u64 = 16;

/// russh-sftp 默认报文上限 256 KiB；读写子请求按同款开销公式收窄
/// （russh-sftp `fs/file.rs`：READ_OVERHEAD_LENGTH=13 / WRITE_OVERHEAD_LENGTH=25），
/// 保证单个请求的响应包不会越过服务器 `max_packet_len`。
const MAX_PACKET_LEN: u64 = 262_144;
const READ_OVERHEAD: u64 = 13;
const WRITE_OVERHEAD: u64 = 25;

/// 一次并行传输的统计（本次运行的耗时；续传 chunk 不计入耗时字节但计入进度）。
#[derive(Debug, Clone)]
pub struct TransferStats {
    pub total_bytes: u64,
    pub chunks_total: usize,
    /// 本次启动时 journal 已命中、直接跳过的 chunk 数。
    pub chunks_resumed: usize,
    pub elapsed: std::time::Duration,
}

impl TransferStats {
    /// 本次运行的有效吞吐（MB/s，10^6 字节口径）。
    pub fn mb_per_s(&self) -> f64 {
        let transferred = self.total_bytes
            - (self.chunks_resumed as u64).saturating_mul(CHUNK_SIZE).min(self.total_bytes);
        transferred as f64 / 1e6 / self.elapsed.as_secs_f64().max(1e-9)
    }
}

/// 断点续传 journal。语义见模块注释的不变量。
struct Journal {
    file: Mutex<std::fs::File>,
}

impl Journal {
    /// 扫描已有 journal，返回已完成 chunk 的起始 offset 集合。
    /// 文件不存在 / 行损坏按"未完成"处理（容忍尾行半截——append 原子性
    /// 足够行级写入，但显式容错更稳）。
    fn load(path: &Path) -> HashSet<u64> {
        std::fs::read_to_string(path)
            .map(|s| {
                s.lines()
                    .filter_map(|l| l.trim().parse::<u64>().ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 以追加模式打开 journal（不存在则创建）。
    fn open(path: &Path) -> std::io::Result<Self> {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        Ok(Self { file: Mutex::new(file) })
    }

    /// 记录一个已完成 chunk（写行 + flush 到 OS）。
    /// **必须在该 chunk 数据完整落盘之后调用**（模块注释的不变量）。
    fn record(&self, offset: u64) -> std::io::Result<()> {
        let mut f = self.file.lock().unwrap();
        f.write_all(format!("{offset}\n").as_bytes())?;
        f.flush()
    }
}

fn protocol_error(e: impl std::error::Error + Send + Sync + 'static, ctx: &str) -> Error {
    Error::Protocol {
        message: format!("{ctx}: {e}"),
        source: Some(Box::new(e)),
    }
}

fn plain_error(ctx: String) -> Error {
    Error::Protocol { message: ctx, source: None }
}

/// SFTP EOF 状态包（read 越过文件尾；对"按 stat 长度分块"的我们意味着
/// 文件在传输中被截短，属于异常终止条件而非正常 EOF）。
fn is_eof(e: &SftpError) -> bool {
    matches!(e, SftpError::Status(s) if s.status_code == StatusCode::Eof)
}

/// 打开 SFTP 子系统并完成协议握手。
async fn open_sftp(session: &SshSession) -> Result<Arc<RawSftpSession>> {
    let stream = session.open_sftp_stream().await?;
    let sftp = Arc::new(RawSftpSession::new(stream));
    sftp.init()
        .await
        .map_err(|e| protocol_error(e, "sftp init"))?;
    Ok(sftp)
}

async fn remote_size(sftp: &RawSftpSession, remote: &str) -> Result<u64> {
    let attrs = sftp
        .stat(remote)
        .await
        .map_err(|e| protocol_error(e, &format!("stat {remote}")))?;
    attrs.attrs.size.ok_or_else(|| plain_error(format!("{remote}: stat attrs have no size")))
}

/// 探测读写子请求块大小：报文上限收窄 + 服务器 limits@openssh.com 明示上限。
async fn probe_block_sizes(sftp: &RawSftpSession, handle: &str) -> (u32, u32) {
    let mut read_block = (MAX_PACKET_LEN - READ_OVERHEAD) as u32;
    let mut write_block = ((MAX_PACKET_LEN - WRITE_OVERHEAD).saturating_sub(handle.len() as u64)
        as u32)
        .min(256 * 1024);
    if let Ok(ext) = sftp.limits().await {
        if ext.max_read_len > 0 {
            read_block = read_block.min(ext.max_read_len as u32);
        }
        if ext.max_write_len > 0 {
            write_block = write_block.min(ext.max_write_len as u32);
        }
    }
    (read_block.max(1024), write_block.max(1024))
}

fn chunk_table(total: u64, done: &HashSet<u64>) -> Vec<(usize, u64, u64)> {
    let chunks_total = total.div_ceil(CHUNK_SIZE) as usize;
    (0..chunks_total)
        .map(|i| {
            let off = i as u64 * CHUNK_SIZE;
            let len = (total - off).min(CHUNK_SIZE);
            (i, off, len)
        })
        .filter(|(_, off, _)| !done.contains(off))
        .collect()
}

fn print_resume_line(pending: &[(usize, u64, u64)], chunks_total: usize, workers: usize) {
    let resumed = chunks_total - pending.len();
    if resumed > 0 {
        let first = pending
            .first()
            .map(|(i, _, _)| *i)
            .unwrap_or(chunks_total); // 全部已完成：无可续传
        println!(
            "resume from chunk {first} ({resumed}/{chunks_total} chunks already journaled, {workers} workers)",
        );
    } else {
        println!(
            "starting fresh: {chunks_total} chunks x {:.1} MiB, {workers} workers",
            CHUNK_SIZE as f64 / (1024.0 * 1024.0)
        );
    }
}

/// 并行分块下载：远端 `remote` → 本地 `local`。
///
/// `chunks` 为并发 worker 数（简报签名里的 `chunks: 4`；spike 默认 4）。
/// journal 语义见模块注释。返回本次运行的统计。
pub async fn download_parallel(
    session: &SshSession,
    remote: &str,
    local: &Path,
    chunks: usize,
    journal_path: &Path,
) -> Result<TransferStats> {
    let started = Instant::now();
    let workers = chunks.max(1);

    let sftp = open_sftp(session).await?;
    let total = remote_size(&sftp, remote).await?;
    let read_handle = sftp
        .open(remote, OpenFlags::READ, FileAttributes::empty())
        .await
        .map_err(|e| protocol_error(e, &format!("open remote {remote}")))?
        .handle;

    let done = Journal::load(journal_path);
    let pending = chunk_table(total, &done);
    let chunks_total = total.div_ceil(CHUNK_SIZE) as usize;
    let resumed = chunks_total - pending.len();
    print_resume_line(&pending, chunks_total, workers);

    // 本地文件按远端长度定长（稀疏预分配）；partial chunk 的旧字节会被
    // 重传幂等覆盖。写入用 pwrite（write_all_at），worker 间无共享游标。
    let local_file = Arc::new(
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(local)?,
    );
    local_file.set_len(total)?;

    let journal = Arc::new(Journal::open(journal_path)?);
    let (read_block, _) = probe_block_sizes(&sftp, &read_handle).await;

    let queue = Arc::new(Mutex::new(VecDeque::from(pending)));
    let progress = Arc::new(AtomicU64::new(0));
    let remaining = queue.lock().unwrap().len() as u64;

    let handles = (0..workers).map(|_| {
        let sftp = Arc::clone(&sftp);
        let handle = read_handle.clone();
        let queue = Arc::clone(&queue);
        let journal = Arc::clone(&journal);
        let local_file = Arc::clone(&local_file);
        let progress = Arc::clone(&progress);
        async move {
            loop {
                let next = queue.lock().unwrap().pop_front();
                let Some((_index, offset, len)) = next else { break };
                let data =
                    read_chunk_pipelined(&sftp, &handle, offset, len as usize, read_block).await?;
                // 顺序不变量：数据先完整写盘（页缓存，kill -9 不丢），后记 journal。
                local_file.write_all_at(&data, offset)?;
                journal.record(offset)?;
                let done_now = progress.fetch_add(1, Ordering::Relaxed) + 1;
                if done_now % PROGRESS_EVERY == 0 || done_now == remaining {
                    let chunks_done = chunks_total as u64 - remaining + done_now;
                    let bytes = (chunks_done * CHUNK_SIZE).min(total);
                    println!(
                        "progress {chunks_done}/{chunks_total} chunks | {:.1} MiB | {:.1} MB/s",
                        bytes as f64 / (1024.0 * 1024.0),
                        bytes as f64 / 1e6 / started.elapsed().as_secs_f64().max(1e-9),
                    );
                }
            }
            Ok::<(), Error>(())
        }
    });
    try_join_all(handles).await?;

    sftp.close(read_handle).await.map_err(|e| protocol_error(e, "close remote handle"))?;

    Ok(TransferStats {
        total_bytes: total,
        chunks_total,
        chunks_resumed: resumed,
        elapsed: started.elapsed(),
    })
}

/// 单 chunk 读取：按 block 切子请求，一轮 `try_join_all` 让整块请求在同一
/// 通道上 in-flight（流水线）；短读块顺序补齐（SFTP read 允许少读；
/// OpenSSH 对未越尾的读几乎总是整块返回）。
async fn read_chunk_pipelined(
    sftp: &RawSftpSession,
    handle: &str,
    offset: u64,
    len: usize,
    block: u32,
) -> Result<Vec<u8>> {
    let mut out = vec![0u8; len];
    let mut parts: Vec<(usize, usize)> = Vec::new(); // (块内偏移, 请求长度)
    let mut pos = 0usize;
    while pos < len {
        let want = (len - pos).min(block as usize);
        parts.push((pos, want));
        pos += want;
    }

    let futs = parts.iter().map(|(rel, want)| {
        let off = offset + *rel as u64;
        let want = *want as u32;
        async move { sftp.read(handle, off, want).await }
    });
    let results = try_join_all(futs)
        .await
        .map_err(|e| protocol_error(e, &format!("sftp read chunk @{offset}")))?;

    for ((rel, want), data) in parts.iter().zip(results) {
        let rel = *rel;
        let want = *want;
        let got = data.data.len();
        if got == 0 {
            return Err(plain_error(format!(
                "unexpected EOF at offset {} (file shorter than stat size?)",
                offset + rel as u64
            )));
        }
        if got > want {
            return Err(plain_error(format!(
                "server over-read at offset {}: got {got}, asked {want}",
                offset + rel as u64
            )));
        }
        out[rel..rel + got].copy_from_slice(&data.data);
        let mut filled = got;
        while filled < want {
            let block_off = offset + (rel + filled) as u64;
            let more = sftp.read(handle, block_off, (want - filled) as u32).await;
            let more = match more {
                Ok(d) => d,
                Err(e) if is_eof(&e) => {
                    return Err(plain_error(format!(
                        "unexpected EOF at offset {block_off} (file shorter than stat size?)"
                    )))
                }
                Err(e) => return Err(protocol_error(e, "sftp read top-up")),
            };
            if more.data.is_empty() {
                return Err(plain_error(format!(
                    "unexpected EOF at offset {block_off} (file shorter than stat size?)"
                )));
            }
            out[rel + filled..rel + filled + more.data.len()].copy_from_slice(&more.data);
            filled += more.data.len();
        }
    }
    Ok(out)
}

/// 并行分块上传：本地 `local` → 远端 `remote`。与 [`download_parallel`] 同构。
///
/// 续传时远端以 `CREATE|WRITE` 重开（**绝不 TRUNCATE**，否则会抹掉已完成
/// chunk）；全新传输才 `CREATE|TRUNCATE|WRITE`。
pub async fn upload_parallel(
    session: &SshSession,
    local: &Path,
    remote: &str,
    chunks: usize,
    journal_path: &Path,
) -> Result<TransferStats> {
    let started = Instant::now();
    let workers = chunks.max(1);

    let sftp = open_sftp(session).await?;
    let total = std::fs::metadata(local)?.len();

    let done = Journal::load(journal_path);
    let pending = chunk_table(total, &done);
    let chunks_total = total.div_ceil(CHUNK_SIZE) as usize;
    let resumed = chunks_total - pending.len();
    print_resume_line(&pending, chunks_total, workers);

    let flags = if resumed > 0 {
        OpenFlags::CREATE | OpenFlags::WRITE
    } else {
        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
    };
    let write_handle = sftp
        .open(remote, flags, FileAttributes::empty())
        .await
        .map_err(|e| protocol_error(e, &format!("open remote {remote}")))?
        .handle;

    let journal = Arc::new(Journal::open(journal_path)?);
    let (_, write_block) = probe_block_sizes(&sftp, &write_handle).await;

    let local_file = Arc::new(std::fs::File::open(local)?);
    let queue = Arc::new(Mutex::new(VecDeque::from(pending)));
    let progress = Arc::new(AtomicU64::new(0));
    let remaining = queue.lock().unwrap().len() as u64;

    let handles = (0..workers).map(|_| {
        let sftp = Arc::clone(&sftp);
        let handle = write_handle.clone();
        let queue = Arc::clone(&queue);
        let journal = Arc::clone(&journal);
        let local_file = Arc::clone(&local_file);
        let progress = Arc::clone(&progress);
        async move {
            loop {
                let next = queue.lock().unwrap().pop_front();
                let Some((_index, offset, len)) = next else { break };
                let mut data = vec![0u8; len as usize];
                local_file.read_exact_at(&mut data, offset)?;
                // 远端写：块切分后一轮 try_join_all 流水线；raw write 对每个
                // ack 校验 Status Ok。全部 ack 返回，chunk 才算完成 —— 然后才
                // 记 journal（顺序不变量，见模块注释）。
                let mut parts: Vec<(usize, usize)> = Vec::new();
                let mut pos = 0usize;
                while pos < data.len() {
                    let want = (data.len() - pos).min(write_block as usize);
                    parts.push((pos, want));
                    pos += want;
                }
                let sftp_ref: &RawSftpSession = &sftp;
                let handle_ref: &str = handle.as_str();
                let futs = parts.iter().map(|(rel, want)| {
                    let off = offset + *rel as u64;
                    let slice = data[*rel..*rel + *want].to_vec();
                    async move { sftp_ref.write(handle_ref, off, slice).await }
                });
                try_join_all(futs)
                    .await
                    .map_err(|e| protocol_error(e, &format!("sftp write chunk @{offset}")))?;
                journal.record(offset)?;
                let done_now = progress.fetch_add(1, Ordering::Relaxed) + 1;
                if done_now % PROGRESS_EVERY == 0 || done_now == remaining {
                    let chunks_done = chunks_total as u64 - remaining + done_now;
                    let bytes = (chunks_done * CHUNK_SIZE).min(total);
                    println!(
                        "progress {chunks_done}/{chunks_total} chunks | {:.1} MiB | {:.1} MB/s",
                        bytes as f64 / (1024.0 * 1024.0),
                        bytes as f64 / 1e6 / started.elapsed().as_secs_f64().max(1e-9),
                    );
                }
            }
            Ok::<(), Error>(())
        }
    });
    try_join_all(handles).await?;

    sftp.close(write_handle).await.map_err(|e| protocol_error(e, "close remote handle"))?;

    Ok(TransferStats {
        total_bytes: total,
        chunks_total,
        chunks_resumed: resumed,
        elapsed: started.elapsed(),
    })
}
