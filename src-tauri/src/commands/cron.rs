//! cron 定时任务命令域（Phase 4 Task 1，Phase 3 缺口① + 终审风险#2 清偿）：
//! 调度器 spawn 点 + cj_* 命令面 + `ottr://cron-run` 事件。
//!
//! # 引擎宿主裁定（本模块是裁定的装配点；语义论证见 ottr-monitor::cron）
//!
//! [`spawn_cron_scheduler`] 在 **vault 就绪后**（lib.rs，hostkey_audit 同款
//! 挂点）起一个进程级调度循环——跑在 Rust tokio 运行时上，与 webview 生命
//! 周期**解耦**：
//! * 关窗到托盘（`menu::on_close_requested` 隐藏主窗）→ webview 隐藏但本循环
//!   照跑（终审「关窗后是否照跑」的肯定面——真窗实验见 task-1-report §6）；
//! * 通知触发只 emit `ottr://cron-run` 事件，落库/系统通知/外部渠道分发都在
//!   TS 管线（`src/cron/events.ts` → `notify(kind=cron)`）——隐藏的 webview
//!   仍存活，管线照走（同事件在库表的通知行可复核「关窗期间通知照发」）；
//! * **真退出**（quit_app / 菜单退出）→ 进程没了，调度随停——「App 退出即停」
//!   是产品语义（cron 不是系统级守护，不写 crontab），文档明示；
//! * 会话解析：任务按 host_id 找**在册会话**（SessionEntry.host_id，复用会话
//!   exec 通道先例）——会话不在 → 本轮标 **missed**（如实入库，**不自动连接**，
//!   简报裁定 #3；凭据/TOFU 面的后台重建量级不成比例，batch 执行模型同款裁定）。
//!
//! # 锁定语义
//!
//! cron_jobs/cron_runs 皆明文面（无 *_enc 列）：调度循环直读直写存储层（不经
//! 命令门卫）——主密码模式锁定态下任务照跑（与「App 开着就跑」一致；通知
//! 落库同为明文面）。cj_list/create/update/delete 过 `ensure_unlocked` 门卫
//! （配置面与 alert_rules 同款）；cj_runs / cj_run_output 是历史读面（
//! notify_list / recording_list 同款豁免）。
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use ottr_monitor::{
    run_cron_scheduler, BoxedCronExec, CronClock, CronExecOutput, CronExecResolver, CronExpr,
    CronJobView, CronJobsProvider, CronLoopConfig, CronRunRecord, CronRunSink, CronRunStatus,
};
use ottr_ssh::SshSession;
use ottr_vault::{CronJob, CronJobInput, CronJobs, CronRun, CronRunInput, CronRuns};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

use super::state::AppState;
use crate::vault::VaultState;

/// `ottr://cron-run` 事件载荷（serde snake_case，前端 `CronRunEvent` 同构）。
/// channel_ids 供外部渠道订阅路由（spec §7③：cron_jobs.channels）。
#[derive(Debug, Clone, Serialize)]
pub struct CronRunEvent {
    pub run_id: i64,
    pub cron_id: i64,
    pub host_id: i64,
    pub status: CronRunStatus,
    pub exit_code: Option<i64>,
    pub duration_ms: u64,
    pub ts: i64,
    pub output_digest: Option<String>,
    pub truncated: bool,
    /// missed/failed 的错误原文（会话缺失 / 非零退出 / 通道错误）。
    pub error: Option<String>,
    pub channel_ids: Vec<i64>,
}

/// 输出 sidecar 目录名（app_data_dir 下；正文不入库——0016 迁移文件头）。
pub(crate) const CRON_OUTPUT_DIR: &str = "cron-runs";

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// host_id → 在册会话（SessionEntry.host_id 扫描；batch 的 session_resolver
/// Rust 侧等价物——「已连标签复用」同一执行模型）。多个会话同主机时取第一个
/// （表序即注册序；exec 通道彼此独立，无状态冲突面）。
pub(crate) fn session_for_host(state: &AppHandle, host_id: i64) -> Option<Arc<SshSession>> {
    let app_state = state.state::<AppState>();
    let sessions = app_state.sessions.lock().unwrap();
    sessions
        .values()
        .find(|e| e.host_id == Some(host_id))
        .map(|e| Arc::clone(&e.session))
}

/// 单轮结果 → 持久化 + 事件（调度 sink 与 cj_trigger 共用的收尾路径）：
/// ① cron_runs 落行（digest 随行）→ ② 非空输出写 sidecar 文件并回填
/// output_path → ③ emit `ottr://cron-run`。vault 不可用（init 窗口期）→
/// 打日志丢弃本轮（调度器活过初始化窗口，下一轮照常）。
/// 返回落库的 run id（vault 不可用/落库失败 → None，事件不发）。
fn persist_and_emit(
    app: &AppHandle,
    record: CronRunRecord,
    host_id: i64,
    channel_ids: Vec<i64>,
) -> Option<i64> {
    let Some(state) = app.try_state::<VaultState>() else {
        eprintln!("[cron:{}] vault not ready; run dropped", record.cron_id);
        return None;
    };
    let vault = state.0.clone();
    // digest 对截断后的输出算（完整性对账面；正文在 sidecar）
    let digest = if record.output.is_empty() {
        None
    } else {
        use sha2::Digest;
        Some(format!(
            "{:x}",
            sha2::Sha256::digest(record.output.as_bytes())
        ))
    };
    let ts = if record.ts > 0 { record.ts } else { now_secs() };
    let row = match CronRuns::insert(
        &vault,
        &CronRunInput {
            cron_id: record.cron_id,
            status: record_status_str(record.status),
            exit_code: record.exit_code,
            output_digest: digest.clone(),
            output_path: None,
            duration_ms: record.duration_ms as i64,
            ts,
        },
    ) {
        Ok(row) => row,
        Err(e) => {
            // 任务刚被删的竞态等：显式浮出不静默（本轮历史丢失如实记日志）
            eprintln!("[cron:{}] persist run failed: {e}", record.cron_id);
            return None;
        }
    };
    // sidecar：非空输出才写（文件名含 run id——插入后才有，回填路径）
    let output_path = if record.output.is_empty() {
        None
    } else {
        write_sidecar(app, record.cron_id, row.id, record.output.as_bytes())
            .map_err(|e| eprintln!("[cron:{}] sidecar write failed: {e}", record.cron_id))
            .ok()
    };
    if let Some(path) = &output_path {
        if let Err(e) = CronRuns::attach_output(&vault, row.id, path) {
            eprintln!("[cron:{}] attach output path failed: {e}", record.cron_id);
        }
    }
    let event = CronRunEvent {
        run_id: row.id,
        cron_id: record.cron_id,
        host_id,
        status: record.status,
        exit_code: record.exit_code,
        duration_ms: record.duration_ms,
        ts,
        output_digest: digest,
        truncated: record.truncated,
        error: record.error,
        channel_ids,
    };
    if let Err(e) = app.emit("ottr://cron-run", &event) {
        eprintln!("[cron:{}] emit run event failed: {e}", record.cron_id);
    }
    Some(row.id)
}

fn record_status_str(s: CronRunStatus) -> String {
    match s {
        CronRunStatus::Ok => "ok".into(),
        CronRunStatus::Failed => "failed".into(),
        CronRunStatus::Timeout => "timeout".into(),
        CronRunStatus::Missed => "missed".into(),
    }
}

/// sidecar 写入：`{app_data_dir}/cron-runs/{cron_id}-{run_id}.log`。
fn write_sidecar(
    app: &AppHandle,
    cron_id: i64,
    run_id: i64,
    bytes: &[u8],
) -> Result<String, String> {
    let dir = output_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create cron-runs dir: {e}"))?;
    let path = dir.join(format!("{cron_id}-{run_id}.log"));
    std::fs::write(&path, bytes).map_err(|e| format!("write sidecar: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// sidecar 目录绝对路径（路径守卫用 canonical 形态比对）。
fn output_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(base.join(CRON_OUTPUT_DIR))
}

/// 调度器装配（vault 就绪后调一次；进程生命周期 owner——无需 guard，
/// 进程退出即停是裁定语义的一部分）。
pub fn spawn_cron_scheduler(app: AppHandle) {
    let config = CronLoopConfig::production();
    let cancel = CancellationToken::new();
    let clock: CronClock = Arc::new(|| now_secs());

    // 任务表快照：每 tick 全量读（明文面——锁定态照读；vault 未就绪 = 空表）
    let jobs_app = app.clone();
    let jobs: CronJobsProvider = Arc::new(move || {
        let Some(state) = jobs_app.try_state::<VaultState>() else {
            return Vec::new();
        };
        CronJobs::list(&state.0)
            .unwrap_or_default()
            .into_iter()
            .map(|j| CronJobView {
                id: j.id,
                host_id: j.host_id,
                schedule: j.schedule,
                enabled: j.enabled,
            })
            .collect()
    });

    // exec resolver：host_id → 在册会话；脚本现读任务行（任务刚删 → missed）
    let resolver_app = app.clone();
    let exec: CronExecResolver = Arc::new(move |job: &CronJobView| {
        let session = session_for_host(&resolver_app, job.host_id)
            .ok_or_else(|| format!("no live session for host {} (not connected)", job.host_id))?;
        let script = {
            let state = resolver_app.state::<VaultState>();
            CronJobs::get(&state.0, job.id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("job {} deleted", job.id))?
                .script
        };
        Ok(Box::pin(async move {
            let out = session.exec(&script).await.map_err(|e| e.to_string())?;
            Ok(CronExecOutput {
                exit_code: out.exit_status.map(i64::from),
                stdout: out.stdout,
                stderr: out.stderr,
            })
        }) as BoxedCronExec)
    });

    // 结果 sink：落库 + sidecar + 事件（core 回调线程面——阻塞写很小，直调）
    let sink_app = app.clone();
    let sink: CronRunSink = Arc::new(move |record: CronRunRecord| {
        // host_id/channels 需要任务行——刚删的任务记录尽力归档（host_id 取 0）
        let (host_id, channel_ids) = {
            let state = sink_app.try_state::<VaultState>();
            match state.map(|s| CronJobs::get(&s.0, record.cron_id)) {
                Some(Ok(Some(job))) => (job.host_id, job.channels),
                _ => (0, Vec::new()),
            }
        };
        persist_and_emit(&sink_app, record, host_id, channel_ids);
    });

    tauri::async_runtime::spawn(async move {
        // 进程生命周期任务：终态只有取消一路（现无取消入口——宿主=进程），
        // 返回值无消费面；循环自身带心跳/限时兜底。
        let _ = run_cron_scheduler(cancel, config, clock, jobs, exec, sink).await;
    });
}

// ---------------------------------------------------------------------------
// 命令面
// ---------------------------------------------------------------------------

type CmdResult<T> = Result<T, String>;

fn ensure_unlocked(vault: &VaultState) -> CmdResult<()> {
    vault.0.ensure_unlocked().map_err(|e| e.to_string())
}

/// schedule 语义校验（五段式；存储层只做长度护栏，这里是解析器关卡）。
fn validate_schedule(schedule: &str) -> CmdResult<()> {
    CronExpr::parse(schedule).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn cj_list(state: State<'_, VaultState>) -> CmdResult<Vec<CronJob>> {
    ensure_unlocked(&state)?;
    CronJobs::list(&state.0).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn cj_create(state: State<'_, VaultState>, input: CronJobInput) -> CmdResult<CronJob> {
    ensure_unlocked(&state)?;
    validate_schedule(&input.schedule)?;
    CronJobs::create(&state.0, &input).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn cj_update(
    state: State<'_, VaultState>,
    id: i64,
    input: CronJobInput,
) -> CmdResult<CronJob> {
    ensure_unlocked(&state)?;
    validate_schedule(&input.schedule)?;
    CronJobs::update(&state.0, id, &input).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn cj_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&state)?;
    CronJobs::delete(&state.0, id).map_err(|e| e.to_string())
}

/// 运行历史（某任务最近 `limit` 条；明文读面，无门卫——notify_list 同款）。
#[tauri::command]
pub(crate) fn cj_runs(
    state: State<'_, VaultState>,
    cron_id: i64,
    limit: u32,
) -> CmdResult<Vec<CronRun>> {
    CronRuns::list_for_job(&state.0, cron_id, limit.clamp(1, 200) as usize)
        .map_err(|e| e.to_string())
}

/// 下次触发时刻（UI 预览面：schedule 输入实时「下次运行」；解析失败 → Err）。
#[tauri::command]
pub(crate) fn cj_next_fire(schedule: String, after_secs: Option<i64>) -> CmdResult<Option<i64>> {
    let expr = CronExpr::parse(&schedule).map_err(|e| e.to_string())?;
    Ok(expr.next_after(after_secs.unwrap_or_else(now_secs)))
}

/// 手动触发一轮（CronPanel「立即运行」）：绕过调度表直跑一次，同步等结果
/// （单轮有 exec_timeout 兜底，UI 不悬挂）；历史与事件走同一收尾路径。
#[tauri::command]
pub(crate) async fn cj_trigger(
    app: AppHandle,
    state: State<'_, VaultState>,
    id: i64,
) -> CmdResult<CronRunEvent> {
    let job = CronJobs::get(&state.0, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no such cron job: {id}"))?;
    let started = Instant::now();
    let ts = now_secs();
    let record = match session_for_host(&app, job.host_id) {
        None => CronRunRecord {
            cron_id: job.id,
            status: CronRunStatus::Missed,
            exit_code: None,
            output: String::new(),
            truncated: false,
            duration_ms: 0,
            ts,
            error: Some(format!(
                "no live session for host {} (not connected)",
                job.host_id
            )),
        },
        Some(session) => {
            let script = job.script.clone();
            let exec = async move {
                let out = session.exec(&script).await.map_err(|e| e.to_string())?;
                Ok(CronExecOutput {
                    exit_code: out.exit_status.map(i64::from),
                    stdout: out.stdout,
                    stderr: out.stderr,
                })
            };
            // 手动触发限时 = 生产单轮限时（CronLoopConfig::production）
            match tokio::time::timeout(CronLoopConfig::production().exec_timeout, exec).await {
                Err(_) => CronRunRecord {
                    cron_id: job.id,
                    status: CronRunStatus::Timeout,
                    exit_code: None,
                    output: String::new(),
                    truncated: false,
                    duration_ms: elapsed_ms(&started),
                    ts,
                    error: None,
                },
                Ok(Err(e)) => CronRunRecord {
                    cron_id: job.id,
                    status: CronRunStatus::Failed,
                    exit_code: None,
                    output: String::new(),
                    truncated: false,
                    duration_ms: elapsed_ms(&started),
                    ts,
                    error: Some(e),
                },
                Ok(Ok(out)) => cron_settle_from_output(job.id, ts, &started, out),
            }
        }
    };
    let run_id =
        persist_and_emit(&app, record.clone(), job.host_id, job.channels.clone()).unwrap_or(0);
    Ok(CronRunEvent {
        run_id,
        cron_id: record.cron_id,
        host_id: job.host_id,
        status: record.status,
        exit_code: record.exit_code,
        duration_ms: record.duration_ms,
        ts: record.ts,
        output_digest: record_digest_hint(&record),
        truncated: record.truncated,
        error: record.error,
        channel_ids: job.channels,
    })
}

fn elapsed_ms(started: &Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// exec 输出 → 记录（与 core settle 同一状态判定面；trigger 路径的复刻——
/// core 的 settle 不出 crate，此处按同一规则判定并截断）。
fn cron_settle_from_output(
    cron_id: i64,
    ts: i64,
    started: &Instant,
    out: CronExecOutput,
) -> CronRunRecord {
    let cap = CronLoopConfig::production().output_cap;
    let mut bytes = out.stdout.clone();
    if !out.stderr.is_empty() {
        if !bytes.is_empty() {
            bytes.extend_from_slice(b"\n[stderr]\n");
        }
        bytes.extend_from_slice(&out.stderr);
    }
    let truncated = bytes.len() > cap;
    if truncated {
        bytes.truncate(cap);
    }
    let (status, error, exit_code) = match out.exit_code {
        Some(0) => (CronRunStatus::Ok, None, Some(0)),
        Some(n) => (
            CronRunStatus::Failed,
            Some(format!("exit code {n}")),
            Some(i64::from(n)),
        ),
        None => (
            CronRunStatus::Failed,
            Some("remote closed without exit status".into()),
            None,
        ),
    };
    CronRunRecord {
        cron_id,
        status,
        exit_code,
        output: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
        duration_ms: elapsed_ms(started),
        ts,
        error,
    }
}

fn record_digest_hint(record: &CronRunRecord) -> Option<String> {
    use sha2::Digest;
    if record.output.is_empty() {
        None
    } else {
        Some(format!(
            "{:x}",
            sha2::Sha256::digest(record.output.as_bytes())
        ))
    }
}

/// 读输出正文（历史行 → sidecar 文本）：路径必须在 cron-runs 目录内
/// （canonical 比对——webview 不可达任意文件；spike_report_file 教训）。
#[tauri::command]
pub(crate) fn cj_run_output(app: AppHandle, path: String) -> CmdResult<String> {
    let dir = output_dir(&app)?;
    let claimed = std::path::PathBuf::from(&path);
    let dir_canon = dir
        .canonicalize()
        .map_err(|e| format!("cron-runs dir: {e}"))?;
    let claimed_canon = claimed
        .canonicalize()
        .map_err(|e| format!("output file: {e}"))?;
    if !claimed_canon.starts_with(&dir_canon) {
        return Err("output path outside cron-runs dir".into());
    }
    std::fs::read_to_string(&claimed_canon).map_err(|e| format!("read output: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 状态判定单点（cron_settle_from_output 与 core settle 同规则的面）：
    /// 0=ok / 非零=failed / 无退出码=failed。真链路由 core settle 与本函数
    /// 分别覆盖（core 单测在 ottr-monitor；此处钉 trigger 路径）。
    #[test]
    fn trigger_settle_maps_exit_codes() {
        let started = Instant::now();
        let r = cron_settle_from_output(
            1,
            100,
            &started,
            CronExecOutput {
                exit_code: Some(0),
                stdout: b"hello".to_vec(),
                stderr: vec![],
            },
        );
        assert_eq!(r.status, CronRunStatus::Ok);
        assert_eq!(r.output, "hello");
        assert_eq!(r.error, None);
        let r = cron_settle_from_output(
            1,
            100,
            &started,
            CronExecOutput {
                exit_code: Some(2),
                stdout: vec![],
                stderr: b"boom".to_vec(),
            },
        );
        assert_eq!(r.status, CronRunStatus::Failed);
        assert_eq!(r.exit_code, Some(2));
        assert_eq!(
            r.output, "boom",
            "空 stdout 时 stderr 直接追加（core 同口径）"
        );
        let r = cron_settle_from_output(
            1,
            100,
            &started,
            CronExecOutput {
                exit_code: None,
                stdout: vec![],
                stderr: vec![],
            },
        );
        assert_eq!(r.status, CronRunStatus::Failed);
        assert!(r.error.as_deref().unwrap().contains("exit status"));
    }

    /// 输出截断护栏（trigger 路径与 core 同 cap）。
    #[test]
    fn trigger_settle_truncates_output() {
        let started = Instant::now();
        let big = vec![b'x'; CronLoopConfig::production().output_cap + 1];
        let r = cron_settle_from_output(
            1,
            100,
            &started,
            CronExecOutput {
                exit_code: Some(0),
                stdout: big,
                stderr: vec![],
            },
        );
        assert!(r.truncated);
        assert_eq!(r.output.len(), CronLoopConfig::production().output_cap);
    }

    /// validate_schedule：语义关卡在命令层（存储层不是解析器）。
    #[test]
    fn validate_schedule_rejects_bad_expressions() {
        assert!(validate_schedule("* * * * *").is_ok());
        assert!(validate_schedule("*/5 9-17 * * 1-5").is_ok());
        assert!(validate_schedule("60 * * * *").is_err());
        assert!(validate_schedule("* * * *").is_err());
        assert!(validate_schedule("garbage").is_err());
    }
}
