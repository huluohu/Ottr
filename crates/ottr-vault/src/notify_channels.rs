//! notify_channels 表访问（Phase 3 Task 3，B5 渠道全矩阵——存储侧，spec §3）。
//!
//! 渠道配置是**密文面**：webhook URL / bot token / 加签 secret / SMTP 密码等
//! 敏感材料整体 JSON 序列化后密封进 config_enc（AES-256-GCM，AAD =
//! `notify_channels:{id}:config`，[`crate::aad`] 唯一构造点）——spec §3
//! 「通知渠道 config 一律走 *_enc 密文，不落明文」。**已登记
//! [`crate::store::scan_registry`]**（主密码升级重密封扫描覆盖，守卫测试
//! `reencrypt_scan_covers_all_enc_columns` 动态比对强制）；锁定语义与
//! secrets/summaries 相同（`Vault::cipher()` 锁定即拒）。
//!
//! 序列化面（与 `frontend/vault/api.ts` 同构）刻意分两层：
//! * [`NotifyChannel`] —— 不含任何密钥材料（config_enc 不进结构体，凭据
//!   同款纪律）；`enabled`/`template_overrides` 非敏感明文列随行返回；
//! * [`NotifyChannels::reveal`] —— 明文 config 单点出库（设置页「发送测试」
//!   与管线挂载时取一次），对应 `credentials_reveal` 同一模式。
//!
//! 密封写入模式：占位行拿 id（AUTOINCREMENT）→ 同事务内密封回填（secrets.rs
//! 同款，无半密封窗口）；update 的 config=None = 保留现值（未重输的 token
//! 不重密封，CredentialPatch 同语义）。

use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::{Result, Vault, VaultError, aad};

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// 合法渠道类别（DB CHECK 同集，spec §3 12 种）。
pub const CHANNEL_KINDS: &[&str] = &[
    "dingtalk",
    "feishu",
    "wecom",
    "bark",
    "serverchan",
    "telegram",
    "discord",
    "slack",
    "smtp",
    "pushover",
    "ntfy",
    "webhook",
];

/// 渠道行（**不含任何密钥材料**——config_enc 不进结构体，明文只经
/// [`NotifyChannels::reveal`] 单点取回）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NotifyChannel {
    pub id: i64,
    /// "dingtalk" | "feishu" | ... | "webhook"（DB CHECK 同集 12 种）。
    pub kind: String,
    /// 渠道级文案覆写（JSON 对象可空；MVP 仅 webhook body 模板消费）。
    pub template_overrides: Option<serde_json::Value>,
    /// 启用位（禁用 = 挂载层跳过挂载；删除前的软开关）。
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 新建渠道的输入：`config` 为明文 JSON 对象（字段面按 kind 见
/// frontend/notify/channels/types.ts），存储层 seal。
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NotifyChannelInput {
    pub kind: String,
    pub config: serde_json::Value,
    pub template_overrides: Option<serde_json::Value>,
    pub enabled: bool,
}

/// 更新补丁：`config` None = 保留现值（未重输的 token 不重密封）。
#[derive(Debug, Clone, Default, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NotifyChannelPatch {
    pub kind: Option<String>,
    pub config: Option<serde_json::Value>,
    pub template_overrides: Option<Option<serde_json::Value>>,
    pub enabled: Option<bool>,
}

/// 校验 kind 合法集（create/update 共用）。
fn validate_kind(kind: &str) -> Result<()> {
    if !CHANNEL_KINDS.contains(&kind) {
        return Err(VaultError::InvalidInput(format!(
            "unknown channel kind: {kind} (dingtalk/feishu/wecom/bark/serverchan/telegram/discord/slack/smtp/pushover/ntfy/webhook)"
        )));
    }
    Ok(())
}

/// 密封 config 并回填（None 不动——update 的保留语义）。
/// AAD 经 [`aad`] 构造：`notify_channels:{id}:config`（换绑防护由 GCM 强制）。
fn seal_config(
    cipher: &crate::Cipher,
    conn: &rusqlite::Connection,
    id: i64,
    config: Option<&serde_json::Value>,
) -> Result<()> {
    let Some(config) = config else { return Ok(()) };
    let blob = cipher.seal(
        config.to_string().as_bytes(),
        &aad("notify_channels", id, "config"),
    )?;
    conn.execute(
        "UPDATE notify_channels SET config_enc = ?1 WHERE id = ?2",
        params![blob, id],
    )?;
    Ok(())
}

/// [`NotifyChannel`] 的存储入口。
pub struct NotifyChannels;

impl NotifyChannels {
    /// 落一条渠道并返回完整行（id/时间戳由存储层定）。config 必须是 JSON
    /// 对象（字段面按 kind 由前端校验，存储层只挡明显乱写）。
    pub fn create(vault: &Vault, input: &NotifyChannelInput) -> Result<NotifyChannel> {
        validate_kind(&input.kind)?;
        if !input.config.is_object() {
            return Err(VaultError::InvalidInput(
                "channel config must be a JSON object".into(),
            ));
        }
        let ts = now_ts();
        let overrides = input
            .template_overrides
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        // 密文列先置占位 blob：AAD 需要 row id，行落地后同事务回填（无中间可见态）。
        tx.execute(
            "INSERT INTO notify_channels (kind, config_enc, template_overrides, enabled, created_at, updated_at)
             VALUES (?1, zeroblob(1), ?2, ?3, ?4, ?4)",
            params![input.kind, overrides, input.enabled as i64, ts],
        )?;
        let id = tx.last_insert_rowid();
        seal_config(&vault.cipher()?, &tx, id, Some(&input.config))?;
        tx.commit()?;
        Ok(NotifyChannel {
            id,
            kind: input.kind.clone(),
            template_overrides: input.template_overrides.clone(),
            enabled: input.enabled,
            created_at: ts,
            updated_at: ts,
        })
    }

    /// 补丁式更新：kind/config/template_overrides/enabled 各 Some 才覆写
    /// （config Some = 重密封；None = 保留现值）。行不存在 → NotFound。
    /// 事务与连接锁同块作用域：必须在 `Self::get` 重入 `vault.connection()`
    /// 前全部释放（单连接 Mutex 不可重入——TDD 实测死锁教训，见 task-3 报告）。
    pub fn update(vault: &Vault, id: i64, patch: &NotifyChannelPatch) -> Result<NotifyChannel> {
        let ts = now_ts();
        {
            let conn = vault.connection();
            let tx = conn.unchecked_transaction()?;
            let existing: Option<String> = tx
                .query_row(
                    "SELECT kind FROM notify_channels WHERE id = ?1",
                    [id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(existing_kind) = existing else {
                return Err(VaultError::NotFound(format!("notify channel id={id}")));
            };
            let kind = match &patch.kind {
                Some(k) => {
                    validate_kind(k)?;
                    tx.execute(
                        "UPDATE notify_channels SET kind = ?1 WHERE id = ?2",
                        params![k, id],
                    )?;
                    k.clone()
                }
                None => existing_kind,
            };
            if let Some(config) = &patch.config
                && !config.is_object()
            {
                return Err(VaultError::InvalidInput(
                    "channel config must be a JSON object".into(),
                ));
            }
            if let Some(enabled) = patch.enabled {
                tx.execute(
                    "UPDATE notify_channels SET enabled = ?1 WHERE id = ?2",
                    params![enabled as i64, id],
                )?;
            }
            if let Some(overrides) = &patch.template_overrides {
                let json = overrides.as_ref().map(serde_json::to_string).transpose()?;
                tx.execute(
                    "UPDATE notify_channels SET template_overrides = ?1 WHERE id = ?2",
                    params![json, id],
                )?;
            }
            seal_config(&vault.cipher()?, &tx, id, patch.config.as_ref())?;
            tx.execute(
                "UPDATE notify_channels SET updated_at = ?1 WHERE id = ?2",
                params![ts, id],
            )?;
            tx.commit()?;
            let _ = kind; // 现值经 get() 重读返回（单点事实源）
        }
        Self::get(vault, id)?.ok_or_else(|| VaultError::NotFound(format!("notify channel id={id}")))
    }

    /// 删渠道；未知 id 显式报 [`VaultError::NotFound`]。规则订阅面
    /// （alert_rules.channels）的悬空 id 由引擎侧过滤（FK 只约束本表）。
    pub fn delete(vault: &Vault, id: i64) -> Result<()> {
        let n = vault
            .connection()
            .execute("DELETE FROM notify_channels WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("notify channel id={id}")));
        }
        Ok(())
    }

    pub fn get(vault: &Vault, id: i64) -> Result<Option<NotifyChannel>> {
        let conn = vault.connection();
        conn.query_row(
            "SELECT * FROM notify_channels WHERE id = ?1",
            [id],
            row_to_channel,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn list(vault: &Vault) -> Result<Vec<NotifyChannel>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare("SELECT * FROM notify_channels ORDER BY id")?;
        let rows = stmt
            .query_map([], row_to_channel)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 明文 config 单点出库（设置页「发送测试」/管线挂载时取一次）。
    /// 行不存在 → NotFound；密文损坏/AAD 换绑/明文非 JSON → Crypto 错误浮出。
    pub fn reveal_config(vault: &Vault, id: i64) -> Result<serde_json::Value> {
        let conn = vault.connection();
        let blob: Option<Vec<u8>> = conn
            .query_row(
                "SELECT config_enc FROM notify_channels WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("notify channel id={id}")))?;
        let blob = blob.ok_or_else(|| VaultError::Crypto("channel config blob is NULL".into()))?;
        let plain = vault
            .cipher()?
            .open(&blob, &aad("notify_channels", id, "config"))?;
        serde_json::from_slice(&plain)
            .map_err(|e| VaultError::Crypto(format!("channel config is not valid JSON: {e}")))
    }
}

fn row_to_channel(row: &Row) -> rusqlite::Result<NotifyChannel> {
    let kind: String = row.get("kind")?;
    if !CHANNEL_KINDS.contains(&kind.as_str()) {
        return Err(conv_failure(row, "kind", &format!("unknown kind: {kind}")));
    }
    let overrides_raw: Option<String> = row.get("template_overrides")?;
    let template_overrides = overrides_raw
        .map(|s| serde_json::from_str::<serde_json::Value>(&s))
        .transpose()
        .map_err(|e| conv_failure(row, "template_overrides", &e.to_string()))?;
    Ok(NotifyChannel {
        id: row.get("id")?,
        kind,
        template_overrides,
        enabled: row.get::<_, i64>("enabled")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 行内列解析失败 → rusqlite 错误（alert_rules.rs conv_failure 同款形态）。
fn conv_failure(row: &Row, column: &str, msg: &str) -> rusqlite::Error {
    use rusqlite::types::Type;
    let idx = row.as_ref().column_index(column).unwrap_or(0);
    rusqlite::Error::FromSqlConversionFailure(
        idx,
        Type::Text,
        Box::new(VaultError::InvalidInput(msg.to_string())),
    )
}
