//! alert_rules 表访问（Phase 3 Task 3，B5 告警规则引擎——存储侧，spec §3）。
//!
//! 规则是**明文面**：无 `*_enc` 列（敏感材料在 [`crate::notify_channels`] 的
//! config_enc，0014），锁定语义与 hosts 同（配置面命令统一 `ensure_unlocked`
//! 门卫）。评估引擎在 TS（src/notify/rules.ts）——数据源是前端监控事件流
//! （ottr://monitor）与进程采集（monitor_ps）；Rust 只供表 + `mark_fired`
//! 回写（引擎防重复触发的水位持久化，重启不重放旧告警）。
//!
//! 序列化面即前端契约：[`AlertRule`] 字段与 `src/vault/api.ts` 的 `AlertRule`
//! 接口同构（snake_case）。`params`/`channels` 以 JSON 文本落库（spec §3），
//! 存储层只校验「合法 JSON / channels 是数组」——类别内字段语义（threshold、
//! consecutive、comm）归 TS 引擎消费面，存储层不越界解释。

use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::{Result, Vault, VaultError};

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// 合法规则类别（DB CHECK 同集）。`log` = 日志关键字——Phase 3 MVP 裁定延后
/// （task-3 简报裁定 #1：tail 会话管理复杂度），存储/CRUD 放行、引擎不评估。
pub const RULE_KINDS: &[&str] = &["disk", "cpu", "process", "log"];

/// 静音窗全格式校验："HH:MM-HH:MM"（本地时区，可跨午夜）。存储层做完整形状
/// 校验（HH ≤ 23、MM ≤ 59；允许跨午夜如 "22:00-08:00"），「当前时刻是否落在
/// 窗口内」的判定在 TS 引擎（muteWindowContains）。
///
/// "HH:MM" 段解析（两位数 + 范围校验；越界 → None）。
fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let h: u32 = h.parse().ok()?;
    let m: u32 = m.parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some((h, m))
}

/// 静音窗全格式校验："HH:MM-HH:MM"。
fn valid_mute_window(w: &str) -> bool {
    let Some((start, end)) = w.split_once('-') else {
        return false;
    };
    parse_hhmm(start).is_some() && parse_hhmm(end).is_some()
}

/// 告警规则行（serde 面与 TS `AlertRule` 同构）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlertRule {
    pub id: i64,
    pub host_id: i64,
    /// "disk" | "cpu" | "process" | "log"（DB CHECK 同集）。
    pub kind: String,
    /// 类别参数（JSON 对象；字段面归引擎消费，存储层只保证合法 JSON）。
    pub params: serde_json::Value,
    /// 订阅渠道 id 数组（notify_channels.id；③外部渠道按此路由）。
    pub channels: Vec<i64>,
    /// 同规则再次告警最小间隔（秒；0 = 只用管线全局 60s 聚合）。
    pub rate_limit: i64,
    /// "HH:MM-HH:MM"（可跨午夜；None = 不静音）。
    pub mute_window: Option<String>,
    /// 最近触发时刻（秒级 Unix；None = 从未触发；[`AlertRules::mark_fired`] 回写）。
    pub last_fired: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 新建规则的输入（create/update 全量替换式提交，HostInput 同款）。
#[derive(Debug, Clone, Deserialize)]
pub struct AlertRuleInput {
    pub host_id: i64,
    pub kind: String,
    pub params: serde_json::Value,
    pub channels: Vec<i64>,
    pub rate_limit: i64,
    pub mute_window: Option<String>,
}

/// 校验输入共通面（create/update 共用）：kind 合法集、params 是 JSON 对象、
/// mute_window 形状、rate_limit 非负。
fn validate_input(input: &AlertRuleInput) -> Result<()> {
    if !RULE_KINDS.contains(&input.kind.as_str()) {
        return Err(VaultError::InvalidInput(format!(
            "unknown alert rule kind: {} (disk/cpu/process/log)",
            input.kind
        )));
    }
    if !input.params.is_object() {
        return Err(VaultError::InvalidInput(
            "alert rule params must be a JSON object".into(),
        ));
    }
    if let Some(w) = &input.mute_window
        && !valid_mute_window(w)
    {
        return Err(VaultError::InvalidInput(
            "mute_window must look like \"HH:MM-HH:MM\" (00-23:00-59)".into(),
        ));
    }
    if input.rate_limit < 0 {
        return Err(VaultError::InvalidInput(
            "rate_limit must be >= 0 seconds".into(),
        ));
    }
    Ok(())
}

/// [`AlertRule`] 的存储入口。
pub struct AlertRules;

impl AlertRules {
    /// 落一条规则并返回完整行（id/created_at/updated_at 由存储层定；last_fired
    /// 初值 NULL）。host 不存在 → FK 报错（sqlite FK on）。
    pub fn create(vault: &Vault, input: &AlertRuleInput) -> Result<AlertRule> {
        validate_input(input)?;
        let ts = now_ts();
        let params_json = serde_json::to_string(&input.params)?;
        let channels_json = serde_json::to_string(&input.channels)?;
        let conn = vault.connection();
        conn.execute(
            "INSERT INTO alert_rules (host_id, kind, params, channels, rate_limit, mute_window, last_fired, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
            params![
                input.host_id,
                input.kind,
                params_json,
                channels_json,
                input.rate_limit,
                input.mute_window,
                ts
            ],
        )?;
        let id = conn.last_insert_rowid();
        Ok(AlertRule {
            id,
            host_id: input.host_id,
            kind: input.kind.clone(),
            params: input.params.clone(),
            channels: input.channels.clone(),
            rate_limit: input.rate_limit,
            mute_window: input.mute_window.clone(),
            last_fired: None,
            created_at: ts,
            updated_at: ts,
        })
    }

    /// 全量替换式更新（未给字段一并覆写——HostInput 同款语义；last_fired 不在
    /// 输入面，保持原值——编辑配置不清防重复水位）。行不存在 → NotFound。
    /// 连接锁作用域：guard 必须在 `Self::get` 重入 `vault.connection()` 前
    /// 释放（单连接 Mutex 不可重入——TDD 实测死锁教训，见 task-3 报告）。
    pub fn update(vault: &Vault, id: i64, input: &AlertRuleInput) -> Result<AlertRule> {
        validate_input(input)?;
        let ts = now_ts();
        let params_json = serde_json::to_string(&input.params)?;
        let channels_json = serde_json::to_string(&input.channels)?;
        {
            let conn = vault.connection();
            let n = conn.execute(
                "UPDATE alert_rules SET host_id = ?1, kind = ?2, params = ?3, channels = ?4,
                 rate_limit = ?5, mute_window = ?6, updated_at = ?7 WHERE id = ?8",
                params![
                    input.host_id,
                    input.kind,
                    params_json,
                    channels_json,
                    input.rate_limit,
                    input.mute_window,
                    ts,
                    id
                ],
            )?;
            if n == 0 {
                return Err(VaultError::NotFound(format!("alert rule id={id}")));
            }
        }
        Ok(Self::get(vault, id)?.expect("row exists after successful UPDATE"))
    }

    /// 删规则；未知 id 显式报 [`VaultError::NotFound`]（同 credentials 纪律）。
    pub fn delete(vault: &Vault, id: i64) -> Result<()> {
        let n = vault
            .connection()
            .execute("DELETE FROM alert_rules WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("alert rule id={id}")));
        }
        Ok(())
    }

    pub fn get(vault: &Vault, id: i64) -> Result<Option<AlertRule>> {
        let conn = vault.connection();
        conn.query_row("SELECT * FROM alert_rules WHERE id = ?1", [id], row_to_rule)
            .optional()
            .map_err(Into::into)
    }

    /// 全部规则（id 升序；引擎装载与设置页列表共用）。
    pub fn list(vault: &Vault) -> Result<Vec<AlertRule>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare("SELECT * FROM alert_rules ORDER BY id")?;
        let rows = stmt
            .query_map([], row_to_rule)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 触发水位回写（引擎放行一条告警时调用）。行不存在 → NotFound
    /// （规则刚被删的竞态显式浮出，不静默——引擎按错误丢弃本次回写）。
    pub fn mark_fired(vault: &Vault, id: i64, ts: i64) -> Result<()> {
        let n = vault.connection().execute(
            "UPDATE alert_rules SET last_fired = ?1 WHERE id = ?2",
            params![ts, id],
        )?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("alert rule id={id}")));
        }
        Ok(())
    }
}

fn row_to_rule(row: &Row) -> rusqlite::Result<AlertRule> {
    let kind: String = row.get("kind")?;
    if !RULE_KINDS.contains(&kind.as_str()) {
        return Err(conv_failure(row, "kind", &format!("unknown kind: {kind}")));
    }
    let params_raw: String = row.get("params")?;
    let params: serde_json::Value = serde_json::from_str(&params_raw)
        .map_err(|e| conv_failure(row, "params", &e.to_string()))?;
    let channels_raw: String = row.get("channels")?;
    let channels: Vec<i64> = serde_json::from_str(&channels_raw)
        .map_err(|e| conv_failure(row, "channels", &e.to_string()))?;
    Ok(AlertRule {
        id: row.get("id")?,
        host_id: row.get("host_id")?,
        kind,
        params,
        channels,
        rate_limit: row.get("rate_limit")?,
        mute_window: row.get("mute_window")?,
        last_fired: row.get("last_fired")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 行内列解析失败 → rusqlite 错误（notifications.rs conv_failure 同款形态：
/// kind 集损坏与 params/channels JSON 损坏不静默吞掉）。
fn conv_failure(row: &Row, column: &str, msg: &str) -> rusqlite::Error {
    use rusqlite::types::Type;
    let idx = row.as_ref().column_index(column).unwrap_or(0);
    rusqlite::Error::FromSqlConversionFailure(
        idx,
        Type::Text,
        Box::new(VaultError::InvalidInput(msg.to_string())),
    )
}
