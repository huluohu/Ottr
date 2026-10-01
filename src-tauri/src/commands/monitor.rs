//! 监控采集命令域（Phase 3 Task 1 Step 2，B4 上半）：MonitorManager（per-session
//! 采样任务生命周期 owner，ForwardManager 同款 owner 模式）+ monitor_start/stop
//! 命令 + `ottr://monitor` 事件推前端。
//!
//! 【事件通道选型】统一全局事件 `ottr://monitor`、会话 id 内嵌载荷（`id` 字段），
//! 不用 per-session 频道（`ottr://monitor-<id>`）：PTY 合批走 per-session
//! `Channel` 是因为字节洪流需要独立背压面；监控是 0.2Hz 量级的微小 JSON 快照，
//! 全局单监听 + zustand store 按 id 分桶（`ottr://encoding-hint` 同款模式）
//! 生命周期更简单（前端一次 initSessionEvents 式接线，无逐会话订阅/退订竞态）。
//!
//! 【采样任务生命周期】（简报：per-session 采样任务挂会话生命周期）：
//! * 挂载：`monitor_start`（前端在 attach 成功后按 host.monitor_enabled 调用，
//!   仅标签根会话）——注册 [`MonitorGuard`] 进表并 spawn [`run_sampling`]；
//! * 解挂三路：① 会话转发循环退出（drop_session/对端断开）→
//!   [`MonitorManager::session_down`]（session.rs 收尾挂钩）；
//!   ② 用户显式 `monitor_stop`；③ 循环自保底——exec 连续失败超限
//!   （会话已死不空转）或远端非 Linux（Unsupported 短路）自行退出并落终态事件；
//!   guard Drop 即 cancel（ottr-monitor::MonitorGuard）。
//! * 幂等：同会话重复 start 拒绝（表内已有 guard）；重启竞态（start→stop→旧
//!   任务收尾）按令牌比对摘除，不误删新实例。
//!
//! 【抖动/防惊群】间隔 = settings `monitor.interval_secs`（默认 5s，
//! [`crate::security::monitor_interval_from`] 校验收敛）；±10% 每轮抖动 +
//! 会话 id 相位错开由 ottr-monitor::sched 承担（golden 测试在 crate 内）。
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use ottr_monitor::{collect, run_sampling, LoopConfig, Metrics, MonitorGuard, SamplingEnd};
use ottr_vault::Settings;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

use super::state::AppState;
use crate::security::{monitor_interval_from, SETTING_MONITOR_INTERVAL};
use crate::vault::VaultState;

/// `ottr://monitor` 事件载荷（serde snake_case）。`status`：
/// * `sample` —— 差分成功的新指标（`metrics` 必在）；
/// * `unsupported` —— 远端非 Linux（无 /proc），采样已短路终止；
/// * `stopped` —— exec 连续失败超限（会话已死），采样已终止。
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct MonitorEventPayload {
    /// Rust 会话 id（pty-N；前端按 session.rustId 反查标签）。
    id: String,
    status: MonitorEventStatus,
    metrics: Option<Metrics>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum MonitorEventStatus {
    Sample,
    Unsupported,
    Stopped,
}

/// 在册采样任务句柄（Drop 即 cancel——会话表摘除/显式停止统一语义）。
pub(crate) struct MonitorRun(MonitorGuard);

/// 采样任务生命周期 owner（Tauri 全局唯一，挂在 AppState）。
/// 键 = Rust 会话 id（pty-N）。
#[derive(Default)]
pub(crate) struct MonitorManager {
    runs: Mutex<HashMap<String, MonitorRun>>,
}

impl MonitorManager {
    /// 登记（幂等：已有在跑实例返回 false，调用方早退）。
    fn register(&self, id: &str, token: CancellationToken) -> bool {
        let mut runs = self.runs.lock().expect("monitors poisoned");
        if runs.contains_key(id) {
            return false;
        }
        runs.insert(id.to_string(), MonitorRun(MonitorGuard(token)));
        true
    }

    /// 显式停止：摘除（Drop 即 cancel）。返回是否确有在跑实例。
    pub(crate) fn stop(&self, id: &str) -> bool {
        self.runs
            .lock()
            .expect("monitors poisoned")
            .remove(id)
            .is_some()
    }

    /// 会话消亡（session.rs 转发循环收尾同点调用）：该会话采样任务摘除即停。
    /// 返回处理的条数（0/1）。
    pub(crate) fn session_down(&self, id: &str) -> usize {
        usize::from(self.stop(id))
    }

    /// 任务自摘除（循环退出收尾）：仅当表内仍是**自己的令牌**才摘——
    /// start→stop→start 重启竞态下不误删新实例。
    fn unregister_if_current(&self, id: &str, token: &CancellationToken) {
        let mut runs = self.runs.lock().expect("monitors poisoned");
        if runs.get(id).is_some_and(|run| (run.0).0 == *token) {
            runs.remove(id);
        }
    }

    #[cfg(test)]
    fn is_running(&self, id: &str) -> bool {
        self.runs
            .lock()
            .expect("monitors poisoned")
            .contains_key(id)
    }
}

/// 启动会话的监控采样（attach 成功后由前端按 host.monitor_enabled 调用；
/// 仅标签根会话——分屏 pane 与根同主机，多份采样是纯浪费）。
/// 已在跑幂等成功；会话不存在显式报错。
#[tauri::command]
pub(crate) async fn monitor_start(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    let session = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&id).map(|e| Arc::clone(&e.session))
    }
    .ok_or_else(|| format!("no such session: {id}"))?;

    // 采样间隔现读 settings（缺省 5s，越界收敛；改配置对下一次 start 生效）
    let interval = monitor_interval_from(
        Settings::get_u64(&vault.0, SETTING_MONITOR_INTERVAL).map_err(|e| e.to_string())?,
    );

    let token = CancellationToken::new();
    if !state.monitors.register(&id, token.clone()) {
        return Ok(()); // 幂等：已在采样
    }
    // 收尾自摘除用的本任务令牌（与表内 guard 的令牌比对，防重启竞态误摘）
    let finish_token = token.clone();
    let emit_app = app.clone();
    let emit_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let end = run_sampling(
            &id,
            LoopConfig::production(interval),
            token,
            // 每轮现取 Arc 克隆（FnMut 返回 Future 借用约束的常规解法；Arc 廉价）
            move || {
                let session = Arc::clone(&session);
                async move { collect(&session).await }
            },
            move |metrics| {
                let app = emit_app.clone();
                let id = emit_id.clone();
                async move {
                    if let Err(e) = app.emit(
                        "ottr://monitor",
                        MonitorEventPayload {
                            id,
                            status: MonitorEventStatus::Sample,
                            metrics: Some(metrics),
                        },
                    ) {
                        eprintln!("[monitor] emit sample failed: {e}");
                    }
                }
            },
        )
        .await;
        // 终态落账（Cancelled = 会话/显式停止收尾，前端另有 session-closed 链）
        match &end {
            SamplingEnd::Cancelled => {}
            SamplingEnd::Unsupported(d) => {
                eprintln!("[monitor:{id}] sampling ended: unsupported ({d})");
                emit_terminal(&app, &id, MonitorEventStatus::Unsupported);
            }
            SamplingEnd::ExcessiveFailures => {
                eprintln!("[monitor:{id}] sampling ended: exec failed repeatedly");
                emit_terminal(&app, &id, MonitorEventStatus::Stopped);
            }
        }
        app.state::<AppState>()
            .monitors
            .unregister_if_current(&id, &finish_token);
    });
    Ok(())
}

/// 终态事件（`metrics: None`，前端按 status 切降级面）。
fn emit_terminal(app: &AppHandle, id: &str, status: MonitorEventStatus) {
    if let Err(e) = app.emit(
        "ottr://monitor",
        MonitorEventPayload {
            id: id.to_string(),
            status,
            metrics: None,
        },
    ) {
        eprintln!("[monitor:{id}] emit terminal status failed: {e}");
    }
}

/// 停止会话的监控采样（用户显式关闭；会话消亡路径走 session_down）。
#[tauri::command]
pub(crate) fn monitor_stop(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.monitors.stop(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// owner 语义三件套：register 幂等 / stop 摘除即停 / session_down 收敛。
    #[test]
    fn manager_register_stop_session_down() {
        let m = MonitorManager::default();
        assert!(!m.is_running("pty-1"));
        assert!(m.register("pty-1", CancellationToken::new()));
        assert!(
            !m.register("pty-1", CancellationToken::new()),
            "重复 register 拒绝"
        );
        assert!(m.is_running("pty-1"));
        assert!(m.stop("pty-1"), "stop 摘除在册实例");
        assert!(!m.stop("pty-1"), "重复 stop 幂等 false");
        assert!(m.register("pty-2", CancellationToken::new()));
        assert_eq!(m.session_down("pty-2"), 1);
        assert_eq!(m.session_down("pty-2"), 0, "session_down 幂等");
        assert_eq!(m.session_down("pty-404"), 0);
    }

    /// unregister_if_current：旧任务收尾不得误摘重启后的新实例。
    #[test]
    fn unregister_only_when_token_is_current() {
        let m = MonitorManager::default();
        let old = CancellationToken::new();
        assert!(m.register("pty-1", old.clone()));
        m.stop("pty-1"); // 用户 stop → 重启
        let fresh = CancellationToken::new();
        assert!(m.register("pty-1", fresh.clone()));
        // 旧循环任务此刻才收尾：令牌已不是表内的，不误删
        m.unregister_if_current("pty-1", &old);
        assert!(m.is_running("pty-1"));
        // 新循环任务自己收尾：正常摘除
        m.unregister_if_current("pty-1", &fresh);
        assert!(!m.is_running("pty-1"));
    }

    /// guard Drop 即停（owner 模式的存在性证明）：摘除运行项即触发取消。
    #[test]
    fn removing_run_cancels_token() {
        let m = MonitorManager::default();
        let token = CancellationToken::new();
        assert!(m.register("pty-1", token.clone()));
        assert!(!token.is_cancelled());
        m.stop("pty-1"); // MonitorRun/Guard Drop → cancel
        assert!(token.is_cancelled(), "摘除必须级联取消（会话断开即停）");
    }
}
