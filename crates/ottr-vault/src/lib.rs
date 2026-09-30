//! ottr-vault — 存储引擎与密钥层级（spec §3）。
//!
//! 层级：系统钥匙链（keyring）存 32B 随机 Master Key → 每条敏感字段独立
//! AES-256-GCM 密封（随机 nonce + AAD 绑定实体，防换绑）→ SQLite WAL 单文件
//! 落盘（FTS5 检索，见 migrations/）。

pub mod crypto;

pub use crypto::{aad, Cipher};

use std::fmt;

/// vault 层统一错误。`Display` 面向用户可读（UI 侧直接展示）。
#[derive(Debug)]
pub enum VaultError {
    /// AES-GCM 密封/开封失败（含 AAD 换绑、blob 截断）。
    Crypto(String),
    Io(std::io::Error),
    Sql(rusqlite::Error),
    Keyring(keyring::Error),
    /// 钥匙链条目存在但内容不是合法的 32B key（十六进制损坏/被外部改写）。
    CorruptedMasterKey,
    /// 库的 schema 版本高于本程序支持——禁止降级打开以防静默数据损坏。
    SchemaTooNew { db: u32, app: u32 },
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Crypto(msg) => write!(f, "crypto error: {msg}"),
            Self::Io(e) => write!(f, "io error: {e}"),
            Self::Sql(e) => write!(f, "sqlite error: {e}"),
            Self::Keyring(e) => write!(f, "keyring error: {e}"),
            Self::CorruptedMasterKey => write!(
                f,
                "master key entry in keyring is corrupted (not valid hex / wrong length)"
            ),
            Self::SchemaTooNew { db, app } => write!(
                f,
                "vault schema v{db} is newer than supported v{app}; upgrade Ottr to open it"
            ),
        }
    }
}

impl std::error::Error for VaultError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            Self::Sql(e) => Some(e),
            Self::Keyring(e) => Some(e),
            _ => None,
        }
    }
}

impl From<aes_gcm::Error> for VaultError {
    fn from(e: aes_gcm::Error) -> Self {
        Self::Crypto(e.to_string())
    }
}

impl From<std::io::Error> for VaultError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<rusqlite::Error> for VaultError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e)
    }
}

impl From<keyring::Error> for VaultError {
    fn from(e: keyring::Error) -> Self {
        Self::Keyring(e)
    }
}

pub type Result<T> = std::result::Result<T, VaultError>;
