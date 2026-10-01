//! notifications 表访问（Task 12，spec §7 ①应用内通知中心）。
//!
//! 通知是**明文面**：不含任何密钥材料（无 `*_enc` 列），锁定态照常可读写
//! ——异常断开等事件在锁定时也要能落表（与 settings/meta 同一锁定语义，
//! 见 store.rs 模块文档「锁定语义」）。
//!
//! 序列化面即前端契约：[`Notification`] 字段与 `src/vault/api.ts` 的
//! `Notification` 接口同构（snake_case）。`title_key` 存 i18n 词典键（UI 渲染
//! 时 `t(title_key)`，换语言历史通知标题跟着变），`body` 存展示文本（路径/
//! 错误消息等事件自带内容，不进词典），二者分工见 0005 迁移文件头。
//!
//! 写入口不做「未读数」等派生维护——unread 由 [`Notifications::unread_count`]
//! 现查（单连接串行化下 COUNT(read=0) 是廉价索引扫描）；清空策略是调用方
//! 裁量（UI「清空」按钮全删；量级由通知频度决定，Phase 1 无自动衰减）。

use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};

use crate::{Result, Vault, VaultError};

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// 通知行（serde 面与 TS `Notification` 同构；`read`/`severity` 已转原生形态）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Notification {
    pub id: i64,
    /// 事件类别（前端 `NotifyKind`："transfer" | "session"，按 kind 静音的键）。
    pub kind: String,
    /// "info" | "success" | "warning" | "error"（DB CHECK 同集；UI 语义配色）。
    pub severity: String,
    pub host_id: Option<i64>,
    /// i18n 词典键（展示时翻译；非明文标题——换语言不失效）。
    pub title_key: String,
    /// 展示文本（远端路径 / 主机名 / 错误消息——事件自带内容，不进词典）。
    pub body: String,
    /// 结构化参数（可选 JSON；payload 列原样解析，损坏显式报错）。
    pub payload: Option<serde_json::Value>,
    pub read: bool,
    /// 秒级 Unix 时间（实体表同口径）。
    pub ts: i64,
}

/// 新建通知的输入（severity 合法集校验在存储层，DB CHECK 是第二道兵）。
#[derive(Debug, Clone, Deserialize)]
pub struct NotificationInput {
    pub kind: String,
    pub severity: String,
    pub host_id: Option<i64>,
    pub title_key: String,
    pub body: String,
    pub payload: Option<serde_json::Value>,
}

/// 合法 severity 集（DB CHECK 约束同集；显式校验给出可读错误而非裸 Sql 错）。
const SEVERITIES: &[&str] = &["info", "success", "warning", "error"];

/// [`Notification`] 的存储入口。
pub struct Notifications;

impl Notifications {
    /// 落一条通知并返回完整行（id/ts 由存储层定）。kind/title_key 非空、
    /// severity 合法集校验失败 → [`VaultError::InvalidInput`]。
    pub fn insert(vault: &Vault, input: &NotificationInput) -> Result<Notification> {
        if input.kind.trim().is_empty() {
            return Err(VaultError::InvalidInput(
                "notification kind must not be empty".into(),
            ));
        }
        if input.title_key.trim().is_empty() {
            return Err(VaultError::InvalidInput(
                "notification title_key must not be empty".into(),
            ));
        }
        if !SEVERITIES.contains(&input.severity.as_str()) {
            return Err(VaultError::InvalidInput(format!(
                "unknown notification severity: {} (info/success/warning/error)",
                input.severity
            )));
        }
        let ts = now_ts();
        let payload = input
            .payload
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let conn = vault.connection();
        conn.execute(
            "INSERT INTO notifications (kind, severity, host_id, title_key, body, payload, read, ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)",
            params![
                input.kind,
                input.severity,
                input.host_id,
                input.title_key,
                input.body,
                payload,
                ts
            ],
        )?;
        let id = conn.last_insert_rowid();
        Ok(Notification {
            id,
            kind: input.kind.clone(),
            severity: input.severity.clone(),
            host_id: input.host_id,
            title_key: input.title_key.clone(),
            body: input.body.clone(),
            payload: input.payload.clone(),
            read: false,
            ts,
        })
    }

    /// 最近通知（ts DESC, id DESC 同 ts 保序），`limit` 截断（0 → 空表）。
    pub fn list(vault: &Vault, limit: usize) -> Result<Vec<Notification>> {
        let conn = vault.connection();
        let mut stmt =
            conn.prepare("SELECT * FROM notifications ORDER BY ts DESC, id DESC LIMIT ?1")?;
        let rows = stmt
            .query_map(params![limit as i64], row_to_notification)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 标记已读。`None` = 全部已读；`Some(id)` 行不存在 → [`VaultError::NotFound`]。
    /// 返回本次翻转的行数（幂等：已读行再标仍算命中，语义 = 「指到即读」）。
    pub fn mark_read(vault: &Vault, id: Option<i64>) -> Result<usize> {
        let conn = vault.connection();
        let n = match id {
            None => conn.execute("UPDATE notifications SET read = 1 WHERE read = 0", [])?,
            Some(id) => {
                let n = conn.execute(
                    "UPDATE notifications SET read = 1 WHERE id = ?1",
                    params![id],
                )?;
                if n == 0 {
                    return Err(VaultError::NotFound(format!("notification id={id}")));
                }
                n
            }
        };
        Ok(n)
    }

    /// 清空全部通知，返回删除行数（幂等）。
    pub fn clear(vault: &Vault) -> Result<usize> {
        let n = vault
            .connection()
            .execute("DELETE FROM notifications", [])?;
        Ok(n)
    }

    /// 未读数（idx_notifications_unread 索引扫描；红点数据源）。
    pub fn unread_count(vault: &Vault) -> Result<i64> {
        let conn = vault.connection();
        conn.query_row(
            "SELECT count(*) FROM notifications WHERE read = 0",
            [],
            |r| r.get(0),
        )
        .map_err(Into::into)
    }
}

/// payload 列 TEXT ↔ serde_json::Value；损坏 JSON 显式报错（同 tags/variables 纪律）。
fn payload_from_json(raw: Option<String>) -> Result<Option<serde_json::Value>> {
    match raw {
        None => Ok(None),
        Some(s) => serde_json::from_str(&s).map(Some).map_err(Into::into),
    }
}

fn row_to_notification(row: &Row) -> rusqlite::Result<Notification> {
    let severity: String = row.get("severity")?;
    if !SEVERITIES.contains(&severity.as_str()) {
        return Err(conv_failure(row, "severity", &severity));
    }
    let payload = payload_from_json(row.get("payload")?)
        .map_err(|e| conv_failure(row, "payload", &e.to_string()))?;
    Ok(Notification {
        id: row.get("id")?,
        kind: row.get("kind")?,
        severity,
        host_id: row.get("host_id")?,
        title_key: row.get("title_key")?,
        body: row.get("body")?,
        payload,
        read: row.get::<_, i64>("read")? != 0,
        ts: row.get("ts")?,
    })
}

/// 行内列解析失败 → rusqlite 错误（带真实列位，query_map 闭包可直接 `?`；
/// 复用 entities.rs 的 FromSqlConversionFailure 形态——severity 集损坏与
/// payload JSON 损坏都不静默吞掉）。
fn conv_failure(row: &Row, column: &str, msg: &str) -> rusqlite::Error {
    use rusqlite::types::Type;
    let idx = row.as_ref().column_index(column).unwrap_or(0);
    rusqlite::Error::FromSqlConversionFailure(
        idx,
        Type::Text,
        Box::new(VaultError::InvalidInput(msg.to_string())),
    )
}
