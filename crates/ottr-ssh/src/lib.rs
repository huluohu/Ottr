//! ottr-ssh：SSH 传输层。Phase 0 spike #1 —— russh 连接 + 三种认证
//! （password / publickey / keyboard-interactive）。
//!
//! 消费方式（Task 4 PTY / Task 7 SFTP / Task 8 跳板 / Task 9 迁移）：
//! 优先依赖 [`SshTransport`] trait 与 [`AuthMethod`]，而不是 russh 具体类型。
//!
//! ```no_run
//! # async fn demo() -> ottr_ssh::Result<()> {
//! use ottr_ssh::{AuthMethod, RusshTransport, SshTransport};
//!
//! let session = RusshTransport::connect(
//!     "127.0.0.1", 2222, "spike",
//!     AuthMethod::Password("spike-pass".into()),
//!     // spike：生产上必须 pin 指纹或走 TOFU，不允许一律放行
//!     std::sync::Arc::new(|fingerprint| fingerprint.starts_with("SHA256:")),
//! ).await?;
//! let channel = session.open_pty(120, 40).await?;
//! # Ok(())
//! # }
//! ```

pub mod auth;
pub mod russh_impl;

pub use auth::{AuthMethod, HostKeyPolicy, PromptResponder};
pub use russh_impl::{RusshTransport, SshSession, connect};

use std::fmt;

/// crate 统一错误。
#[derive(Debug)]
pub enum Error {
    /// russh 协议/连接错误（含 check_server_key 拒绝后的 UnknownKey）。
    Russh(russh::Error),
    /// 网络 I/O 错误。
    Io(std::io::Error),
    /// 私钥文件加载失败（含口令错误解密失败）。
    KeyLoad {
        path: String,
        source: russh::keys::Error,
    },
    /// 服务端拒绝认证（密码错误 / 密钥不在白名单 / 验证码错误）。
    AuthRejected,
    /// keyboard-interactive 回调返回的答案数量与 prompt 数量不一致。
    PromptAnswerMismatch {
        prompts: usize,
        answers: usize,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Russh(e) => write!(f, "ssh protocol error: {e}"),
            Error::Io(e) => write!(f, "network error: {e}"),
            Error::KeyLoad { path, source } => {
                write!(f, "failed to load private key {path}: {source}")
            }
            Error::AuthRejected => write!(f, "authentication rejected by server"),
            Error::PromptAnswerMismatch { prompts, answers } => write!(
                f,
                "keyboard-interactive: got {answers} answers for {prompts} prompts"
            ),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Russh(e) => Some(e),
            Error::Io(e) => Some(e),
            Error::KeyLoad { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<russh::Error> for Error {
    fn from(e: russh::Error) -> Self {
        Error::Russh(e)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// SSH 传输隔离层（spec 约束）：russh 不达标时可切 libssh2。
///
/// **libssh2 fallback 适配点**（russh 具体类型泄漏处，spike 阶段 pragmatic 保留）：
/// - `type Channel`：当前直接暴露 `russh::Channel<russh::client::Msg>`；
///   切换实现时需改为包装类型（如 `TransportChannel`）并重写 `open_pty` 返回值。
/// - `connect` 的内部握手/auth 实现需整体替换，签名可保持不变
///   （`AuthMethod` / `HostKeyPolicy` 与 russh 无关）。
/// - `SshSession` 上 russh 特有的扩展方法（如 `host_key_bytes`）不属于本 trait，
///   切换实现时由具体类型另行提供。
///
/// 方法签名返回 `impl Future + Send`：Task 4/7/8/9 需要在 tokio::spawn 中调用。
pub trait SshTransport: Sized {
    /// 会话通道类型。
    type Channel;

    /// 建立连接、校验主机密钥并完成认证。
    fn connect(
        addr: &str,
        port: u16,
        username: &str,
        auth: AuthMethod,
        host_key_cb: HostKeyPolicy,
    ) -> impl Future<Output = Result<Self>> + Send
    where
        Self: Sized;

    /// 打开 cols×rows 的交互式 PTY 通道（Task 4 消费）。
    fn open_pty(&self, cols: u32, rows: u32) -> impl Future<Output = Result<Self::Channel>> + Send;
}
