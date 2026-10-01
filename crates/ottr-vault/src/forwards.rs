//! port_forwards 表访问（Phase 2 Task 1，spec §3 B7 上半：端口转发中心）。
//!
//! 明文配置面（0008 迁移文件头）：无 `*_enc` 列、不经 AAD 绑定、不涉
//! scan_registry；锁定语义与 hosts 同（命令面统一 `ensure_unlocked` 门卫）。
//!
//! 字段结构（spec「bind_addr/target」两文本列的结构化拆分，偏差记录见迁移
//! 文件头）：`bind_addr:bind_port` = 监听端点，`target_host:target_port` =
//! 目标（dynamic 型两列强制 NULL——目标由每个 SOCKS5 CONNECT 现场指定）。
//!
//! kind 三态映射 OpenSSH 惯例：
//! * `local`   = -L（本机监听 → 经 SSH 到 target_host:target_port）；
//! * `remote`  = -R（远端 sshd 监听 → 隧道回本机连 target）；
//! * `dynamic` = -D（本机 SOCKS5 代理，目标按请求解析）。
//!
//! 校验（存储层兜底，迁移 CHECK 是底线）：bind_addr 非空白；bind_port ≤ 65535
//! （0 = 动态/服务端选）；local/remote 必须带 target（端口 ≥1，不允许 0），
//! dynamic 必须不带（传入的 target 值被丢弃归一为 None，不静默存储）。

use rusqlite::OptionalExtension;
use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};

use crate::{Result, Vault, VaultError};

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// 转发类型（serde 面与 `src/vault/api.ts` 同构小写串：local/remote/dynamic）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForwardKind {
    Local,
    Remote,
    Dynamic,
}

impl ForwardKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
            Self::Dynamic => "dynamic",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "local" => Some(Self::Local),
            "remote" => Some(Self::Remote),
            "dynamic" => Some(Self::Dynamic),
            _ => None,
        }
    }
}

/// 一条端口转发配置（serde 面与前端 `PortForward` 同构，snake_case）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PortForward {
    pub id: i64,
    pub host_id: i64,
    pub kind: ForwardKind,
    pub bind_addr: String,
    /// 0 = 本机动态分配（local）/ 服务端选择（remote）；运行时实际端口由
    /// ForwardManager 的状态快照（bound_port）给出。
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    /// 会话建立成功即自动启动。
    pub enabled: bool,
    /// 会话断线重连成功后自动恢复（须 enabled）。
    pub auto_reconnect: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 新建/全量更新转发配置的输入（id/ts 由存储层定）。
#[derive(Debug, Clone, Deserialize)]
pub struct PortForwardInput {
    pub host_id: i64,
    pub kind: ForwardKind,
    pub bind_addr: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub enabled: bool,
    pub auto_reconnect: bool,
}

/// [`PortForward`] 的存储入口。
pub struct PortForwards;

impl PortForwards {
    /// 校验 + 归一（dynamic 丢 target）。返回归一后的四元组。
    fn validate(input: &PortForwardInput) -> Result<(String, u16, Option<String>, Option<u16>)> {
        if input.bind_addr.trim().is_empty() {
            return Err(VaultError::InvalidInput(
                "port forward bind_addr must not be empty".into(),
            ));
        }
        match input.kind {
            ForwardKind::Local | ForwardKind::Remote => {
                let (Some(host), Some(port)) = (&input.target_host, input.target_port) else {
                    return Err(VaultError::InvalidInput(format!(
                        "{} forward requires target_host/target_port",
                        input.kind.as_str()
                    )));
                };
                if host.trim().is_empty() {
                    return Err(VaultError::InvalidInput(
                        "port forward target_host must not be empty".into(),
                    ));
                }
                if port == 0 {
                    return Err(VaultError::InvalidInput(
                        "port forward target_port must be 1..=65535".into(),
                    ));
                }
                Ok((
                    input.bind_addr.trim().into(),
                    input.bind_port,
                    Some(host.trim().into()),
                    Some(port),
                ))
            }
            ForwardKind::Dynamic => {
                // dynamic 的目标由每个 SOCKS5 CONNECT 现场指定：传入值丢弃归一。
                Ok((input.bind_addr.trim().into(), input.bind_port, None, None))
            }
        }
    }

    pub fn create(vault: &Vault, input: &PortForwardInput) -> Result<PortForward> {
        let (bind_addr, bind_port, target_host, target_port) = Self::validate(input)?;
        let ts = now_ts();
        let conn = vault.connection();
        conn.execute(
            "INSERT INTO port_forwards (host_id, kind, bind_addr, bind_port,
                                        target_host, target_port,
                                        enabled, auto_reconnect, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                input.host_id,
                input.kind.as_str(),
                bind_addr,
                bind_port as i64,
                target_host,
                target_port.map(|p| p as i64),
                input.enabled,
                input.auto_reconnect,
                ts,
            ],
        )?;
        let id = conn.last_insert_rowid();
        Ok(PortForward {
            id,
            host_id: input.host_id,
            kind: input.kind,
            bind_addr,
            bind_port,
            target_host,
            target_port,
            enabled: input.enabled,
            auto_reconnect: input.auto_reconnect,
            created_at: ts,
            updated_at: ts,
        })
    }

    /// 全量替换式更新（字段集同 create）；updated_at 刷新、created_at 保留。
    pub fn update(vault: &Vault, id: i64, input: &PortForwardInput) -> Result<PortForward> {
        let (bind_addr, bind_port, target_host, target_port) = Self::validate(input)?;
        let ts = now_ts();
        let conn = vault.connection();
        let created_at: i64 = conn
            .query_row(
                "SELECT created_at FROM port_forwards WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("port_forward id={id}")))?;
        let n = conn.execute(
            "UPDATE port_forwards SET host_id = ?1, kind = ?2, bind_addr = ?3, bind_port = ?4,
                                      target_host = ?5, target_port = ?6,
                                      enabled = ?7, auto_reconnect = ?8, updated_at = ?9
             WHERE id = ?10",
            params![
                input.host_id,
                input.kind.as_str(),
                bind_addr,
                bind_port as i64,
                target_host,
                target_port.map(|p| p as i64),
                input.enabled,
                input.auto_reconnect,
                ts,
                id,
            ],
        )?;
        debug_assert_eq!(n, 1, "行已确认存在（created_at 读取）");
        Ok(PortForward {
            id,
            host_id: input.host_id,
            kind: input.kind,
            bind_addr,
            bind_port,
            target_host,
            target_port,
            enabled: input.enabled,
            auto_reconnect: input.auto_reconnect,
            created_at,
            updated_at: ts,
        })
    }

    /// 启停开关（面板开关按钮的存储动作；运行侧启停见 ForwardManager）。
    pub fn set_enabled(vault: &Vault, id: i64, enabled: bool) -> Result<()> {
        let n = vault.connection().execute(
            "UPDATE port_forwards SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
            params![enabled, now_ts(), id],
        )?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("port_forward id={id}")));
        }
        Ok(())
    }

    pub fn delete(vault: &Vault, id: i64) -> Result<()> {
        let n = vault
            .connection()
            .execute("DELETE FROM port_forwards WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("port_forward id={id}")));
        }
        Ok(())
    }

    pub fn get(vault: &Vault, id: i64) -> Result<Option<PortForward>> {
        let conn = vault.connection();
        conn.query_row(
            "SELECT * FROM port_forwards WHERE id = ?1",
            [id],
            row_to_forward,
        )
        .optional()
        .map_err(Into::into)
    }

    /// 全量列表（`host_id` Some = 只取该主机的；id 升序 = 创建序）。
    pub fn list(vault: &Vault, host_id: Option<i64>) -> Result<Vec<PortForward>> {
        let conn = vault.connection();
        let mut stmt = conn
            .prepare("SELECT * FROM port_forwards WHERE ?1 IS NULL OR host_id = ?1 ORDER BY id")?;
        let rows = stmt
            .query_map(params![host_id], row_to_forward)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 指主机 enabled 的行（attach 成功后自动启动的取数面）。
    pub fn list_enabled(vault: &Vault, host_id: i64) -> Result<Vec<PortForward>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare(
            "SELECT * FROM port_forwards WHERE host_id = ?1 AND enabled = 1 ORDER BY id",
        )?;
        let rows = stmt
            .query_map(params![host_id], row_to_forward)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

fn row_to_forward(row: &Row) -> rusqlite::Result<PortForward> {
    let kind_str: String = row.get("kind")?;
    let kind = ForwardKind::parse(&kind_str).ok_or_else(|| {
        // CHECK 约束已挡非法值；此处是纵深防御（外部改写库时显式报错不静默）。
        rusqlite::Error::FromSqlConversionFailure(
            row.as_ref().column_index("kind").unwrap_or(0),
            rusqlite::types::Type::Text,
            format!("unknown forward kind: {kind_str}").into(),
        )
    })?;
    Ok(PortForward {
        id: row.get("id")?,
        host_id: row.get("host_id")?,
        kind,
        bind_addr: row.get("bind_addr")?,
        bind_port: row.get::<_, i64>("bind_port")? as u16,
        target_host: row.get("target_host")?,
        target_port: row.get::<_, Option<i64>>("target_port")?.map(|p| p as u16),
        enabled: row.get::<_, i64>("enabled")? != 0,
        auto_reconnect: row.get::<_, i64>("auto_reconnect")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}
