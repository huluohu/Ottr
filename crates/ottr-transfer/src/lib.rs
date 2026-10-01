//! ottr-transfer：文件传输层（Phase 1 Task 10，A5）。
//!
//! 自 Phase 0 spike #4（Task 8）的 `ottr-ssh::sftp` 整体迁入：并行分块传输 +
//! journal v1 断点续传。**搬家不丢东西**——journal v1 不变量、传输语义、
//! 既有集成测试（5 个真夹具用例）随迁不改语义（见 [`sftp`] 模块注释）。
//!
//! ## russh 类型边界（trait 隔离裁定的延伸）
//!
//! [`FileTransfer`] trait 的签名只含 crate 自有类型（`TransferStats`/`Error`）
//! 与 std 类型。实现内部需要从既有 SSH 会话开 SFTP 子系统流——该流是 russh
//! `ChannelStream`（[`ottr_ssh::SshSession::open_sftp_stream`] 的返回类型）。
//! 此处对 russh 类型的依赖与 ottr-ssh `SshTransport::Channel` **同等待遇**：
//! trait 边界上唯一已裁定的泄漏点的直接延伸，ottr-transfer 依赖 ottr-ssh
//! 消费该流；libssh2 fallback 时随传输层实现整体替换，trait 消费方不动。

pub mod ftp;
pub mod ops;
pub mod sftp;

pub use ftp::FtpClient;
pub use ops::{DirEntry, RemoteSnapshot, SftpClient};
pub use sftp::{
    CHUNK_SIZE, CancelToken, ProgressHook, TransferProgress, TransferStats, download_parallel,
    journal_file_name, journal_header, upload_parallel,
};

use std::fmt;
use std::path::Path;

/// 文件传输收口 trait（Task 10 简报 Step 1；Phase 2 Task 5 通用化重构）：
/// 上传/下载 + 断点续传。消费方（src-tauri 传输命令、bench、测试）依赖本 trait
/// 而非具体后端，传输后端可替换（SFTP = [`sftp`] 模块实现；FTP/FTPS = ftp
/// 模块实现，Phase 2 Task 5）。
///
/// ## 通用性核查结论（Task 5 Step 1，先重构后实现）
///
/// Phase 1 收口版 trait 本就**无 SFTP 类型泄漏**（签名只含 crate 自有类型与
/// std 类型）；SFTP 特有面在其**命名与周边自由函数**——「parallel」是 SFTP
/// 单通道流水线策略的命名泄漏，并行分块 + journal 机制整体留在 [`sftp`] 模块
/// （= 事实上的 SFTP extension surface：`download_parallel`/`upload_parallel`
/// 自由函数、journal 帮手，仅 SFTP 消费面使用）。本重构把 trait 迁到 crate
/// 根并去「parallel」命名：[`FileTransfer::download`] / [`FileTransfer::upload`]。
/// 迁移验收 = `tests/sftp_test.rs`（自由函数面）**断言零改动**。
///
/// 签名只含 crate 自有类型与 std 类型；russh 类型只出现在 SFTP 实现内部
/// （边界裁定见 crate 文档，与 `SshTransport::Channel` 例外同等待遇）。
pub trait FileTransfer {
    /// 下载：远端 `remote` → 本地 `local`。SFTP 语义见 [`sftp::download_parallel`]。
    ///
    /// `chunks` 是并发提示（并行后端的 worker 数）；FTP 这类**线性后端忽略
    /// 该值**（单控制连接顺序传输，简报裁定）。`journal_path` 是断点续传
    /// journal 位置——语义按后端各自实现（SFTP = chunk 粒度续传；FTP 下载 =
    /// REST 偏移续传、上传 = 以远端实际大小为准的 APPE 续传）。
    fn download(
        &self,
        remote: &str,
        local: &Path,
        chunks: usize,
        journal_path: &Path,
        cancel: &CancelToken,
        progress: Option<ProgressHook>,
    ) -> impl Future<Output = Result<TransferStats>> + Send;

    /// 上传：本地 `local` → 远端 `remote`。语义同 [`FileTransfer::download`]。
    fn upload(
        &self,
        local: &Path,
        remote: &str,
        chunks: usize,
        journal_path: &Path,
        cancel: &CancelToken,
        progress: Option<ProgressHook>,
    ) -> impl Future<Output = Result<TransferStats>> + Send;
}

/// crate 统一错误。**不含任何 russh / russh-sftp 类型**（I-1 同款纪律）：
/// 底层错误在产生点即被映射为自有变体，类型擦除为 `Box<dyn Error>` 后经
/// [`std::error::Error::source`] 保留可追溯；`message` 字段承载其 Display 文本。
#[derive(Debug)]
pub enum Error {
    /// 传输/SFTP 协议层错误（服务器拒绝、协议失配、journal 身份不符等）。
    Protocol {
        message: String,
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },
    /// 本地文件 I/O 错误。
    Io(std::io::Error),
    /// 传输被调用方取消（Task 10 Step 2）：chunk 边界协作退出；journal 保留，
    /// 同身份重传即断点续传。
    Cancelled,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Protocol { message, .. } => write!(f, "transfer protocol error: {message}"),
            Error::Io(e) => write!(f, "local io error: {e}"),
            Error::Cancelled => write!(f, "transfer cancelled"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        fn erased(
            source: &Option<Box<dyn std::error::Error + Send + Sync>>,
        ) -> Option<&(dyn std::error::Error + 'static)> {
            source
                .as_ref()
                .map(|e| &**e as &(dyn std::error::Error + 'static))
        }
        match self {
            Error::Protocol { source, .. } => erased(source),
            Error::Io(e) => Some(e),
            Error::Cancelled => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

/// ottr-ssh 错误边界转换（SFTP 子系统流打开路径）：russh 细节已在 ottr-ssh
/// 侧擦除为本变体 message + source，此处再包一层 [`Error::Protocol`]，
/// 不引入对 russh 类型的任何依赖（I-1 纪律）。
impl From<ottr_ssh::Error> for Error {
    fn from(e: ottr_ssh::Error) -> Self {
        Error::Protocol {
            message: e.to_string(),
            source: Some(Box::new(e)),
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
