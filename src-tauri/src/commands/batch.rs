//! 批量执行命令域（Phase 3 Task 4，B6）：并发池 + 单主机超时 + 取消 +
//! `ottr://batch-result` 逐主机结果事件。
//!
//! 【执行模型裁定（R-1）】exec 独立通道，不走交互 PTY（`monitor_ps`/LANG 探针/
//! shell 集成注入同款先例）——批量命令的输出是结构化结果而非交互流。会话面 =
//! 「已连标签会话复用」：前端把 host_id → 活动标签 rustId 解析后随目标下发
//! （[`super::monitor::session_arc`] 同款会话表查找）；无在册会话的目标**不发起
//! 连接**，resolve 失败 → per-host failed 结果（「未连接」前端可见）。Rust 侧
//! 后台 attach（TOFU/凭据面重建一条 exec 专用连接）量级不成比例，挂账不做。
//!
//! 【生命周期】`batch_exec` 注册 [`CancellationToken`] 进 [`BatchManager`] 并
//! spawn 池任务，**立即返回 batch_id**（结果走事件流，不等全部完成）；
//! `batch_cancel` 摘除令牌——取消语义 = 裁定口径「剩余主机不再发起」：已发起的
//! exec 无中断原语（exec 通道无 kill 路径），等自然完成或单主机超时；排队中的
//! 目标结算 canceled。池收尾 `unregister_if_current`（monitor 同款令牌比对，
//! 防「取消→立刻重发」竞态误摘新批次）。
//!
//! 【参数边界】并发 clamp 1..=32（缺省 5）、超时 clamp 1..=3600s（缺省 30）、
//! 目标数 ≤100、单命令 ≤64KB（防误粘超大脚本；真脚本应走文件/snippet 面）。
//!
//! 【输出摘要】Rust 侧截断：**前 80 行 + 尾 20 行**（合计 ≤100 行参与前端
//! diff，简报「输出大时截断到前 100 行」口径）、单流 64KB 上限（二进制/超长行
//! 防护），`truncated` 标志前端展示「已截断」。UTF-8 lossy（exec 输出编码不保证）。
//!
//! 【测试面】并发池核心 [`run_batch`] 以 [`ExecResolver`] 注入 mock exec
//! （并发上限/超时/取消/失败结算/输出透传，全部零真连接）；真容器端到端在
//! `src-tauri/tests/batch_fixture.rs`（同容器双连 = 两主机）。
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ottr_ssh::ExecOutput;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use super::state::AppState;

/// exec future（手写别名：src-tauri 不直接依赖 futures crate，`Pin<Box<dyn Future>>`
/// 即全部所需——不必要的依赖树面不引入）。
pub type BoxExecFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<ExecOutput, String>> + Send>>;

/// `ottr://batch-result` 事件载荷（serde snake_case，前端 `BatchResult` 同构）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BatchResultEvent {
    pub batch_id: String,
    pub host_id: i64,
    pub name: String,
    pub status: BatchStatus,
    /// 原始 u32 退出码；None = 服务端未回 ExitStatus（异常流，按失败处置时
    /// status 已是 failed；ok 态 None 仅在理论边沿出现，前端显示「—」）。
    pub exit_code: Option<i64>,
    pub stdout: String,
    pub stderr: String,
    /// 输出被摘要截断（行数或字节超限），前端展示「已截断」标记。
    pub truncated: bool,
    pub duration_ms: u64,
    /// failed 时的错误原文（会话缺失/连接死亡/exec 错误）。
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchStatus {
    Ok,
    Failed,
    Timeout,
    Canceled,
}

/// 单主机目标（前端已把模板变量渲染成最终命令串——变量表单是 per-host 的，
/// 同一模板在不同主机可渲染出不同命令，Rust 不再关心模板面）。
#[derive(Debug, Clone, Deserialize)]
pub struct BatchTargetInput {
    pub host_id: i64,
    pub name: String,
    /// 活动标签的 Rust 会话 id；空串/失效 = 未连接（resolve 必败 → per-host
    /// failed 结果，结果表格如实呈现，不发整批命令错误）。
    pub session_id: String,
    pub command: String,
}

/// 单主机执行器（mock 注入面）：target → exec future 或同步失败（会话缺失）。
/// 生产构造见 [`session_resolver`]。
pub type ExecResolver =
    Arc<dyn Fn(&BatchTargetInput) -> Result<BoxExecFuture, String> + Send + Sync>;

/// 结果事件出口（生产 = app.emit；测试 = 收集器）。
pub(crate) type ResultSink = Arc<dyn Fn(BatchResultEvent) + Send + Sync>;

// --- 参数边界（模块文档【参数边界】） ----------------------------------------

pub(crate) const BATCH_DEFAULT_CONCURRENCY: usize = 5;
pub(crate) const BATCH_MAX_CONCURRENCY: usize = 32;
pub(crate) const BATCH_DEFAULT_TIMEOUT_SECS: u64 = 30;
pub(crate) const BATCH_MAX_TIMEOUT_SECS: u64 = 3600;
pub(crate) const BATCH_MAX_TARGETS: usize = 100;
/// 单命令字节上限（防误粘超大脚本——一次粘 10MB 进 100 台主机的表单是事故，
/// 提前在命令域拒绝而不是让 webview→IPC→SSH 链路扛）。
pub(crate) const BATCH_COMMAND_MAX_BYTES: usize = 64 * 1024;

/// 输出摘要：头部保留行数。
const OUTPUT_HEAD_LINES: usize = 80;
/// 输出摘要：尾部保留行数（合计 ≤100，简报 diff 截断口径）。
const OUTPUT_TAIL_LINES: usize = 20;
/// 单流字节上限（stdout / stderr 各自独立计量）。
const OUTPUT_MAX_BYTES: usize = 64 * 1024;

static BATCH_SEQ: AtomicU64 = AtomicU64::new(0);

/// 批次取消令牌注册表（`batch_id` → token；`batch_cancel` 入口）。
/// monitor 的 MonitorManager 同款 owner 形态：register/unregister_if_current
/// 令牌比对，防「取消→立刻重发」竞态误摘新批次。
#[derive(Default)]
pub struct BatchManager {
    runs: Mutex<HashMap<String, CancellationToken>>,
}

impl BatchManager {
    fn register(&self, id: &str, token: CancellationToken) {
        self.runs
            .lock()
            .expect("batches poisoned")
            .insert(id.to_string(), token);
    }

    /// 摘除并取消。返回是否确有在跑批次（重复 cancel 幂等 false）。
    pub(crate) fn cancel(&self, id: &str) -> bool {
        let token = self.runs.lock().expect("batches poisoned").remove(id);
        match token {
            Some(t) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    /// 池任务收尾自摘除：仅当表内仍是**自己的令牌**才摘。
    fn unregister_if_current(&self, id: &str, token: &CancellationToken) {
        let mut runs = self.runs.lock().expect("batches poisoned");
        if runs.get(id).is_some_and(|t| t == token) {
            runs.remove(id);
        }
    }

    #[cfg(test)]
    fn is_running(&self, id: &str) -> bool {
        self.runs.lock().expect("batches poisoned").contains_key(id)
    }
}

/// 生产 resolver：会话表查 `Arc<SshSession>`（monitor_ps 同款）→ exec future。
/// 会话不在表 = 未连接/已断开，同步失败（不发连接）。
fn session_resolver(
    sessions: super::state::SessionMap,
) -> impl Fn(&BatchTargetInput) -> Result<BoxExecFuture, String> {
    move |t: &BatchTargetInput| {
        let session = sessions
            .lock()
            .unwrap()
            .get(&t.session_id)
            .map(|e| Arc::clone(&e.session));
        match session {
            None => Err(format!(
                "no live session for host {} (not connected)",
                t.name
            )),
            Some(session) => {
                let cmd = t.command.clone();
                Ok(Box::pin(async move {
                    session.exec(&cmd).await.map_err(|e| e.to_string())
                }))
            }
        }
    }
}

/// 并发池核心（mock 注入测试面）：
/// * 并发上限 = `Semaphore(concurrency)`（spawn 全量任务、额度放行后才 exec）；
/// * 单主机超时 = `tokio::time::timeout` 包住 exec（超时标 timeout，exec 本身
///   无法中断——远端命令可能仍在跑，语义上同「取消」的边界，如实记录）；
/// * 取消 = 双检查（入队前 + 额度放行后），canceled 结算不发 exec；
/// * 逐主机结果 = 完成即经 mpsc 回主流线程 → `emit` 事件 + 收集返回值。
pub async fn run_batch(
    batch_id: String,
    targets: Vec<BatchTargetInput>,
    resolve: ExecResolver,
    concurrency: usize,
    timeout: Duration,
    cancel: CancellationToken,
    emit: ResultSink,
) -> Vec<BatchResultEvent> {
    let concurrency = concurrency.clamp(1, BATCH_MAX_CONCURRENCY);
    let timeout = Duration::from_secs(timeout.as_secs().clamp(1, BATCH_MAX_TIMEOUT_SECS));
    let permits = Arc::new(Semaphore::new(concurrency));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<BatchResultEvent>();

    for target in targets {
        let permits = Arc::clone(&permits);
        let tx = tx.clone();
        let resolve = Arc::clone(&resolve);
        let cancel = cancel.clone();
        let batch_id = batch_id.clone();
        tauri::async_runtime::spawn(async move {
            // 检查 ①：排队前取消 → 立即结算（不占并发额度）
            if cancel.is_cancelled() {
                let _ = tx.send(settle(
                    &batch_id,
                    &target,
                    BatchStatus::Canceled,
                    None,
                    None,
                    0,
                ));
                return;
            }
            // 占额度（并发上限面）；上限 0 已被 clamp 兜底，信号量不会关闭
            let _permit = permits.acquire_owned().await.expect("semaphore alive");
            // 检查 ②：排队期间被取消 → 不发起
            if cancel.is_cancelled() {
                let _ = tx.send(settle(
                    &batch_id,
                    &target,
                    BatchStatus::Canceled,
                    None,
                    None,
                    0,
                ));
                return;
            }
            let started = Instant::now();
            let exec = match resolve(&target) {
                Ok(f) => f,
                Err(e) => {
                    let _ = tx.send(settle(
                        &batch_id,
                        &target,
                        BatchStatus::Failed,
                        None,
                        Some(e),
                        0,
                    ));
                    return;
                }
            };
            let event = match tokio::time::timeout(timeout, exec).await {
                Err(_) => settle(
                    &batch_id,
                    &target,
                    BatchStatus::Timeout,
                    None,
                    None,
                    elapsed(&started),
                ),
                Ok(Err(e)) => settle(
                    &batch_id,
                    &target,
                    BatchStatus::Failed,
                    None,
                    Some(e),
                    elapsed(&started),
                ),
                Ok(Ok(out)) => {
                    let (stdout, t1) = summarize_output(&out.stdout);
                    let (stderr, t2) = summarize_output(&out.stderr);
                    BatchResultEvent {
                        batch_id,
                        host_id: target.host_id,
                        name: target.name,
                        status: BatchStatus::Ok,
                        exit_code: out.exit_status.map(i64::from),
                        stdout,
                        stderr,
                        truncated: t1 || t2,
                        duration_ms: elapsed(&started),
                        error: None,
                    }
                }
            };
            let _ = tx.send(event);
        });
    }
    drop(tx); // 全部任务发完后通道收口，recv 循环自然退出

    let mut results = Vec::new();
    while let Some(event) = rx.recv().await {
        emit(event.clone());
        results.push(event);
    }
    results
}

fn elapsed(started: &Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// 非输出类结算（canceled / failed / timeout 共用形状）。
fn settle(
    batch_id: &str,
    target: &BatchTargetInput,
    status: BatchStatus,
    exit_code: Option<i64>,
    error: Option<String>,
    duration_ms: u64,
) -> BatchResultEvent {
    BatchResultEvent {
        batch_id: batch_id.to_string(),
        host_id: target.host_id,
        name: target.name.clone(),
        status,
        exit_code,
        stdout: String::new(),
        stderr: String::new(),
        truncated: false,
        duration_ms,
        error,
    }
}

/// 输出摘要（模块文档【输出摘要】）：>100 行 = 前 80 + 尾 20；字节超 64KB
/// 先按字节截（可能尾行残缺，lossy 兜底）。两上限任一命中 → truncated。
fn summarize_output(bytes: &[u8]) -> (String, bool) {
    let byte_capped = bytes.len() > OUTPUT_MAX_BYTES;
    let capped = if byte_capped {
        &bytes[..OUTPUT_MAX_BYTES]
    } else {
        bytes
    };
    let text = String::from_utf8_lossy(capped);
    let lines: Vec<&str> = text.lines().collect();
    if !byte_capped && lines.len() <= OUTPUT_HEAD_LINES + OUTPUT_TAIL_LINES {
        return (lines.join("\n"), false);
    }
    let mut kept: Vec<&str> = lines.iter().take(OUTPUT_HEAD_LINES).copied().collect();
    if lines.len() > OUTPUT_HEAD_LINES + OUTPUT_TAIL_LINES {
        kept.extend(lines[lines.len() - OUTPUT_TAIL_LINES..].iter().copied());
    }
    (kept.join("\n"), true)
}

/// 发起批量执行：校验参数 → 注册批次 → spawn 池任务 → 立即返回 batch_id
/// （结果经 `ottr://batch-result` 逐主机事件流回，前端按 batch_id 归拢）。
#[tauri::command]
pub(crate) async fn batch_exec(
    state: State<'_, AppState>,
    app: AppHandle,
    targets: Vec<BatchTargetInput>,
    concurrency: Option<usize>,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    if targets.is_empty() {
        return Err("batch: no targets".into());
    }
    if targets.len() > BATCH_MAX_TARGETS {
        return Err(format!("batch: too many targets (max {BATCH_MAX_TARGETS})"));
    }
    if let Some(t) = targets
        .iter()
        .find(|t| t.command.len() > BATCH_COMMAND_MAX_BYTES)
    {
        return Err(format!(
            "batch: command for host {} exceeds {} bytes",
            t.name, BATCH_COMMAND_MAX_BYTES
        ));
    }
    let batch_id = format!("batch-{}", BATCH_SEQ.fetch_add(1, Ordering::Relaxed) + 1);
    let token = CancellationToken::new();
    state.batches.register(&batch_id, token.clone());

    let resolve: ExecResolver = Arc::new(session_resolver(Arc::clone(&state.sessions)));
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(BATCH_DEFAULT_TIMEOUT_SECS));
    let concurrency = concurrency.unwrap_or(BATCH_DEFAULT_CONCURRENCY);
    let sink: ResultSink = {
        let app = app.clone();
        let batch_id = batch_id.clone();
        Arc::new(move |event| {
            if let Err(e) = app.emit("ottr://batch-result", &event) {
                eprintln!("[batch:{batch_id}] emit result failed: {e}");
            }
        })
    };
    // 收尾自摘除用的本批令牌（unregister_if_current 比对面）
    let finish_token = token.clone();
    let finish_id = batch_id.clone();
    tauri::async_runtime::spawn(async move {
        let results = run_batch(
            finish_id.clone(),
            targets,
            resolve,
            concurrency,
            timeout,
            token,
            sink,
        )
        .await;
        eprintln!("[batch:{finish_id}] finished: {} results", results.len());
        app.state::<AppState>()
            .batches
            .unregister_if_current(&finish_id, &finish_token);
    });
    Ok(batch_id)
}

/// 取消批次（裁定口径：剩余主机不再发起；在途 exec 等自然完成/超时）。
#[tauri::command]
pub(crate) fn batch_cancel(state: State<'_, AppState>, batch_id: String) -> Result<bool, String> {
    Ok(state.batches.cancel(&batch_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(host_id: i64, name: &str, command: &str) -> BatchTargetInput {
        BatchTargetInput {
            host_id,
            name: name.to_string(),
            session_id: format!("pty-{host_id}"),
            command: command.to_string(),
        }
    }

    /// mock resolver：固定 stdout + 退出码（可按 target 定制）。
    fn ok_resolve(
        f: impl Fn(&BatchTargetInput) -> Result<ExecOutput, String> + Send + Sync + 'static,
    ) -> ExecResolver {
        Arc::new(move |t: &BatchTargetInput| {
            let out = f(t);
            Ok(Box::pin(async move { out }) as BoxExecFuture)
        })
    }

    fn sink_into(cell: &Arc<Mutex<Vec<BatchResultEvent>>>) -> ResultSink {
        let cell = Arc::clone(cell);
        Arc::new(move |event| cell.lock().unwrap().push(event))
    }

    fn sorted(mut events: Vec<BatchResultEvent>) -> Vec<BatchResultEvent> {
        events.sort_by_key(|e| e.host_id);
        events
    }

    #[tokio::test]
    async fn pool_executes_all_and_passes_output() {
        let resolve = ok_resolve(|t| {
            Ok(ExecOutput {
                stdout: format!("out-{} from {}", t.host_id, t.command).into_bytes(),
                stderr: b"warn".to_vec(),
                exit_status: Some(7),
            })
        });
        let events = Arc::new(Mutex::new(Vec::new()));
        let results = run_batch(
            "batch-1".into(),
            vec![target(1, "a", "whoami"), target(2, "b", "id")],
            resolve,
            5,
            Duration::from_secs(5),
            CancellationToken::new(),
            sink_into(&events),
        )
        .await;
        assert_eq!(results.len(), 2);
        let [a, b] = &sorted(results)[..] else {
            panic!("two results")
        };
        assert_eq!(a.status, BatchStatus::Ok);
        assert_eq!(a.exit_code, Some(7));
        assert_eq!(a.stdout, "out-1 from whoami");
        assert_eq!(a.stderr, "warn");
        assert!(!a.truncated);
        assert_eq!(a.name, "a");
        assert_eq!(b.host_id, 2);
        // 事件出口逐主机收到同样多的事件
        assert_eq!(events.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn pool_respects_concurrency_bound() {
        let in_flight = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let max_seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let resolve: ExecResolver = {
            let in_flight = Arc::clone(&in_flight);
            let max_seen = Arc::clone(&max_seen);
            Arc::new(move |_t: &BatchTargetInput| {
                let in_flight = Arc::clone(&in_flight);
                let max_seen = Arc::clone(&max_seen);
                Ok(Box::pin(async move {
                    let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    max_seen.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    Ok(ExecOutput {
                        stdout: vec![],
                        stderr: vec![],
                        exit_status: Some(0),
                    })
                }))
            })
        };
        let targets: Vec<_> = (1..=8).map(|i| target(i, "h", "x")).collect();
        let results = run_batch(
            "batch-2".into(),
            targets,
            resolve,
            3,
            Duration::from_secs(5),
            CancellationToken::new(),
            Arc::new(|_| {}),
        )
        .await;
        assert_eq!(results.len(), 8);
        assert!(
            max_seen.load(Ordering::SeqCst) <= 3,
            "并发上限必须生效: {}",
            max_seen.load(Ordering::SeqCst)
        );
    }

    #[tokio::test]
    async fn pool_timeout_marks_host_timeout() {
        let resolve: ExecResolver = Arc::new(|t: &BatchTargetInput| {
            let slow = t.host_id == 1;
            Ok(Box::pin(async move {
                if slow {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
                Ok(ExecOutput {
                    stdout: b"done".to_vec(),
                    stderr: vec![],
                    exit_status: Some(0),
                })
            }))
        });
        let started = Instant::now();
        let results = run_batch(
            "batch-3".into(),
            vec![target(1, "slow", "sleep"), target(2, "fast", "echo")],
            resolve,
            2,
            Duration::from_millis(80),
            CancellationToken::new(),
            Arc::new(|_| {}),
        )
        .await;
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "超时必须截断等待"
        );
        let [slow, fast] = &sorted(results)[..] else {
            panic!("two results")
        };
        assert_eq!(slow.status, BatchStatus::Timeout);
        assert_eq!(slow.exit_code, None);
        assert!(slow.error.is_none(), "超时不是错误对象，是独立状态");
        assert_eq!(fast.status, BatchStatus::Ok);
        assert_eq!(fast.stdout, "done");
    }

    /// 取消语义：排队中的目标不再发起（exec 调用数不增），在途的自然完成。
    #[tokio::test]
    async fn cancel_skips_queued_targets() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        // host 1 的 exec 挂在 gate 上（模拟在途慢命令）
        let resolve: ExecResolver = {
            let gate = Arc::clone(&gate);
            let calls = Arc::clone(&calls);
            Arc::new(move |_t: &BatchTargetInput| {
                let gate = Arc::clone(&gate);
                let calls = Arc::clone(&calls);
                Ok(Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    // 全部 exec 都挂在 gate 上：并发 1 下同一时刻至多一个在途，
                    // 「calls==1」即「恰有一个主机占着额度阻塞在 exec 里」
                    gate.notified().await;
                    Ok(ExecOutput {
                        stdout: b"ran".to_vec(),
                        stderr: vec![],
                        exit_status: Some(0),
                    })
                }))
            })
        };

        let cancel = CancellationToken::new();
        let run = tauri::async_runtime::spawn(run_batch(
            "batch-4".into(),
            vec![
                target(1, "a", "x"),
                target(2, "b", "x"),
                target(3, "c", "x"),
            ],
            resolve,
            1,
            Duration::from_secs(30),
            cancel.clone(),
            Arc::new(|_| {}),
        ));
        // 等 host 1 真正进 exec（并发 1：其余两个在排队），然后取消
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        cancel.cancel();
        gate.notify_waiters(); // 放行在途主机（排队的从未进 exec，无需唤醒）
        let results = run.await.expect("pool task");
        // 在途的那台自然完成（哪台先抢到额度不 assert——调度序不属契约面），
        // 排队的两台一律 canceled
        let ok = results
            .iter()
            .filter(|e| e.status == BatchStatus::Ok)
            .count();
        let canceled = results
            .iter()
            .filter(|e| e.status == BatchStatus::Canceled)
            .count();
        assert_eq!((ok, canceled), (1, 2), "1 台在途完成 + 2 台排队取消");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "取消后不得再发起 exec");
    }

    #[tokio::test]
    async fn resolve_failure_becomes_failed_result() {
        let resolve: ExecResolver = Arc::new(|t: &BatchTargetInput| {
            if t.host_id == 2 {
                Err("no live session for host b (not connected)".to_string())
            } else {
                Ok(Box::pin(async move {
                    Ok(ExecOutput {
                        stdout: b"ok".to_vec(),
                        stderr: vec![],
                        exit_status: Some(0),
                    })
                }))
            }
        });
        let results = run_batch(
            "batch-5".into(),
            vec![target(1, "a", "x"), target(2, "b", "x")],
            resolve,
            2,
            Duration::from_secs(5),
            CancellationToken::new(),
            Arc::new(|_| {}),
        )
        .await;
        let [a, b] = &sorted(results)[..] else {
            panic!("two results")
        };
        assert_eq!(a.status, BatchStatus::Ok);
        assert_eq!(b.status, BatchStatus::Failed);
        assert!(b.error.as_deref().unwrap().contains("not connected"));
        assert_eq!(b.exit_code, None);
    }

    /// exec 通道错误（连接死亡等）→ failed + 错误原文。
    #[tokio::test]
    async fn exec_error_becomes_failed_with_message() {
        let resolve: ExecResolver = Arc::new(|_t: &BatchTargetInput| {
            Ok(Box::pin(async move { Err("channel closed".to_string()) }))
        });
        let results = run_batch(
            "batch-6".into(),
            vec![target(1, "a", "x")],
            resolve,
            1,
            Duration::from_secs(5),
            CancellationToken::new(),
            Arc::new(|_| {}),
        )
        .await;
        assert_eq!(results[0].status, BatchStatus::Failed);
        assert_eq!(results[0].error.as_deref(), Some("channel closed"));
    }

    #[test]
    fn summarize_keeps_small_output_intact() {
        let (text, truncated) = summarize_output("line1\nline2\n".as_bytes());
        assert_eq!(text, "line1\nline2");
        assert!(!truncated);
        let (text, truncated) = summarize_output(b"");
        assert_eq!(text, "");
        assert!(!truncated);
    }

    #[test]
    fn summarize_truncates_to_head_and_tail_lines() {
        let body: String = (1..=150).map(|i| format!("L{i}\n")).collect();
        let (text, truncated) = summarize_output(body.as_bytes());
        assert!(truncated);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), OUTPUT_HEAD_LINES + OUTPUT_TAIL_LINES);
        assert_eq!(lines[0], "L1");
        assert_eq!(lines[OUTPUT_HEAD_LINES - 1], "L80");
        assert_eq!(
            lines[OUTPUT_HEAD_LINES], "L131",
            "尾部 20 行衔接（150-20+1=131）"
        );
        assert_eq!(lines[lines.len() - 1], "L150");
    }

    #[test]
    fn summarize_byte_cap_marks_truncated() {
        let big = vec![b'x'; OUTPUT_MAX_BYTES * 2];
        let (text, truncated) = summarize_output(&big);
        assert!(truncated);
        assert_eq!(text.len(), OUTPUT_MAX_BYTES, "单行超限按字节截");
        // 99 行但单行超字节上限：行不再裁（≤100 行），truncated 仍为真
        let mut body = String::new();
        for i in 0..99 {
            body.push_str(&format!("L{i}:{}", "y".repeat(800)));
        }
        let (_, truncated) = summarize_output(body.as_bytes());
        assert!(truncated);
    }

    /// 参数 clamp：并发 0/超大、超时 0 → 都收敛到合法区间照常执行。
    #[tokio::test]
    async fn out_of_range_params_are_clamped() {
        let resolve = ok_resolve(|_t| {
            Ok(ExecOutput {
                stdout: b"ok".to_vec(),
                stderr: vec![],
                exit_status: Some(0),
            })
        });
        let results = run_batch(
            "batch-7".into(),
            vec![target(1, "a", "x")],
            resolve,
            0,
            Duration::from_secs(0),
            CancellationToken::new(),
            Arc::new(|_| {}),
        )
        .await;
        assert_eq!(results[0].status, BatchStatus::Ok, "clamp 后照常执行");
    }

    /// manager 语义三件套：register / cancel 幂等 / unregister_if_current。
    #[test]
    fn manager_register_cancel_unregister() {
        let m = BatchManager::default();
        let token = CancellationToken::new();
        m.register("batch-1", token.clone());
        assert!(m.is_running("batch-1"));
        assert!(m.cancel("batch-1"));
        assert!(token.is_cancelled(), "cancel 必须级联取消令牌");
        assert!(!m.cancel("batch-1"), "重复 cancel 幂等 false");
        assert!(!m.is_running("batch-1"));
        // 竞态面：取消→立刻重发，旧批收尾不得误摘新批
        let old = CancellationToken::new();
        m.register("batch-9", old.clone());
        m.cancel("batch-9");
        let fresh = CancellationToken::new();
        m.register("batch-9", fresh.clone());
        m.unregister_if_current("batch-9", &old);
        assert!(m.is_running("batch-9"));
        m.unregister_if_current("batch-9", &fresh);
        assert!(!m.is_running("batch-9"));
    }
}
