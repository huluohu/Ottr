//! 端口转发命令域（Phase 2 Task 1，B7 上半）：ForwardManager（每会话转发生命
//! 周期 owner）+ port_forwards CRUD 命令 + 面板取数面 + 会话断线/重连挂钩。
//!
//! 分层（沿 Task 0 结构）：
//! * `ottr_ssh::forward`（crates/ottr-ssh/src/forward.rs）= 三型转发的运行核
//!   （监听/SOCKS5/泵/字节计数/单实例状态机）；本模块 = 命令域所有者：
//!   * [`ForwardManager`]：`port_forward 行 id → ForwardRun`（取消令牌 + 共享
//!     状态快照 + 归属会话/主机）注册表。按行 id 单实例——同主机多标签时转发
//!     跑在最近一次启动/恢复所用的会话上（pf_start 换绑）。
//!   * 会话生命周期挂钩：`attach_host_session` 成功 → [`on_session_up`]（启动
//!     该主机 enabled 的转发）；会话转发循环退出（`ottr://session-closed` 同源
//!     路径）→ [`ForwardManager::session_down`]——auto_reconnect 行标记 Error
//!     并保留（面板显示断灯），非 auto_reconnect 行直接移除（stopped 语义）。
//!     重连成功再走 on_session_up 时跳过 skip 表中的行（=「不自动恢复」，用户
//!     手动 pf_start 即清除）。
//! * [`PortForwards`]（ottr-vault）= 存储层 CRUD；本模块命令只做门卫/映射/装配。
//!
//! 状态机（`ottr_ssh::ForwardState`）：starting → active | error；pf_stop /
//! 任务收尾 → stopped（不覆盖 error——会话断开先标 error 再取消）。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tauri::State;
use tokio_util::sync::CancellationToken;

use ottr_ssh::{
    ForwardKind, ForwardSpec, ForwardState, ForwardStats, ForwardStatsSnapshot,
    RemoteForwardRouter, SshSession,
};
use ottr_vault::{
    ForwardKind as VaultForwardKind, PortForward, PortForwardInput, PortForwards, Vault,
};

use super::state::{AppState, SessionMap};
use crate::vault::{ensure_unlocked, CmdResult, VaultState};

// ---------------------------------------------------------------------------
// ForwardManager：行 id → 运行实例注册表
// ---------------------------------------------------------------------------

/// 一条在册转发（运行实例或已终结的错误留痕）。
struct ForwardRun {
    /// 归属会话（Rust 会话 id，pty-N）。
    session_id: String,
    host_id: i64,
    /// vault 行的 auto_reconnect（断线收尾按它决定留痕/摘除）。
    auto_reconnect: bool,
    /// 取消令牌：pf_stop / session_down 触发；任务收尾自会退出。
    cancel: CancellationToken,
    /// 共享状态（字节计数/状态机）——任务与 Manager 各持一份 Arc。
    stats: Arc<ForwardStats>,
}

/// 转发生命周期 owner（Tauri 全局唯一，挂在 AppState）。
/// 键 = port_forwards 行 id（跨重连稳定）。
#[derive(Default)]
pub struct ForwardManager {
    runs: Mutex<HashMap<i64, ForwardRun>>,
    /// auto_reconnect=false 且被会话断开摘除的行：重连恢复时跳过，
    /// 用户显式 pf_start / pf_set_enabled(true) / pf_create 时清除。
    skips: Mutex<HashSet<i64>>,
}

impl ForwardManager {
    /// 启动（或换绑重启）一条转发。已在跑的同 id 实例先取消（pf_start 幂等/
    /// 换会话语义）。启动失败不抛——错误落进运行留痕（面板显示 error 灯 +
    /// 消息），返回快照给调用方打点。
    pub async fn start(
        &self,
        row_id: i64,
        host_id: i64,
        session_id: &str,
        auto_reconnect: bool,
        spec: ForwardSpec,
        session: Arc<SshSession>,
        router: RemoteForwardRouter,
    ) -> ForwardStatsSnapshot {
        // 幂等：旧实例取消（其任务随令牌自行退出；注册表项立即被替换）。
        if let Some(old) = self.runs.lock().expect("forwards poisoned").get(&row_id) {
            old.cancel.cancel();
        }
        self.skips
            .lock()
            .expect("forwards poisoned")
            .remove(&row_id);

        let cancel = CancellationToken::new();
        let stats = ForwardStats::shared();
        let outcome = ottr_ssh::forward::start_forward(
            Arc::clone(&session),
            &router,
            spec.clone(),
            Arc::clone(&stats),
            cancel.clone(),
        )
        .await;
        // JoinHandle 即刻 detach：任务退出由令牌/错误驱动，Manager 不阻塞等待
        // （断连收尾毫秒级；错误路径下 stats 已带终态，无泄漏面）。
        if let Err(e) = &outcome {
            // 监听/登记失败：start_forward 已把 Error 落进 stats；此处显式留痕
            // ——错误状态也要在面板可见，不能无声无息。
            stats.set_error(e.to_string());
        }
        self.runs.lock().expect("forwards poisoned").insert(
            row_id,
            ForwardRun {
                session_id: session_id.to_string(),
                host_id,
                auto_reconnect,
                cancel,
                stats: Arc::clone(&stats),
            },
        );
        self.snapshot(row_id).expect("run 刚插入必可见")
    }

    /// 用户停止：取消 + 摘除（面板此后显示 stopped——行 enabled=false 或无
    /// runtime 记录）。返回是否确有在跑实例。
    pub fn stop(&self, row_id: i64) -> bool {
        match self.runs.lock().expect("forwards poisoned").remove(&row_id) {
            Some(run) => {
                run.cancel.cancel();
                true
            }
            None => false,
        }
    }

    /// 会话消亡（`ottr://session-closed` 同源收尾路径调用）：该会话全部转发
    /// 取消，并按 auto_reconnect 分派——
    /// * `true` → 标 Error **保留**、不进 skip 表（断灯可见，重连后
    ///   on_session_up 自动恢复 = 断线恢复链）；
    /// * `false` → 摘除（面板显示 stopped）+ 进 skip 表（重连后不自动恢复，
    ///   直到用户显式 pf_start / pf_set_enabled(true)）。
    /// 返回处理的条数。
    pub fn session_down(&self, session_id: &str) -> usize {
        let mut runs = self.runs.lock().expect("forwards poisoned");
        let mut handled = 0;
        let keys: Vec<i64> = runs
            .iter()
            .filter(|(_, run)| run.session_id == session_id)
            .map(|(id, _)| *id)
            .collect();
        for row_id in keys {
            handled += 1;
            if runs.get(&row_id).expect("键刚在表里").auto_reconnect {
                let run = runs.get_mut(&row_id).expect("键刚在表里");
                run.cancel.cancel();
                run.stats.set_error("session closed");
            } else {
                let run = runs.remove(&row_id).expect("键刚在表里");
                run.cancel.cancel();
                self.skips.lock().expect("forwards poisoned").insert(row_id);
            }
        }
        handled
    }

    /// 单行运行快照（None = 无在册实例 = 未运行）。
    pub fn snapshot(&self, row_id: i64) -> Option<ForwardStatsSnapshot> {
        self.runs
            .lock()
            .expect("forwards poisoned")
            .get(&row_id)
            .map(|run| run.stats.snapshot())
    }

    /// 行的归属（会话 id, host_id）——pf_stop 前的换绑判断/面板归属展示。
    pub fn owner(&self, row_id: i64) -> Option<(String, i64)> {
        self.runs
            .lock()
            .expect("forwards poisoned")
            .get(&row_id)
            .map(|run| (run.session_id.clone(), run.host_id))
    }

    /// 重连恢复时的跳过判定（auto_reconnect=false 的断线摘除行）。
    fn is_skipped(&self, row_id: i64) -> bool {
        self.skips
            .lock()
            .expect("forwards poisoned")
            .contains(&row_id)
    }

    fn clear_skip(&self, row_id: i64) {
        self.skips
            .lock()
            .expect("forwards poisoned")
            .remove(&row_id);
    }
}

// ---------------------------------------------------------------------------
// 会话生命周期挂钩（session.rs 调用）
// ---------------------------------------------------------------------------

/// 会话建立（attach 成功）后的自动启动面：该主机 enabled 的转发逐条启动。
/// 失败只打点（面板错误灯可见，不打断连接路径）；auto_reconnect=false 且在
/// skip 表中的行跳过（= 断线后不自动恢复，用户手动 start 清除）。参数全部
/// Arc 化（调用侧 spawn 脱离命令借用的 'static 事务）。
pub(crate) async fn on_session_up(
    sessions: &SessionMap,
    forwards: &ForwardManager,
    vault: &Vault,
    session_id: &str,
    host_id: i64,
) {
    let rows = match PortForwards::list_enabled(vault, host_id) {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("[forward] session_up list_enabled(host={host_id}) failed: {e}");
            return;
        }
    };
    let entry = {
        let sessions = sessions.lock().unwrap();
        sessions
            .get(session_id)
            .map(|e| (Arc::clone(&e.session), e.forward_router.clone()))
    };
    let Some((session, router)) = entry else {
        eprintln!("[forward] session_up: session {session_id} vanished before start");
        return;
    };
    for row in rows {
        if forwards.is_skipped(row.id) {
            continue;
        }
        let spec = vault_row_to_spec(&row);
        let snapshot = forwards
            .start(
                row.id,
                host_id,
                session_id,
                row.auto_reconnect,
                spec,
                Arc::clone(&session),
                router.clone(),
            )
            .await;
        eprintln!(
            "[forward] session_up row={} {} {}:{} -> {:?}",
            row.id,
            row.kind.as_str(),
            row.bind_addr,
            row.bind_port,
            snapshot.state
        );
    }
}

// ---------------------------------------------------------------------------
// 映射与视图
// ---------------------------------------------------------------------------

/// vault 行 → 运行规格。
fn vault_row_to_spec(row: &PortForward) -> ForwardSpec {
    ForwardSpec {
        kind: match row.kind {
            VaultForwardKind::Local => ForwardKind::Local,
            VaultForwardKind::Remote => ForwardKind::Remote,
            VaultForwardKind::Dynamic => ForwardKind::Dynamic,
        },
        bind_addr: row.bind_addr.clone(),
        bind_port: row.bind_port,
        target_host: row.target_host.clone(),
        target_port: row.target_port,
    }
}

/// 运行态视图（serde 面与前端 `ForwardRuntime` 同构，snake_case）。
#[derive(Clone, serde::Serialize)]
pub struct ForwardRuntimeView {
    pub session_id: String,
    /// "starting" | "active" | "error" | "stopped"
    pub state: String,
    pub error: Option<String>,
    pub tx_bytes: u64,
    pub rx_bytes: u64,
    pub connections: u64,
    pub conn_errors: u64,
    pub bound_port: u16,
}

/// 面板行：配置（vault）+ 运行态（Manager）拼接。
#[derive(Clone, serde::Serialize)]
pub struct PortForwardView {
    pub id: i64,
    pub host_id: i64,
    pub host_name: String,
    /// "local" | "remote" | "dynamic"
    pub kind: String,
    pub bind_addr: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub enabled: bool,
    pub auto_reconnect: bool,
    /// None = 未运行（stopped 灯）。
    pub runtime: Option<ForwardRuntimeView>,
}

fn state_name(state: &ForwardState) -> &'static str {
    match state {
        ForwardState::Starting => "starting",
        ForwardState::Active => "active",
        ForwardState::Error(_) => "error",
        ForwardState::Stopped => "stopped",
    }
}

fn runtime_view(session_id: String, snapshot: ForwardStatsSnapshot) -> ForwardRuntimeView {
    let (state, error) = match &snapshot.state {
        ForwardState::Error(msg) => ("error", Some(msg.clone())),
        other => (state_name(other), None),
    };
    ForwardRuntimeView {
        session_id,
        state: state.to_string(),
        error,
        tx_bytes: snapshot.tx_bytes,
        rx_bytes: snapshot.rx_bytes,
        connections: snapshot.connections,
        conn_errors: snapshot.conn_errors,
        bound_port: snapshot.bound_port,
    }
}

fn view_of(row: PortForward, host_name: String, manager: &ForwardManager) -> PortForwardView {
    let runtime = manager
        .owner(row.id)
        .and_then(|(session_id, _)| manager.snapshot(row.id).map(|s| (session_id, s)))
        .map(|(session_id, snapshot)| runtime_view(session_id, snapshot));
    PortForwardView {
        id: row.id,
        host_id: row.host_id,
        host_name,
        kind: row.kind.as_str().to_string(),
        bind_addr: row.bind_addr,
        bind_port: row.bind_port,
        target_host: row.target_host,
        target_port: row.target_port,
        enabled: row.enabled,
        auto_reconnect: row.auto_reconnect,
        runtime,
    }
}

fn host_name_of(vault: &Vault, host_id: i64) -> String {
    ottr_vault::Hosts::get(vault, host_id)
        .ok()
        .flatten()
        .map(|h| h.name)
        .unwrap_or_else(|| format!("host {host_id}"))
}

// ---------------------------------------------------------------------------
// 命令面
// ---------------------------------------------------------------------------

/// 面板取数：全量（host_id 缺省）或按主机过滤的转发列表（配置 + 运行态）。
#[tauri::command]
pub(crate) fn pf_list(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    host_id: Option<i64>,
) -> CmdResult<Vec<PortForwardView>> {
    ensure_unlocked(&vault.0)?;
    let rows = PortForwards::list(&vault.0, host_id).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let name = host_name_of(&vault.0, row.host_id);
            view_of(row, name, &state.forwards)
        })
        .collect())
}

/// 新建转发配置（面板「添加」表单）。不自动启动——enabled=true 的行在下次
/// 会话建立时自动启动；要立即启动请再调 pf_start。
#[tauri::command]
pub(crate) fn pf_create(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    input: PortForwardInput,
) -> CmdResult<PortForwardView> {
    ensure_unlocked(&vault.0)?;
    let row = PortForwards::create(&vault.0, &input).map_err(|e| e.to_string())?;
    let name = host_name_of(&vault.0, row.host_id);
    Ok(view_of(row, name, &state.forwards))
}

/// 全量替换式更新。在跑的实例停止（配置已变，旧实例作废；要继续请重新
/// pf_start）。
#[tauri::command]
pub(crate) fn pf_update(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    id: i64,
    input: PortForwardInput,
) -> CmdResult<PortForwardView> {
    ensure_unlocked(&vault.0)?;
    let row = PortForwards::update(&vault.0, id, &input).map_err(|e| e.to_string())?;
    state.forwards.stop(id);
    let name = host_name_of(&vault.0, row.host_id);
    Ok(view_of(row, name, &state.forwards))
}

/// 删除转发配置（在跑实例一并停止）。
#[tauri::command]
pub(crate) fn pf_delete(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    id: i64,
) -> CmdResult<()> {
    ensure_unlocked(&vault.0)?;
    state.forwards.stop(id);
    PortForwards::delete(&vault.0, id).map_err(|e| e.to_string())
}

/// 启停开关落库（面板开关；运行态启停走 pf_start/pf_stop）。
#[tauri::command]
pub(crate) fn pf_set_enabled(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    id: i64,
    enabled: bool,
) -> CmdResult<()> {
    ensure_unlocked(&vault.0)?;
    PortForwards::set_enabled(&vault.0, id, enabled).map_err(|e| e.to_string())?;
    if enabled {
        state.forwards.clear_skip(id);
    }
    Ok(())
}

/// 启动（在指定会话上）。`session_id` = Rust 会话 id（前端 session.rustId）：
/// 会话不存在/已断 → 显式报错（前端提示先连接主机）。
#[tauri::command]
pub(crate) async fn pf_start(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    id: i64,
    session_id: String,
) -> CmdResult<ForwardRuntimeView> {
    ensure_unlocked(&vault.0)?;
    let row = PortForwards::get(&vault.0, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("port_forward id={id} not found"))?;
    let (session, router) = {
        let sessions = state.sessions.lock().unwrap();
        let entry = sessions
            .get(&session_id)
            .ok_or_else(|| format!("no such session: {session_id}"))?;
        (Arc::clone(&entry.session), entry.forward_router.clone())
    };
    let spec = vault_row_to_spec(&row);
    let snapshot = state
        .forwards
        .start(
            id,
            row.host_id,
            &session_id,
            row.auto_reconnect,
            spec,
            session,
            router,
        )
        .await;
    Ok(runtime_view(session_id, snapshot))
}

/// 停止（用户显式停转；清除 auto_reconnect 的跳过标记——用户意志优先）。
#[tauri::command]
pub(crate) fn pf_stop(state: State<'_, AppState>, id: i64) -> CmdResult<bool> {
    state.forwards.clear_skip(id);
    Ok(state.forwards.stop(id))
}

// ---------------------------------------------------------------------------
// 单测（状态机决策表，无 SSH/无 Tauri）：ForwardRun 直构——start 的 SSH 侧
// （真实连接）由 tests/forward_manager_fixture.rs 真夹具覆盖。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use ottr_ssh::ForwardState;

    /// 直构一条在册转发（绕开 start_forward——其 SSH 侧由夹具集成测试覆盖）。
    fn run(session_id: &str, auto_reconnect: bool) -> ForwardRun {
        ForwardRun {
            session_id: session_id.into(),
            host_id: 1,
            auto_reconnect,
            cancel: CancellationToken::new(),
            stats: ForwardStats::shared(),
        }
    }

    /// session_down 决策表：auto_reconnect=true → Error 留痕 + 不进 skip（重连
    /// 自动恢复）；false → 摘除（stopped 显示）+ 进 skip（重连不自动恢复）；
    /// 其他会话的行不受牵连。
    #[test]
    fn session_down_decision_table() {
        let manager = ForwardManager::default();
        manager.runs.lock().unwrap().insert(1, run("s1", true));
        manager.runs.lock().unwrap().insert(2, run("s1", false));
        manager.runs.lock().unwrap().insert(3, run("s2", true));

        let handled = manager.session_down("s1");
        assert_eq!(handled, 2, "只处理归属会话的行");

        // 行 1（auto_reconnect）：Error 留痕可见 + 可恢复（不进 skip）
        let snap1 = manager.snapshot(1).expect("行 1 保留");
        assert_eq!(snap1.state, ForwardState::Error("session closed".into()));
        assert!(!manager.is_skipped(1), "auto_reconnect 行必须可自动恢复");
        // 行 2（非 auto_reconnect）：摘除 = 面板 stopped + skip（重连不自动恢复）
        assert!(manager.snapshot(2).is_none(), "非 auto_reconnect 行摘除");
        assert!(manager.is_skipped(2));
        // 行 3（他会话）：原样 Active 起点（Starting）
        assert_eq!(manager.snapshot(3).unwrap().state, ForwardState::Starting);
        // 取消令牌确实触发（任务侧自会退出）
        assert!(manager.runs.lock().unwrap()[&1].cancel.is_cancelled());
    }

    /// stop：摘除 + 取消（对不存在行返回 false，幂等）。
    #[test]
    fn stop_removes_and_cancels() {
        let manager = ForwardManager::default();
        manager.runs.lock().unwrap().insert(7, run("s", true));
        assert!(manager.stop(7));
        assert!(manager.snapshot(7).is_none());
        assert!(!manager.stop(7), "重复 stop 幂等返回 false");
    }

    /// start 的 skip 清除语义经 clear_skip 面：is_skipped → clear → 非跳过。
    #[test]
    fn skipped_row_is_cleared_for_manual_start() {
        let manager = ForwardManager::default();
        manager.skips.lock().unwrap().insert(9);
        assert!(manager.is_skipped(9));
        manager.clear_skip(9);
        assert!(!manager.is_skipped(9));
    }
}
