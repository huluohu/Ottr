//! AI 目标作用域（feat/ask-ottr-orb Task 1）：把 AI 的上下文读取与命令插入
//! 钉死到**开立作用域时的那一个运行时**上。
//!
//! 身份与裁定（简报原文落点）：
//! * 前端给的目标（pane/root/rustId/epoch/kind/hostId）只是**元数据**——真实
//!   身份一律以 Rust 会话表捕获的运行时为准：open 时按 rustId 在对应表（SSH
//!   [`AppState::sessions`] / 本地 [`AppState::local_sessions`]，kind 决定查
//!   哪张表、绝不双表兜底）查到表项，捕获 `runtime_id`（`Arc<()>` 生成期身份）
//!   与 endpoint/username（**连接注册时的实际值**——SSH 用户名来自注册面而非
//!   数据库当前行；本地显式 endpoint "local" 且 hostId 必须为 null）。绝不按
//!   hostId 另找运行时：同主机双标签是两个运行时，hostId 只做与表项的一致性
//!   复核（None vs Some 亦判失配）。
//! * insert = 一次性动作：文本静态校验（非空单行，拒绝一切控制字符与
//!   U+2028/2029）→ actionId 在**拿到 writer 锁之前**登记（await 前 claim，
//!   等待窗口内的并发重放即被拒）→ 拿到锁后复核（作用域仍在册同一 Arc + 库
//!   未锁 + 表内 runtime_id 仍是捕获的那个）→ 逐字节写入、**不追加换行**
//!   （绝不自动执行；与 `write_session` 击键路径完全独立，普通键盘语义零改动）。
//! * 生命周期失效：作用域 15 分钟 TTL（惰性清扫）；库锁定（手动/自动）经
//!   [`lock_vault`] 撤销**全部**作用域（解锁后不复活——重开新作用域才可用）；
//!   drop/断开收尾撤销对应运行时的作用域；移除/重连替换同名 id 后 runtime_id
//!   失配 = 拒绝（这就是「identity invalidation」的第二道门，覆盖只拿到 map
//!   Arc 的收尾路径）。
//! * 有界注册表：max_scopes 满员拒绝新开（撤销/过期腾位），max_actions 每
//!   作用域动作集上限——**已消费的 actionId 永不驱逐**（满员拒绝新 id，重放
//!   旧 id 恒拒），容量回收只经作用域整体撤销/过期。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use ottr_vault::Vault;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::AsyncWriteExt;

use super::state::AppState;
use crate::vault::VaultState;

/// `connectionEpoch` 的前端安全上限：2^53（JS number 安全整数上界）。
const EPOCH_SAFE_MAX: u64 = 1 << 53;
/// 开立链接元数据（pane/root/rustId/conversation/request）的单段长度上限。
const LINKAGE_MAX_LEN: usize = 256;
/// AI 插入单次文本上限（字节）：单行命令绰绰有余，防误传爆 PTY 写端。
const INSERT_MAX_BYTES: usize = 4096;
/// context 单次取尾上限（1 MiB，与 `session_tail` 同口径）。
const CONTEXT_MAX_BYTES: u32 = 1 << 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AiSessionKind {
    Ssh,
    Local,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiScopeTarget {
    pub pane_session_id: String,
    pub root_tab_id: String,
    pub rust_id: String,
    pub connection_epoch: u64,
    pub kind: AiSessionKind,
    pub host_id: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiScope {
    #[serde(flatten)]
    pub target: AiScopeTarget,
    pub scope_id: String,
    pub endpoint: String,
    pub username: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiScopeContext {
    pub tail: String,
    pub notes: Option<String>,
}

/// 捕获的 writer 身份（open 时快照；kind 亦由此判别，insert 分支按它分派
/// 异步（SSH russh 通道）与同步（本地 PTY master）两套写端）。
enum ScopeWriter {
    Ssh(Arc<tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>>),
    Local(Arc<Mutex<Box<dyn std::io::Write + Send>>>),
}

/// 单个作用域的在册实体：捕获的运行时身份 + 快照面 + 一次性动作账本。
pub(crate) struct AiScopeEntry {
    /// 开立时的目标元数据（pane/root/epoch 只作联动记录，不参与身份判定）。
    pub(crate) target: AiScopeTarget,
    /// 连接注册时的实际端点（SSH = address:port；本地 = "local"）。
    endpoint: String,
    /// SSH = 注册面的实际登录名；本地 = None（与简报契约一致）。
    username: Option<String>,
    created_at: Instant,
    /// 捕获的运行时生成期身份：insert/context 复核 `Arc::ptr_eq` 的比对面。
    runtime_id: Arc<()>,
    /// 捕获的 writer（不可变身份面）：insert 用它写，绝不改从 hostId/表另找。
    writer: ScopeWriter,
    /// 一次性动作账本（actionId 集合；登记即永久，满员拒新不逐旧）。
    actions: Mutex<HashSet<String>>,
}

/// 有界内存作用域注册表（AppState 持有）：key = Rust 生成的 scopeId。
pub(crate) struct AiScopeRegistry {
    ttl: Duration,
    max_scopes: usize,
    max_actions: usize,
    scopes: Mutex<HashMap<String, Arc<AiScopeEntry>>>,
    seq: AtomicU64,
}

impl Default for AiScopeRegistry {
    fn default() -> Self {
        Self {
            ttl: Duration::from_secs(15 * 60),
            max_scopes: 128,
            max_actions: 256,
            scopes: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
        }
    }
}

impl AiScopeRegistry {
    /// 过期清扫（持锁调用）：TTL 之外的作用域就地出表（惰性，无后台任务）。
    fn prune_locked(scopes: &mut HashMap<String, Arc<AiScopeEntry>>, ttl: Duration) {
        scopes.retain(|_, entry| entry.created_at.elapsed() < ttl);
    }

    /// 取一个当前有效（在册且未过期）的作用域；撤销/过期一律按不存在拒绝。
    fn valid(&self, scope_id: &str) -> Result<Arc<AiScopeEntry>, String> {
        let mut scopes = self.scopes.lock().unwrap();
        Self::prune_locked(&mut scopes, self.ttl);
        scopes
            .get(scope_id)
            .cloned()
            .ok_or_else(|| "AI scope not found: revoked or expired".to_string())
    }

    /// 登记新作用域（满员 = 拒绝；返回 Rust 生成的 scopeId 与在册实体句柄）。
    fn register(&self, entry: AiScopeEntry) -> Result<(String, Arc<AiScopeEntry>), String> {
        let mut scopes = self.scopes.lock().unwrap();
        Self::prune_locked(&mut scopes, self.ttl);
        if scopes.len() >= self.max_scopes {
            return Err(format!(
                "AI scope registry full ({}): revoke unused scopes first",
                self.max_scopes
            ));
        }
        let scope_id = format!("ai-scope-{}", self.seq.fetch_add(1, Ordering::Relaxed));
        let stored = Arc::new(entry);
        scopes.insert(scope_id.clone(), Arc::clone(&stored));
        Ok((scope_id, stored))
    }

    /// 撤销单个作用域（真移除：context/insert 即刻失效，容量即刻回收）。
    pub(crate) fn revoke(&self, scope_id: &str) -> bool {
        self.scopes.lock().unwrap().remove(scope_id).is_some()
    }

    /// 撤销绑定到指定运行时（kind + rustId）的全部作用域（drop/断开收尾）。
    pub(crate) fn revoke_runtime(&self, kind: AiSessionKind, rust_id: &str) {
        self.scopes
            .lock()
            .unwrap()
            .retain(|_, e| !(e.target.kind == kind && e.target.rust_id == rust_id));
    }

    /// 撤销全部作用域（库锁定收尾：解锁后不复活，重开才可用）。
    pub(crate) fn revoke_all(&self) -> usize {
        self.scopes.lock().unwrap().drain().count()
    }

    /// 一次性动作登记（await 前 claim 的 claim 面）：重放拒绝；动作集满员
    /// 拒绝**新** id——已消费的 id 永不驱逐（驱逐 = 打开重放窗口）。
    fn claim_action(&self, entry: &AiScopeEntry, action_id: &str) -> Result<(), String> {
        let mut actions = entry.actions.lock().unwrap();
        if actions.contains(action_id) {
            return Err(format!("AI action already consumed: {action_id}"));
        }
        if actions.len() >= self.max_actions {
            return Err(format!(
                "AI action budget exhausted ({}): open a new scope",
                self.max_actions
            ));
        }
        actions.insert(action_id.to_string());
        Ok(())
    }
}

/// 目标元数据与运行链接的静态校验（open 入口）：非空字段 + 长度上限 +
/// JS 安全 epoch（2^53 之上前端 number 已失真，直接拒收）。conversationId/
/// requestId 只做链接校验不入册——会话/请求的绑定面在前端（Task 3），
/// Rust 侧身份真源只有捕获的运行时。
fn validate_target(
    target: &AiScopeTarget,
    conversation_id: &str,
    request_id: &str,
) -> Result<(), String> {
    fn check(value: &str, name: &str) -> Result<(), String> {
        if value.is_empty() {
            return Err(format!("AI target rejected: empty {name}"));
        }
        if value.len() > LINKAGE_MAX_LEN {
            return Err(format!(
                "AI target rejected: {name} exceeds {LINKAGE_MAX_LEN} bytes"
            ));
        }
        Ok(())
    }
    check(&target.pane_session_id, "paneSessionId")?;
    check(&target.root_tab_id, "rootTabId")?;
    check(&target.rust_id, "rustId")?;
    check(conversation_id, "conversationId")?;
    check(request_id, "requestId")?;
    if target.connection_epoch >= EPOCH_SAFE_MAX {
        return Err(format!(
            "AI target rejected: connectionEpoch {} is outside the JS safe range",
            target.connection_epoch
        ));
    }
    Ok(())
}

/// 插入文本静态校验：非空单行，拒绝一切控制字符（\t\n\r\0、C1、DEL 全在
/// Unicode Cc）与 U+2028/U+2029 行/段分隔符——AI 永不写入回车（绝不自动执行）。
fn validate_insert_text(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err("AI insert rejected: empty text".into());
    }
    if text.len() > INSERT_MAX_BYTES {
        return Err(format!(
            "AI insert rejected: text exceeds {INSERT_MAX_BYTES} bytes"
        ));
    }
    if let Some(ch) = text
        .chars()
        .find(|c| c.is_control() || *c == '\u{2028}' || *c == '\u{2029}')
    {
        return Err(format!(
            "AI insert rejected: control/newline character U+{:04X}",
            ch as u32
        ));
    }
    Ok(())
}

/// 开立 AI 目标作用域：元数据目标 → 捕获运行时身份（真实 endpoint/username
/// 取自会话表项，绝不回读数据库、绝不按 hostId 兜底找运行时）。
fn open_scope(
    state: &AppState,
    vault: &Vault,
    target: AiScopeTarget,
    conversation_id: String,
    request_id: String,
) -> Result<AiScope, String> {
    if vault.is_locked() {
        return Err("AI target rejected: vault locked".into());
    }
    validate_target(&target, &conversation_id, &request_id)?;
    match target.kind {
        AiSessionKind::Ssh => {
            // 精确表分派：SSH 目标只查 SSH 表；hostId 与表项**完全一致**
            //（None vs Some 亦失配）才放行——同主机另一连接绝不误中。
            let (runtime_id, writer, endpoint, username, host_id) = {
                let sessions = state.sessions.lock().unwrap();
                sessions.get(&target.rust_id).map_or_else(
                    || {
                        Err(format!(
                            "AI target rejected: no SSH runtime for rustId {}",
                            target.rust_id
                        ))
                    },
                    |e| {
                        Ok((
                            Arc::clone(&e.runtime_id),
                            Arc::clone(&e.writer),
                            e.endpoint.clone(),
                            e.username.clone(),
                            e.host_id,
                        ))
                    },
                )?
            };
            if target.host_id != host_id {
                return Err(format!(
                    "AI target rejected: hostId {:?} does not match runtime host {host_id:?}",
                    target.host_id
                ));
            }
            let (scope_id, stored) = state.ai_scopes.register(AiScopeEntry {
                target: target.clone(),
                endpoint: endpoint.clone(),
                username: Some(username.clone()),
                created_at: Instant::now(),
                runtime_id,
                writer: ScopeWriter::Ssh(writer),
                actions: Mutex::new(HashSet::new()),
            })?;
            Ok(AiScope {
                target,
                scope_id,
                endpoint: stored.endpoint.clone(),
                username: stored.username.clone(),
            })
        }
        AiSessionKind::Local => {
            // 本地目标显式无主机：hostId 非 null 直接拒（前端/AI 侧不得把
            // 本地会话冒充某主机连接）。
            if let Some(host_id) = target.host_id {
                return Err(format!(
                    "AI target rejected: local target must have hostId null, got {host_id}"
                ));
            }
            let (runtime_id, writer) = {
                let local = state.local_sessions.lock().unwrap();
                local.get(&target.rust_id).map_or_else(
                    || {
                        Err(format!(
                            "AI target rejected: no local runtime for rustId {}",
                            target.rust_id
                        ))
                    },
                    |e| Ok((Arc::clone(&e.runtime_id), Arc::clone(&e.writer))),
                )?
            };
            let (scope_id, _stored) = state.ai_scopes.register(AiScopeEntry {
                target: target.clone(),
                endpoint: "local".into(),
                username: None,
                created_at: Instant::now(),
                runtime_id,
                writer: ScopeWriter::Local(writer),
                actions: Mutex::new(HashSet::new()),
            })?;
            Ok(AiScope {
                target,
                scope_id,
                endpoint: "local".into(),
                username: None,
            })
        }
    }
}

/// 作用域上下文：**只**取本作用域运行时的剥 ANSI 文本尾 + 归属主机的备注行
///（本地无主机 → notes 恒 None）；绝不跨作用域、绝不按 hostId 重找运行时。
fn scope_context(
    state: &AppState,
    vault: &Vault,
    scope_id: &str,
    bytes: u32,
) -> Result<AiScopeContext, String> {
    if vault.is_locked() {
        return Err("AI context rejected: vault locked".into());
    }
    let entry = state.ai_scopes.valid(scope_id)?;
    let bytes = bytes.min(CONTEXT_MAX_BYTES) as usize;
    match &entry.writer {
        ScopeWriter::Ssh(_) => {
            let (tail, host_id) = {
                let sessions = state.sessions.lock().unwrap();
                match sessions.get(&entry.target.rust_id) {
                    Some(e) if Arc::ptr_eq(&e.runtime_id, &entry.runtime_id) => {
                        (e.text_tail.tail(bytes), e.host_id)
                    }
                    _ => {
                        return Err(format!(
                            "AI context rejected: runtime {} no longer matches the scoped connection",
                            entry.target.rust_id
                        ));
                    }
                }
            };
            let notes = match host_id {
                Some(id) => ottr_vault::Hosts::get(vault, id)
                    .map_err(|e| format!("AI context rejected: host row: {e}"))?
                    .and_then(|host| host.notes),
                None => None,
            };
            Ok(AiScopeContext { tail, notes })
        }
        ScopeWriter::Local(_) => {
            let tail = {
                let local = state.local_sessions.lock().unwrap();
                match local.get(&entry.target.rust_id) {
                    Some(e) if Arc::ptr_eq(&e.runtime_id, &entry.runtime_id) => {
                        e.text_tail.tail(bytes)
                    }
                    _ => {
                        return Err(format!(
                            "AI context rejected: runtime {} no longer matches the scoped connection",
                            entry.target.rust_id
                        ));
                    }
                }
            };
            Ok(AiScopeContext { tail, notes: None })
        }
    }
}

/// writer 锁在手后的第二道门（简报：claim 后、写入前复核 scope/lock/当前
/// writer）：作用域仍在册且是同一实体（撤销/过期/随锁撤销 = 拒绝）+ 库未锁
/// + 表内 runtime_id 仍是捕获的那个（移除/替换同名 id = 拒绝）。
fn gate_after_lock(
    scopes: &AiScopeRegistry,
    vault: &Vault,
    scope_id: &str,
    entry: &Arc<AiScopeEntry>,
    current_runtime: Option<&Arc<()>>,
) -> Result<(), String> {
    if vault.is_locked() {
        return Err("AI insert rejected: vault locked".into());
    }
    let live = scopes.valid(scope_id)?;
    if !Arc::ptr_eq(&live, entry) {
        return Err("AI insert rejected: scope revoked or expired".into());
    }
    match current_runtime {
        Some(rt) if Arc::ptr_eq(rt, &entry.runtime_id) => Ok(()),
        Some(_) => Err(format!(
            "AI insert rejected: runtime {} was replaced",
            entry.target.rust_id
        )),
        None => Err(format!(
            "AI insert rejected: runtime {} is gone",
            entry.target.rust_id
        )),
    }
}

/// AI 插入（一次性）：文本校验 → claim（await 前）→ 快照当前表项身份 →
/// 拿 writer 锁 → [`gate_after_lock`] 复核 → 逐字节写入（不追加换行）。
/// SSH 写端异步锁；本地 PTY master 同步锁经 spawn_blocking（满缓冲会阻塞，
/// 绝不拖垮异步运行时——`write_session` 本地分支同款裁定），复核在**锁内**
/// 重做（撤销/替换发生在等待窗口时照样零写入）。
async fn insert_scope(
    state: &AppState,
    vault: Arc<Vault>,
    scope_id: String,
    action_id: String,
    text: String,
) -> Result<(), String> {
    // 静态校验先行：坏文本不消耗动作预算。
    validate_insert_text(&text)?;
    if vault.is_locked() {
        return Err("AI insert rejected: vault locked".into());
    }
    let entry = state.ai_scopes.valid(&scope_id)?;
    // await 前 claim：一次性语义在等待 writer 之前落账——并发重放即拒。
    state.ai_scopes.claim_action(&entry, &action_id)?;
    let runtime_id = Arc::clone(&entry.runtime_id);
    let rust_id = entry.target.rust_id.clone();
    // 写端用 open 时捕获的 Arc（不可变身份面）；表内 runtime_id 复核通过
    // 即等价同一表项（Arc<()> 每次注册唯一）——绝不按 hostId/表另找 writer。
    match &entry.writer {
        ScopeWriter::Ssh(captured) => {
            {
                let sessions = state.sessions.lock().unwrap();
                match sessions.get(&rust_id) {
                    Some(e) if Arc::ptr_eq(&e.runtime_id, &runtime_id) => {}
                    Some(_) => {
                        return Err(format!(
                            "AI insert rejected: runtime {rust_id} was replaced"
                        ));
                    }
                    None => return Err(format!("AI insert rejected: runtime {rust_id} is gone")),
                }
            }
            let mut guard = captured.lock().await;
            let current_runtime = state
                .sessions
                .lock()
                .unwrap()
                .get(&rust_id)
                .map(|e| Arc::clone(&e.runtime_id));
            gate_after_lock(
                &state.ai_scopes,
                &vault,
                &scope_id,
                &entry,
                current_runtime.as_ref(),
            )?;
            guard
                .write_all(text.as_bytes())
                .await
                .map_err(|e| format!("AI insert rejected: pty write failed: {e}"))?;
            guard
                .flush()
                .await
                .map_err(|e| format!("AI insert rejected: pty flush failed: {e}"))?;
            Ok(())
        }
        ScopeWriter::Local(captured) => {
            {
                let local = state.local_sessions.lock().unwrap();
                match local.get(&rust_id) {
                    Some(e) if Arc::ptr_eq(&e.runtime_id, &runtime_id) => {}
                    Some(_) => {
                        return Err(format!(
                            "AI insert rejected: runtime {rust_id} was replaced"
                        ));
                    }
                    None => return Err(format!("AI insert rejected: runtime {rust_id} is gone")),
                }
            }
            let writer = Arc::clone(captured);
            let scopes = Arc::clone(&state.ai_scopes);
            let local_sessions = Arc::clone(&state.local_sessions);
            let entry = Arc::clone(&entry);
            let scope_id2 = scope_id.clone();
            tokio::task::spawn_blocking(move || -> Result<(), String> {
                let mut guard = writer.lock().unwrap();
                let current_runtime = local_sessions
                    .lock()
                    .unwrap()
                    .get(&rust_id)
                    .map(|e| Arc::clone(&e.runtime_id));
                gate_after_lock(
                    &scopes,
                    &vault,
                    &scope_id2,
                    &entry,
                    current_runtime.as_ref(),
                )?;
                guard
                    .write_all(text.as_bytes())
                    .map_err(|e| format!("AI insert rejected: pty write failed: {e}"))?;
                guard
                    .flush()
                    .map_err(|e| format!("AI insert rejected: pty flush failed: {e}"))?;
                Ok(())
            })
            .await
            .map_err(|e| format!("AI insert rejected: join: {e}"))?
        }
    }
}

/// 库锁定收尾（[`lock_vault`]）：先撤作用域再落锁，窗口最短——锁定即 AI
/// 全部作用域失效，解锁后不复活。vault_lock 命令与自动锁定共用。
pub(crate) fn lock_vault(vault: &Vault, scopes: &AiScopeRegistry) {
    scopes.revoke_all();
    vault.lock();
}

// ---------------------------------------------------------------------------
// Tauri 命令面（camelCase 参数由 Tauri 运行时映射到 snake_case 形参；前端
// 消费面 frontend/ai/sessionApi.ts，命令名契约由 tests/command_contract.rs
// 与 sessionApi.test.ts 双面钉住——session 域同款：不进 tauri-specta 生成面）。
// ---------------------------------------------------------------------------

/// 开立 AI 目标作用域（`ai_scope_open(target, conversationId, requestId)`）。
#[tauri::command]
pub(crate) fn ai_scope_open(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    target: AiScopeTarget,
    conversation_id: String,
    request_id: String,
) -> Result<AiScope, String> {
    open_scope(&state, &vault.0, target, conversation_id, request_id)
}

/// 作用域上下文（`ai_scope_context(scopeId, bytes)`）：本作用域尾部 + 主机备注。
#[tauri::command]
pub(crate) fn ai_scope_context(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    scope_id: String,
    bytes: u32,
) -> Result<AiScopeContext, String> {
    scope_context(&state, &vault.0, &scope_id, bytes)
}

/// 一次性插入（`ai_scope_insert(scopeId, actionId, text)`）：单行、不追加换行。
#[tauri::command]
pub(crate) async fn ai_scope_insert(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    scope_id: String,
    action_id: String,
    text: String,
) -> Result<(), String> {
    insert_scope(&state, Arc::clone(&vault.0), scope_id, action_id, text).await
}

/// 撤销作用域（`ai_scope_revoke(scopeId)`）：幂等（重复撤销/未知 id 均 Ok）。
#[tauri::command]
pub(crate) fn ai_scope_revoke(state: State<'_, AppState>, scope_id: String) -> Result<(), String> {
    state.ai_scopes.revoke(&scope_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Write};
    use std::sync::{Mutex, atomic::AtomicBool};
    use std::task::Poll;
    use std::time::Instant;

    use ottr_ssh::AuthMethod;
    use ottr_term::encoding::{Encoding, StreamDecoder};
    use ottr_vault::{HostInput, HostProtocol, Hosts, master_key::InMemoryStorage};
    use portable_pty::{NativePtySystem, PtySize, PtySystem};
    use tauri::ipc::{Channel, InvokeResponseBody};

    use crate::commands::local_term::LocalSessionEntry;
    use crate::commands::session::open_and_register;
    use crate::commands::state::{SessionCounters, TextTail};

    struct Fixture {
        state: Arc<AppState>,
        vault: Arc<Vault>,
        _dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let vault = Vault::open_with(dir.path(), &InMemoryStorage::default()).unwrap();
            Self {
                state: Arc::new(AppState::default()),
                vault: Arc::new(vault),
                _dir: dir,
            }
        }

        fn password() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let vault = Vault::open_password_only(dir.path()).unwrap();
            vault.unlock_with_password("fixture-password").unwrap();
            Self {
                state: Arc::new(AppState::default()),
                vault: Arc::new(vault),
                _dir: dir,
            }
        }

        fn target(&self, id: &str, kind: AiSessionKind, host_id: Option<i64>) -> AiScopeTarget {
            AiScopeTarget {
                pane_session_id: "pane-a".into(),
                root_tab_id: "root-a".into(),
                rust_id: id.into(),
                connection_epoch: 3,
                kind,
                host_id,
            }
        }

        fn open(&self, target: AiScopeTarget) -> AiScope {
            open_scope(
                &self.state,
                &self.vault,
                target,
                "conversation-a".into(),
                "request-a".into(),
            )
            .unwrap()
        }

        async fn insert(&self, scope: &AiScope, action: &str, text: &str) -> Result<(), String> {
            insert_scope(
                &self.state,
                Arc::clone(&self.vault),
                scope.scope_id.clone(),
                action.into(),
                text.into(),
            )
            .await
        }

        fn local(&self, id: &str) -> Arc<Mutex<Vec<u8>>> {
            let bytes = Arc::new(Mutex::new(Vec::new()));
            let pair = NativePtySystem::default()
                .openpty(PtySize::default())
                .unwrap();
            self.state.local_sessions.lock().unwrap().insert(
                id.into(),
                LocalSessionEntry {
                    runtime_id: Arc::new(()),
                    writer: Arc::new(Mutex::new(Box::new(CaptureSync(Arc::clone(&bytes))))),
                    killer: Arc::new(Mutex::new(Box::new(NoChild))),
                    master: Arc::new(Mutex::new(pair.master)),
                    counters: Arc::new(SessionCounters::default()),
                    decoder: Arc::new(Mutex::new(StreamDecoder::new(Encoding::Utf8))),
                    text_tail: Arc::new(TextTail::new()),
                    recorder: Arc::new(Mutex::new(None)),
                    cols: 80,
                    rows: 24,
                    cancel: Arc::new(AtomicBool::new(false)),
                },
            );
            bytes
        }

        async fn ssh(&self, host_id: Option<i64>, username: &str) -> SshFixture {
            let bytes = Arc::new(Mutex::new(Vec::new()));
            let key =
                russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                    .unwrap();
            let config = Arc::new(russh::server::Config {
                keys: vec![key],
                ..Default::default()
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let sink = Arc::clone(&bytes);
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let handler = SshHandler { bytes: sink };
                let running = russh::server::run_stream(config, stream, handler)
                    .await
                    .unwrap();
                let _ = running.await;
            });
            let id = open_and_register(
                Arc::clone(&self.state.sessions),
                None,
                host_id,
                "127.0.0.1",
                addr.port(),
                username,
                AuthMethod::Password("fixture-password".into()),
                Arc::new(|_| true),
                None,
                Duration::from_secs(5),
                "ai-scope-fixture".into(),
                80,
                24,
                Channel::new(|_: InvokeResponseBody| Ok(())),
                Encoding::Utf8,
                false,
                false,
            )
            .await
            .unwrap();
            SshFixture {
                id,
                endpoint: format!("127.0.0.1:{}", addr.port()),
                bytes,
                server,
            }
        }
    }

    struct SshFixture {
        id: String,
        endpoint: String,
        bytes: Arc<Mutex<Vec<u8>>>,
        server: tokio::task::JoinHandle<()>,
    }

    impl Drop for SshFixture {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    struct SshHandler {
        bytes: Arc<Mutex<Vec<u8>>>,
    }

    impl russh::server::Handler for SshHandler {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            _password: &str,
        ) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _channel: russh::Channel<russh::server::Msg>,
            reply: russh::server::ChannelOpenHandle,
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        async fn data(
            &mut self,
            _channel: russh::ChannelId,
            data: &[u8],
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            self.bytes.lock().unwrap().extend_from_slice(data);
            Ok(())
        }
    }

    struct CaptureSync(Arc<Mutex<Vec<u8>>>);

    impl Write for CaptureSync {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Debug)]
    struct NoChild;

    impl portable_pty::ChildKiller for NoChild {
        fn kill(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(Self)
        }
    }

    async fn wait_for(mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !predicate() {
            assert!(Instant::now() < deadline, "fixture deadline exceeded");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    fn host_input(notes: &str) -> HostInput {
        HostInput {
            name: "fixture".into(),
            group_id: None,
            tags: vec![],
            address: "database-current.example".into(),
            port: 22,
            username: Some("database-current-user".into()),
            protocol: HostProtocol::Ssh,
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            is_production: false,
            notes: Some(notes.into()),
        }
    }

    #[tokio::test]
    async fn opens_exact_runtime_and_keeps_actual_endpoint_and_account() {
        let f = Fixture::new();
        let host = Hosts::create(&f.vault, host_input("host notes")).unwrap();
        let ssh = f.ssh(Some(host.id), "actual-login").await;
        let target = f.target(&ssh.id, AiSessionKind::Ssh, Some(host.id));
        let scope = f.open(target.clone());
        Hosts::update(&f.vault, host.id, host_input("updated notes")).unwrap();
        let reopened = f.open(target.clone());
        assert_eq!(scope.target, target);
        assert_eq!(scope.endpoint, ssh.endpoint);
        assert_eq!(scope.username.as_deref(), Some("actual-login"));
        assert_eq!(reopened.endpoint, ssh.endpoint);
        assert_eq!(reopened.username.as_deref(), Some("actual-login"));
        let json = serde_json::to_value(&scope).unwrap();
        assert_eq!(json["paneSessionId"], "pane-a");
        assert_eq!(json["rootTabId"], "root-a");
        assert_eq!(json["connectionEpoch"], 3);
        assert_eq!(json["kind"], "ssh");
        assert_eq!(json["hostId"], host.id);
        assert!(json.get("target").is_none());
        assert!(json.get("scopeId").is_some());
    }

    #[tokio::test]
    async fn rejects_wrong_host_kind_and_missing_runtime_without_host_fallback() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "actual-login").await;
        f.local("local-1");
        for target in [
            f.target(&ssh.id, AiSessionKind::Ssh, Some(43)),
            f.target(&ssh.id, AiSessionKind::Local, None),
            f.target("local-1", AiSessionKind::Ssh, Some(42)),
            f.target("local-1", AiSessionKind::Local, Some(42)),
            f.target("absent", AiSessionKind::Ssh, Some(42)),
            f.target("absent", AiSessionKind::Local, None),
        ] {
            let err = open_scope(&f.state, &f.vault, target, "c".into(), "r".into()).unwrap_err();
            assert!(err.starts_with("AI target"), "{err}");
        }
    }

    #[tokio::test]
    async fn exact_ssh_and_local_writers_receive_only_their_actions() {
        let f = Fixture::new();
        let ssh_a = f.ssh(Some(42), "user-a").await;
        let ssh_b = f.ssh(Some(42), "user-b").await;
        let local_a = f.local("local-a");
        let local_b = f.local("local-b");
        let ssh_scope = f.open(f.target(&ssh_b.id, AiSessionKind::Ssh, Some(42)));
        let local_scope = f.open(f.target("local-b", AiSessionKind::Local, None));
        assert_eq!(local_scope.endpoint, "local");
        assert_eq!(local_scope.username, None);
        assert_eq!(local_scope.target.host_id, None);
        f.insert(&ssh_scope, "action", "whoami").await.unwrap();
        f.insert(&local_scope, "action", "pwd").await.unwrap();
        wait_for(|| ssh_b.bytes.lock().unwrap().len() == 6).await;
        assert_eq!(*ssh_b.bytes.lock().unwrap(), b"whoami");
        assert!(ssh_a.bytes.lock().unwrap().is_empty());
        assert_eq!(*local_b.lock().unwrap(), b"pwd");
        assert!(local_a.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn context_uses_only_scoped_runtime_tail_and_host_notes() {
        let f = Fixture::new();
        let host_a = Hosts::create(&f.vault, host_input("notes-a")).unwrap();
        let host_b = Hosts::create(&f.vault, host_input("notes-b")).unwrap();
        let ssh_a = f.ssh(Some(host_a.id), "user-a").await;
        let ssh_b = f.ssh(Some(host_b.id), "user-b").await;
        {
            let sessions = f.state.sessions.lock().unwrap();
            sessions[&ssh_a.id].text_tail.push(b"output-a\n");
            sessions[&ssh_b.id]
                .text_tail
                .push(b"\x1b[31moutput-b\x1b[0m\n");
        }
        f.local("local-a");
        f.state.local_sessions.lock().unwrap()["local-a"]
            .text_tail
            .push(b"local-output\n");
        let scope = f.open(f.target(&ssh_b.id, AiSessionKind::Ssh, Some(host_b.id)));
        assert_eq!(
            scope_context(&f.state, &f.vault, &scope.scope_id, 8192).unwrap(),
            AiScopeContext {
                tail: "output-b".into(),
                notes: Some("notes-b".into())
            }
        );
        let local = f.open(f.target("local-a", AiSessionKind::Local, None));
        assert_eq!(
            scope_context(&f.state, &f.vault, &local.scope_id, 8192).unwrap(),
            AiScopeContext {
                tail: "local-output".into(),
                notes: None
            }
        );
    }

    #[tokio::test]
    async fn concurrent_duplicate_action_is_claimed_before_writer_wait() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let writer = Arc::clone(&f.state.sessions.lock().unwrap()[&ssh.id].writer);
        let guard = writer.lock().await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let mut first = Box::pin(f.insert(&scope, "same-action", "whoami"));
        assert!(
            std::future::poll_fn(|cx| Poll::Ready(first.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        let duplicate = tokio::time::timeout(
            Duration::from_secs(1),
            f.insert(&scope, "same-action", "whoami"),
        )
        .await
        .expect("duplicate must not wait for the writer");
        assert!(duplicate.is_err());
        drop(guard);
        first.await.unwrap();
        assert!(f.insert(&scope, "same-action", "whoami").await.is_err());
        wait_for(|| ssh.bytes.lock().unwrap().len() == 6).await;
        assert_eq!(*ssh.bytes.lock().unwrap(), b"whoami");
    }

    #[tokio::test]
    async fn revocation_while_waiting_for_ssh_writer_writes_nothing() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let writer = Arc::clone(&f.state.sessions.lock().unwrap()[&ssh.id].writer);
        let guard = writer.lock().await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let mut pending = Box::pin(f.insert(&scope, "late", "whoami"));
        assert!(
            std::future::poll_fn(|cx| Poll::Ready(pending.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        f.state.ai_scopes.revoke(&scope.scope_id);
        drop(guard);
        assert!(pending.await.is_err());
        assert!(ssh.bytes.lock().unwrap().is_empty());
        assert!(scope_context(&f.state, &f.vault, &scope.scope_id, 8192).is_err());
    }

    #[tokio::test]
    async fn removed_ssh_runtime_cannot_write_through_captured_writer() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let writer = Arc::clone(&f.state.sessions.lock().unwrap()[&ssh.id].writer);
        let guard = writer.lock().await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let mut pending = Box::pin(f.insert(&scope, "late", "whoami"));
        assert!(
            std::future::poll_fn(|cx| Poll::Ready(pending.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        let removed = f.state.sessions.lock().unwrap().remove(&ssh.id).unwrap();
        drop(guard);
        assert!(pending.await.is_err());
        assert!(scope_context(&f.state, &f.vault, &scope.scope_id, 8192).is_err());
        assert!(ssh.bytes.lock().unwrap().is_empty());
        removed.cancel.notify_one();
    }

    #[tokio::test]
    async fn replaced_ssh_runtime_with_same_id_and_writer_cannot_reuse_scope() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let replacement = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let old = {
            let mut sessions = f.state.sessions.lock().unwrap();
            let mut new = sessions.remove(&replacement.id).unwrap();
            new.writer = Arc::clone(&sessions[&ssh.id].writer);
            sessions.insert(ssh.id.clone(), new).unwrap()
        };
        assert!(f.insert(&scope, "late", "whoami").await.is_err());
        assert!(scope_context(&f.state, &f.vault, &scope.scope_id, 8192).is_err());
        assert!(ssh.bytes.lock().unwrap().is_empty());
        assert!(replacement.bytes.lock().unwrap().is_empty());
        old.cancel.notify_one();
    }

    #[tokio::test]
    async fn removed_and_replaced_local_runtimes_cannot_reuse_scope() {
        let f = Fixture::new();
        let old = f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        f.state.local_sessions.lock().unwrap().remove("local-a");
        assert!(f.insert(&scope, "removed", "pwd").await.is_err());
        let replacement = f.local("local-a");
        assert!(f.insert(&scope, "replaced", "pwd").await.is_err());
        assert!(scope_context(&f.state, &f.vault, &scope.scope_id, 8192).is_err());
        assert!(old.lock().unwrap().is_empty());
        assert!(replacement.lock().unwrap().is_empty());
    }

    #[tokio::test]
    // 故意持有 std 锁跨 await：复现「PTY master 同步写端被占、insert 阻塞
    // 等锁」的窗口（正是被测行为；真正产线路径在 spawn_blocking 内锁）。
    #[allow(clippy::await_holding_lock)]
    async fn local_worker_rechecks_revocation_after_blocking_writer_acquisition() {
        let f = Fixture::new();
        let bytes = f.local("local-a");
        let writer = Arc::clone(&f.state.local_sessions.lock().unwrap()["local-a"].writer);
        let guard = writer.lock().unwrap();
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        let mut pending = Box::pin(f.insert(&scope, "late", "pwd"));
        assert!(
            std::future::poll_fn(|cx| Poll::Ready(pending.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        f.state.ai_scopes.revoke(&scope.scope_id);
        drop(guard);
        assert!(pending.await.is_err());
        tokio::task::spawn_blocking(move || drop(writer.lock().unwrap()))
            .await
            .unwrap();
        assert!(bytes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn rejects_controls_and_newlines_without_writing() {
        let f = Fixture::new();
        let bytes = f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        for (i, text) in [
            "",
            "whoami\n",
            "whoami\r",
            "a\tb",
            "a\0b",
            "\x1b[31mwhoami",
            "a\x7fb",
            "a\u{85}b",
            "a\u{2028}b",
            "a\u{2029}b",
        ]
        .iter()
        .enumerate()
        {
            assert!(
                f.insert(&scope, &format!("invalid-{i}"), text)
                    .await
                    .is_err()
            );
        }
        assert!(bytes.lock().unwrap().is_empty());
        f.insert(&scope, "valid", "printf '中文'").await.unwrap();
        assert_eq!(*bytes.lock().unwrap(), "printf '中文'".as_bytes());
    }

    #[tokio::test]
    async fn locked_vault_rejects_open_context_and_insert() {
        let f = Fixture::password();
        let bytes = f.local("local-a");
        let target = f.target("local-a", AiSessionKind::Local, None);
        let scope = f.open(target.clone());
        f.vault.lock();
        assert!(open_scope(&f.state, &f.vault, target, "c".into(), "r".into()).is_err());
        assert!(scope_context(&f.state, &f.vault, &scope.scope_id, 8192).is_err());
        assert!(f.insert(&scope, "locked", "pwd").await.is_err());
        assert!(bytes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn vault_lock_revokes_scopes_permanently_across_unlock() {
        let f = Fixture::password();
        let bytes = f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        lock_vault(&f.vault, &f.state.ai_scopes);
        assert!(f.vault.is_locked());
        f.vault.unlock_with_password("fixture-password").unwrap();
        assert!(f.insert(&scope, "unlocked-late", "pwd").await.is_err());
        assert!(scope_context(&f.state, &f.vault, &scope.scope_id, 8192).is_err());
        assert!(bytes.lock().unwrap().is_empty());
        let new_scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        f.insert(&new_scope, "fresh", "pwd").await.unwrap();
        assert_eq!(*bytes.lock().unwrap(), b"pwd");
    }

    #[tokio::test]
    async fn expired_scope_rejects_context_and_insertion() {
        let mut f = Fixture::new();
        Arc::get_mut(&mut f.state).unwrap().ai_scopes = Arc::new(AiScopeRegistry {
            ttl: Duration::ZERO,
            ..Default::default()
        });
        let bytes = f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        assert!(scope_context(&f.state, &f.vault, &scope.scope_id, 8192).is_err());
        assert!(f.insert(&scope, "expired", "pwd").await.is_err());
        assert!(bytes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn bounded_scope_registry_recovers_capacity_after_revoke() {
        let mut f = Fixture::new();
        Arc::get_mut(&mut f.state).unwrap().ai_scopes = Arc::new(AiScopeRegistry {
            max_scopes: 1,
            ..Default::default()
        });
        f.local("local-a");
        let target = f.target("local-a", AiSessionKind::Local, None);
        let scope = f.open(target.clone());
        assert!(open_scope(&f.state, &f.vault, target.clone(), "c".into(), "r2".into()).is_err());
        f.state.ai_scopes.revoke(&scope.scope_id);
        f.open(target);
    }

    #[tokio::test]
    async fn bounded_actions_never_evict_consumed_action_ids() {
        let mut f = Fixture::new();
        Arc::get_mut(&mut f.state).unwrap().ai_scopes = Arc::new(AiScopeRegistry {
            max_actions: 1,
            ..Default::default()
        });
        let bytes = f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        f.insert(&scope, "first", "pwd").await.unwrap();
        assert!(f.insert(&scope, "second", "pwd").await.is_err());
        assert!(f.insert(&scope, "first", "pwd").await.is_err());
        assert_eq!(*bytes.lock().unwrap(), b"pwd");
    }

    #[tokio::test]
    async fn rejects_empty_run_linkage_and_unsafe_frontend_numbers() {
        let f = Fixture::new();
        f.local("local-a");
        let target = f.target("local-a", AiSessionKind::Local, None);
        for (conversation, request) in [("", "r"), ("c", "")] {
            assert!(
                open_scope(
                    &f.state,
                    &f.vault,
                    target.clone(),
                    conversation.into(),
                    request.into()
                )
                .is_err()
            );
        }
        let mut unsafe_epoch = target.clone();
        unsafe_epoch.connection_epoch = 1 << 53;
        assert!(open_scope(&f.state, &f.vault, unsafe_epoch, "c".into(), "r".into()).is_err());
        let mut empty_pane = target;
        empty_pane.pane_session_id.clear();
        assert!(open_scope(&f.state, &f.vault, empty_pane, "c".into(), "r".into()).is_err());
    }
}
