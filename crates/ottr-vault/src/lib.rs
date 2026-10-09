//! ottr-vault — 存储引擎与密钥层级（spec §3）。
//!
//! 层级：系统钥匙链（keyring）存 32B 随机 Master Key → 每条敏感字段独立
//! AES-256-GCM 密封（随机 nonce + AAD 绑定实体，防换绑）→ SQLite WAL 单文件
//! 落盘（FTS5 检索，见 migrations/）。

pub mod alert_rules;
pub mod cron_jobs;
pub mod crypto;
pub mod entities;
pub mod export;
pub mod forwards;
pub mod history;
pub mod jump_chains;
pub mod master_key;
pub mod mcp_grants;
pub mod notifications;
pub mod notify_channels;
pub mod recordings;
pub mod secrets;
pub mod seed;
pub mod settings;
pub mod store;
pub mod summaries;
pub mod sync_snapshot;

pub use crypto::{Cipher, aad};
// 主机清单 CSV 导出（BL-206：join/序列化随实体同库可单测；desktop 只管路径与落盘）
pub use entities::{
    Credential, CredentialInput, CredentialKind, CredentialPatch, Credentials, Host, HostGroup,
    HostGroups, HostInput, HostProtocol, Hosts, KnownHost, KnownHostState, KnownHosts, SecretField,
    Snippet, SnippetInput, Snippets, host_endpoint_key, parse_endpoint_key,
};
pub use export::hosts_csv;
pub use forwards::{ForwardKind, PortForward, PortForwardInput, PortForwards};
pub use history::{
    HISTORY_KEEP_ROWS, HISTORY_SEARCH_LIMIT, HISTORY_SESSION_LIMIT, History, HistoryEntry,
    HistoryInput,
};
pub use jump_chains::{JumpChain, JumpChainInput, JumpChains};
pub use master_key::MasterKey;
pub use notifications::{DeliveryFailure, Notification, NotificationInput, Notifications};
pub use notify_channels::{
    CHANNEL_KINDS, NotifyChannel, NotifyChannelInput, NotifyChannelPatch, NotifyChannels,
};
// 告警规则（Phase 3 Task 3，B5；评估引擎在 TS 侧，本 crate 只供表）
pub use alert_rules::{AlertRule, AlertRuleInput, AlertRules, RULE_KINDS};
// cron 定时任务（Phase 4 Task 1，缺口①；调度引擎在 ottr-monitor——宿主裁定
// 落地，本 crate 只供表 + 运行历史）
pub use cron_jobs::{
    CRON_RUN_STATUSES, CRON_RUNS_KEEP, CRON_SCHEDULE_MAX_BYTES, CRON_SCRIPT_MAX_BYTES, CronJob,
    CronJobInput, CronJobs, CronRun, CronRunInput, CronRuns,
};
// MCP 授权矩阵（Phase 4 Task 3，C1；协议引擎在 desktop commands/mcp.rs，
// 本 crate 只供表——cron_jobs 同款分工）
pub use mcp_grants::{MCP_READ_PATHS_MAX, McpGrant, McpGrantInput, McpGrants};
pub use secrets::Secrets;
pub use settings::Settings;
// 同步分类快照导出/导入（Phase 5 Task 3；编排引擎在 frontend/sync/SyncStore.ts，
// 本 crate 只供 vault ↔ 快照 JSON 的双向翻译——cron_jobs 同款分工）
pub use store::{KeyMode, Vault};
pub use summaries::{SUMMARIES_LIST_LIMIT, SessionSummaries, SummaryEntry, SummaryInput};
pub use sync_snapshot::{SYNC_CATEGORIES, SYNC_DATA_VERSION, SyncImportMode, SyncImportReport};
// 录制审计回放（Phase 3 Task 5，B3；asciinema 原始流在 .cast 文件，本 crate 只供表+FTS）
pub use recordings::{
    RECORDINGS_SEARCH_LIMIT, RecordingEntry, RecordingHit, RecordingInput, Recordings,
    TEXT_INDEX_PREFIX,
};

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
    /// KDF（Argon2id）派生失败。
    Kdf(String),
    /// 库的 schema 版本高于本程序支持——禁止降级打开以防静默数据损坏。
    SchemaTooNew {
        db: u32,
        app: u32,
    },
    /// meta.schema_version 存在但不是合法版本号——库可能被外部改写。
    /// 必须显式报错而非按 0 处理（按 0 会重跑迁移、静默改写库、掩盖损坏，T3 评审裁定）。
    CorruptedSchemaVersion(String),
    /// 输入校验失败（空名称、端口越界等）——消息可直接展示给用户。
    InvalidInput(String),
    /// 请求的实体不存在（update/delete/reveal 等按 id/key 操作落空）。
    NotFound(String),
    /// 库处于锁定态（主密码模式，Master Key 不在内存）——需要密钥的操作
    /// （凭据密封/解密、主密码升级）拒绝执行。UI 层应对策略 = 弹锁定屏。
    Locked,
    /// 主密码错误（解锁校验器开封失败；与「校验器损坏」统一映射，防侧信道枚举）。
    BadMasterPassword,
    /// 主密钥不可达：库是 keyring 模式但系统钥匙链服务不可用（典型：Linux
    /// Secret Service 在建库后消失）。密钥在打不开的钥匙链里，fallback 换钥
    /// 等于销毁数据——显式报错，绝不静默换钥。
    MasterKeyUnreachable,
    /// JSON 序列化/反序列化失败（tags/variables 等 JSON 列）。
    Json(serde_json::Error),
    /// 同步快照导入**写入段**中途失败（BL-206 反馈面）：单事务原子回滚不变，
    /// `category` 指明失败发生在哪个分类的写入（"host_groups"/"hosts"/…）——
    /// 此前中途的 SQL/密封错误裸穿原文、无位置可循；底层原因经 `source`
    /// 可追溯（`Display` 同样带分类前缀，直达 UI/日志即可定位）。
    ImportStep {
        /// 失败发生的写入分类（SYNC_CATEGORIES 之一或 "replace-delete"）。
        category: String,
        /// 底层错误（Sql/Json/Crypto…）。
        source: Box<VaultError>,
    },
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
            Self::Kdf(msg) => write!(f, "kdf error: {msg}"),
            Self::SchemaTooNew { db, app } => write!(
                f,
                "vault schema v{db} is newer than supported v{app}; upgrade Ottr to open it"
            ),
            Self::CorruptedSchemaVersion(v) => write!(
                f,
                "schema_version in meta is corrupted (not a version number): {v:?}; \
                 the vault file may have been modified externally"
            ),
            Self::InvalidInput(msg) => write!(f, "invalid input: {msg}"),
            Self::NotFound(msg) => write!(f, "not found: {msg}"),
            Self::Locked => write!(
                f,
                "vault is locked; unlock with the master password to continue"
            ),
            Self::BadMasterPassword => write!(f, "master password is incorrect"),
            Self::MasterKeyUnreachable => write!(
                f,
                "master key lives in the system keychain, which is currently unavailable; \
                 restore the keychain service to open this vault"
            ),
            Self::Json(e) => write!(f, "json error: {e}"),
            Self::ImportStep { category, source } => {
                write!(f, "sync import failed while writing {category}: {source}")
            }
        }
    }
}

impl std::error::Error for VaultError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            Self::Sql(e) => Some(e),
            Self::Keyring(e) => Some(e),
            Self::Json(e) => Some(e),
            Self::ImportStep { source, .. } => Some(source.as_ref()),
            _ => None,
        }
    }
}

impl From<serde_json::Error> for VaultError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
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
