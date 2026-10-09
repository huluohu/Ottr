//! FTP/FTPS 第二后端（Phase 2 Task 5，ottr-transfer 的第二个 [`FileTransfer`]
//! 实现 + FilePanel 远端操作面）。
//!
//! ## 选型与语义裁定（task-5 简报 + 协调者裁定）
//!
//! - **suppaftp 12**（crates.io，tokio 运行时 feature + native-tls FTPS）：
//!   显式 FTPS（RFC 4217 AUTH TLS + PBSZ/PROT，[`FtpClient::connect_ftps`]）与
//!   隐式 FTPS（[`FtpClient::connect_ftps_implicit`]，suppaftp `deprecated`
//!   feature）都支持；夹具（pyftpdlib）只提供显式——隐式是客户端能力保留，
//!   无真夹具验证缺口如实记录于 task-5-report。
//! - **单一流类型**：suppaftp 的 `ImplAsyncFtpStream<T>` 以 T 选 TLS 后端、
//!   `DataStream::Plain/Ssl` 分明文/加密态——明文 FTP 与 FTPS 共用
//!   `ImplAsyncFtpStream<AsyncNativeTlsStream>`（native-tls 后端），客户端
//!   类型唯一，命令层无需感知安全态。
//! - **被动模式**：suppaftp 默认 Passive（`Mode::Passive`），无需显式设置；
//!   主动模式（PORT）不实现——NAT/防火墙现实下被动是唯一合理默认。
//! - **TLS 验证策略**：`accept_invalid_certs` 可配（[`FtpsPolicy`]），**默认
//!   false**（正常校验系统信任链）。自签证书场景（夹具/内网 FTPS）由调用方
//!   显式放开；证书 pin（TOFU over TLS）不进本期。
//! - **传输形态**：FTP 是单控制连接 + 串行数据连接的线性协议——**不并行**
//!   （trait 的 `chunks` 参数按提示忽略），整传输持客户端互斥锁（传输期间
//!   面板浏览/操作排队，FTP 协议固有限制，如实记录）。
//! - **断点续传（如实记录，与 SFTP 语义差异见下）**：
//!   - 下载 = **REST**（`resume_transfer`，suppaftp 支持）：journal 已完成
//!     chunk 必须是**连续前缀**（线性传输的自然形态），续传偏移 = 前缀长度 ×
//!     chunk 粒度；服务器拒绝 REST 时明确报错，绝不静默全量重传（本地前缀
//!     字节会被覆盖、用户无从得知）。
//!   - 上传 = **APPE**（append）：REST 对 STOR 不适用，APPE 只能接在**远端
//!     实际文件尾**后——偏移真值取 `SIZE(remote)`（服务器侧真值）。**续传
//!     闸门 = journal（load 成功且有记录）**（Fix round 1 I-1）：journal 缺席
//!     = 全量重传（STOR 截断覆盖）——远端同长遗留不被静默跳过，恢复与
//!     SFTP「done 即删 journal → 重传」的对等性（FTP 无分块 ack，journal
//!     的角色是闸门 + 统计，偏移真值必须另取远端 SIZE）。journal 身份不符 =
//!     显式报错（同 SFTP）。远端比本次总长还长（同名更大文件的遗留）且
//!     journal 放行续传时明确报错——FTP 无 truncate 原语，绝不静默截断。
//!   - **取消**：[`CancelToken`] 在 chunk 边界（1 MiB 记账粒度）检查，ABOR
//!     中止数据流，journal 保留已完成边界——与 SFTP 取消语义对齐。
//!
//! ## FilePanel 操作面
//!
//! 与 [`crate::ops::SftpClient`] 同形 API（list/mkdir/rename/remove/chmod/
//! stat/realpath/exists），命令层（desktop transfer.rs）按会话类型分派。
//! 差异如实记录：列目录/stat 走 **MLSD/MLST**（RFC 3659，结构化无解析地狱，
//! pyftpdlib 等现代服务器支持；LIST 文本解析不实现——MVP 裁定）；`realpath`
//! 仅 `.` 展开（FTP 协议无 realpath，其余路径原样透传）；`mode` 只有 9 位
//! 权限位（MLSD UNIX.mode 事实，无 SFTP 的类型位）。

use std::future::Future;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Instant;

use async_native_tls::TlsConnector;
use suppaftp::Status;
use suppaftp::list::{File as FtpEntry, ListParser};
use suppaftp::tokio::{
    AsyncNativeTlsConnector, AsyncNativeTlsFtpStream, ImplAsyncFtpStream, TokioTlsStream,
};
use suppaftp::types::{FileType, FtpError, Response};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::fs_at::pwrite_all;
use crate::ops::DirEntry;
use crate::sftp::{
    CHUNK_SIZE, CancelToken, Journal, ProgressHook, TransferProgress, TransferStats,
};
use crate::{Error, FileTransfer, Result};

/// TLS 校验配置（Task 5 裁定：默认 false = 正常校验；自签场景显式放开）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FtpsPolicy {
    pub accept_invalid_certs: bool,
}

/// FTP/FTPS 客户端：FilePanel 远端操作面 + [`FileTransfer`] 传输。
///
/// 单控制连接 = 所有操作串行（`Mutex`）；方法 `&self`（锁在内部），调用方
/// 持 `Arc` 共享。错误统一映射 crate [`Error::Protocol`]（suppaftp 类型不出
/// crate，I-1 同款纪律）。
pub struct FtpClient {
    stream: Mutex<AsyncNativeTlsFtpStream>,
    /// 登录目录（login 后 `PWD`）——`realpath(".")` 的锚点。
    root: String,
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

/// SITE CHMOD 等扩展命令的 2xx 校验（suppaftp `site` 返回原始 Response，
/// 状态由调用方裁定）。
fn ensure_ok(resp: Response, ctx: &str) -> Result<()> {
    if resp.status.code() / 100 == 2 {
        Ok(())
    } else {
        Err(plain_error(format!(
            "{ctx}: server replied {} {}",
            resp.status.code(),
            String::from_utf8_lossy(&resp.body).trim()
        )))
    }
}

impl FtpClient {
    /// 明文 FTP 连接 + 登录 + 切二进制模式（pyftpdlib 等服务器登录后默认
    /// ASCII——不切 TYPE I 则字节级校验必错）。
    pub async fn connect(host: &str, port: u16, username: &str, password: &str) -> Result<Self> {
        let mut plain = Self::dial(host, port).await?;
        login_and_binary(&mut plain, username, password).await?;
        let root = pwd(&mut plain).await?;
        Ok(Self {
            stream: Mutex::new(plain),
            root,
        })
    }

    /// 显式 FTPS（RFC 4217）：明文连接 → AUTH TLS（suppaftp `into_secure`
    /// 自带 AUTH + PBSZ 0 + PROT P）→ 登录。TLS 在登录**之前**建立（夹具
    /// `tls_control_required` 与安全默认一致：凭据不进明文通道）。
    pub async fn connect_ftps(
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        policy: FtpsPolicy,
    ) -> Result<Self> {
        let plain = Self::dial(host, port).await?;
        let mut secure = plain
            .into_secure(AsyncNativeTlsConnector::from(tls_connector(policy)?), host)
            .await
            .map_err(|e| protocol_error(e, "explicit FTPS handshake (AUTH TLS)"))?;
        login_and_binary(&mut secure, username, password).await?;
        let root = pwd(&mut secure).await?;
        Ok(Self {
            stream: Mutex::new(secure),
            root,
        })
    }

    /// 隐式 FTPS（端口 990 惯例：TCP 连上即 TLS）。suppaftp `deprecated`
    /// feature（RFC 认为 implicit 已过时）——客户端能力保留，夹具无此路径
    /// （pyftpdlib 不支持 implicit），验证缺口见 task-5-report。
    pub async fn connect_ftps_implicit(
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        policy: FtpsPolicy,
    ) -> Result<Self> {
        let mut secure = AsyncNativeTlsFtpStream::connect_secure_implicit(
            (host, port),
            AsyncNativeTlsConnector::from(tls_connector(policy)?),
            host,
        )
        .await
        .map_err(|e| protocol_error(e, &format!("implicit FTPS connect {host}:{port}")))?;
        login_and_binary(&mut secure, username, password).await?;
        let root = pwd(&mut secure).await?;
        Ok(Self {
            stream: Mutex::new(secure),
            root,
        })
    }

    async fn dial(host: &str, port: u16) -> Result<AsyncNativeTlsFtpStream> {
        AsyncNativeTlsFtpStream::connect((host, port))
            .await
            .map_err(|e| protocol_error(e, &format!("connect {host}:{port}")))
    }

    /// 登录目录（FilePanel 初载锚点；`realpath(".")` 语义）。
    pub fn root(&self) -> &str {
        &self.root
    }

    /// 优雅退出（drop_session 调用；best-effort——退出失败不阻塞清理）。
    pub async fn quit(&self) {
        if let Ok(mut s) = self.stream.try_lock() {
            let _ = s.quit().await;
        }
    }

    /// 路径解析：仅 `.`（及空串）展开为登录目录；其余原样返回——FTP 协议
    /// 无 realpath 原语（SFTP 语义对齐点，差异如实记录）。
    pub async fn realpath(&self, path: &str) -> Result<String> {
        Ok(match path {
            "" | "." => self.root.clone(),
            other => other.to_string(),
        })
    }

    /// 列目录（MLSD，RFC 3659）。`type=cdir/pdir` 与 `.`/`..` 不进结果；
    /// 按 name 排序（与 SftpClient::list_dir 同口径）。
    pub async fn list_dir(&self, path: &str) -> Result<Vec<DirEntry>> {
        let lines = self
            .lock()
            .await
            .mlsd(Some(path))
            .await
            .map_err(|e| protocol_error(e, &format!("mlsd {path}")))?;
        let mut out = Vec::new();
        for line in lines {
            let entry = match ListParser::parse_mlsd(&line) {
                Ok(f) => f,
                Err(_) => continue, // 单行解析失败跳过（目录列表容忍，同 local_list）
            };
            let name = entry.name().to_string();
            if name == "." || name == ".." {
                continue;
            }
            out.push(entry_from_ftp(name, &entry));
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// 新建目录。
    pub async fn mkdir(&self, path: &str) -> Result<()> {
        self.lock()
            .await
            .mkdir(path)
            .await
            .map_err(|e| protocol_error(e, &format!("mkdir {path}")))
    }

    /// 重命名（RNFR/RNTO；目标已存在由服务器拒绝，UI 层提示）。
    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.lock()
            .await
            .rename(from, to)
            .await
            .map_err(|e| protocol_error(e, &format!("rename {from} -> {to}")))
    }

    /// 删除文件（DELE）。
    pub async fn remove_file(&self, path: &str) -> Result<()> {
        self.lock()
            .await
            .rm(path)
            .await
            .map_err(|e| protocol_error(e, &format!("remove {path}")))
    }

    /// 删除空目录（RMD；非空由服务器拒绝——递归删除不进 MVP，同 SFTP 裁定）。
    pub async fn remove_dir(&self, path: &str) -> Result<()> {
        self.lock()
            .await
            .rmdir(path)
            .await
            .map_err(|e| protocol_error(e, &format!("rmdir {path}")))
    }

    /// chmod（SITE CHMOD；`mode` 为 9 位权限位）。服务器不支持时显式报错。
    pub async fn chmod(&self, path: &str, mode: u32) -> Result<()> {
        let resp = self
            .lock()
            .await
            .site(format!("CHMOD {mode:o} {path}"))
            .await
            .map_err(|e| protocol_error(e, &format!("chmod {mode:o} {path}")))?;
        ensure_ok(resp, &format!("chmod {mode:o} {path}"))
    }

    /// stat 单个路径（MLST；目录/文件通用；不存在返回 Err）。
    pub async fn stat(&self, path: &str) -> Result<DirEntry> {
        let line = self
            .lock()
            .await
            .mlst(Some(path))
            .await
            .map_err(|e| protocol_error(e, &format!("mlst {path}")))?;
        let entry = ListParser::parse_mlst(&line)
            .map_err(|e| plain_error(format!("mlst {path}: unparsable reply {line:?}: {e}")))?;
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        Ok(entry_from_ftp(name, &entry))
    }

    /// 是否存在（MLST 探测；550 = 不存在，其余错误透传）。
    pub async fn exists(&self, path: &str) -> Result<bool> {
        match self.lock().await.mlst(Some(path)).await {
            Ok(_) => Ok(true),
            Err(FtpError::UnexpectedResponse(resp)) if resp.status == Status::FileUnavailable => {
                Ok(false)
            }
            Err(e) => Err(protocol_error(e, &format!("stat {path}"))),
        }
    }

    /// 远端文件字节数（SIZE，二进制模式）。
    pub async fn size(&self, path: &str) -> Result<u64> {
        let n = self
            .lock()
            .await
            .size(path)
            .await
            .map_err(|e| protocol_error(e, &format!("size {path}")))?;
        Ok(n as u64)
    }

    async fn lock(&self) -> tokio::sync::MutexGuard<'_, AsyncNativeTlsFtpStream> {
        self.stream.lock().await
    }
}

async fn login_and_binary<T: TokioTlsStream + Send>(
    stream: &mut ImplAsyncFtpStream<T>,
    username: &str,
    password: &str,
) -> Result<()> {
    stream
        .login(username, password)
        .await
        .map_err(|e| protocol_error(e, "ftp login"))?;
    stream
        .transfer_type(FileType::Binary)
        .await
        .map_err(|e| protocol_error(e, "TYPE I (binary mode)"))?;
    Ok(())
}

async fn pwd<T: TokioTlsStream + Send>(stream: &mut ImplAsyncFtpStream<T>) -> Result<String> {
    stream.pwd().await.map_err(|e| protocol_error(e, "pwd"))
}

fn tls_connector(policy: FtpsPolicy) -> Result<TlsConnector> {
    Ok(TlsConnector::new().danger_accept_invalid_certs(policy.accept_invalid_certs))
}

/// suppaftp `list::File` → 命令面 [`DirEntry`]。
/// `mode` 只还原 9 位权限位（MLSD UNIX.mode 经 posix_pex 三组查询；无 SFTP
/// 类型位——FilePanel formatMode 本就只看低 9 位）。MLSD 无 modify 事实时
/// suppaftp 兜底 UNIX_EPOCH（mtime=0，前端不显示日期，同 DirEntry 约定）。
fn entry_from_ftp(name: String, entry: &FtpEntry) -> DirEntry {
    use suppaftp::list::PosixPexQuery;
    let mut mode = 0u32;
    for (shift, who) in [
        (6, PosixPexQuery::Owner),
        (3, PosixPexQuery::Group),
        (0, PosixPexQuery::Others),
    ] {
        mode |= if entry.can_read(who) { 4 } else { 0 } << shift;
        mode |= if entry.can_write(who) { 2 } else { 0 } << shift;
        mode |= if entry.can_execute(who) { 1 } else { 0 } << shift;
    }
    let mtime = entry
        .modified()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as u32)
        .unwrap_or(0);
    DirEntry {
        name,
        is_dir: entry.is_directory(),
        size: entry.size() as u64,
        mode,
        mtime,
    }
}

/// journal 已完成 chunk 的连续前缀长度（线性传输的可续传面：FTP 无随机
/// 读写，只有前缀可 REST）。journal 里的「洞」之后的部分照常重传。
fn contiguous_prefix(done: &std::collections::HashSet<u64>) -> usize {
    let mut n = 0usize;
    while done.contains(&((n as u64) * CHUNK_SIZE)) {
        n += 1;
    }
    n
}

/// chunk 边界记账 + 进度回调（读/写循环推进 `pos` 后调用）。
struct BoundaryTracker<'a> {
    journal: &'a Journal,
    progress: Option<&'a ProgressHook>,
    total: u64,
    chunks_total: usize,
    done: usize,
}

impl BoundaryTracker<'_> {
    fn advance(&mut self, pos: u64) {
        while self.done < self.chunks_total && pos >= ((self.done as u64) + 1) * CHUNK_SIZE {
            let _ = self.journal.record((self.done as u64) * CHUNK_SIZE);
            self.done += 1;
            self.emit();
        }
    }

    /// 传输收尾（服务器 226 ack 后）：补记尾 chunk + 末帧进度。
    fn finish(&mut self) {
        while self.done < self.chunks_total {
            let _ = self.journal.record((self.done as u64) * CHUNK_SIZE);
            self.done += 1;
        }
        self.emit();
    }

    fn emit(&self) {
        if let Some(hook) = self.progress {
            hook(TransferProgress {
                transferred: ((self.done as u64) * CHUNK_SIZE).min(self.total),
                total: self.total,
                chunks_done: self.done,
                chunks_total: self.chunks_total,
            });
        }
    }
}

const STREAM_BUF: usize = 64 * 1024;

/// 线性下载：`remote` → `local`（REST 续传，语义见模块注释）。
async fn download_linear(
    client: &FtpClient,
    remote: &str,
    local: &Path,
    journal_path: &Path,
    cancel: &CancelToken,
    progress: Option<ProgressHook>,
) -> Result<TransferStats> {
    let started = Instant::now();
    let mut s = client.lock().await;
    let total = s
        .size(remote)
        .await
        .map(|n| n as u64)
        .map_err(|e| protocol_error(e, &format!("size {remote}")))?;
    let done = Journal::load(journal_path, "down", remote, total)?;
    let resume_chunks = contiguous_prefix(&done);
    let resume_from = resume_chunks as u64 * CHUNK_SIZE;
    let chunks_total = total.div_ceil(CHUNK_SIZE) as usize;
    if resume_chunks > 0 {
        println!(
            "resume from chunk {resume_chunks} ({resume_chunks}/{chunks_total} chunks already journaled, linear stream)"
        );
    }

    // 本地按远端长度定长（稀疏预分配）；REST 起点之后的旧字节被重传覆盖。
    // 刻意**不 truncate**（create|write）：续传时本地前缀字节必须保留——
    // set_len 只补长不截短，尺寸真值来自远端 SIZE。
    #[allow(clippy::suspicious_open_options)]
    let local_file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .open(local)?;
    local_file.set_len(total)?;
    let journal = Journal::open(journal_path, "down", remote, total)?;

    if resume_from >= total {
        // 全命中（hazard 面与 SFTP 同款：app「done 即删 journal」策略兜底）。
        return Ok(TransferStats {
            total_bytes: total,
            chunks_total,
            chunks_resumed: resume_chunks,
            elapsed: started.elapsed(),
        });
    }
    if resume_from > 0 {
        // REST：服务器拒绝 = 显式失败（绝不静默全量重传覆盖本地前缀字节）。
        s.resume_transfer(resume_from as usize).await.map_err(|e| {
            plain_error(format!(
                "server rejected REST resume at offset {resume_from} for {remote}: {e}"
            ))
        })?;
    }

    let mut tracker = BoundaryTracker {
        journal: &journal,
        progress: progress.as_ref(),
        total,
        chunks_total,
        done: resume_chunks,
    };
    let mut transfer = s
        .retr_as_stream(remote)
        .await
        .map_err(|e| protocol_error(e, &format!("retr {remote}")))?;
    let mut buf = vec![0u8; STREAM_BUF];
    let mut pos = resume_from;
    loop {
        // 取消（chunk 边界协作检查）：ABOR 中止数据流，journal 保留前缀。
        if cancel.is_cancelled() {
            let _ = s.abort(transfer).await;
            return Err(Error::Cancelled);
        }
        let n = transfer
            .read(&mut buf)
            .await
            .map_err(|e| protocol_error(e, &format!("retr stream {remote} @{pos}")))?;
        if n == 0 {
            break; // EOF：数据收讫，226 由 finish() 确认
        }
        pwrite_all(&local_file, pos, &buf[..n])?;
        pos += n as u64;
        tracker.advance(pos);
    }
    // 226 = 传输完成的唯一权威确认；之后补记尾 chunk（数据已在服务器落定）。
    transfer
        .finish()
        .await
        .map_err(|e| protocol_error(e, &format!("retr finish {remote}")))?;
    tracker.finish();

    Ok(TransferStats {
        total_bytes: total,
        chunks_total,
        chunks_resumed: resume_chunks,
        elapsed: started.elapsed(),
    })
}

/// 线性上传：`local` → `remote`（续传真值 = 远端 SIZE，APPE 追加，见模块注释）。
async fn upload_linear(
    client: &FtpClient,
    local: &Path,
    remote: &str,
    journal_path: &Path,
    cancel: &CancelToken,
    progress: Option<ProgressHook>,
) -> Result<TransferStats> {
    let started = Instant::now();
    let total = std::fs::metadata(local)?.len();
    // 续传闸门（Fix round 1 I-1）：**journal load 成功且有记录才允许续传**。
    // 远端 SIZE 只是偏移真值、不是「该续传」的凭据——无 journal = 全量重传
    // （STOR 截断覆盖），远端同长遗留不再被静默跳过（与 SFTP「done 即删
    // journal → 重传」对等；FTP 的真值是远端 SIZE，删 journal 必须同样有效）。
    // journal 身份不符（换文件/换大小/旧格式）= 显式报错，绝不按旧 offset 续传
    // （与 SFTP 上传侧同一语义）。
    let done = Journal::load(journal_path, "up", remote, total)?;
    let mut s = client.lock().await;
    // 偏移真值 = 远端实际大小（APPE 只能接在真实文件尾后；无文件 = 0）。
    let remote_size = s.size(remote).await.map(|n| n as u64).unwrap_or(0);
    let resuming = !done.is_empty();
    let resume_from = if resuming { remote_size.min(total) } else { 0 };
    if resuming && remote_size > total {
        return Err(plain_error(format!(
            "resume upload {remote}: remote size {remote_size} exceeds transfer total {total} \
             and FTP has no truncate primitive (stale longer tail from an earlier, bigger file)"
        )));
    }
    let chunks_total = total.div_ceil(CHUNK_SIZE) as usize;
    let resumed = ((resume_from / CHUNK_SIZE) as usize).min(chunks_total);
    if resumed > 0 {
        println!(
            "resume from chunk {resumed} ({resumed}/{chunks_total} chunks already on server, linear stream)"
        );
    }

    // journal 续写：身份头（open 对空文件补写）+ 前缀补记（偏移真值在远端
    // SIZE；journal 的职责是「闸门 + 统计」，与下载侧「真值」角色刻意区分）。
    let journal = Journal::open(journal_path, "up", remote, total)?;
    for i in 0..resumed {
        let _ = journal.record(i as u64 * CHUNK_SIZE);
    }

    if resume_from >= total {
        // 全命中——**仅在 journal 闸门放行后可达**（resuming = true），即「同
        // 身份的上一次尝试确已把这些字节推到服务器」（崩溃在 finish 边缘）。
        return Ok(TransferStats {
            total_bytes: total,
            chunks_total,
            chunks_resumed: resumed,
            elapsed: started.elapsed(),
        });
    }

    let mut local_file = std::fs::File::open(local)?;
    local_file.seek(SeekFrom::Start(resume_from))?;
    let mut transfer = if resume_from > 0 {
        s.append_with_stream(remote)
            .await
            .map_err(|e| protocol_error(e, &format!("appe {remote} (resume at {resume_from})")))?
    } else {
        s.put_with_stream(remote)
            .await
            .map_err(|e| protocol_error(e, &format!("stor {remote}")))?
    };

    let mut tracker = BoundaryTracker {
        journal: &journal,
        progress: progress.as_ref(),
        total,
        chunks_total,
        done: resumed,
    };
    let mut buf = vec![0u8; STREAM_BUF];
    let mut pos = resume_from;
    loop {
        if cancel.is_cancelled() {
            let _ = s.abort(transfer).await;
            return Err(Error::Cancelled);
        }
        let n = local_file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        transfer
            .write_all(&buf[..n])
            .await
            .map_err(|e| protocol_error(e, &format!("stor stream {remote} @{pos}")))?;
        pos += n as u64;
        tracker.advance(pos);
    }
    // 226 确认后补记尾 chunk（上传的不变量级别：以服务器 ack 收尾——比
    // SFTP 的逐 chunk ack 粗，FTP 协议固有限制，报告如实记录）。
    transfer
        .finish()
        .await
        .map_err(|e| protocol_error(e, &format!("stor finish {remote}")))?;
    tracker.finish();

    Ok(TransferStats {
        total_bytes: total,
        chunks_total,
        chunks_resumed: resumed,
        elapsed: started.elapsed(),
    })
}

impl FileTransfer for FtpClient {
    fn download(
        &self,
        remote: &str,
        local: &Path,
        _chunks: usize,
        journal_path: &Path,
        cancel: &CancelToken,
        progress: Option<ProgressHook>,
    ) -> impl Future<Output = Result<TransferStats>> + Send {
        download_linear(self, remote, local, journal_path, cancel, progress)
    }

    fn upload(
        &self,
        local: &Path,
        remote: &str,
        _chunks: usize,
        journal_path: &Path,
        cancel: &CancelToken,
        progress: Option<ProgressHook>,
    ) -> impl Future<Output = Result<TransferStats>> + Send {
        upload_linear(self, local, remote, journal_path, cancel, progress)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// 默认 TLS 策略 = 正常校验（accept_invalid_certs=false，Task 5 裁定）。
    #[test]
    fn ftps_policy_defaults_to_verifying() {
        assert!(!FtpsPolicy::default().accept_invalid_certs);
    }

    /// REST 可续传面 = journal 的连续前缀：洞之后的 chunk 照常重传
    /// （线性协议无随机读写，超前的 offset 不可跳）。
    #[test]
    fn contiguous_prefix_stops_at_first_hole() {
        let done: HashSet<u64> = [0, CHUNK_SIZE, 2 * CHUNK_SIZE].into_iter().collect();
        assert_eq!(contiguous_prefix(&done), 3);
        let holed: HashSet<u64> = [0, 2 * CHUNK_SIZE].into_iter().collect();
        assert_eq!(
            contiguous_prefix(&holed),
            1,
            "hole at chunk 1 stops the prefix"
        );
        assert_eq!(contiguous_prefix(&HashSet::new()), 0);
    }

    /// MLSD UNIX.mode → 9 位权限位还原（rwx 三组查询位拼装）。
    #[test]
    fn entry_mode_from_posix_pex() {
        let f =
            ListParser::parse_mlsd("type=file;size=7;modify=20260101000000;UNIX.mode=0644; a.txt")
                .expect("parse");
        let e = entry_from_ftp("a.txt".into(), &f);
        assert_eq!(e.mode, 0o644);
        assert_eq!(e.size, 7);
        assert!(!e.is_dir);
        let d = ListParser::parse_mlsd("type=dir;modify=20260101000000;UNIX.mode=0755; sub")
            .expect("parse dir");
        let e = entry_from_ftp("sub".into(), &d);
        assert!(e.is_dir);
        assert_eq!(e.mode, 0o755);
        // cdir/pdir 解析为目录（pyftpdlib MLSD 会带，list_dir 按名字过滤）
        let cdir = ListParser::parse_mlsd("type=cdir;modify=20260101000000; .").expect("cdir");
        assert!(entry_from_ftp(".".into(), &cdir).is_dir);
    }
}
