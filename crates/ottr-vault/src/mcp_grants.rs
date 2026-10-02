//! mcp_grants 表访问（Phase 4 Task 3，C1 MCP Server 接入——存储侧）。
//!
//! 与 [`crate::cron_jobs`] 同款分工：MCP 协议引擎在 src-tauri（commands/mcp.rs
//! ——工具面/审批门/UDS listener 都与 App 生命周期耦合），本 crate 只供表。
//! 授权矩阵语义（默认全拒 / 主机粒度 / 逐次审批档 / read 目录白名单）见
//! 0017 迁移文件头。明文面（无 `*_enc` 列），锁定语义与 hosts 同（配置面
//! 命令统一 `ensure_unlocked` 门卫；存储层不设门卫——cron_jobs 同口径）。
//!
//! `read_paths` 以 JSON 字符串数组落库；存储层只校验「合法 JSON / 元素是
//! 字符串」——路径语义（绝对化/归一/白名单前缀匹配）在引擎层做（DB 不是
//! 路径解析器，schedule 语义不在存储层同理）。

use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::{Result, Vault, VaultError};

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// read_paths JSON 元素上限（目录白名单是人工维护面，超量即配置事故）。
pub const MCP_READ_PATHS_MAX: usize = 64;

/// 单主机授权行（serde 面与 TS `McpGrant` 同构）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpGrant {
    pub id: i64,
    pub host_id: i64,
    /// list_hosts 可见位（0 = 该主机对 MCP 完全不可见）。
    pub can_list: bool,
    /// exec_command 放行位。
    pub can_exec: bool,
    /// 逐次执行审批门（1 = 每次 exec 先经 UI 审批框）。
    pub exec_approval: bool,
    /// read_file 目录白名单（绝对路径数组；空 = read_file 一律拒绝）。
    pub read_paths: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 新建/更新授权输入（upsert 全量替换式，host_id 定位）。
#[derive(Debug, Clone, Deserialize)]
pub struct McpGrantInput {
    pub host_id: i64,
    pub can_list: bool,
    pub can_exec: bool,
    pub exec_approval: bool,
    pub read_paths: Vec<String>,
}

fn validate_input(input: &McpGrantInput) -> Result<()> {
    if input.host_id <= 0 {
        return Err(VaultError::InvalidInput(format!(
            "host_id must be positive, got {}",
            input.host_id
        )));
    }
    if input.read_paths.len() > MCP_READ_PATHS_MAX {
        return Err(VaultError::InvalidInput(format!(
            "read_paths exceeds {MCP_READ_PATHS_MAX} entries"
        )));
    }
    for p in &input.read_paths {
        if p.trim().is_empty() {
            return Err(VaultError::InvalidInput(
                "read_paths must not contain empty entries".into(),
            ));
        }
    }
    Ok(())
}

fn parse_read_paths(raw: &str) -> Result<Vec<String>> {
    let paths: Vec<String> = serde_json::from_str(raw)
        .map_err(|e| VaultError::InvalidInput(format!("read_paths is not valid JSON: {e}")))?;
    Ok(paths)
}

/// [`McpGrant`] 的存储入口。
pub struct McpGrants;

impl McpGrants {
    /// 落/替一条授权（host_id UNIQUE upsert）并返回完整行。
    /// host 不存在 → FK 报错（授权悬挂主机即 bug，显式浮出）。
    pub fn upsert(vault: &Vault, input: &McpGrantInput) -> Result<McpGrant> {
        validate_input(input)?;
        let ts = now_ts();
        let paths_json = serde_json::to_string(&input.read_paths)?;
        let conn = vault.connection();
        conn.execute(
            "INSERT INTO mcp_grants (host_id, can_list, can_exec, exec_approval, read_paths, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(host_id) DO UPDATE SET
                can_list = excluded.can_list,
                can_exec = excluded.can_exec,
                exec_approval = excluded.exec_approval,
                read_paths = excluded.read_paths,
                updated_at = excluded.updated_at",
            params![
                input.host_id,
                input.can_list,
                input.can_exec,
                input.exec_approval,
                paths_json,
                ts
            ],
        )?;
        let id = conn.query_row(
            "SELECT id FROM mcp_grants WHERE host_id = ?1",
            [input.host_id],
            |r| r.get(0),
        )?;
        Ok(McpGrant {
            id,
            host_id: input.host_id,
            can_list: input.can_list,
            can_exec: input.can_exec,
            exec_approval: input.exec_approval,
            read_paths: input.read_paths.clone(),
            created_at: ts,
            updated_at: ts,
        })
    }

    /// 删授权（= 回收该主机的全部 MCP 面，回到默认拒）。
    /// 未知 id 显式报 NotFound（credentials 纪律）。
    pub fn delete(vault: &Vault, id: i64) -> Result<()> {
        let n = vault
            .connection()
            .execute("DELETE FROM mcp_grants WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("mcp grant id={id}")));
        }
        Ok(())
    }

    /// 按主机取授权（None = 未授权 = 默认拒）。
    pub fn get_for_host(vault: &Vault, host_id: i64) -> Result<Option<McpGrant>> {
        let conn = vault.connection();
        conn.query_row(
            "SELECT * FROM mcp_grants WHERE host_id = ?1",
            [host_id],
            row_to_grant,
        )
        .optional()
        .map_err(Into::into)
    }

    /// 全部授权行（id 升序；设置页授权管理列表）。
    pub fn list(vault: &Vault) -> Result<Vec<McpGrant>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare("SELECT * FROM mcp_grants ORDER BY id")?;
        let rows = stmt
            .query_map([], row_to_grant)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

fn row_to_grant(row: &Row) -> rusqlite::Result<McpGrant> {
    let raw: String = row.get("read_paths")?;
    let read_paths =
        parse_read_paths(&raw).map_err(|e| conv_failure(row, "read_paths", &e.to_string()))?;
    Ok(McpGrant {
        id: row.get("id")?,
        host_id: row.get("host_id")?,
        can_list: row.get::<_, i64>("can_list")? != 0,
        can_exec: row.get::<_, i64>("can_exec")? != 0,
        exec_approval: row.get::<_, i64>("exec_approval")? != 0,
        read_paths,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 行内列解析失败 → rusqlite 错误（cron_jobs conv_failure 同款形态：
/// read_paths JSON 损坏不静默吞掉）。
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
                tags: vec!["web".into()],
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

    fn input(host_id: i64) -> McpGrantInput {
        McpGrantInput {
            host_id,
            can_list: true,
            can_exec: true,
            exec_approval: true,
            read_paths: vec!["/tmp".into()],
        }
    }

    #[test]
    fn upsert_inserts_then_replaces_and_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let host_id = host(&vault, "fx");
        let row = McpGrants::upsert(&vault, &input(host_id)).expect("upsert");
        assert_eq!(row.host_id, host_id);
        assert!(row.can_list && row.can_exec && row.exec_approval);
        assert_eq!(row.read_paths, vec!["/tmp".to_string()]);

        // 同主机再次 upsert = 替换（UNIQUE 单行），非新增。
        let replaced = McpGrants::upsert(
            &vault,
            &McpGrantInput {
                host_id,
                can_list: false,
                can_exec: true,
                exec_approval: false,
                read_paths: vec!["/var/log".into(), "/tmp".into()],
            },
        )
        .expect("upsert replace");
        assert_eq!(McpGrants::list(&vault).unwrap().len(), 1);
        assert_eq!(replaced.id, row.id, "UNIQUE(host_id) upsert 不换行");
        assert!(!replaced.can_list);
        assert!(!replaced.exec_approval);
        assert_eq!(replaced.read_paths.len(), 2);
    }

    #[test]
    fn default_deny_get_for_host_missing_row_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let host_id = host(&vault, "ungranted");
        assert!(
            McpGrants::get_for_host(&vault, host_id).unwrap().is_none(),
            "无授权行 = 默认拒（引擎层据此拒绝一切工具调用）"
        );
    }

    #[test]
    fn delete_removes_and_unknown_id_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let host_id = host(&vault, "fx");
        let row = McpGrants::upsert(&vault, &input(host_id)).unwrap();
        McpGrants::delete(&vault, row.id).expect("delete");
        assert!(McpGrants::get_for_host(&vault, host_id).unwrap().is_none());
        let err = McpGrants::delete(&vault, row.id).unwrap_err();
        assert!(matches!(err, VaultError::NotFound(_)));
    }

    #[test]
    fn host_delete_cascades_grant() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let host_id = host(&vault, "fx");
        McpGrants::upsert(&vault, &input(host_id)).unwrap();
        Hosts::delete(&vault, host_id).unwrap();
        assert!(
            McpGrants::list(&vault).unwrap().is_empty(),
            "删主机级联删授权"
        );
    }

    #[test]
    fn dangling_host_fk_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let err = McpGrants::upsert(&vault, &input(4242)).unwrap_err();
        assert!(matches!(err, VaultError::Sql(_)), "FK 悬空拒绝: {err:?}");
    }

    #[test]
    fn input_validation_rejects_bad_host_id_and_read_paths() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        // host_id 非正。
        assert!(matches!(
            McpGrants::upsert(
                &vault,
                &McpGrantInput {
                    host_id: 0,
                    can_list: true,
                    can_exec: false,
                    exec_approval: true,
                    read_paths: vec![],
                }
            ),
            Err(VaultError::InvalidInput(_))
        ));
        // read_paths 空白条目拒绝。
        assert!(matches!(
            McpGrants::upsert(
                &vault,
                &McpGrantInput {
                    host_id: host(&vault, "fx"),
                    can_list: true,
                    can_exec: false,
                    exec_approval: true,
                    read_paths: vec!["  ".into()],
                }
            ),
            Err(VaultError::InvalidInput(_))
        ));
        // 超量白名单拒绝。
        let paths: Vec<String> = (0..=MCP_READ_PATHS_MAX)
            .map(|i| format!("/dir{i}"))
            .collect();
        assert!(matches!(
            McpGrants::upsert(
                &vault,
                &McpGrantInput {
                    host_id: host(&vault, "fx2"),
                    can_list: true,
                    can_exec: false,
                    exec_approval: true,
                    read_paths: paths,
                }
            ),
            Err(VaultError::InvalidInput(_))
        ));
    }
}
