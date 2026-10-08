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
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::crypto::Cipher;
use crate::{Result, Vault, VaultError, aad};

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
#[cfg_attr(feature = "specta", derive(specta::Type))]
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
        // BL-109 ②：同组内同名显式拒绝（0018 部分唯一索引的 DB 层兜底之外，
        // 应用层先给可展示的错误——索引冲突的 SQLite 裸错对用户无意义）。
        Self::assert_sibling_name_unique(&tx, name, parent_id, None)?;
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
        // 同组内同名拒绝（改名/挪组撞名同一防线；exclude 本行自身——非改名
        // 提交必须放行）。
        Self::assert_sibling_name_unique(&tx, name, parent_id, Some(id))?;
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

    /// 同组内同名拒绝（BL-109 ②应用层防线；与 0018 两条部分唯一索引同口径：
    /// 唯一性只在同一 parent_id 内生效，跨组允许同名）。`exclude` = 更新路径
    /// 的本行 id（非改名提交放行）；创建路径传 None。
    fn assert_sibling_name_unique(
        conn: &Connection,
        name: &str,
        parent_id: Option<i64>,
        exclude: Option<i64>,
    ) -> Result<()> {
        let dup: i64 = match parent_id {
            Some(pid) => conn.query_row(
                "SELECT count(*) FROM host_groups
                 WHERE name = ?1 AND parent_id = ?2 AND id != ?3",
                params![name, pid, exclude.unwrap_or(0)],
                |r| r.get(0),
            )?,
            None => conn.query_row(
                "SELECT count(*) FROM host_groups
                 WHERE name = ?1 AND parent_id IS NULL AND id != ?2",
                params![name, exclude.unwrap_or(0)],
                |r| r.get(0),
            )?,
        };
        if dup > 0 {
            return Err(VaultError::InvalidInput(format!(
                "a group named \"{name}\" already exists in the same location"
            )));
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

/// 凭据类型（serde 小写，DB CHECK 同名约束——0001 建 CHECK，0010 放开
/// ftp/ftps）。FTP/FTPS 凭据 = 密码型（secret 通道密封），与 SSH 密码凭据
/// 同存储面，只在 UI/连接分派时区分协议（Phase 2 Task 5）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum CredentialKind {
    Password,
    Key,
    Totp,
    Ftp,
    Ftps,
}

impl CredentialKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Key => "key",
            Self::Totp => "totp",
            Self::Ftp => "ftp",
            Self::Ftps => "ftps",
        }
    }

    /// 凭据是否为密码型（password/ftp/ftps 共用 secret 通道；连接分派用）。
    pub fn is_password_like(self) -> bool {
        matches!(self, Self::Password | Self::Ftp | Self::Ftps)
    }
}

impl std::str::FromStr for CredentialKind {
    type Err = VaultError;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "password" => Ok(Self::Password),
            "key" => Ok(Self::Key),
            "totp" => Ok(Self::Totp),
            "ftp" => Ok(Self::Ftp),
            "ftps" => Ok(Self::Ftps),
            other => Err(VaultError::InvalidInput(format!(
                "unknown credential kind: {other}"
            ))),
        }
    }
}

/// 可开封的密文字段（列名与 AAD 字段名一一对应）。
/// serde 面（snake_case："secret"/"passphrase"/"totp_secret"）与 TS `SecretField`
/// 联合类型逐字同构——Task 4 评审转交必办①：`credentials_reveal` 命令的 `field`
/// 参数反序列化依赖这里（TS 侧 totp_secret 传 "totp_secret"，缺 derive 会地雷式失败）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
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
#[cfg_attr(feature = "specta", derive(specta::Type))]
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
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct CredentialInput {
    pub kind: CredentialKind,
    pub secret: Option<String>,
    pub key_pub: Option<String>,
    pub passphrase: Option<String>,
    pub totp_secret: Option<String>,
}

/// 更新凭据的补丁：全部 `None = 保留现值`（UI 语义：未重输的密钥不重密封）。
#[derive(Debug, Clone, Default, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
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
            &vault.cipher()?,
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
            &vault.cipher()?,
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
            .cipher()?
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

/// 主机协议（0010 迁移，Phase 2 Task 5）：ssh | ftp | ftps。`None`/缺省 =
/// ssh（存量行零迁移）；FTP/FTPS 主机为文件传输会话（无 PTY 终端）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum HostProtocol {
    #[default]
    Ssh,
    Ftp,
    Ftps,
}

impl HostProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ssh => "ssh",
            Self::Ftp => "ftp",
            Self::Ftps => "ftps",
        }
    }
}

impl std::str::FromStr for HostProtocol {
    type Err = VaultError;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "ssh" => Ok(Self::Ssh),
            "ftp" => Ok(Self::Ftp),
            "ftps" => Ok(Self::Ftps),
            other => Err(VaultError::InvalidInput(format!(
                "unknown host protocol: {other}"
            ))),
        }
    }
}

/// 主机。tags 为 JSON 列；credential_id / group_id 可空、FK ON DELETE SET NULL；
/// jump_chain_id 的目标表（jump_chains）未建，暂无 FK（0002 迁移注释）。
/// username（0003 迁移）为登录用户名，可空（未指定时连接侧回退当前用户）。
/// protocol（0010 迁移）为主机协议，缺省 ssh（FilePanel 后端切换依据）。
/// is_production（0012 迁移）为生产环境标记——终端红框 + 页签 PROD 徽标 +
/// danger 输入提醒的消费依据（B11 防呆），缺省 false。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Host {
    pub id: i64,
    pub name: String,
    pub group_id: Option<i64>,
    pub tags: Vec<String>,
    pub address: String,
    pub port: i64,
    pub username: Option<String>,
    pub protocol: HostProtocol,
    pub credential_id: Option<i64>,
    pub jump_chain_id: Option<i64>,
    pub encoding_override: Option<String>,
    pub theme_override: Option<String>,
    pub monitor_enabled: bool,
    pub is_production: bool,
    pub notes: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 新建/全量更新主机的输入（字段名与 [`Host`] 可编辑子集同构）。
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct HostInput {
    pub name: String,
    pub group_id: Option<i64>,
    pub tags: Vec<String>,
    pub address: String,
    pub port: i64,
    pub username: Option<String>,
    /// serde default：旧调用面（测试/驱动脚本）不传 = ssh（0010 语义兼容）。
    #[serde(default)]
    pub protocol: HostProtocol,
    pub credential_id: Option<i64>,
    pub jump_chain_id: Option<i64>,
    pub encoding_override: Option<String>,
    pub theme_override: Option<String>,
    pub monitor_enabled: bool,
    /// serde default：旧载荷不传 = 非生产（0012 语义兼容——标记是显式动作）。
    #[serde(default)]
    pub is_production: bool,
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
            "INSERT INTO hosts (name, group_id, tags, address, port, username, protocol,
                                credential_id, jump_chain_id, encoding_override, theme_override,
                                monitor_enabled, is_production, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
            params![
                input.name,
                input.group_id,
                tags_to_json(&input.tags),
                input.address,
                input.port,
                input.username,
                input.protocol.as_str(),
                input.credential_id,
                input.jump_chain_id,
                input.encoding_override,
                input.theme_override,
                input.monitor_enabled,
                input.is_production,
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
            username: input.username,
            protocol: input.protocol,
            credential_id: input.credential_id,
            jump_chain_id: input.jump_chain_id,
            encoding_override: input.encoding_override,
            theme_override: input.theme_override,
            monitor_enabled: input.monitor_enabled,
            is_production: input.is_production,
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
                              username = ?6, protocol = ?7, credential_id = ?8, jump_chain_id = ?9,
                              encoding_override = ?10, theme_override = ?11,
                              monitor_enabled = ?12, is_production = ?13, notes = ?14,
                              updated_at = ?15
             WHERE id = ?16",
            params![
                input.name,
                input.group_id,
                tags_to_json(&input.tags),
                input.address,
                input.port,
                input.username,
                input.protocol.as_str(),
                input.credential_id,
                input.jump_chain_id,
                input.encoding_override,
                input.theme_override,
                input.monitor_enabled,
                input.is_production,
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
            username: input.username,
            protocol: input.protocol,
            credential_id: input.credential_id,
            jump_chain_id: input.jump_chain_id,
            encoding_override: input.encoding_override,
            theme_override: input.theme_override,
            monitor_enabled: input.monitor_enabled,
            is_production: input.is_production,
            notes: input.notes,
            created_at,
            updated_at: ts,
        })
    }

    /// 删主机：绑定的凭据/分组实体不动（仅解绑），snippet 的 host_scope 置空。
    /// 跳板链反向补偿（I-1 fix）：被链 hops 引用的主机在**同一事务**内先从各链
    /// 摘除（链变空 → 级联删链并解绑引用主机，见
    /// [`crate::jump_chains::remove_host_from_chains`]）——与库内「删引用清理」
    /// 惯例一致，不会留下指向已删主机的死 hop id。
    pub fn delete(vault: &Vault, id: i64) -> Result<()> {
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        crate::jump_chains::remove_host_from_chains(&tx, id)?;
        let n = tx.execute("DELETE FROM hosts WHERE id = ?1", [id])?;
        if n == 0 {
            // 事务随 tx drop 回滚：链补偿不落账（主机其实不存在）。
            return Err(VaultError::NotFound(format!("host id={id}")));
        }
        tx.commit()?;
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
    let protocol: String = row.get("protocol")?;
    Ok(Host {
        id: row.get("id")?,
        name: row.get("name")?,
        group_id: row.get("group_id")?,
        tags,
        address: row.get("address")?,
        port: row.get("port")?,
        username: row.get("username")?,
        protocol: protocol
            .parse()
            .map_err(|e: VaultError| conv_failure(row, "protocol", e))?,
        credential_id: row.get("credential_id")?,
        jump_chain_id: row.get("jump_chain_id")?,
        encoding_override: row.get("encoding_override")?,
        theme_override: row.get("theme_override")?,
        monitor_enabled: row.get("monitor_enabled")?,
        is_production: row.get::<_, i64>("is_production")? != 0,
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
#[cfg_attr(feature = "specta", derive(specta::Type))]
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
#[cfg_attr(feature = "specta", derive(specta::Type))]
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

/// TOFU 信任锚的 host 端点键（0004 迁移起 known_hosts 的主键）：
/// `"{address}:{port}"`；地址含冒号（IPv6）时统一 `"[{address}]:{port}"`
/// （OpenSSH 惯例），保证键格式无歧义、可逆解析。
///
/// 为什么按端点而不是 host_id 关联（0004 迁移文件头）：TOFU 信任锚是网络端点——
/// 删主机重建（新 id）不应重置信任，同端点的多条主机记录共享同一份信任。
pub fn host_endpoint_key(address: &str, port: i64) -> String {
    if address.contains(':') {
        format!("[{address}]:{port}")
    } else {
        format!("{address}:{port}")
    }
}

/// [`host_endpoint_key`] 的逆映射（B9 巡检/管理页，Task 6 Phase 3）：
/// 端点键 → `(address, port)`。IPv6 的方括号形态剥括号还原；`legacy:{fp}`
/// 虚拟端点（0004 迁移前的存量行）与一切畸形键返回 `None`——巡检面对
/// parse 失败的行只能「跳过」，绝不拿不可探测的端点做 changed 判定。
/// 端口须落在 u16 值域（1..=65535；0 端口非可探测端点，一并拒绝），且只认
/// **规范十进制**（纯 ASCII 数字、无前导零、无符号——见 [`canonical_port`]，
/// BL-206 宽松解析收紧）。
pub fn parse_endpoint_key(host_key: &str) -> Option<(String, i64)> {
    let (address, port_str) = if let Some(rest) = host_key.strip_prefix('[') {
        // IPv6："[addr]:port"——先剥方括号，再取 "]:" 之后的端口段
        let close = rest.find("]:")?;
        let port = canonical_port(&rest[close + 2..])?;
        return Some((rest[..close].to_string(), port));
    } else {
        let idx = host_key.rfind(':')?;
        (&host_key[..idx], &host_key[idx + 1..])
    };
    if address.is_empty() || address.contains(':') || address.contains('[') || address.contains(']')
    {
        // 无括号的裸 IPv6（多冒号）不可能是 host_endpoint_key 的产物——拒绝
        return None;
    }
    let port = canonical_port(port_str)?;
    Some((address.to_string(), port))
}

/// 规范十进制端口解析（BL-206 宽松解析收紧）：端点键是 [`host_endpoint_key`]
/// 的 `format!("{port}")` 产物，只会是纯 ASCII 数字（正 i64 无前导零）。
/// `i64::from_str` 的宽松面（前导零 `"080"`、显式符号 `"+80"`）在此一并拒绝
/// ——非规范形态不是本 crate 的产出，接受会让同端点在改写/拼接场景下长出
/// 两个键。返回 `None` = 拒绝（空串/非数字/带符号/前导零/越 u16 值域，含 0）。
fn canonical_port(s: &str) -> Option<i64> {
    if s.is_empty() || s.starts_with('0') || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port = s.parse::<i64>().ok()?;
    if port <= 0 || port > u16::MAX as i64 {
        return None;
    }
    Some(port)
}

/// 主机指纹状态机（0004 起按 host 端点记账）：
/// `pending`（首见未核验）→ `ok`（用户 verify）→ `changed`（key 变更，verified
/// 作废）——verify 可再回到 ok。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
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

/// 已知主机指纹（TOFU 记录，以 host 端点为主键、fingerprint = 当前信任锚）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct KnownHost {
    /// host 端点键（[`host_endpoint_key`]；0004 前的存量行为
    /// `"legacy:{fingerprint}"` 虚拟端点，信任关系待下次连接重建）。
    pub host_key: String,
    /// 当前信任锚：最近一次 verify 接受的指纹。mark_changed **不覆盖**本列
    /// （拒绝疑似 MITM 后仍钉着原钥匙，OpenSSH「警告且不写 known_hosts」语义）。
    pub fingerprint: String,
    pub first_seen: i64,
    pub verified: bool,
    /// 最近一次检测到该端点指纹与信任锚**不一致**的时间（事件时间戳而非状态
    /// 属性）——之后 re-verify 回 ok 也**保留不清空**（「何时出过事」的历史不随
    /// 信任恢复而抹除）。重复检测到不一致会刷新（= 最近一次检测到）。
    /// 从未变更过则为 None。
    pub changed_at: Option<i64>,
    pub state: KnownHostState,
}

/// [`KnownHost`] 的存储入口（upsert / verify / mark_changed，均单语句幂等；
/// 键 = host 端点，换钥检测由策略层比对 `get` 的 fingerprint 与实际指纹）。
pub struct KnownHosts;

impl KnownHosts {
    /// 首见入库（state=pending、verified=0）；该端点已有记录则原样返回
    /// （first_seen 不刷新、fingerprint 不覆盖——换钥必须走 changed 流程，
    /// 绝不允许 upsert 静默换锚）。
    pub fn upsert(vault: &Vault, host_key: &str, fingerprint: &str) -> Result<KnownHost> {
        let ts = now_ts();
        vault.with_conn(|conn| {
            conn.execute(
                "INSERT INTO known_hosts (host_key, fingerprint, first_seen, verified, state)
                 VALUES (?1, ?2, ?3, 0, 'pending')
                 ON CONFLICT(host_key) DO NOTHING",
                params![host_key, fingerprint, ts],
            )?;
            Self::get_conn(conn, host_key)?
                .ok_or_else(|| VaultError::NotFound(format!("known_host {host_key}")))
        })
    }

    /// 用户确认指纹：verified=1、state=ok、信任锚更新为本次接受的指纹
    /// （对 changed 的重确认也回到 ok）。`changed_at` **保留不清空**（语义见
    /// [`KnownHost::changed_at`]：变更是历史事件，不随信任恢复抹除）。
    /// 未入库端点按首见 verify 处理（HostKeyPolicy 可直接调用）。
    pub fn verify(vault: &Vault, host_key: &str, fingerprint: &str) -> Result<KnownHost> {
        let ts = now_ts();
        vault.with_conn(|conn| {
            conn.execute(
                "INSERT INTO known_hosts (host_key, fingerprint, first_seen, verified, state)
                 VALUES (?1, ?2, ?3, 1, 'ok')
                 ON CONFLICT(host_key) DO UPDATE SET
                     fingerprint = excluded.fingerprint, verified = 1, state = 'ok'",
                params![host_key, fingerprint, ts],
            )?;
            Self::get_conn(conn, host_key)?
                .ok_or_else(|| VaultError::NotFound(format!("known_host {host_key}")))
        })
    }

    /// 检测到 key 变更：state=changed、verified 作废、changed_at 落值。
    /// **信任锚（fingerprint）保留原值不覆盖**——用户拒绝疑似 MITM 后，行内仍
    /// 钉着原钥匙；新指纹是否接管信任由 verify 在用户显式接受后决定。
    /// 未入库端点直接以 changed 状态入库（首次即为 changed 的异常流）。
    pub fn mark_changed(
        vault: &Vault,
        host_key: &str,
        _seen_fingerprint: &str,
    ) -> Result<KnownHost> {
        let ts = now_ts();
        vault.with_conn(|conn| {
            let updated = conn.execute(
                "UPDATE known_hosts SET verified = 0, state = 'changed', changed_at = ?2
                 WHERE host_key = ?1",
                params![host_key, ts],
            )?;
            if updated == 0 {
                conn.execute(
                    "INSERT INTO known_hosts (host_key, fingerprint, first_seen, verified, changed_at, state)
                     VALUES (?1, ?2, ?3, 0, ?3, 'changed')",
                    params![host_key, _seen_fingerprint, ts],
                )?;
            }
            Self::get_conn(conn, host_key)?
                .ok_or_else(|| VaultError::NotFound(format!("known_host {host_key}")))
        })
    }

    pub fn get(vault: &Vault, host_key: &str) -> Result<Option<KnownHost>> {
        vault.with_conn(|conn| Self::get_conn(conn, host_key))
    }

    /// 锁内读取——多语句实体操作的组合件，只收 `&Connection`，绝不自行加锁。
    fn get_conn(conn: &Connection, host_key: &str) -> Result<Option<KnownHost>> {
        conn.query_row(
            "SELECT * FROM known_hosts WHERE host_key = ?1",
            [host_key],
            row_to_known_host,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn list(vault: &Vault) -> Result<Vec<KnownHost>> {
        vault.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT * FROM known_hosts ORDER BY first_seen DESC")?;
            let rows = stmt
                .query_map([], row_to_known_host)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// 删除 = 忘记该端点（B9 管理页，Task 6 Phase 3）：行消失后下次连接重走
    /// TOFU（首见 pending）。返回是否有行被删（幂等面：重复删除 = false）。
    pub fn delete(vault: &Vault, host_key: &str) -> Result<bool> {
        vault.with_conn(|conn| {
            let n = conn.execute(
                "DELETE FROM known_hosts WHERE host_key = ?1",
                params![host_key],
            )?;
            Ok(n > 0)
        })
    }
}

fn row_to_known_host(row: &Row) -> rusqlite::Result<KnownHost> {
    let state: String = row.get("state")?;
    Ok(KnownHost {
        host_key: row.get("host_key")?,
        fingerprint: row.get("fingerprint")?,
        first_seen: row.get("first_seen")?,
        verified: row.get("verified")?,
        changed_at: row.get("changed_at")?,
        state: KnownHostState::from_db(&state).map_err(|e| conv_failure(row, "state", e))?,
    })
}
