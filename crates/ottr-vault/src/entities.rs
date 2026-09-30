//! 实体 CRUD + FTS5 trigram 检索（spec §3：hosts / credentials / host_groups /
//! snippets / known_hosts；history 表 Task 15、notifications Task 12 各自成迁移）。
//!
//! 设计要点：
//! - **序列化面即前端契约**：结构体字段与 serde 形态由 `src/vault/api.ts` 同构镜像
//!   （snake_case、`Option<T>` ↔ `T | null`）。敏感字段（`*_enc`）绝不进结构体——
//!   明文只经 [`Credentials::reveal`] 单点出库。
//! - **密文纪律**：调用方传明文，存储层经 [`Vault::crypto`] seal；AAD 一律走
//!   [`crate::aad`]（`credentials:{id}:{field}`）。落库无明文由
//!   `entities_test::credential_secret_is_sealed_at_rest` 直查库文件断言。
//! - **AAD 绑定表一律 AUTOINCREMENT**（评审 I-1）：承载加密字段的表主键必须是
//!   `INTEGER PRIMARY KEY AUTOINCREMENT`（0002 迁移已落地）——裸 rowid 在删最大行后
//!   会被新行复用，同主密钥下被删行的旧密文即可原样通过 GCM 认证注入复用同 id 的
//!   新行；AUTOINCREMENT 保证 rowid 严格递增永不复用。回归测试
//!   `entities_test::rowids_never_reused_after_delete`。未来新表凡带 `*_enc`/
//!   `config_enc` 类字段必须遵守本约定。
//! - **删除语义（裁定 #3）**：credentials / host_groups 是可复用实体，只解绑不级联删；
//!   FK 统一 ON DELETE SET NULL（0002 迁移），删引用方留被引用方。
//! - **检索（spec §3 CJK 约束 + Task 3 实测）**：trigram 只命中 ≥3 字符查询，
//!   `search` 按字符数分派——≥3 走 FTS MATCH（短语引号包裹防 FTS 语法注入），
//!   <3 走 LIKE 兜底（`%_\` 转义）；空查询返回全量。

use rusqlite::types::Type;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::crypto::Cipher;
use crate::{aad, Result, Vault, VaultError};

// ---------------------------------------------------------------------------
// 公共工具
// ---------------------------------------------------------------------------

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn tags_to_json(tags: &[String]) -> String {
    serde_json::to_string(tags).expect("Vec<String> 总能序列化")
}

/// JSON 列 → Vec<String>；损坏内容报 [`VaultError::Json`]（不静默吞掉）。
fn list_from_json(raw: &str) -> Result<Vec<String>> {
    serde_json::from_str(raw).map_err(Into::into)
}

/// LIKE 兜底的通配转义：`\` `%` `_` 前置 `\`，配合 `ESCAPE '\'` 使用。
fn escape_like(query: &str) -> String {
    query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// FTS5 MATCH 查询词：短语引号包裹（内部 `"` 翻倍），防 AND/OR/NEAR/* 等语法注入。
fn fts_phrase(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

/// 行内列解析失败 → rusqlite 错误（带真实列位，query_map 闭包可直接 `?`）。
fn conv_failure(
    row: &Row,
    column: &str,
    source: impl std::error::Error + Send + Sync + 'static,
) -> rusqlite::Error {
    let idx = row.as_ref().column_index(column).unwrap_or(0);
    rusqlite::Error::FromSqlConversionFailure(idx, Type::Text, Box::new(source))
}

// ---------------------------------------------------------------------------
// HostGroups
// ---------------------------------------------------------------------------

/// 主机分组（树形：parent_id 自引用）。删父组 → 子组提根；删组 → 组内主机脱离分组。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostGroup {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub color: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// [`HostGroup`] 的存储入口（零尺寸命名空间，方法签名以 `&Vault` 开头）。
pub struct HostGroups;

impl HostGroups {
    pub fn create(
        vault: &Vault,
        name: &str,
        parent_id: Option<i64>,
        color: Option<&str>,
    ) -> Result<HostGroup> {
        Self::validate(name)?;
        let ts = now_ts();
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO host_groups (name, parent_id, color, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![name, parent_id, color, ts],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(HostGroup {
            id,
            name: name.into(),
            parent_id,
            color: color.map(Into::into),
            created_at: ts,
            updated_at: ts,
        })
    }

    /// 全量替换式更新（name/parent_id/color 三字段同提交；parent_id=None 即提根）。
    pub fn update(
        vault: &Vault,
        id: i64,
        name: &str,
        parent_id: Option<i64>,
        color: Option<&str>,
    ) -> Result<HostGroup> {
        Self::validate(name)?;
        let ts = now_ts();
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        let created_at: i64 = tx
            .query_row(
                "SELECT created_at FROM host_groups WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("host_group id={id}")))?;
        tx.execute(
            "UPDATE host_groups SET name = ?1, parent_id = ?2, color = ?3, updated_at = ?4
             WHERE id = ?5",
            params![name, parent_id, color, ts, id],
        )?;
        tx.commit()?;
        Ok(HostGroup {
            id,
            name: name.into(),
            parent_id,
            color: color.map(Into::into),
            created_at,
            updated_at: ts,
        })
    }

    pub fn get(vault: &Vault, id: i64) -> Result<Option<HostGroup>> {
        let conn = vault.connection();
        conn.query_row(
            "SELECT * FROM host_groups WHERE id = ?1",
            [id],
            row_to_group,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn list(vault: &Vault) -> Result<Vec<HostGroup>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare("SELECT * FROM host_groups ORDER BY name")?;
        let rows = stmt
            .query_map([], row_to_group)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 删组：组内主机 group_id 置空、子组 parent_id 置空（FK ON DELETE SET NULL）。
    pub fn delete(vault: &Vault, id: i64) -> Result<()> {
        let n = vault
            .connection()
            .execute("DELETE FROM host_groups WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("host_group id={id}")));
        }
        Ok(())
    }

    fn validate(name: &str) -> Result<()> {
        if name.trim().is_empty() {
            return Err(VaultError::InvalidInput(
                "group name must not be empty".into(),
            ));
        }
        Ok(())
    }
}

fn row_to_group(row: &Row) -> rusqlite::Result<HostGroup> {
    Ok(HostGroup {
        id: row.get("id")?,
        name: row.get("name")?,
        parent_id: row.get("parent_id")?,
        color: row.get("color")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// 凭据类型（serde 小写，DB CHECK 同名约束）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialKind {
    Password,
    Key,
    Totp,
}

impl CredentialKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Key => "key",
            Self::Totp => "totp",
        }
    }
}

impl std::str::FromStr for CredentialKind {
    type Err = VaultError;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "password" => Ok(Self::Password),
            "key" => Ok(Self::Key),
            "totp" => Ok(Self::Totp),
            other => Err(VaultError::InvalidInput(format!(
                "unknown credential kind: {other}"
            ))),
        }
    }
}

/// 可开封的密文字段（列名与 AAD 字段名一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretField {
    Secret,
    Passphrase,
    TotpSecret,
}

impl SecretField {
    fn aad_name(self) -> &'static str {
        match self {
            Self::Secret => "secret",
            Self::Passphrase => "passphrase",
            Self::TotpSecret => "totp_secret",
        }
    }

    fn column(self) -> &'static str {
        match self {
            Self::Secret => "secret_enc",
            Self::Passphrase => "passphrase_enc",
            Self::TotpSecret => "totp_secret_enc",
        }
    }
}

/// 凭据。**不含任何密钥材料**（`*_enc` 列不进结构体）——明文只经
/// [`Credentials::reveal`] 单点取回，序列化面（TS 类型同构）天然无密钥。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Credential {
    pub id: i64,
    pub kind: CredentialKind,
    pub key_pub: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 新建凭据的输入：`secret`（password/key 的主体：口令或私钥）、`passphrase`、
/// `totp_secret` 为明文，存储层 seal；`key_pub` 非敏感，明文存储。
#[derive(Debug, Clone, Deserialize)]
pub struct CredentialInput {
    pub kind: CredentialKind,
    pub secret: Option<String>,
    pub key_pub: Option<String>,
    pub passphrase: Option<String>,
    pub totp_secret: Option<String>,
}

/// 更新凭据的补丁：全部 `None = 保留现值`（UI 语义：未重输的密钥不重密封）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CredentialPatch {
    pub kind: Option<CredentialKind>,
    pub secret: Option<String>,
    pub key_pub: Option<String>,
    pub passphrase: Option<String>,
    pub totp_secret: Option<String>,
}

/// [`Credential`] 的存储入口。
pub struct Credentials;

impl Credentials {
    pub fn create(vault: &Vault, input: &CredentialInput) -> Result<Credential> {
        let ts = now_ts();
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        // 密文列先置 NULL：AAD 需要 row id，行落地后回填（同一事务，无中间可见态）。
        tx.execute(
            "INSERT INTO credentials (kind, key_pub, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)",
            params![input.kind.as_str(), input.key_pub, ts],
        )?;
        let id = tx.last_insert_rowid();
        seal_fields(
            vault.crypto(),
            &tx,
            id,
            input.secret.as_deref(),
            input.passphrase.as_deref(),
            input.totp_secret.as_deref(),
        )?;
        tx.commit()?;
        Ok(Credential {
            id,
            kind: input.kind,
            key_pub: input.key_pub.clone(),
            created_at: ts,
            updated_at: ts,
        })
    }

    /// `patch` 中 Some 的字段替换（密文字段重密封），None 保留现值。
    pub fn update(vault: &Vault, id: i64, patch: &CredentialPatch) -> Result<Credential> {
        let ts = now_ts();
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        let (existing_kind, existing_key_pub, created_at): (String, Option<String>, i64) = tx
            .query_row(
                "SELECT kind, key_pub, created_at FROM credentials WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("credential id={id}")))?;
        let kind = match patch.kind {
            Some(k) => {
                tx.execute(
                    "UPDATE credentials SET kind = ?1 WHERE id = ?2",
                    params![k.as_str(), id],
                )?;
                k
            }
            None => existing_kind.parse()?,
        };
        if let Some(key_pub) = &patch.key_pub {
            tx.execute(
                "UPDATE credentials SET key_pub = ?1 WHERE id = ?2",
                params![key_pub, id],
            )?;
        }
        seal_fields(
            vault.crypto(),
            &tx,
            id,
            patch.secret.as_deref(),
            patch.passphrase.as_deref(),
            patch.totp_secret.as_deref(),
        )?;
        tx.execute(
            "UPDATE credentials SET updated_at = ?1 WHERE id = ?2",
            params![ts, id],
        )?;
        tx.commit()?;
        Ok(Credential {
            id,
            kind,
            key_pub: patch.key_pub.clone().or(existing_key_pub),
            created_at,
            updated_at: ts,
        })
    }

    /// 删凭据：引用它的 host.credential_id 由 FK ON DELETE SET NULL 解绑（凭据不迁移）。
    pub fn delete(vault: &Vault, id: i64) -> Result<()> {
        let n = vault
            .connection()
            .execute("DELETE FROM credentials WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("credential id={id}")));
        }
        Ok(())
    }

    pub fn get(vault: &Vault, id: i64) -> Result<Option<Credential>> {
        let conn = vault.connection();
        conn.query_row(
            "SELECT * FROM credentials WHERE id = ?1",
            [id],
            row_to_credential,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn list(vault: &Vault) -> Result<Vec<Credential>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare("SELECT * FROM credentials ORDER BY id")?;
        let rows = stmt
            .query_map([], row_to_credential)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 明文单点出库。行不存在 → [`VaultError::NotFound`]；字段未设置（NULL）→ `None`。
    pub fn reveal(vault: &Vault, id: i64, field: SecretField) -> Result<Option<String>> {
        let conn = vault.connection();
        let sql = format!("SELECT {} FROM credentials WHERE id = ?1", field.column());
        let blob = match conn.query_row(&sql, params![id], |r| r.get::<_, Option<Vec<u8>>>(0)) {
            Ok(v) => v,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                return Err(VaultError::NotFound(format!("credential id={id}")));
            }
            Err(e) => return Err(e.into()),
        };
        let Some(blob) = blob else {
            return Ok(None);
        };
        let plain = vault
            .crypto()
            .open(&blob, &aad("credentials", id, field.aad_name()))?;
        String::from_utf8(plain)
            .map(Some)
            .map_err(|e| VaultError::Crypto(format!("secret field is not valid utf-8: {e}")))
    }
}

/// 明文 → 密文回填 `*_enc` 列。`None` 的字段不动（update 的保留语义）。
/// AAD 一律经 [`aad`] 构造：`credentials:{id}:{field}`（换绑防护由 GCM 认证强制）。
fn seal_fields(
    cipher: &Cipher,
    conn: &Connection,
    id: i64,
    secret: Option<&str>,
    passphrase: Option<&str>,
    totp_secret: Option<&str>,
) -> Result<()> {
    for (field, plain) in [
        ("secret", secret),
        ("passphrase", passphrase),
        ("totp_secret", totp_secret),
    ] {
        let Some(plain) = plain else { continue };
        let blob = cipher.seal(plain.as_bytes(), &aad("credentials", id, field))?;
        conn.execute(
            &format!("UPDATE credentials SET {field}_enc = ?1 WHERE id = ?2"),
            params![blob, id],
        )?;
    }
    Ok(())
}

fn row_to_credential(row: &Row) -> rusqlite::Result<Credential> {
    let kind: String = row.get("kind")?;
    Ok(Credential {
        id: row.get("id")?,
        kind: kind
            .parse()
            .map_err(|e: VaultError| conv_failure(row, "kind", e))?,
        key_pub: row.get("key_pub")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

/// 主机。tags 为 JSON 列；credential_id / group_id 可空、FK ON DELETE SET NULL；
/// jump_chain_id 的目标表（jump_chains）未建，暂无 FK（0002 迁移注释）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Host {
    pub id: i64,
    pub name: String,
    pub group_id: Option<i64>,
    pub tags: Vec<String>,
    pub address: String,
    pub port: i64,
    pub credential_id: Option<i64>,
    pub jump_chain_id: Option<i64>,
    pub encoding_override: Option<String>,
    pub theme_override: Option<String>,
    pub monitor_enabled: bool,
    pub notes: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 新建/全量更新主机的输入（字段名与 [`Host`] 可编辑子集同构）。
#[derive(Debug, Clone, Deserialize)]
pub struct HostInput {
    pub name: String,
    pub group_id: Option<i64>,
    pub tags: Vec<String>,
    pub address: String,
    pub port: i64,
    pub credential_id: Option<i64>,
    pub jump_chain_id: Option<i64>,
    pub encoding_override: Option<String>,
    pub theme_override: Option<String>,
    pub monitor_enabled: bool,
    pub notes: Option<String>,
}

/// [`Host`] 的存储入口。`search` 是 spec §3 CJK 检索的 API 落点。
pub struct Hosts;

impl Hosts {
    pub fn create(vault: &Vault, input: HostInput) -> Result<Host> {
        Self::validate(&input)?;
        let ts = now_ts();
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO hosts (name, group_id, tags, address, port, credential_id,
                                jump_chain_id, encoding_override, theme_override,
                                monitor_enabled, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
            params![
                input.name,
                input.group_id,
                tags_to_json(&input.tags),
                input.address,
                input.port,
                input.credential_id,
                input.jump_chain_id,
                input.encoding_override,
                input.theme_override,
                input.monitor_enabled,
                input.notes,
                ts,
            ],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(Host {
            id,
            name: input.name,
            group_id: input.group_id,
            tags: input.tags,
            address: input.address,
            port: input.port,
            credential_id: input.credential_id,
            jump_chain_id: input.jump_chain_id,
            encoding_override: input.encoding_override,
            theme_override: input.theme_override,
            monitor_enabled: input.monitor_enabled,
            notes: input.notes,
            created_at: ts,
            updated_at: ts,
        })
    }

    /// 全量替换式更新（表单语义：整单重提交）；created_at 保持不变。
    pub fn update(vault: &Vault, id: i64, input: HostInput) -> Result<Host> {
        Self::validate(&input)?;
        let ts = now_ts();
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        let created_at: i64 = tx
            .query_row("SELECT created_at FROM hosts WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("host id={id}")))?;
        tx.execute(
            "UPDATE hosts SET name = ?1, group_id = ?2, tags = ?3, address = ?4, port = ?5,
                              credential_id = ?6, jump_chain_id = ?7,
                              encoding_override = ?8, theme_override = ?9,
                              monitor_enabled = ?10, notes = ?11, updated_at = ?12
             WHERE id = ?13",
            params![
                input.name,
                input.group_id,
                tags_to_json(&input.tags),
                input.address,
                input.port,
                input.credential_id,
                input.jump_chain_id,
                input.encoding_override,
                input.theme_override,
                input.monitor_enabled,
                input.notes,
                ts,
                id,
            ],
        )?;
        tx.commit()?;
        Ok(Host {
            id,
            name: input.name,
            group_id: input.group_id,
            tags: input.tags,
            address: input.address,
            port: input.port,
            credential_id: input.credential_id,
            jump_chain_id: input.jump_chain_id,
            encoding_override: input.encoding_override,
            theme_override: input.theme_override,
            monitor_enabled: input.monitor_enabled,
            notes: input.notes,
            created_at,
            updated_at: ts,
        })
    }

    /// 删主机：绑定的凭据/分组实体不动（仅解绑），snippet 的 host_scope 置空。
    pub fn delete(vault: &Vault, id: i64) -> Result<()> {
        let n = vault
            .connection()
            .execute("DELETE FROM hosts WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("host id={id}")));
        }
        Ok(())
    }

    pub fn get(vault: &Vault, id: i64) -> Result<Option<Host>> {
        let conn = vault.connection();
        conn.query_row("SELECT * FROM hosts WHERE id = ?1", [id], row_to_host)
            .optional()
            .map_err(Into::into)
    }

    pub fn list(vault: &Vault) -> Result<Vec<Host>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare("SELECT * FROM hosts ORDER BY name")?;
        let rows = stmt
            .query_map([], row_to_host)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// `None` = 未分组主机（group_id IS NULL）。
    pub fn list_by_group(vault: &Vault, group_id: Option<i64>) -> Result<Vec<Host>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare("SELECT * FROM hosts WHERE group_id IS ?1 ORDER BY name")?;
        let rows = stmt
            .query_map([group_id], row_to_host)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// CJK 检索（hosts_fts：name + notes）。
    ///
    /// 分派规则（spec §3「超短查询用 LIKE 兜底」+ Task 3 实测：trigram 对 <3 字符
    /// 的 MATCH 恒 0 行）：
    /// - 空查询 → 全量（[`Hosts::list`]，⌘K 面板初始态）；
    /// - ≥3 字符 → FTS MATCH（短语引号包裹），按 bm25 相关度排序；
    /// - <3 字符 → LIKE 兜底（`%_\` 转义），按 name 排序。
    pub fn search(vault: &Vault, query: &str) -> Result<Vec<Host>> {
        let q = query.trim();
        if q.is_empty() {
            return Self::list(vault);
        }
        let conn = vault.connection();
        if q.chars().count() >= 3 {
            let phrase = fts_phrase(q);
            let mut stmt = conn.prepare(
                "SELECT hosts.* FROM hosts, hosts_fts
                 WHERE hosts.id = hosts_fts.rowid AND hosts_fts MATCH ?1
                 ORDER BY bm25(hosts_fts)",
            )?;
            let rows = stmt
                .query_map(params![phrase], row_to_host)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        } else {
            let pattern = format!("%{}%", escape_like(q));
            let mut stmt = conn.prepare(
                "SELECT * FROM hosts
                 WHERE name LIKE ?1 ESCAPE '\\' OR notes LIKE ?1 ESCAPE '\\'
                 ORDER BY name",
            )?;
            let rows = stmt
                .query_map(params![pattern], row_to_host)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        }
    }

    fn validate(input: &HostInput) -> Result<()> {
        if input.name.trim().is_empty() {
            return Err(VaultError::InvalidInput(
                "host name must not be empty".into(),
            ));
        }
        if input.address.trim().is_empty() {
            return Err(VaultError::InvalidInput(
                "host address must not be empty".into(),
            ));
        }
        if !(1..=65535).contains(&input.port) {
            return Err(VaultError::InvalidInput(format!(
                "port {} out of range 1-65535",
                input.port
            )));
        }
        Ok(())
    }
}

fn row_to_host(row: &Row) -> rusqlite::Result<Host> {
    let tags_raw: String = row.get("tags")?;
    let tags = list_from_json(&tags_raw).map_err(|e| conv_failure(row, "tags", e))?;
    Ok(Host {
        id: row.get("id")?,
        name: row.get("name")?,
        group_id: row.get("group_id")?,
        tags,
        address: row.get("address")?,
        port: row.get("port")?,
        credential_id: row.get("credential_id")?,
        jump_chain_id: row.get("jump_chain_id")?,
        encoding_override: row.get("encoding_override")?,
        theme_override: row.get("theme_override")?,
        monitor_enabled: row.get("monitor_enabled")?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

/// 命令片段：body 支持 `{{var}}` 模板，variables 为变量名清单（JSON 列）。
/// host_scope 可选绑定单机；删该主机 → 转全局（SET NULL）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snippet {
    pub id: i64,
    pub name: String,
    pub body: String,
    pub variables: Vec<String>,
    pub tags: Vec<String>,
    pub host_scope: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 新建/全量更新 snippet 的输入。
#[derive(Debug, Clone, Deserialize)]
pub struct SnippetInput {
    pub name: String,
    pub body: String,
    pub variables: Vec<String>,
    pub tags: Vec<String>,
    pub host_scope: Option<i64>,
}

/// [`Snippet`] 的存储入口。`search` 走 snippets_fts（spec §3：snippets.body）。
pub struct Snippets;

impl Snippets {
    pub fn create(vault: &Vault, input: &SnippetInput) -> Result<Snippet> {
        Self::validate(input)?;
        let ts = now_ts();
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO snippets (name, body, variables, tags, host_scope, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                input.name,
                input.body,
                tags_to_json(&input.variables),
                tags_to_json(&input.tags),
                input.host_scope,
                ts,
            ],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(Snippet {
            id,
            name: input.name.clone(),
            body: input.body.clone(),
            variables: input.variables.clone(),
            tags: input.tags.clone(),
            host_scope: input.host_scope,
            created_at: ts,
            updated_at: ts,
        })
    }

    /// 全量替换式更新；body 变更经触发器同步进 snippets_fts（测试覆盖）。
    pub fn update(vault: &Vault, id: i64, input: &SnippetInput) -> Result<Snippet> {
        Self::validate(input)?;
        let ts = now_ts();
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        let created_at: i64 = tx
            .query_row("SELECT created_at FROM snippets WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("snippet id={id}")))?;
        tx.execute(
            "UPDATE snippets SET name = ?1, body = ?2, variables = ?3, tags = ?4,
                                 host_scope = ?5, updated_at = ?6
             WHERE id = ?7",
            params![
                input.name,
                input.body,
                tags_to_json(&input.variables),
                tags_to_json(&input.tags),
                input.host_scope,
                ts,
                id,
            ],
        )?;
        tx.commit()?;
        Ok(Snippet {
            id,
            name: input.name.clone(),
            body: input.body.clone(),
            variables: input.variables.clone(),
            tags: input.tags.clone(),
            host_scope: input.host_scope,
            created_at,
            updated_at: ts,
        })
    }

    pub fn delete(vault: &Vault, id: i64) -> Result<()> {
        let n = vault
            .connection()
            .execute("DELETE FROM snippets WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("snippet id={id}")));
        }
        Ok(())
    }

    pub fn get(vault: &Vault, id: i64) -> Result<Option<Snippet>> {
        let conn = vault.connection();
        conn.query_row("SELECT * FROM snippets WHERE id = ?1", [id], row_to_snippet)
            .optional()
            .map_err(Into::into)
    }

    pub fn list(vault: &Vault) -> Result<Vec<Snippet>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare("SELECT * FROM snippets ORDER BY name")?;
        let rows = stmt
            .query_map([], row_to_snippet)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// CJK 检索（snippets_fts：body）。分派规则与 [`Hosts::search`] 相同
    /// （≥3 字符 FTS MATCH / <3 字符 LIKE 兜底；空查询返回全量）。
    pub fn search(vault: &Vault, query: &str) -> Result<Vec<Snippet>> {
        let q = query.trim();
        if q.is_empty() {
            return Self::list(vault);
        }
        let conn = vault.connection();
        if q.chars().count() >= 3 {
            let phrase = fts_phrase(q);
            let mut stmt = conn.prepare(
                "SELECT snippets.* FROM snippets, snippets_fts
                 WHERE snippets.id = snippets_fts.rowid AND snippets_fts MATCH ?1
                 ORDER BY bm25(snippets_fts)",
            )?;
            let rows = stmt
                .query_map(params![phrase], row_to_snippet)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        } else {
            let pattern = format!("%{}%", escape_like(q));
            let mut stmt = conn
                .prepare("SELECT * FROM snippets WHERE body LIKE ?1 ESCAPE '\\' ORDER BY name")?;
            let rows = stmt
                .query_map(params![pattern], row_to_snippet)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        }
    }

    fn validate(input: &SnippetInput) -> Result<()> {
        if input.name.trim().is_empty() {
            return Err(VaultError::InvalidInput(
                "snippet name must not be empty".into(),
            ));
        }
        Ok(())
    }
}

fn json_column(row: &Row, column: &str) -> rusqlite::Result<Vec<String>> {
    let raw: String = row.get(column)?;
    list_from_json(&raw).map_err(|e| conv_failure(row, column, e))
}

fn row_to_snippet(row: &Row) -> rusqlite::Result<Snippet> {
    Ok(Snippet {
        id: row.get("id")?,
        name: row.get("name")?,
        body: row.get("body")?,
        variables: json_column(row, "variables")?,
        tags: json_column(row, "tags")?,
        host_scope: row.get("host_scope")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

// ---------------------------------------------------------------------------
// KnownHosts
// ---------------------------------------------------------------------------

/// 主机指纹状态机：`pending`（首见未核验）→ `ok`（用户 verify）→
/// `changed`（key 变更，verified 作废）——verify 可再回到 ok。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KnownHostState {
    Ok,
    Changed,
    Pending,
}

impl KnownHostState {
    fn from_db(s: &str) -> Result<Self> {
        match s {
            "ok" => Ok(Self::Ok),
            "changed" => Ok(Self::Changed),
            "pending" => Ok(Self::Pending),
            other => Err(VaultError::InvalidInput(format!(
                "unknown known_hosts state: {other}"
            ))),
        }
    }
}

/// 已知主机指纹（TOFU 记录，以 fingerprint 为主键）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KnownHost {
    pub fingerprint: String,
    pub first_seen: i64,
    pub verified: bool,
    pub changed_at: Option<i64>,
    pub state: KnownHostState,
}

/// [`KnownHost`] 的存储入口（upsert / verify / mark_changed，均单语句幂等）。
pub struct KnownHosts;

impl KnownHosts {
    /// 首见入库（state=pending、verified=0）；已存在则原样返回（first_seen 不刷新）。
    pub fn upsert(vault: &Vault, fingerprint: &str) -> Result<KnownHost> {
        let ts = now_ts();
        vault.connection().execute(
            "INSERT INTO known_hosts (fingerprint, first_seen, verified, state)
             VALUES (?1, ?2, 0, 'pending')
             ON CONFLICT(fingerprint) DO NOTHING",
            params![fingerprint, ts],
        )?;
        Self::get(vault, fingerprint)?
            .ok_or_else(|| VaultError::NotFound(format!("known_host {fingerprint}")))
    }

    /// 用户确认指纹：verified=1、state=ok（对 changed 的重确认也回到 ok）。
    /// 未入库指纹按 upsert 处理（HostKeyPolicy 可直接调用）。
    pub fn verify(vault: &Vault, fingerprint: &str) -> Result<KnownHost> {
        let ts = now_ts();
        vault.connection().execute(
            "INSERT INTO known_hosts (fingerprint, first_seen, verified, state)
             VALUES (?1, ?2, 1, 'ok')
             ON CONFLICT(fingerprint) DO UPDATE SET verified = 1, state = 'ok'",
            params![fingerprint, ts],
        )?;
        Self::get(vault, fingerprint)?
            .ok_or_else(|| VaultError::NotFound(format!("known_host {fingerprint}")))
    }

    /// 检测到 key 变更：state=changed、verified 作废、changed_at 落值。
    /// 未入库指纹直接以 changed 状态入库（首次即为 changed 的异常流）。
    pub fn mark_changed(vault: &Vault, fingerprint: &str) -> Result<KnownHost> {
        let ts = now_ts();
        vault.connection().execute(
            "INSERT INTO known_hosts (fingerprint, first_seen, verified, changed_at, state)
             VALUES (?1, ?2, 0, ?2, 'changed')
             ON CONFLICT(fingerprint) DO UPDATE SET
                 verified = 0, state = 'changed', changed_at = ?2",
            params![fingerprint, ts],
        )?;
        Self::get(vault, fingerprint)?
            .ok_or_else(|| VaultError::NotFound(format!("known_host {fingerprint}")))
    }

    pub fn get(vault: &Vault, fingerprint: &str) -> Result<Option<KnownHost>> {
        let conn = vault.connection();
        conn.query_row(
            "SELECT * FROM known_hosts WHERE fingerprint = ?1",
            [fingerprint],
            row_to_known_host,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn list(vault: &Vault) -> Result<Vec<KnownHost>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare("SELECT * FROM known_hosts ORDER BY first_seen DESC")?;
        let rows = stmt
            .query_map([], row_to_known_host)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

fn row_to_known_host(row: &Row) -> rusqlite::Result<KnownHost> {
    let state: String = row.get("state")?;
    Ok(KnownHost {
        fingerprint: row.get("fingerprint")?,
        first_seen: row.get("first_seen")?,
        verified: row.get("verified")?,
        changed_at: row.get("changed_at")?,
        state: KnownHostState::from_db(&state).map_err(|e| conv_failure(row, "state", e))?,
    })
}
