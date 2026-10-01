//! SFTP 并行分块传输 + 断点续传（Phase 0 spike #4 / Task 8 代码随迁）。
//!
//! Task 10 Step 1：本模块自 `ottr-ssh/src/sftp.rs` 原样迁入 ottr-transfer，
//! 接口与 journal 语义不变；journal 身份绑定等不变量见下文（测试随迁：
//! `tests/sftp_test.rs` 同一套 5 个真夹具用例）。russh 类型边界裁定见
//! crate 文档（lib.rs）：`FileTransfer` trait 签名纯自有类型，实现内部经
//! [`ottr_ssh::SshSession::open_sftp_stream`] 消费 russh `ChannelStream`
//! （与 `SshTransport::Channel` 例外同等待遇）。
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
//! 3. **journal 绑定传输身份（模式 + 路径 + 总字节），不匹配即拒**（Fix round 1
//!    I-1）：journal 文件第一行是 v1 自描述头部（[`journal_header`]），载入时与
//!    本次传输三方比对（下载：远端路径 + 远端 stat 大小；上传：远端目标路径 +
//!    本地源大小），不一致返回明确错误、提示删除或更换 journal——绝不按旧
//!    offset 静默续传（否则换文件复用旧 journal 会把已跳过的 chunk 混成
//!    两个文件的内容）。上传续传另以 `fsetstat(size=total)` 修剪远端可能
//!    遗留的超长尾部字节（早前更大文件的同名遗留）。
//!
//! journal 格式（v1）：第一行 [`journal_header`]（`ottr-journal v1` + TAB 分隔的
//! 路径/总字节/模式；TAB 以容忍含空格路径），其后每行一个十进制 offset（chunk
//! 起始字节）。
//!
//! ## spike 简化（如实注明）
//!
//! - 续传日志仍 `println!`（Task 8 裁定要求进程日志含 `resume from chunk N`）；
//!   进度日志已在 Task 10 Step 2 换成 [`ProgressHook`] 回调（src-tauri 转成
//!   Tauri 事件）；
//! - 错误统一映射为 crate [`Error::Protocol`]（另有 [`Error::Cancelled`] /
//!   [`Error::Io`]），无结构化重试分类；
//! - chunk 内子请求完成到 worker 写盘之间有 join 屏障（每 chunk 一轮），
//!   4 worker 错峰后通道基本不空转；更细粒度的无屏障流水线是 Phase 1
//!   优化项，不属本 spike 验证范围。

use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures::future::try_join_all;
use russh_sftp::client::RawSftpSession;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};

use ottr_ssh::SshSession;

use crate::{Error, Result};

/// chunk 粒度（简报规定 1 MiB）。journal 记录的是 chunk 起始 offset，
/// 续传粒度即 chunk 粒度。
pub const CHUNK_SIZE: u64 = 1024 * 1024;

/// 协作式取消令牌（Task 10 Step 2）：chunk 边界轮询的 AtomicBool（不引
/// tokio_util，一枚 bool 足够）。
///
/// 语义：[`CancelToken::cancel`] 置位后，每个 worker 在**下一个 chunk 边界**
/// 退出——in-flight chunk 正常完成/失败，不中途 drop 请求 future（russh-sftp
/// 的请求配对表不承受半途 future 消亡）；journal 只含已完整落盘的 chunk，
/// 因此取消对续传语义**零破坏**：同身份重传 = 断点续传。取消最坏延迟 =
/// 一个 chunk 的传输时长（1 MiB @ 本地夹具 ≈ 数十 ms）。
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// 置位取消信号（幂等；任意线程/任务可调用）。
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// 传输进度快照（每个 chunk 完成时回调一次；Task 10 Step 2）。
/// `transferred` = 已完成 chunk 覆盖的字节数（**含续传跳过部分**，封顶
/// `total`）——UI 进度条口径 = 「文件完成度」，与本次运行的有效吞吐
/// （[`TransferStats::mb_per_s`] 的口径，剔除续传跳过字节）刻意区分。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransferProgress {
    pub transferred: u64,
    pub total: u64,
    pub chunks_done: usize,
    pub chunks_total: usize,
}

/// 进度回调（chunk 边界同步触发，务必轻量——emit/记账即可，勿做重活）。
pub type ProgressHook = Arc<dyn Fn(TransferProgress) + Send + Sync>;

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
            - (self.chunks_resumed as u64)
                .saturating_mul(CHUNK_SIZE)
                .min(self.total_bytes);
        transferred as f64 / 1e6 / self.elapsed.as_secs_f64().max(1e-9)
    }
}

/// journal 头部魔数（v1，自描述传输身份）。
pub const JOURNAL_MAGIC: &str = "ottr-journal v1";

/// 生成 journal v1 头部行：`ottr-journal v1<TAB>路径<TAB>总字节<TAB>down|up`。
/// 字段用 TAB 分隔以容忍含空格的路径。`identity_path` 为传输身份路径：
/// 下载是远端源路径，上传是远端目标路径（按字面比对）。
pub fn journal_header(identity_path: &str, total: u64, mode: &str) -> String {
    format!("{JOURNAL_MAGIC}\t{identity_path}\t{total}\t{mode}\n")
}

/// journal 文件名派生（Task 10 Fix round 1，C-1）：sha256 + base64url 无填充。
///
/// `scope` = **传输作用域身份**，与 v1 头部的（mode, identity_path, total）共同
/// 构成完整传输身份：下载 scope = host 端点（`address:port`），上传 scope =
/// 本地源路径。同 (mode, path, total) 但 scope 不同的 journal **不共享文件名**——
/// 跨主机/跨源的同路径同大小文件各用各的 journal，杜绝「A 机已传内容被 B 机
/// 按旧 offset 跳过」（头部身份校验只看 path+size，scope 在文件名层补上最后
/// 一块身份）。
pub fn journal_file_name(mode: &str, scope: &str, identity_path: &str, total: u64) -> String {
    use base64::Engine as _;
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(mode.as_bytes());
    hasher.update(b"|");
    hasher.update(scope.as_bytes());
    hasher.update(b"|");
    hasher.update(identity_path.as_bytes());
    hasher.update(b"|");
    hasher.update(total.to_string().as_bytes());
    let digest = hasher.finalize();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

/// 断点续传 journal。语义见模块注释的不变量。
/// pub(crate)：FTP 后端（Phase 2 Task 5 ftp.rs）复用同一 v1 格式与读写原语
/// （身份头/加载校验/追加记录），格式一份、两个后端共享。
pub(crate) struct Journal {
    file: Mutex<std::fs::File>,
}

impl Journal {
    /// 扫描已有 journal：解析 v1 头部并校验传输身份（模式 + 路径 + 总字节，
    /// 三方与本次传输一致才放行），返回已完成 chunk 的起始 offset 集合。
    ///
    /// - 文件不存在 → 空集合（全新传输）；
    /// - 空文件（open 与写头之间被杀等，零记录无续传对象）→ 空集合；
    /// - 非空但无 v1 头部（旧格式/别的东西）→ Err：journal 无法证明身份，
    ///   **绝不按旧 offset 静默续传**；
    /// - 头部身份与本次传输不一致 → Err，提示删除或更换 journal 文件；
    /// - offset 行损坏按"未完成"处理（容忍尾行半截）。
    pub(crate) fn load(
        path: &Path,
        mode: &str,
        identity_path: &str,
        total: u64,
    ) -> Result<HashSet<u64>> {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
            Err(e) => return Err(Error::Io(e)),
        };
        let mut lines = content.lines();
        let head = match lines.next() {
            None => return Ok(HashSet::new()), // 空文件：零记录，按全新传输
            Some(h) => h,
        };
        let expected = format!("{mode} {identity_path} {total}");
        let reject = |why: &str| {
            plain_error(format!(
                "journal {} rejected ({why}); expected identity: {expected:?}. \
                 Delete this journal or point at a new one — refusing to resume blindly",
                path.display()
            ))
        };
        let rest = head
            .strip_prefix(JOURNAL_MAGIC)
            .filter(|r| r.starts_with('\t'))
            .ok_or_else(|| reject("missing v1 header"))?;
        let mut fields = rest[1..].split('\t');
        let (h_path, h_total, h_mode) =
            match (fields.next(), fields.next(), fields.next(), fields.next()) {
                (Some(p), Some(t), Some(m), None) if !p.is_empty() => (p, t, m),
                _ => return Err(reject("malformed v1 header")),
            };
        let h_total: u64 = h_total
            .parse()
            .map_err(|_| reject("malformed v1 header (total not a number)"))?;
        if h_mode != mode || h_path != identity_path || h_total != total {
            return Err(reject(&format!(
                "identity mismatch: journal is {h_mode} {h_path} {h_total}"
            )));
        }
        Ok(lines.filter_map(|l| l.trim().parse::<u64>().ok()).collect())
    }

    /// 以追加模式打开 journal（不存在则创建）；文件为空时先写入 v1 头部行。
    pub(crate) fn open(
        path: &Path,
        mode: &str,
        identity_path: &str,
        total: u64,
    ) -> std::io::Result<Self> {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        if file.metadata()?.len() == 0 {
            let mut f = file;
            f.write_all(journal_header(identity_path, total, mode).as_bytes())?;
            f.flush()?;
            return Ok(Self {
                file: Mutex::new(f),
            });
        }
        Ok(Self {
            file: Mutex::new(file),
        })
    }

    /// 记录一个已完成 chunk（写行 + flush 到 OS）。
    /// **必须在该 chunk 数据完整落盘之后调用**（模块注释的不变量）。
    pub(crate) fn record(&self, offset: u64) -> std::io::Result<()> {
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
    Error::Protocol {
        message: ctx,
        source: None,
    }
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
    attrs
        .attrs
        .size
        .ok_or_else(|| plain_error(format!("{remote}: stat attrs have no size")))
}

/// 探测读写子请求块大小：报文上限收窄 + 服务器 limits@openssh.com 明示上限。
/// pub(crate)：ops.rs 的单通道小文件读写（Phase 2 Task 3）复用同一探测。
pub(crate) async fn probe_block_sizes(sftp: &RawSftpSession, handle: &str) -> (u32, u32) {
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
        let first = pending.first().map(|(i, _, _)| *i).unwrap_or(chunks_total); // 全部已完成：无可续传
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
/// Task 10 Step 2：`cancel` = chunk 边界协作取消；`progress` = 每 chunk 完成
/// 时的进度回调（None = 静默）。
pub async fn download_parallel(
    session: &SshSession,
    remote: &str,
    local: &Path,
    chunks: usize,
    journal_path: &Path,
    cancel: &CancelToken,
    progress: Option<ProgressHook>,
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

    let done = Journal::load(journal_path, "down", remote, total)?;
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

    let journal = Arc::new(Journal::open(journal_path, "down", remote, total)?);
    let (read_block, _) = probe_block_sizes(&sftp, &read_handle).await;

    let queue = Arc::new(Mutex::new(VecDeque::from(pending)));
    // 计数器与进度 hook 参数刻意不同名（counter）：`progress` 参数是 hook 传递面。
    let counter = Arc::new(AtomicU64::new(0));
    let remaining = queue.lock().unwrap().len() as u64;

    let handles = (0..workers).map(|_| {
        let sftp = Arc::clone(&sftp);
        let handle = read_handle.clone();
        let queue = Arc::clone(&queue);
        let journal = Arc::clone(&journal);
        let local_file = Arc::clone(&local_file);
        let counter = Arc::clone(&counter);
        let cancel = cancel.clone();
        let progress_hook = progress.clone();
        async move {
            loop {
                // 取消检查（Step 2，chunk 边界）：协作退出——in-flight chunk 正常
                // 完成/失败，不中途 drop 请求 future；journal 只含完整落盘 chunk，
                // 续传语义零破坏（同身份重传即续传）。
                if cancel.is_cancelled() {
                    return Ok::<(), Error>(());
                }
                let next = queue.lock().unwrap().pop_front();
                let Some((_index, offset, len)) = next else {
                    break;
                };
                let data =
                    read_chunk_pipelined(&sftp, &handle, offset, len as usize, read_block).await?;
                // 顺序不变量：数据先完整写盘（页缓存，kill -9 不丢），后记 journal。
                local_file.write_all_at(&data, offset)?;
                journal.record(offset)?;
                let done_now = counter.fetch_add(1, Ordering::Relaxed) + 1;
                let chunks_done = chunks_total as u64 - remaining + done_now;
                if let Some(hook) = &progress_hook {
                    hook(TransferProgress {
                        transferred: (chunks_done * CHUNK_SIZE).min(total),
                        total,
                        chunks_done: chunks_done as usize,
                        chunks_total,
                    });
                }
            }
            Ok::<(), Error>(())
        }
    });
    try_join_all(handles).await?;

    // 取消（Step 2）：全部 worker 已在 chunk 边界就地退出；显式 Cancelled 让
    // 调用方区分「用户中止」与「失败」。
    if cancel.is_cancelled() {
        let _ = sftp.close(read_handle).await;
        return Err(Error::Cancelled);
    }

    sftp.close(read_handle)
        .await
        .map_err(|e| protocol_error(e, "close remote handle"))?;

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
                    )));
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
/// 取消/进度语义与 [`download_parallel`] 相同（Task 10 Step 2）。
pub async fn upload_parallel(
    session: &SshSession,
    local: &Path,
    remote: &str,
    chunks: usize,
    journal_path: &Path,
    cancel: &CancelToken,
    progress: Option<ProgressHook>,
) -> Result<TransferStats> {
    let started = Instant::now();
    let workers = chunks.max(1);

    let sftp = open_sftp(session).await?;
    let total = std::fs::metadata(local)?.len();

    let done = Journal::load(journal_path, "up", remote, total)?;
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

    // 上传续传：修剪远端可能遗留的超长尾部（如早前同名更大文件的字节）。
    // fsetstat(size=total) 把远端截/扩到恰好本次总长；服务器不支持 fsetstat
    // 时退化为检查——远端未超过总长则无尾部问题，超过则明确报错（绝不留下
    // 会被静默保留的陈旧尾部）。
    if resumed > 0 {
        let trim = FileAttributes {
            size: Some(total),
            ..FileAttributes::default()
        };
        if sftp.fsetstat(write_handle.as_str(), trim).await.is_err() {
            let cur = remote_size(&sftp, remote).await?;
            if cur > total {
                return Err(plain_error(format!(
                    "resume upload {remote}: remote size {cur} exceeds transfer total {total} \
                     and server does not support fsetstat to trim the stale tail"
                )));
            }
        }
    }

    let journal = Arc::new(Journal::open(journal_path, "up", remote, total)?);
    let (_, write_block) = probe_block_sizes(&sftp, &write_handle).await;

    let local_file = Arc::new(std::fs::File::open(local)?);
    let queue = Arc::new(Mutex::new(VecDeque::from(pending)));
    // 计数器与进度 hook 参数刻意不同名（counter）：`progress` 参数是 hook 传递面。
    let counter = Arc::new(AtomicU64::new(0));
    let remaining = queue.lock().unwrap().len() as u64;

    let handles = (0..workers).map(|_| {
        let sftp = Arc::clone(&sftp);
        let handle = write_handle.clone();
        let queue = Arc::clone(&queue);
        let journal = Arc::clone(&journal);
        let local_file = Arc::clone(&local_file);
        let counter = Arc::clone(&counter);
        let cancel = cancel.clone();
        let progress_hook = progress.clone();
        async move {
            loop {
                // 取消检查（Step 2，chunk 边界）：语义同下载侧。
                if cancel.is_cancelled() {
                    return Ok::<(), Error>(());
                }
                let next = queue.lock().unwrap().pop_front();
                let Some((_index, offset, len)) = next else {
                    break;
                };
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
                let done_now = counter.fetch_add(1, Ordering::Relaxed) + 1;
                let chunks_done = chunks_total as u64 - remaining + done_now;
                if let Some(hook) = &progress_hook {
                    hook(TransferProgress {
                        transferred: (chunks_done * CHUNK_SIZE).min(total),
                        total,
                        chunks_done: chunks_done as usize,
                        chunks_total,
                    });
                }
            }
            Ok::<(), Error>(())
        }
    });
    try_join_all(handles).await?;

    // 取消（Step 2）：语义同下载侧（journal 保留，重传即续传）。
    if cancel.is_cancelled() {
        let _ = sftp.close(write_handle).await;
        return Err(Error::Cancelled);
    }

    sftp.close(write_handle)
        .await
        .map_err(|e| protocol_error(e, "close remote handle"))?;

    Ok(TransferStats {
        total_bytes: total,
        chunks_total,
        chunks_resumed: resumed,
        elapsed: started.elapsed(),
    })
}

impl crate::FileTransfer for SshSession {
    fn download(
        &self,
        remote: &str,
        local: &Path,
        chunks: usize,
        journal_path: &Path,
        cancel: &CancelToken,
        progress: Option<ProgressHook>,
    ) -> impl Future<Output = Result<TransferStats>> + Send {
        download_parallel(self, remote, local, chunks, journal_path, cancel, progress)
    }

    fn upload(
        &self,
        local: &Path,
        remote: &str,
        chunks: usize,
        journal_path: &Path,
        cancel: &CancelToken,
        progress: Option<ProgressHook>,
    ) -> impl Future<Output = Result<TransferStats>> + Send {
        upload_parallel(self, local, remote, chunks, journal_path, cancel, progress)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fix round 1 C-1 回归（单测面）：同 path+size+mode 跨身份 scope 的 journal
    /// 文件名必须不同（跨主机/跨源不互通），同身份必须派生同名。
    #[test]
    fn journal_file_name_binds_scope_identity() {
        let a1 = journal_file_name("down", "10.0.0.1:22", "/tmp/x.bin", 1000);
        let b1 = journal_file_name("down", "10.0.0.2:22", "/tmp/x.bin", 1000);
        assert_ne!(a1, b1, "cross-host same path+size must NOT share a journal");

        let up_a = journal_file_name("up", "/Users/me/a.bin", "/srv/x.bin", 1000);
        let up_b = journal_file_name("up", "/Users/me/b.bin", "/srv/x.bin", 1000);
        assert_ne!(
            up_a, up_b,
            "cross-source same remote must NOT share a journal"
        );

        let a2 = journal_file_name("down", "10.0.0.1:22", "/tmp/x.bin", 1000);
        assert_eq!(
            a1, a2,
            "same identity must derive the same name (resume hits)"
        );
        assert_ne!(
            journal_file_name("down", "10.0.0.1:22", "/tmp/x.bin", 1000),
            journal_file_name("up", "10.0.0.1:22", "/tmp/x.bin", 1000),
            "mode is part of the identity"
        );
        // 文件名安全面：base64url 无填充，不含路径分隔符/填充符
        assert!(!a1.contains('/') && !a1.contains('='));
    }
}
