//! mcp_servers 表访问（Ottr 作为 **MCP 客户端**——外部 MCP server 清单）。
//!
//! 与 [`crate::mcp_grants`] 严格对偶：mcp_grants 管的是「Ottr 作为 MCP **server**，
//! 把主机暴露给 AI 客户端」的授权矩阵；本模块管的是「Ottr 作为 MCP **客户端**，
//! 去连**外部** MCP server」的连接配置（命令 / 参数 / 启用位 / 环境变量）。
//!
//! 【分工】协议核（起子进程、initialize、tools/list、tools/call）在 desktop
//! （`desktop/src/mcp_client.rs`——与 App 生命周期/进程模型耦合），本 crate 只供表。
//!
//! 【密钥面】环境变量的**值**一律不进本表——那多半是 API key / token，明文落库
//! 即破「秘密字段级加密」红线（见 CLAUDE.md 安全边界）。值走 [`crate::Secrets`]
//! 密封 KV，key 约定 `mcp.env.<server_id>.<VAR_NAME>`（与 `ai.apikey.<id>` 同款
//! 加密面：AES-256-GCM + AAD 绑定）。本表只留**变量名**（供 UI 回显「哪些变量
//! 有值」+ 删 server 时逐个清密文——不留名字就清不掉孤儿密文）。
//!
//! 【明文面】命令/参数/变量名都不是机密（无 `*_enc` 列，不涉 scan_registry）；
//! 锁定语义与 hosts/cron_jobs 同（配置面）：命令层统一 `ensure_unlocked` 门卫。

use std::collections::BTreeMap;

use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::{Result, Secrets, Vault, VaultError};

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// 启动参数上限（人工维护面，超量即配置事故）。
pub const MCP_ARGS_MAX: usize = 64;
/// 单个参数长度上限。
pub const MCP_ARG_MAX_BYTES: usize = 1024;
/// 环境变量名上限。
pub const MCP_ENV_VARS_MAX: usize = 32;
/// 环境变量名长度上限。
pub const MCP_ENV_NAME_MAX: usize = 128;
/// 环境变量值长度上限（1 MiB 足够装下 token/JWT）。
pub const MCP_ENV_VALUE_MAX: usize = 1024 * 1024;
/// 名称长度上限。
pub const MCP_NAME_MAX: usize = 120;
/// 命令长度上限。
pub const MCP_COMMAND_MAX: usize = 1024;
/// id 长度上限（生成面 = 32 hex 字符）。
pub const MCP_ID_MAX: usize = 64;

/// 环境变量名（POSIX 变量名 + Windows 常见形态）：首字符为字母或下划线，
/// 其余为字母/数字/下划线——挡住空格、`=`、路径分隔符等会破坏 env 语义的名字。
fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// secrets 表里的 env 密文键（`mcp.env.<server_id>.<VAR>`）。
pub fn env_secret_key(server_id: &str, var: &str) -> String {
    format!("mcp.env.{server_id}.{var}")
}

/// 外部 MCP server 配置行（serde 面与 TS `McpServerInfo` 同构，字段名由
/// 命令层投影为 camelCase）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpServer {
    /// 稳定标识（TEXT 主键；新建时生成）。
    pub id: String,
    /// 用户可见名。
    pub name: String,
    /// 可执行文件路径（不经 shell 拼接）。
    pub command: String,
    /// 启动参数。
    pub args: Vec<String>,
    /// 启用位（关 = 配置保留但不可用）。
    pub enabled: bool,
    /// 已配置环境变量的**名**列表（值在 secrets 密文面）。
    pub env_names: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 新建/更新输入（upsert 全量替换式，id 定位；id 缺省 = 新建）。
#[derive(Debug, Clone, Deserialize)]
pub struct McpServerInput {
    /// 空 = 新建（id 由存储层生成）。
    pub id: Option<String>,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub enabled: bool,
    /// 环境变量 → 值。`None` = **保留旧值不动**（缺失的键同理——编辑表单
    /// 只带用户真正改过的项，避免误删既有密文）。
    pub env: BTreeMap<String, Option<String>>,
}

fn validate_input(input: &McpServerInput) -> Result<()> {
    if input.name.trim().is_empty() {
        return Err(VaultError::InvalidInput("name must not be empty".into()));
    }
    if input.name.chars().count() > MCP_NAME_MAX {
        return Err(VaultError::InvalidInput(format!(
            "name exceeds {MCP_NAME_MAX} characters"
        )));
    }
    if input.command.trim().is_empty() {
        return Err(VaultError::InvalidInput("command must not be empty".into()));
    }
    if input.command.chars().count() > MCP_COMMAND_MAX {
        return Err(VaultError::InvalidInput(format!(
            "command exceeds {MCP_COMMAND_MAX} characters"
        )));
    }
    if input.args.len() > MCP_ARGS_MAX {
        return Err(VaultError::InvalidInput(format!(
            "args exceeds {MCP_ARGS_MAX} entries"
        )));
    }
    for a in &input.args {
        if a.chars().count() > MCP_ARG_MAX_BYTES {
            return Err(VaultError::InvalidInput(format!(
                "arg exceeds {MCP_ARG_MAX_BYTES} characters"
            )));
        }
    }
    if input.env.len() > MCP_ENV_VARS_MAX {
        return Err(VaultError::InvalidInput(format!(
            "env exceeds {MCP_ENV_VARS_MAX} entries"
        )));
    }
    for (k, v) in &input.env {
        if !valid_env_name(k) {
            return Err(VaultError::InvalidInput(format!(
                "invalid environment variable name: {k}"
            )));
        }
        if k.chars().count() > MCP_ENV_NAME_MAX {
            return Err(VaultError::InvalidInput(format!(
                "environment variable name exceeds {MCP_ENV_NAME_MAX} characters"
            )));
        }
        if let Some(v) = v
            && v.chars().count() > MCP_ENV_VALUE_MAX
        {
            return Err(VaultError::InvalidInput(format!(
                "environment variable value exceeds {MCP_ENV_VALUE_MAX} characters"
            )));
        }
    }
    if let Some(id) = &input.id {
        if id.trim().is_empty() {
            return Err(VaultError::InvalidInput("id must not be empty".into()));
        }
        if id.chars().count() > MCP_ID_MAX {
            return Err(VaultError::InvalidInput(format!(
                "id exceeds {MCP_ID_MAX} characters"
            )));
        }
    }
    Ok(())
}

/// 生成新 id（32 位 hex 随机；非机密面——ThreadRng 足够）。
fn new_id() -> String {
    let mut bytes = [0u8; 16];
    crate::crypto::fill_os(&mut bytes);
    hex::encode(bytes)
}

/// [`McpServer`] 的存储入口。
pub struct McpServers;

impl McpServers {
    /// 全部配置行（按创建时间升序；列表面稳定序）。
    pub fn list(vault: &Vault) -> Result<Vec<McpServer>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare("SELECT * FROM mcp_servers ORDER BY created_at, id")?;
        let rows = stmt
            .query_map([], row_to_server)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 按 id 取一行（未知 id → [`VaultError::NotFound`]）。
    pub fn get(vault: &Vault, id: &str) -> Result<McpServer> {
        let conn = vault.connection();
        let row = conn
            .query_row(
                "SELECT * FROM mcp_servers WHERE id = ?1",
                [id],
                row_to_server,
            )
            .optional()?;
        row.ok_or_else(|| VaultError::NotFound(format!("mcp server id={id}")))
    }

    /// 落/替一行（id 缺省 = 新建并生成 id）并返回完整行。
    ///
    /// env 语义：**只写** `Some(value)` 的项；`None`（或未出现的键）= 保留旧值
    /// 不动——编辑表单只带用户真正改过的项，误删既有密文不可能发生。
    pub fn upsert(vault: &Vault, input: &McpServerInput) -> Result<McpServer> {
        validate_input(input)?;
        let id = match input.id.as_deref() {
            Some(id) => id.to_string(),
            None => new_id(),
        };
        let ts = now_ts();
        let args_json = serde_json::to_string(&input.args)?;
        // 连接守卫**限时作用域**：vault 是单连接 Mutex（连接锁不可重入）——
        // 下面 set_env/get 会再次取连接，守卫必须先释放（否则自锁死等）。
        {
            let conn = vault.connection();
            conn.execute(
                "INSERT INTO mcp_servers (id, name, command, args, env_names, enabled, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, '[]', ?5, ?6, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    command = excluded.command,
                    args = excluded.args,
                    enabled = excluded.enabled,
                    updated_at = excluded.updated_at",
                params![id, input.name.trim(), input.command.trim(), args_json, input.enabled, ts],
            )?;
        }
        // env：逐项写入密文面（None = 保留旧值，不动）。
        for (name, value) in &input.env {
            if let Some(v) = value {
                McpServers::set_env(vault, &id, name, v)?;
            }
        }
        McpServers::get(vault, &id)
    }

    /// 删一行（连带清掉该 server 的 env 密文——不留孤儿密文）。
    pub fn delete(vault: &Vault, id: &str) -> Result<()> {
        let server = McpServers::get(vault, id)?;
        for name in &server.env_names {
            // 密文可能已被外部删除（不一致即如实忽略：删 server 的主目标达成）。
            let _ = Secrets::delete(vault, &env_secret_key(id, name));
        }
        let n = vault
            .connection()
            .execute("DELETE FROM mcp_servers WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("mcp server id={id}")));
        }
        Ok(())
    }

    /// 改启用位（配置保留，仅不可用）。
    pub fn set_enabled(vault: &Vault, id: &str, enabled: bool) -> Result<McpServer> {
        let n = vault.connection().execute(
            "UPDATE mcp_servers SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
            params![enabled, now_ts(), id],
        )?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("mcp server id={id}")));
        }
        McpServers::get(vault, id)
    }

    /// 已配置环境变量的**名**列表（值不出库）。
    pub fn list_env_names(vault: &Vault, id: &str) -> Result<Vec<String>> {
        Ok(McpServers::get(vault, id)?.env_names)
    }

    /// 写一个环境变量（值进 secrets 密文面；名字登记进本表）。
    pub fn set_env(vault: &Vault, id: &str, name: &str, value: &str) -> Result<()> {
        if !valid_env_name(name) {
            return Err(VaultError::InvalidInput(format!(
                "invalid environment variable name: {name}"
            )));
        }
        if value.chars().count() > MCP_ENV_VALUE_MAX {
            return Err(VaultError::InvalidInput(format!(
                "environment variable value exceeds {MCP_ENV_VALUE_MAX} characters"
            )));
        }
        // 先确保行存在（env 依附于某个 server）。
        let mut names = McpServers::list_env_names(vault, id)?;
        Secrets::set(vault, &env_secret_key(id, name), value)?;
        if !names.iter().any(|n| n == name) {
            names.push(name.to_string());
            names.sort();
            McpServers::write_env_names(vault, id, &names)?;
        }
        Ok(())
    }

    /// 删一个环境变量（清密文 + 摘名字）。
    pub fn delete_env(vault: &Vault, id: &str, name: &str) -> Result<()> {
        let mut names = McpServers::list_env_names(vault, id)?;
        let had = names.iter().any(|n| n == name);
        if had {
            let _ = Secrets::delete(vault, &env_secret_key(id, name));
            names.retain(|n| n != name);
            McpServers::write_env_names(vault, id, &names)?;
        }
        Ok(())
    }

    /// 读该 server 全部环境变量的**值**（供起子进程时注入 env）。
    /// 锁定期返回 [`VaultError::Locked`]（secrets 密文面纪律）。
    pub fn env_values(vault: &Vault, id: &str) -> Result<Vec<(String, String)>> {
        let names = McpServers::list_env_names(vault, id)?;
        let mut out = Vec::with_capacity(names.len());
        for name in names {
            if let Some(v) = Secrets::get(vault, &env_secret_key(id, &name))? {
                out.push((name, v));
            }
        }
        Ok(out)
    }

    /// 写回环境变量名列表（内部）。
    fn write_env_names(vault: &Vault, id: &str, names: &[String]) -> Result<()> {
        let json = serde_json::to_string(names)?;
        let n = vault.connection().execute(
            "UPDATE mcp_servers SET env_names = ?1, updated_at = ?2 WHERE id = ?3",
            params![json, now_ts(), id],
        )?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("mcp server id={id}")));
        }
        Ok(())
    }
}

fn row_to_server(row: &Row) -> rusqlite::Result<McpServer> {
    let args_raw: String = row.get("args")?;
    let args = serde_json::from_str::<Vec<String>>(&args_raw)
        .map_err(|e| conv_failure(row, "args", &e.to_string()))?;
    let env_raw: String = row.get("env_names")?;
    let env_names = serde_json::from_str::<Vec<String>>(&env_raw)
        .map_err(|e| conv_failure(row, "env_names", &e.to_string()))?;
    Ok(McpServer {
        id: row.get("id")?,
        name: row.get("name")?,
        command: row.get("command")?,
        args,
        enabled: row.get::<_, i64>("enabled")? != 0,
        env_names,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 行内列解析失败 → rusqlite 错误（mcp_grants conv_failure 同款形态）。
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

    fn open_vault(dir: &std::path::Path) -> Vault {
        Vault::open_with(dir, &InMemoryStorage::new()).expect("open vault")
    }

    fn input(name: &str) -> McpServerInput {
        McpServerInput {
            id: None,
            name: name.into(),
            command: "npx".into(),
            args: vec![
                "-y".into(),
                "@modelcontextprotocol/server-filesystem".into(),
            ],
            enabled: true,
            env: BTreeMap::new(),
        }
    }

    #[test]
    fn upsert_creates_then_replaces_and_lists() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let row = McpServers::upsert(&vault, &input("files")).expect("upsert");
        assert!(!row.id.is_empty(), "新建自动生成 id");
        assert_eq!(row.name, "files");
        assert_eq!(row.args.len(), 2);
        assert!(row.enabled);
        assert!(row.env_names.is_empty());

        // 同 id 再次 upsert = 替换（不新增行）。
        let replaced = McpServers::upsert(
            &vault,
            &McpServerInput {
                id: Some(row.id.clone()),
                name: "files-2".into(),
                command: "node".into(),
                args: vec!["server.js".into()],
                enabled: false,
                env: BTreeMap::new(),
            },
        )
        .expect("upsert replace");
        assert_eq!(replaced.id, row.id, "同 id upsert 不换行");
        assert_eq!(replaced.name, "files-2");
        assert!(!replaced.enabled);
        assert_eq!(McpServers::list(&vault).unwrap().len(), 1);
    }

    #[test]
    fn env_values_live_in_secrets_not_in_the_row() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let row = McpServers::upsert(&vault, &input("files")).expect("upsert");
        McpServers::set_env(&vault, &row.id, "API_TOKEN", "s3cret").expect("set env");

        // 表里只有变量名。
        let names = McpServers::list_env_names(&vault, &row.id).unwrap();
        assert_eq!(names, vec!["API_TOKEN".to_string()]);
        let raw = vault
            .connection()
            .query_row(
                "SELECT env_names FROM mcp_servers WHERE id = ?1",
                [&row.id],
                |r| r.get::<_, String>(0),
            )
            .unwrap();
        assert!(!raw.contains("s3cret"), "值不进表: {raw}");

        // 值在 secrets 密文面（读回为明文）。
        let values = McpServers::env_values(&vault, &row.id).unwrap();
        assert_eq!(
            values,
            vec![("API_TOKEN".to_string(), "s3cret".to_string())]
        );
        let stored = Secrets::get(&vault, &env_secret_key(&row.id, "API_TOKEN"))
            .unwrap()
            .unwrap();
        assert_eq!(stored, "s3cret");
    }

    #[test]
    fn upsert_env_none_keeps_old_value_and_missing_key_keeps_old_value() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let row = McpServers::upsert(&vault, &input("files")).expect("upsert");
        McpServers::set_env(&vault, &row.id, "API_TOKEN", "old").expect("set env");
        McpServers::set_env(&vault, &row.id, "OTHER", "keep").expect("set env");

        // env 里带 null 值 = 保留旧值；未出现的键 = 保留旧值。
        let mut env = BTreeMap::new();
        env.insert("API_TOKEN".to_string(), None);
        McpServers::upsert(
            &vault,
            &McpServerInput {
                id: Some(row.id.clone()),
                name: "files".into(),
                command: "npx".into(),
                args: vec![],
                enabled: true,
                env,
            },
        )
        .expect("upsert");
        let values = McpServers::env_values(&vault, &row.id).unwrap();
        assert!(
            values.contains(&("API_TOKEN".to_string(), "old".to_string())),
            "null 值不得清掉旧密文: {values:?}"
        );
        assert!(
            values.contains(&("OTHER".to_string(), "keep".to_string())),
            "未出现的键不得动: {values:?}"
        );

        // 显式给值 = 覆盖。
        let mut env = BTreeMap::new();
        env.insert("API_TOKEN".to_string(), Some("new".to_string()));
        McpServers::upsert(
            &vault,
            &McpServerInput {
                id: Some(row.id.clone()),
                name: "files".into(),
                command: "npx".into(),
                args: vec![],
                enabled: true,
                env,
            },
        )
        .expect("upsert");
        let values = McpServers::env_values(&vault, &row.id).unwrap();
        assert!(values.contains(&("API_TOKEN".to_string(), "new".to_string())));
    }

    #[test]
    fn delete_env_clears_ciphertext_and_name() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let row = McpServers::upsert(&vault, &input("files")).expect("upsert");
        McpServers::set_env(&vault, &row.id, "API_TOKEN", "s3cret").expect("set env");
        McpServers::delete_env(&vault, &row.id, "API_TOKEN").expect("delete env");
        assert!(
            McpServers::list_env_names(&vault, &row.id)
                .unwrap()
                .is_empty()
        );
        assert!(
            Secrets::get(&vault, &env_secret_key(&row.id, "API_TOKEN"))
                .unwrap()
                .is_none(),
            "密文必须一并清掉（不留孤儿）"
        );
    }

    #[test]
    fn delete_server_removes_row_and_env_ciphertexts() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let row = McpServers::upsert(&vault, &input("files")).expect("upsert");
        McpServers::set_env(&vault, &row.id, "API_TOKEN", "s3cret").expect("set env");
        McpServers::delete(&vault, &row.id).expect("delete");
        assert!(McpServers::list(&vault).unwrap().is_empty());
        assert!(
            Secrets::get(&vault, &env_secret_key(&row.id, "API_TOKEN"))
                .unwrap()
                .is_none(),
            "删 server 必须连带清 env 密文"
        );
        // 未知 id → NotFound。
        let err = McpServers::delete(&vault, "nope").unwrap_err();
        assert!(matches!(err, VaultError::NotFound(_)));
    }

    #[test]
    fn set_enabled_toggles_without_dropping_config() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        let row = McpServers::upsert(&vault, &input("files")).expect("upsert");
        let off = McpServers::set_enabled(&vault, &row.id, false).expect("disable");
        assert!(!off.enabled);
        assert_eq!(off.command, "npx", "禁用不改配置");
        let on = McpServers::set_enabled(&vault, &row.id, true).expect("enable");
        assert!(on.enabled);
    }

    #[test]
    fn input_validation_rejects_bad_values() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        // 空名。
        assert!(matches!(
            McpServers::upsert(
                &vault,
                &McpServerInput {
                    name: "  ".into(),
                    ..input("x")
                }
            ),
            Err(VaultError::InvalidInput(_))
        ));
        // 空命令。
        assert!(matches!(
            McpServers::upsert(
                &vault,
                &McpServerInput {
                    command: "".into(),
                    ..input("x")
                }
            ),
            Err(VaultError::InvalidInput(_))
        ));
        // 非法环境变量名（含空格/等号）。
        let mut env = BTreeMap::new();
        env.insert("BAD NAME".to_string(), Some("v".into()));
        assert!(matches!(
            McpServers::upsert(&vault, &McpServerInput { env, ..input("x") }),
            Err(VaultError::InvalidInput(_))
        ));
        // 参数超量。
        let many = (0..=MCP_ARGS_MAX).map(|i| i.to_string()).collect();
        assert!(matches!(
            McpServers::upsert(
                &vault,
                &McpServerInput {
                    args: many,
                    ..input("x")
                }
            ),
            Err(VaultError::InvalidInput(_))
        ));
    }

    #[test]
    fn locked_vault_rejects_secret_reads() {
        let dir = tempfile::tempdir().unwrap();
        let locked = Vault::open_password_only(dir.path()).expect("open locked vault");
        let row = McpServers::upsert(&locked, &input("files")).expect("upsert");
        // 明文面（配置）在锁定态可读。
        assert!(McpServers::list_env_names(&locked, &row.id).is_ok());
        // 直接写一行带 env 名的数据（模拟已配好的密文项）——密文面锁定即拒。
        {
            let conn = locked.connection();
            conn.execute(
                "UPDATE mcp_servers SET env_names = ?1 WHERE id = ?2",
                params!["[\"API_TOKEN\"]", row.id],
            )
            .expect("seed env names");
        }
        assert_eq!(
            McpServers::list_env_names(&locked, &row.id).unwrap(),
            vec!["API_TOKEN".to_string()]
        );
        assert!(matches!(
            McpServers::env_values(&locked, &row.id),
            Err(VaultError::Locked)
        ));
    }
}
