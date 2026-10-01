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
pub mod deploy;
pub mod forward;
pub mod jump;
pub mod jump_session;
pub mod keygen;
pub mod russh_impl;
pub mod shell_integration;

pub use auth::{AuthMethod, HostKeyPolicy, PromptResponder};
pub use deploy::{DeployOutcome, DeployStatus, deploy_public_key};
pub use forward::{
    ForwardKind, ForwardRunning, ForwardSpec, ForwardState, ForwardStats, ForwardStatsSnapshot,
    RemoteForwardRouter,
};
pub use jump::{HopSpec, JumpError};
pub use jump_session::JumpSession;
pub use keygen::{KeyAlgorithm, KeyMaterial, PublicKeyInfo, generate, inspect, parse_public_key};
pub use russh_impl::{ExecOutput, RusshTransport, SshSession, connect, connect_with_keepalive};
// ExecOutput（SshSession::exec 的结果类型）随方法一起出根：Phase 3 Task 4（B6）
// 批量执行在 src-tauri 侧消费 exec 面（并发池 + 逐主机结果事件）。

// KeyError 随 Error 一起导出（Error::KeyLoad 的 source 类型）。

use std::fmt;

/// crate 统一错误。**不含任何 russh 类型**（I-1）：russh 原始错误在产生点即被
/// 映射为自有变体，其类型擦除为 `Box<dyn Error>` 后经 [`std::error::Error::source`]
/// 保留可追溯；`message` 字段承载其 Display 文本。消费方按本枚举匹配，
/// 不应（也无法）匹配 russh 变体。
#[derive(Debug)]
pub enum Error {
    /// 主机密钥校验被策略拒绝（pin 不匹配 / TOFU 拒绝）。
    /// `fingerprint` 为服务器实际出示的 `SHA256:…` 指纹。
    HostKeyRejected {
        fingerprint: String,
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },
    /// 服务端拒绝认证（密码错误 / 密钥不在白名单 / 验证码错误）。
    AuthRejected,
    /// keyboard-interactive 回调返回的答案数量与 prompt 数量不一致。
    PromptAnswerMismatch { prompts: usize, answers: usize },
    /// 私钥文件加载失败（含口令缺失/错误），`KeyError` 为 crate 自有分类。
    KeyLoad { path: String, source: KeyError },
    /// 传输/协议层错误（连接失败、握手失败、通道打开失败等）。
    Protocol {
        message: String,
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },
    /// 网络 I/O 错误。
    Io(std::io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::HostKeyRejected { fingerprint, .. } => write!(
                f,
                "host key rejected by policy (server fingerprint: {fingerprint})"
            ),
            Error::AuthRejected => write!(f, "authentication rejected by server"),
            Error::PromptAnswerMismatch { prompts, answers } => write!(
                f,
                "keyboard-interactive: got {answers} answers for {prompts} prompts"
            ),
            Error::KeyLoad { path, source } => {
                write!(f, "failed to load private key {path}: {source}")
            }
            Error::Protocol { message, .. } => write!(f, "ssh protocol error: {message}"),
            Error::Io(e) => write!(f, "network error: {e}"),
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
            Error::HostKeyRejected { source, .. } => erased(source),
            Error::KeyLoad { source, .. } => Some(source),
            Error::Protocol { source, .. } => erased(source),
            Error::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<russh::Error> for Error {
    fn from(e: russh::Error) -> Self {
        // 类型在此处被擦除：公共变体不暴露 russh::Error（I-1）。
        Error::Protocol {
            message: e.to_string(),
            source: Some(Box::new(e)),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

/// 私钥加载失败的 crate 自有分类（不泄漏 russh 类型；russh 原始错误
/// 经 `source()` 或 `Invalid` 的 boxed source 可追溯）。
#[derive(Debug)]
pub enum KeyError {
    /// 密钥文件不存在或不可读。
    Io(std::io::Error),
    /// 密钥已加密：缺口令或口令错误。
    PassphraseRequired,
    /// 密钥内容损坏、格式/算法不支持等。
    Invalid {
        message: String,
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeyError::Io(e) => write!(f, "key file I/O error: {e}"),
            KeyError::PassphraseRequired => {
                write!(f, "key is encrypted: passphrase missing or wrong")
            }
            KeyError::Invalid { message, .. } => write!(f, "invalid key: {message}"),
        }
    }
}

impl std::error::Error for KeyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            KeyError::Io(e) => Some(e),
            KeyError::Invalid { source, .. } => source
                .as_ref()
                .map(|e| &**e as &(dyn std::error::Error + 'static)),
            _ => None,
        }
    }
}

impl From<russh::keys::Error> for KeyError {
    fn from(e: russh::keys::Error) -> Self {
        match e {
            russh::keys::Error::IO(io) => KeyError::Io(io),
            russh::keys::Error::KeyIsEncrypted => KeyError::PassphraseRequired,
            other => KeyError::Invalid {
                message: other.to_string(),
                source: Some(Box::new(other)),
            },
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// SSH 传输隔离层（spec 约束）：russh 不达标时可切 libssh2。
///
/// **libssh2 fallback 适配点**（russh 具体类型泄漏处）：
/// - `type Channel`：当前直接暴露 `russh::Channel<russh::client::Msg>`；
///   切换实现时需改为包装类型（如 `TransportChannel`）并重写 `open_pty` 返回值。
///   这是 russh 类型在 trait 边界上的**唯一**泄漏点。
/// - `connect` 的内部握手/auth 实现需整体替换，签名可保持不变
///   （`AuthMethod` / `HostKeyPolicy` / `Error` / `KeyError` 均为 crate 自有类型，与 russh 无关）。
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
