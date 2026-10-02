//! cron_jobs / cron_runs 表访问（Phase 4 Task 1，Phase 3 缺口①——存储侧）。
//!
//! 与 [`crate::alert_rules`] 同款分工：调度/评估引擎在 ottr-monitor（Rust 侧，
//! 引擎宿主裁定落地——脱离 webview 生命周期），本 crate 只供表。明文面
//! （无 `*_enc` 列），锁定语义与 hosts 同（配置面命令统一 `ensure_unlocked`
//! 门卫）。`channels` 以 JSON 文本落库（spec §3），存储层只校验「合法 JSON /
//! channels 是数组」；`schedule` 的五段式语义校验在 ottr-monitor::cron::CronExpr
//! （命令层 create/update 前置），存储层只做非空+长度护栏（DB 不是解析器）。
//!
//! 运行历史（[`CronRuns`]）：每轮执行一条（ok/failed/timeout/missed），
//! 插入时按 [`CRON_RUNS_KEEP`] 裁剪每任务保留条数——历史无限增长会拖垮
//! CronPanel 列表与库体积；输出正文不入库（sidecar 文件，路径在
//! output_path；digest 对截断后输出算，完整性对账面）。

use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::{Result, Vault, VaultError};

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// 合法运行状态（DB CHECK 同集）。
pub const CRON_RUN_STATUSES: &[&str] = &["ok", "failed", "timeout", "missed"];

/// 每任务保留的运行历史条数（插入时裁剪；CronPanel 列表与库体积的护栏）。
pub const CRON_RUNS_KEEP: i64 = 50;

/// schedule/script 长度护栏（batch 单命令 64KB 同款；schedule 是一行表达式）。
pub const CRON_SCRIPT_MAX_BYTES: usize = 64 * 1024;
pub const CRON_SCHEDULE_MAX_BYTES: usize = 256;

/// cron 任务行（serde 面与 TS `CronJob` 同构）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CronJob {
    pub id: i64,
    pub host_id: i64,
    /// 五段式 cron 表达式（"*/5 * * * *"）。
    pub schedule: String,
    /// 远端执行的脚本/命令（exec 通道）。
    pub script: String,
    /// 订阅渠道 id 数组（notify_channels.id；③外部渠道按此路由）。
    pub channels: Vec<i64>,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 新建/更新任务的输入（全量替换式提交，AlertRuleInput 同款）。
#[derive(Debug, Clone, Deserialize)]
pub struct CronJobInput {
    pub host_id: i64,
    pub schedule: String,
    pub script: String,
    pub channels: Vec<i64>,
    pub enabled: bool,
}

/// 校验输入共通面：schedule/script 非空+长度、channels 可序列化。
/// schedule 五段式语义（段数/取值域）在命令层经 CronExpr::parse 前置。
fn validate_input(input: &CronJobInput) -> Result<()> {
    if input.schedule.trim().is_empty() {
        return Err(VaultError::InvalidInput(
            "schedule must not be empty".into(),
        ));
    }
    if input.schedule.len() > CRON_SCHEDULE_MAX_BYTES {
        return Err(VaultError::InvalidInput(format!(
            "schedule exceeds {CRON_SCHEDULE_MAX_BYTES} bytes"
        )));
    }
    if input.script.trim().is_empty() {
        return Err(VaultError::InvalidInput("script must not be empty".into()));
    }
    if input.script.len() > CRON_SCRIPT_MAX_BYTES {
        return Err(VaultError::InvalidInput(format!(
            "script exceeds {} bytes",
            CRON_SCRIPT_MAX_BYTES
        )));
    }
    Ok(())
}

/// [`CronJob`] 的存储入口。
pub struct CronJobs;

impl CronJobs {
    /// 落一条任务并返回完整行（host 不存在 → FK 报错）。
    pub fn create(vault: &Vault, input: &CronJobInput) -> Result<CronJob> {
        validate_input(input)?;
        let ts = now_ts();
        let channels_json = serde_json::to_string(&input.channels)?;
        let conn = vault.connection();
        conn.execute(
            "INSERT INTO cron_jobs (host_id, schedule, script, channels, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                input.host_id,
                input.schedule.trim(),
                input.script,
                channels_json,
                input.enabled,
                ts
            ],
        )?;
        let id = conn.last_insert_rowid();
        Ok(CronJob {
            id,
            host_id: input.host_id,
            schedule: input.schedule.trim().to_string(),
            script: input.script.clone(),
            channels: input.channels.clone(),
            enabled: input.enabled,
            created_at: ts,
            updated_at: ts,
        })
    }

    /// 全量替换式更新。行不存在 → NotFound。
    /// 连接锁作用域：guard 必须在 `Self::get` 重入 `vault.connection()` 前
    /// 释放（单连接 Mutex 不可重入——alert_rules 同款纪律）。
    pub fn update(vault: &Vault, id: i64, input: &CronJobInput) -> Result<CronJob> {
        validate_input(input)?;
        let ts = now_ts();
        let channels_json = serde_json::to_string(&input.channels)?;
        {
            let conn = vault.connection();
            let n = conn.execute(
                "UPDATE cron_jobs SET host_id = ?1, schedule = ?2, script = ?3, channels = ?4,
                 enabled = ?5, updated_at = ?6 WHERE id = ?7",
                params![
                    input.host_id,
                    input.schedule.trim(),
                    input.script,
                    channels_json,
                    input.enabled,
                    ts,
                    id
                ],
            )?;
            if n == 0 {
                return Err(VaultError::NotFound(format!("cron job id={id}")));
            }
        }
        Ok(Self::get(vault, id)?.expect("row exists after successful UPDATE"))
    }

    /// 删任务（cron_runs 随 FK ON DELETE CASCADE 级联清）。
    /// 未知 id 显式报 NotFound（credentials 纪律）。
    pub fn delete(vault: &Vault, id: i64) -> Result<()> {
        let n = vault
            .connection()
            .execute("DELETE FROM cron_jobs WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("cron job id={id}")));
        }
        Ok(())
    }

    pub fn get(vault: &Vault, id: i64) -> Result<Option<CronJob>> {
        let conn = vault.connection();
        conn.query_row("SELECT * FROM cron_jobs WHERE id = ?1", [id], row_to_job)
            .optional()
            .map_err(Into::into)
    }

    /// 全部任务（id 升序；调度器装载与 CronPanel 列表共用）。
    pub fn list(vault: &Vault) -> Result<Vec<CronJob>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare("SELECT * FROM cron_jobs ORDER BY id")?;
        let rows = stmt
            .query_map([], row_to_job)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

/// 一轮运行历史行（serde 面与 TS `CronRun` 同构）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CronRun {
    pub id: i64,
    pub cron_id: i64,
    /// "ok" | "failed" | "timeout" | "missed"（DB CHECK 同集）。
    pub status: String,
    /// 远端退出码；None = missed/timeout/未回退出码。
    pub exit_code: Option<i64>,
    /// 输出（截断后）的 sha256 hex；无输出 → None。
    pub output_digest: Option<String>,
    /// 输出正文 sidecar 文件路径；无输出 → None。
    pub output_path: Option<String>,
    pub duration_ms: i64,
    /// 触发时刻（秒级 Unix）。
    pub ts: i64,
}

/// 运行历史输入（引擎 sink 落库面）。
#[derive(Debug, Clone, Deserialize)]
pub struct CronRunInput {
    pub cron_id: i64,
    pub status: String,
    pub exit_code: Option<i64>,
    pub output_digest: Option<String>,
    pub output_path: Option<String>,
    pub duration_ms: i64,
    pub ts: i64,
}

/// [`CronRun`] 的存储入口。
pub struct CronRuns;

impl CronRuns {
    /// 落一条历史并裁剪保留窗口（每任务最近 [`CRON_RUNS_KEEP`] 条）。
    /// 任务不存在 → FK 报错（任务刚被删的竞态显式浮出，不静默）。
    pub fn insert(vault: &Vault, input: &CronRunInput) -> Result<CronRun> {
        if !CRON_RUN_STATUSES.contains(&input.status.as_str()) {
            return Err(VaultError::InvalidInput(format!(
                "unknown cron run status: {} (ok/failed/timeout/missed)",
                input.status
            )));
        }
        let conn = vault.connection();
        conn.execute(
            "INSERT INTO cron_runs (cron_id, status, exit_code, output_digest, output_path, duration_ms, ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                input.cron_id,
                input.status,
                input.exit_code,
                input.output_digest,
                input.output_path,
                input.duration_ms,
                input.ts
            ],
        )?;
        let id = conn.last_insert_rowid();
        // 保留窗口裁剪：按 ts 降序以外的旧行删除（同 ts 按 id 稳定排序）
        conn.execute(
            "DELETE FROM cron_runs WHERE cron_id = ?1 AND id NOT IN (
                SELECT id FROM cron_runs WHERE cron_id = ?1 ORDER BY ts DESC, id DESC LIMIT ?2
             )",
            params![input.cron_id, CRON_RUNS_KEEP],
        )?;
        Ok(CronRun {
            id,
            cron_id: input.cron_id,
            status: input.status.clone(),
            exit_code: input.exit_code,
            output_digest: input.output_digest.clone(),
            output_path: input.output_path.clone(),
            duration_ms: input.duration_ms,
            ts: input.ts,
        })
    }

    /// 回填输出 sidecar 路径（落库先于写文件——sink 两步收尾的第二步）。
    /// 行不存在（竞态删除）→ NotFound。
    pub fn attach_output(vault: &Vault, id: i64, path: &str) -> Result<()> {
        let n = vault.connection().execute(
            "UPDATE cron_runs SET output_path = ?1 WHERE id = ?2",
            params![path, id],
        )?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("cron run id={id}")));
        }
        Ok(())
    }

    /// 某任务的最近历史（ts 降序；CronPanel 历史列表）。
    pub fn list_for_job(vault: &Vault, cron_id: i64, limit: usize) -> Result<Vec<CronRun>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare(
            "SELECT * FROM cron_runs WHERE cron_id = ?1 ORDER BY ts DESC, id DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![cron_id, limit as i64], row_to_run)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 全任务最近历史（CronPanel「最近运行」横切面；ts 降序）。
    pub fn list_recent(vault: &Vault, limit: usize) -> Result<Vec<CronRun>> {
        let conn = vault.connection();
        let mut stmt =
            conn.prepare("SELECT * FROM cron_runs ORDER BY ts DESC, id DESC LIMIT ?1")?;
        let rows = stmt
            .query_map(params![limit as i64], row_to_run)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

fn row_to_job(row: &Row) -> rusqlite::Result<CronJob> {
    let channels_raw: String = row.get("channels")?;
    let channels: Vec<i64> = serde_json::from_str(&channels_raw)
        .map_err(|e| conv_failure(row, "channels", &format!("bad channels json: {e}")))?;
    Ok(CronJob {
        id: row.get("id")?,
        host_id: row.get("host_id")?,
        schedule: row.get("schedule")?,
        script: row.get("script")?,
        channels,
        enabled: row.get::<_, i64>("enabled")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_run(row: &Row) -> rusqlite::Result<CronRun> {
    let status: String = row.get("status")?;
    if !CRON_RUN_STATUSES.contains(&status.as_str()) {
        return Err(conv_failure(
            row,
            "status",
            &format!("unknown status: {status}"),
        ));
    }
    Ok(CronRun {
        id: row.get("id")?,
        cron_id: row.get("cron_id")?,
        status,
        exit_code: row.get("exit_code")?,
        output_digest: row.get("output_digest")?,
        output_path: row.get("output_path")?,
        duration_ms: row.get("duration_ms")?,
        ts: row.get("ts")?,
    })
}

/// 行内列解析失败 → rusqlite 错误（alert_rules conv_failure 同款形态：
/// channels JSON 损坏与 status 集损坏不静默吞掉）。
fn conv_failure(row: &Row, column: &str, msg: &str) -> rusqlite::Error {
    use rusqlite::types::Type;
    let idx = row.as_ref().column_index(column).unwrap_or(0);
    rusqlite::Error::FromSqlConversionFailure(
        idx,
        Type::Text,
        Box::new(VaultError::InvalidInput(msg.to_string())),
    )
}
