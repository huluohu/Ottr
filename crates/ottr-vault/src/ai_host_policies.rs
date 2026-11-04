//! ai_host_policies 表访问（Ask Ottr 执行模式第三步：自动档——存储侧）。
//!
//! 与 [`crate::mcp_grants`] 同款分工：引擎与命令面在 desktop（commands/ai_policy.rs
//! ——授权判定与 Tauri 命令都与应用生命周期耦合），本 crate 只供表。
//!
//! **默认全拒**（沿用 mcp_grants 的"默认全拒"范式）：**无授权行 = 该主机
//! 不允许 AI 自动执行任何命令**——自动档在未授权主机上直接不可用（规划档与
//! 手动档不受影响）。
//!
//! `write_categories` 以 JSON 字符串数组落库（"package" / "service" / "file"
//! / "git"）；**取值白名单在存储层校验**——未知类别写不进去（手改数据库写进
//! 未知类别时，引擎侧按"不认识 = 不放行"处理，不会误放行）。
//!
//! 明文面（无 `*_enc` 列），锁定语义与 hosts 同（配置面：命令统一
//! ensure_unlocked 门卫；存储层不设门卫）。

use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::{Result, Vault, VaultError};

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// 可自动执行的**写操作类别**（自动档放行面）。
///
/// 只读命令不在此列——它们由引擎侧的只读白名单统一放行，与主机授权无关。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiWriteCategory {
    /// 包管理（apt/dnf/apk/pacman/brew…）。
    Package,
    /// 服务重启（systemctl/service…）。
    Service,
    /// 文件编辑（rm/mv/cp/chmod/te…）。
    File,
    /// 版本控制写操作（git commit/checkout/push…）。
    Git,
}

impl AiWriteCategory {
    /// 全部合法类别（设置页勾选面 + 存储层白名单校验共用此列表）。
    pub const ALL: [AiWriteCategory; 4] = [
        AiWriteCategory::Package,
        AiWriteCategory::Service,
        AiWriteCategory::File,
        AiWriteCategory::Git,
    ];

    /// 线面名称（落库 / 传输用的稳定字符串）。
    pub fn as_str(self) -> &'static str {
        match self {
            AiWriteCategory::Package => "package",
            AiWriteCategory::Service => "service",
            AiWriteCategory::File => "file",
            AiWriteCategory::Git => "git",
        }
    }

    /// 从线面字符串解析（未知值 → None：**不放行**）。
    ///
    /// 命名用 `parse` 而不是 `from_str`：后者与 `std::str::FromStr::from_str`
    /// 同名易混（clippy 会警告），且本类型**不实现** FromStr（那是 traits 面，
    /// 这里只是字符串 → 枚举的解析助手）。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "package" => Some(AiWriteCategory::Package),
            "service" => Some(AiWriteCategory::Service),
            "file" => Some(AiWriteCategory::File),
            "git" => Some(AiWriteCategory::Git),
            _ => None,
        }
    }
}

/// 单主机自动执行授权行（serde 面与 TS `AiHostPolicy` 同构）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AiHostPolicy {
    pub id: i64,
    pub host_id: i64,
    /// 自动档总闸（false = 该主机不允许自动执行）。
    pub auto_enabled: bool,
    /// 自动档允许**直接执行**的写操作类别（空 = 只读命令可自动执行）。
    pub write_categories: Vec<AiWriteCategory>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 新建/更新授权输入（upsert 全量替换式，host_id 定位）。
#[derive(Debug, Clone, Deserialize)]
pub struct AiHostPolicyInput {
    pub host_id: i64,
    pub auto_enabled: bool,
    pub write_categories: Vec<AiWriteCategory>,
}

fn validate_input(input: &AiHostPolicyInput) -> Result<()> {
    if input.host_id <= 0 {
        return Err(VaultError::InvalidInput(format!(
            "host_id must be positive, got {}",
            input.host_id
        )));
    }
    Ok(())
}

/// 解析 write_categories JSON（元素必须是合法类别字符串——**未知类别即错误**，
/// 不静默丢弃：写进去一个不认识的类别却以为放行了，是授权面上的事故）。
fn parse_categories(raw: &str) -> Result<Vec<AiWriteCategory>> {
    let items: Vec<String> = serde_json::from_str(raw).map_err(|e| {
        VaultError::InvalidInput(format!("write_categories is not valid JSON: {e}"))
    })?;
    let mut out = Vec::with_capacity(items.len());
    for it in items {
        let cat = AiWriteCategory::parse(&it)
            .ok_or_else(|| VaultError::InvalidInput(format!("unknown write category: {it:?}")))?;
        if !out.contains(&cat) {
            out.push(cat);
        }
    }
    Ok(out)
}

/// [`AiHostPolicy`] 的存储入口。
pub struct AiHostPolicies;

impl AiHostPolicies {
    /// 落/替一条授权（host_id UNIQUE upsert）并返回完整行。
    /// host 不存在 → FK 报错（授权悬挂主机即 bug，显式浮出）。
    pub fn upsert(vault: &Vault, input: &AiHostPolicyInput) -> Result<AiHostPolicy> {
        validate_input(input)?;
        let ts = now_ts();
        let cats_json = serde_json::to_string(
            &input
                .write_categories
                .iter()
                .map(|c| c.as_str())
                .collect::<Vec<_>>(),
        )?;
        let conn = vault.connection();
        conn.execute(
            "INSERT INTO ai_host_policies (host_id, auto_enabled, write_categories, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(host_id) DO UPDATE SET
                auto_enabled = excluded.auto_enabled,
                write_categories = excluded.write_categories,
                updated_at = excluded.updated_at",
            params![
                input.host_id,
                input.auto_enabled,
                cats_json,
                ts
            ],
        )?;
        let id = conn.query_row(
            "SELECT id FROM ai_host_policies WHERE host_id = ?1",
            [input.host_id],
            |r| r.get(0),
        )?;
        Ok(AiHostPolicy {
            id,
            host_id: input.host_id,
            auto_enabled: input.auto_enabled,
            write_categories: input.write_categories.clone(),
            created_at: ts,
            updated_at: ts,
        })
    }

    /// 删授权（= 回收该主机的全部自动执行权，回到默认拒）。
    /// 未知 host 显式报 NotFound（credentials 纪律）。
    pub fn delete(vault: &Vault, host_id: i64) -> Result<()> {
        let n = vault
            .connection()
            .execute("DELETE FROM ai_host_policies WHERE host_id = ?1", [host_id])?;
        if n == 0 {
            return Err(VaultError::NotFound(format!(
                "ai host policy host_id={host_id}"
            )));
        }
        Ok(())
    }

    /// 按主机取授权（None = 未授权 = 默认拒）。
    pub fn get_for_host(vault: &Vault, host_id: i64) -> Result<Option<AiHostPolicy>> {
        vault
            .connection()
            .query_row(
                "SELECT * FROM ai_host_policies WHERE host_id = ?1",
                [host_id],
                row_to_policy,
            )
            .optional()
            .map_err(Into::into)
    }

    /// 全部授权行（id 升序；设置页逐主机授权管理列表）。
    pub fn list(vault: &Vault) -> Result<Vec<AiHostPolicy>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare("SELECT * FROM ai_host_policies ORDER BY id")?;
        let rows = stmt
            .query_map([], row_to_policy)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

fn row_to_policy(row: &Row) -> rusqlite::Result<AiHostPolicy> {
    let raw: String = row.get("write_categories")?;
    let cats = parse_categories(&raw)
        .map_err(|e| conv_failure(row, "write_categories", &e.to_string()))?;
    Ok(AiHostPolicy {
        id: row.get("id")?,
        host_id: row.get("host_id")?,
        auto_enabled: row.get::<_, i64>("auto_enabled")? != 0,
        write_categories: cats,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 行内列解析失败 → rusqlite 错误（mcp_grants conv_failure 同款形态：
/// write_categories JSON 损坏不静默吞掉）。
fn conv_failure(row: &Row, column: &str, msg: &str) -> rusqlite::Error {
    use rusqlite::types::Type;
    let idx = row.as_ref().column_index(column).unwrap_or(0);
    rusqlite::Error::FromSqlConversionFailure(
        idx,
        Type::Text,
        Box::new(VaultError::InvalidInput(msg.to_string())),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master_key::InMemoryStorage;
    use crate::{HostInput, Hosts};

    fn open_vault(dir: &std::path::Path) -> Vault {
        Vault::open_with(dir, &InMemoryStorage::new()).expect("open vault")
    }

    fn host(vault: &Vault, name: &str) -> i64 {
        Hosts::create(
            vault,
            HostInput {
                protocol: Default::default(),
                name: name.into(),
                group_id: None,
                tags: vec![],
                address: "127.0.0.1".into(),
                port: 2222,
                username: Some("spike".into()),
                credential_id: None,
                jump_chain_id: None,
                encoding_override: None,
                theme_override: None,
                monitor_enabled: false,
                is_production: false,
                notes: None,
            },
        )
        .expect("create host")
        .id
    }

    fn input(host_id: i64) -> AiHostPolicyInput {
        AiHostPolicyInput {
            host_id,
            auto_enabled: true,
            write_categories: vec![AiWriteCategory::File, AiWriteCategory::Git],
        }
    }

    #[test]
    fn upsert_inserts_then_replaces_and_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let host_id = host(&vault, "fx");
        let row = AiHostPolicies::upsert(&vault, &input(host_id)).expect("upsert");
        assert_eq!(row.host_id, host_id);
        assert!(row.auto_enabled);
        assert_eq!(
            row.write_categories,
            vec![AiWriteCategory::File, AiWriteCategory::Git]
        );

        // 同主机再次 upsert = 替换（UNIQUE 单行），非新增。
        let replaced = AiHostPolicies::upsert(
            &vault,
            &AiHostPolicyInput {
                host_id,
                auto_enabled: false,
                write_categories: vec![AiWriteCategory::Package],
            },
        )
        .expect("upsert replace");
        assert_eq!(AiHostPolicies::list(&vault).unwrap().len(), 1);
        assert_eq!(replaced.id, row.id, "UNIQUE(host_id) upsert 不换行");
        assert!(!replaced.auto_enabled);
        assert_eq!(replaced.write_categories, vec![AiWriteCategory::Package]);
    }

    #[test]
    fn default_deny_get_for_host_missing_row_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let host_id = host(&vault, "ungranted");
        assert!(
            AiHostPolicies::get_for_host(&vault, host_id)
                .unwrap()
                .is_none(),
            "无授权行 = 默认拒（自动档据此不可用）"
        );
    }

    #[test]
    fn delete_removes_and_unknown_host_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let host_id = host(&vault, "fx");
        AiHostPolicies::upsert(&vault, &input(host_id)).unwrap();
        AiHostPolicies::delete(&vault, host_id).expect("delete");
        assert!(
            AiHostPolicies::get_for_host(&vault, host_id)
                .unwrap()
                .is_none()
        );
        let err = AiHostPolicies::delete(&vault, host_id).unwrap_err();
        assert!(matches!(err, VaultError::NotFound(_)));
    }

    #[test]
    fn host_delete_cascades_policy() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let host_id = host(&vault, "fx");
        AiHostPolicies::upsert(&vault, &input(host_id)).unwrap();
        Hosts::delete(&vault, host_id).unwrap();
        assert!(
            AiHostPolicies::list(&vault).unwrap().is_empty(),
            "删主机级联删授权"
        );
    }

    #[test]
    fn dangling_host_fk_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let err = AiHostPolicies::upsert(&vault, &input(4242)).unwrap_err();
        assert!(matches!(err, VaultError::Sql(_)), "FK 悬空拒绝: {err:?}");
    }

    #[test]
    fn input_validation_rejects_bad_host_id() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        assert!(matches!(
            AiHostPolicies::upsert(
                &vault,
                &AiHostPolicyInput {
                    host_id: 0,
                    auto_enabled: true,
                    write_categories: vec![],
                }
            ),
            Err(VaultError::InvalidInput(_))
        ));
    }

    #[test]
    fn unknown_category_in_db_is_rejected_not_silently_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let host_id = host(&vault, "fx");
        AiHostPolicies::upsert(&vault, &input(host_id)).unwrap();
        // 手改数据库写入未知类别 → 读取时**报错**（不是静默当成空放行面）。
        vault
            .connection()
            .execute(
                "UPDATE ai_host_policies SET write_categories = '[\"unknown_cat\"]' WHERE host_id = ?1",
                [host_id],
            )
            .unwrap();
        let err = AiHostPolicies::get_for_host(&vault, host_id).unwrap_err();
        // 列解析失败按 mcp_grants 同款包成 Sql(FromSqlConversionFailure)，
        // 但**必须报错**——不能静默当成空放行面。
        assert!(
            format!("{err:?}").contains("unknown write category"),
            "未知类别必须显式报错: {err:?}"
        );
    }

    #[test]
    fn category_names_roundtrip() {
        for c in AiWriteCategory::ALL {
            assert_eq!(AiWriteCategory::parse(c.as_str()), Some(c));
        }
        assert_eq!(AiWriteCategory::parse("nope"), None);
    }
}
