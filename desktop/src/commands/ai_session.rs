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
//!
//! * 第一步（Ask Ottr 执行模式 · Plan 档，2026-11-04）：只读面
//!   （[`ai_scope_list_dir`] / [`ai_scope_read_file`]）与执行面
//!   （[`ai_scope_exec`]）落**同一套身份校验**（scope 在册 + 同一 entry +
//!   按 kind 精确分派 + hostId 完全一致，绝不双表兜底）：
//!   * plan 档（默认）执行类动作**只登记计划步骤**——绝不打开 exec 通道、
//!     绝不碰写端（零执行、零副作用），返回 `planned = true` + 步骤 id；
//!   * manual 档本步同样**只登记不执行**（真执行是第二步的 pending 确认流）；
//!   * auto 档本步**直接拒**（主机授权表在第三步）——绝不"先跑起来"；
//!   * 本地会话（kind=local）**一律不给执行权**（设计裁定：本地是用户自己的
//!     机器与交互 shell，误操作代价最高且无法与用户输入隔离）——只给只读
//!     上下文（终端输出尾）；
//!   * 本地会话**同样不开放主机文件读取面**（读文件 / 列目录一律拒，见
//!     [`LOCAL_READ_DENIED`]）：本地只读根曾被实现自选为「Ottr 进程用户的
//!     整个 HOME」，等于把 `~/.ssh`、`~/.aws`、`~/.kube`、`~/.gnupg` 默认
//!     交给外部模型，而脱敏层覆盖不到那些形态。远端家目录之外的放开（按主机
//!     授权表）是第三步的事；
//!   * 执行面的 actionId 是**一次性**的（登记计划之前即消费）：同一 actionId
//!     第二次调用即拒「already consumed」。

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
/// 只读面单次 I/O 超时（秒）：读文件/列目录共用（与设计 §3.5 单条命令超时
/// 同值 30s——超时即失败，绝不无限等）。
const AI_SCOPE_IO_TIMEOUT: Duration = Duration::from_secs(30);
/// 读文件**返回内容**上限（字节）：超出截断 + `truncated` 标记。
const AI_SCOPE_FILE_MAX_BYTES: usize = 64 * 1024;
/// 读文件**硬上限**（字节）：超过直接拒（不把大文件读进内存——AI 侧拿到
/// 半截大文件是事故源，同 MCP read_file 口径）；软上限与硬上限之间才截断。
const AI_SCOPE_FILE_HARD_MAX_BYTES: u64 = 256 * 1024;
/// 列目录条目上限：超出截断（防超大目录撑爆面板与模型上下文）。
const AI_SCOPE_LIST_MAX_ENTRIES: usize = 512;
/// 每作用域计划步骤上限：满员拒绝新登记（登记即有界）。
const AI_SCOPE_MAX_PLAN_STEPS: usize = 128;

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

/// 会话级执行模式（前端可传，**后端独立复核**——webview 不是信任边界，
/// Rust 侧是最后一道闸；未知档位在反序列化面即被拒）。
///
/// * `plan`（默认）：执行类动作**只产计划、不执行**（零 exec 通道、零写端
///   副作用），返回 `planned = true` + 步骤 id 供前端渲染计划清单。
/// * `auto`：本步**未启用**（主机授权表是第三步）——一律拒，绝不"先跑起来"。
/// * `manual`：本步同样**只登记不执行**（真正执行是第二步的前端确认流）。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AiExecMode {
    Plan,
    Auto,
    Manual,
}

/// 只读面：目录项（`name` / `isDir` / `size`）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiScopeEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// 只读面：目录列举结果（`path` = 生效路径——远端 canonical / 本机 canonical）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiScopeListing {
    pub path: String,
    pub entries: Vec<AiScopeEntry>,
}

/// 只读面：文件内容（超软上限截断 + `truncated` 标记；`size` 是文件全量大小）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiScopeFile {
    pub path: String,
    pub size: u64,
    pub content: String,
    pub truncated: bool,
}

/// 执行面：按模式分派的结果（本步 plan/manual **均不执行**：`executed`
/// 恒为 false，`planned` 恒为 true；`stepId` 是计划清单里的步骤 id）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiScopeExecOutcome {
    pub executed: bool,
    pub planned: bool,
    pub step_id: String,
    pub message: String,
}

/// 捕获的 writer 身份（open 时快照；kind 亦由此判别，insert 分支按它分派
/// 异步（SSH russh 通道）与同步（本地 PTY master）两套写端）。
enum ScopeWriter {
    Ssh(Arc<tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>>),
    Local(Arc<Mutex<Box<dyn std::io::Write + Send>>>),
}

/// 单个作用域的在册实体：捕获的运行时身份 + 快照面 + 一次性动作账本。
///
/// 名字带 "Registry" 是为了给**契约面**的 `AiScopeEntry`（只读面目录项）让位
/// ——两者的语义面完全不同（一个是作用域实体，一个是目录条目）。
pub(crate) struct AiScopeRegistryEntry {
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
    /// 捕获的 SSH 会话句柄（SSH 作用域；本地为 None）：SFTP 只读面**只**经
    /// 它开通道——绝不按 hostId/表另找（与 writer 同一纪律：不可变身份面）。
    ssh: Option<Arc<ottr_ssh::SshSession>>,
    /// 该作用域的 SFTP 客户端缓存（懒开 + 复用；随作用域消亡）。
    sftp: tokio::sync::Mutex<Option<Arc<ottr_transfer::SftpClient>>>,
    /// 一次性动作账本（actionId 集合；登记即永久，满员拒新不逐旧）。
    actions: Mutex<HashSet<String>>,
    /// 计划步骤登记簿（**只登记不执行**；同一 actionId 幂等返同一步 id）。
    plans: Mutex<Vec<AiPlanStep>>,
}

/// 计划步骤登记项（作用域内；**只登记不执行**——本步没有任何执行面消费它）。
struct AiPlanStep {
    /// 计划步骤 id（确定性派生，见 [`plan_step_id`]）。
    step_id: String,
    /// 触发步骤的一次性动作 id（幂等键：同 id 恒得同一步）。
    action_id: String,
    /// 计划中的命令原文（第二步手动执行时消费；本步只存不用——保留原文是
    /// 为了让后端登记簿成为"模型原始命令"的第二真源，前端改写后的命令以
    /// 新的 actionId 重新登记）。
    #[allow(dead_code)]
    command: String,
}

/// 有界内存作用域注册表（AppState 持有）：key = Rust 生成的 scopeId。
pub(crate) struct AiScopeRegistry {
    ttl: Duration,
    max_scopes: usize,
    max_actions: usize,
    scopes: Mutex<HashMap<String, Arc<AiScopeRegistryEntry>>>,
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
    fn prune_locked(scopes: &mut HashMap<String, Arc<AiScopeRegistryEntry>>, ttl: Duration) {
        scopes.retain(|_, entry| entry.created_at.elapsed() < ttl);
    }

    /// 取一个当前有效（在册且未过期）的作用域；撤销/过期一律按不存在拒绝。
    fn valid(&self, scope_id: &str) -> Result<Arc<AiScopeRegistryEntry>, String> {
        let mut scopes = self.scopes.lock().unwrap();
        Self::prune_locked(&mut scopes, self.ttl);
        scopes
            .get(scope_id)
            .cloned()
            .ok_or_else(|| "AI scope not found: revoked or expired".to_string())
    }

    /// 登记新作用域（满员 = 拒绝；返回 Rust 生成的 scopeId 与在册实体句柄）。
    fn register(
        &self,
        entry: AiScopeRegistryEntry,
    ) -> Result<(String, Arc<AiScopeRegistryEntry>), String> {
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
    fn claim_action(&self, entry: &AiScopeRegistryEntry, action_id: &str) -> Result<(), String> {
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
            let (runtime_id, writer, session, endpoint, username, host_id) = {
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
                            Arc::clone(&e.session),
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
            let (scope_id, stored) = state.ai_scopes.register(AiScopeRegistryEntry {
                target: target.clone(),
                endpoint: endpoint.clone(),
                username: Some(username.clone()),
                created_at: Instant::now(),
                runtime_id,
                writer: ScopeWriter::Ssh(writer),
                ssh: Some(session),
                sftp: tokio::sync::Mutex::new(None),
                actions: Mutex::new(HashSet::new()),
                plans: Mutex::new(Vec::new()),
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
            let (scope_id, _stored) = state.ai_scopes.register(AiScopeRegistryEntry {
                target: target.clone(),
                endpoint: "local".into(),
                username: None,
                created_at: Instant::now(),
                runtime_id,
                writer: ScopeWriter::Local(writer),
                ssh: None,
                sftp: tokio::sync::Mutex::new(None),
                actions: Mutex::new(HashSet::new()),
                plans: Mutex::new(Vec::new()),
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
    entry: &Arc<AiScopeRegistryEntry>,
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
// 只读面 + 执行面（Ask Ottr 执行模式 · 第一步 Plan 档）
// ---------------------------------------------------------------------------

/// 单行文本静态校验（插入面与执行面**同一口径**）：非空、单行（拒绝一切
/// 控制字符与 U+2028/2029 行/段分隔符）、≤ [`INSERT_MAX_BYTES`] 字节。
/// `face` 只进错误前缀（insert / exec）——执行面**也要**过这道闸：命令会
/// 进计划清单，脏命令进清单等于把注入面留给后续执行。
fn validate_single_line_text(text: &str, face: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err(format!("AI {face} rejected: empty text"));
    }
    if text.len() > INSERT_MAX_BYTES {
        return Err(format!(
            "AI {face} rejected: text exceeds {INSERT_MAX_BYTES} bytes"
        ));
    }
    if let Some(ch) = text
        .chars()
        .find(|c| c.is_control() || *c == '\u{2028}' || *c == '\u{2029}')
    {
        return Err(format!(
            "AI {face} rejected: control/newline character U+{:04X}",
            ch as u32
        ));
    }
    Ok(())
}

/// actionId 静态校验（非空 + 长度上限）：它是执行面的幂等键。
fn validate_action_id(action_id: &str) -> Result<(), String> {
    if action_id.is_empty() {
        return Err("AI exec rejected: empty actionId".into());
    }
    if action_id.len() > LINKAGE_MAX_LEN {
        return Err(format!(
            "AI exec rejected: actionId exceeds {LINKAGE_MAX_LEN} bytes"
        ));
    }
    Ok(())
}

/// 远端路径静态校验（沿用 MCP read_file 口径）：绝对路径、无 NUL、无 `..`
/// 段。**canonical 终判在远端**（realpath 后与作用域只读根做段边界比对）。
fn validate_remote_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("AI read rejected: empty path".into());
    }
    if !path.starts_with('/') {
        return Err("AI read rejected: path must be an absolute remote path".into());
    }
    if path.as_bytes().contains(&0) {
        return Err("AI read rejected: path contains NUL".into());
    }
    if path.split('/').any(|seg| seg == "..") {
        return Err("AI read rejected: path must not contain '..' segments".into());
    }
    Ok(())
}

/// 目录边界精确到路径段（`/tmp2` 不匹配 `/tmp`；根目录 `/` 特判避免 `//`
/// 前缀误判）——与 MCP read_file 的白名单前缀判定同款纪律。
fn path_within(child: &str, dir: &str) -> bool {
    if dir == "/" {
        return child.starts_with('/');
    }
    child == dir || child.starts_with(&format!("{dir}/"))
}

/// 本机（kind=local）会话**一律不开放主机文件读取面**。
///
/// 裁定（2026-11-04 修补 A1）：本地终端会话的只读面**只保留终端输出尾**
/// （那本来就是用户自己屏幕上的东西），读文件 / 列目录**一律拒**——本地会话
/// 的只读根曾被实现自选为「Ottr 进程用户的整个 HOME」，等于把 `~/.ssh`、
/// `~/.aws`、`~/.kube`、`~/.gnupg` 等凭据默认交给外部模型，而脱敏层只覆盖
/// PEM/AKIA/`password=` 等已知形态（`~/.kube/config` 的 `client-key-data`、
/// PGP 私钥块并不覆盖）。远端家目录之外的放开（按主机授权表）是第三步的事。
///
/// 错误文案要能直接说清原因（前端另有 8 语本地化文案，见 i18n `ai.hostTool.
/// localReadRejected`）。
const LOCAL_READ_DENIED: &str =
    "AI read rejected: local terminal sessions do not expose host file reads";

/// IO 之后的二次身份复核（读取面专用）：作用域若在 IO 期间被撤销/过期/
/// 运行时被替换 → **不返回已取到的数据**（读取面同样守"撤销即失效"；
/// 读面虽无副作用，但"已撤销的作用域不该再拿到主机内容"是同一条纪律）。
fn recheck_scope(
    state: &AppState,
    scope_id: &str,
    entry: &Arc<AiScopeRegistryEntry>,
    face: &str,
) -> Result<(), String> {
    let live = state.ai_scopes.valid(scope_id)?;
    if !Arc::ptr_eq(&live, entry) {
        return Err(format!("AI {face} rejected: scope revoked or expired"));
    }
    verify_runtime(state, entry, face)
}

/// 作用域运行时复核（任何 IO 之前）：SSH 只查 SSH 表、本地只查本地表
/// （**绝不双表兜底**）；表内 runtime_id 必须是开立作用域时捕获的那一个
/// （`Arc::ptr_eq`）——被替换/移除即拒；hostId 与表项**完全一致**
/// （None vs Some 亦判失配）。
fn verify_runtime(
    state: &AppState,
    entry: &Arc<AiScopeRegistryEntry>,
    face: &str,
) -> Result<(), String> {
    match entry.target.kind {
        AiSessionKind::Ssh => {
            let sessions = state.sessions.lock().unwrap();
            match sessions.get(&entry.target.rust_id) {
                Some(e) if Arc::ptr_eq(&e.runtime_id, &entry.runtime_id) => {
                    if e.host_id != entry.target.host_id {
                        return Err(format!(
                            "AI {face} rejected: hostId {:?} does not match runtime host {:?}",
                            entry.target.host_id, e.host_id
                        ));
                    }
                    Ok(())
                }
                Some(_) => Err(format!(
                    "AI {face} rejected: runtime {} was replaced",
                    entry.target.rust_id
                )),
                None => Err(format!(
                    "AI {face} rejected: runtime {} is gone",
                    entry.target.rust_id
                )),
            }
        }
        AiSessionKind::Local => {
            let local = state.local_sessions.lock().unwrap();
            match local.get(&entry.target.rust_id) {
                Some(e) if Arc::ptr_eq(&e.runtime_id, &entry.runtime_id) => Ok(()),
                Some(_) => Err(format!(
                    "AI {face} rejected: runtime {} was replaced",
                    entry.target.rust_id
                )),
                None => Err(format!(
                    "AI {face} rejected: runtime {} is gone",
                    entry.target.rust_id
                )),
            }
        }
    }
}

/// 作用域的 SFTP 客户端（懒开 + 缓存）：**只**经开立时捕获的会话开通道
/// （绝不按 hostId/表另找——防串主机）。
async fn scope_sftp(
    entry: &AiScopeRegistryEntry,
) -> Result<Arc<ottr_transfer::SftpClient>, String> {
    let Some(session) = entry.ssh.as_ref() else {
        return Err("AI read rejected: scope has no SSH runtime".into());
    };
    let mut guard = entry.sftp.lock().await;
    if let Some(cached) = guard.as_ref() {
        return Ok(Arc::clone(cached));
    }
    let client = Arc::new(
        ottr_transfer::SftpClient::open(session)
            .await
            .map_err(|e| format!("AI read rejected: sftp open failed: {e}"))?,
    );
    *guard = Some(Arc::clone(&client));
    Ok(client)
}

/// 远端只读根 = 远端家目录（`realpath(".")`：远端 home 展开锚点）。
///
/// **形态校验**：SFTP 服务端在 `realpath` 回落成空文件名列表时会把入参原样
/// 返回（对 "." 就是 "."）——此时只读根不是绝对路径，`path_within` 恒假、
/// **所有远端读全被拒**（fail-closed，安全上没问题，但错误面难排查）。故这里
/// 显式判形态：拿不到绝对路径的家目录就说清是「无法确定远端家目录」。
async fn remote_read_root(sftp: &ottr_transfer::SftpClient) -> Result<String, String> {
    let root = sftp
        .realpath(".")
        .await
        .map_err(|e| format!("AI read rejected: resolve scope root failed: {e}"))?;
    if !root.starts_with('/') {
        return Err(format!(
            "AI read rejected: cannot determine the remote home directory (realpath returned {root:?})"
        ));
    }
    Ok(root)
}

/// 远端列目录（canonical 终判 → 列目录 → 截断条目数）。
async fn sftp_list_dir(
    sftp: &ottr_transfer::SftpClient,
    path: &str,
) -> Result<AiScopeListing, String> {
    let canonical = sftp
        .realpath(path)
        .await
        .map_err(|e| format!("AI read rejected: resolve path failed: {e}"))?;
    let root = remote_read_root(sftp).await?;
    if !path_within(&canonical, &root) {
        return Err(format!(
            "AI read rejected: path {path} is outside the scope read root ({root})"
        ));
    }
    let entries = sftp
        .list_dir(&canonical)
        .await
        .map_err(|e| format!("AI read rejected: list dir failed: {e}"))?;
    let entries = entries
        .into_iter()
        .take(AI_SCOPE_LIST_MAX_ENTRIES)
        .map(|e| AiScopeEntry {
            name: e.name,
            is_dir: e.is_dir,
            size: e.size,
        })
        .collect();
    Ok(AiScopeListing {
        path: canonical,
        entries,
    })
}

/// 远端读文件（canonical 终判 → stat 硬上限 → 读 → 软上限截断）。
async fn sftp_read_file(
    sftp: &ottr_transfer::SftpClient,
    path: &str,
) -> Result<AiScopeFile, String> {
    let canonical = sftp
        .realpath(path)
        .await
        .map_err(|e| format!("AI read rejected: resolve path failed: {e}"))?;
    let root = remote_read_root(sftp).await?;
    if !path_within(&canonical, &root) {
        return Err(format!(
            "AI read rejected: path {path} is outside the scope read root ({root})"
        ));
    }
    let stat = sftp
        .stat(&canonical)
        .await
        .map_err(|e| format!("AI read rejected: stat failed: {e}"))?;
    if stat.is_dir {
        return Err("AI read rejected: path is a directory".into());
    }
    if stat.size > AI_SCOPE_FILE_HARD_MAX_BYTES {
        return Err(format!(
            "AI read rejected: file exceeds the {} KiB read limit ({} bytes)",
            AI_SCOPE_FILE_HARD_MAX_BYTES / 1024,
            stat.size
        ));
    }
    let bytes = sftp
        .open_remote_text(&canonical)
        .await
        .map_err(|e| format!("AI read rejected: read failed: {e}"))?;
    let truncated = bytes.len() > AI_SCOPE_FILE_MAX_BYTES;
    let cut = bytes.len().min(AI_SCOPE_FILE_MAX_BYTES);
    Ok(AiScopeFile {
        path: canonical,
        size: stat.size.max(bytes.len() as u64),
        content: String::from_utf8_lossy(&bytes[..cut]).into_owned(),
        truncated,
    })
}

/// 只读面：列目录（**仅 SSH 走 SFTP**；本地会话一律拒——见 [`LOCAL_READ_DENIED`]）。
///
/// 闸门顺序：锁定 → 作用域在册/未过期 → 运行时身份复核（被替换/移除即拒）
/// → 本地面关闭（kind=local 一律拒）→ 路径规则（远端：绝对 + 无 `..`）→ IO
/// （带超时与字节/条目上限）。
async fn list_dir_scope(
    state: &AppState,
    vault: &Vault,
    scope_id: &str,
    path: &str,
) -> Result<AiScopeListing, String> {
    if vault.is_locked() {
        return Err("AI read rejected: vault locked".into());
    }
    let entry = state.ai_scopes.valid(scope_id)?;
    verify_runtime(state, &entry, "read")?;
    match entry.target.kind {
        AiSessionKind::Ssh => {
            validate_remote_path(path)?;
            // 超时**包住开通道在内**的整段远端 IO：对端不回 SFTP 握手时
            // 绝不无限挂起（russh 通道无 Drop 收尾——超时后通道悬空也好过
            // 整个命令挂死）。
            let io = async {
                let sftp = scope_sftp(&entry).await?;
                sftp_list_dir(&sftp, path).await
            };
            let result = tokio::time::timeout(AI_SCOPE_IO_TIMEOUT, io)
                .await
                .map_err(|_| {
                    format!(
                        "AI read rejected: timed out after {}s",
                        AI_SCOPE_IO_TIMEOUT.as_secs()
                    )
                })?;
            recheck_scope(state, scope_id, &entry, "read")?;
            result
        }
        // 本地会话**不开放主机文件读取面**（A1 裁定）：一律拒，零 IO。
        AiSessionKind::Local => Err(LOCAL_READ_DENIED.to_string()),
    }
}

/// 只读面：读文件（**仅 SSH 走 SFTP**；本地会话一律拒——见 [`LOCAL_READ_DENIED`]）。
/// 路径规则与列目录同口径（绝对路径、无 `..` 段、canonical 终判落在只读根内）。
async fn read_file_scope(
    state: &AppState,
    vault: &Vault,
    scope_id: &str,
    path: &str,
) -> Result<AiScopeFile, String> {
    if vault.is_locked() {
        return Err("AI read rejected: vault locked".into());
    }
    let entry = state.ai_scopes.valid(scope_id)?;
    verify_runtime(state, &entry, "read")?;
    match entry.target.kind {
        AiSessionKind::Ssh => {
            validate_remote_path(path)?;
            // 超时**包住开通道在内**的整段远端 IO（见 list_dir_scope 同款裁定）。
            let io = async {
                let sftp = scope_sftp(&entry).await?;
                sftp_read_file(&sftp, path).await
            };
            let result = tokio::time::timeout(AI_SCOPE_IO_TIMEOUT, io)
                .await
                .map_err(|_| {
                    format!(
                        "AI read rejected: timed out after {}s",
                        AI_SCOPE_IO_TIMEOUT.as_secs()
                    )
                })?;
            recheck_scope(state, scope_id, &entry, "read")?;
            result
        }
        // 本地会话**不开放主机文件读取面**（A1 裁定）：一律拒，零 IO。
        AiSessionKind::Local => Err(LOCAL_READ_DENIED.to_string()),
    }
}

/// 计划步骤 id（确定性派生）：同一 actionId 恒得同一步 id——重放幂等（前端
/// 可直接用它去重计划清单，后端也据此判"这一步已登记"）。FNV-1a 64 位摘要。
fn plan_step_id(action_id: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in action_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("ai-step-{hash:016x}")
}

/// 计划步骤登记（**只登记不执行**）：满员拒绝新登记。
///
/// 同一 actionId 的重复登记在**进入本函数之前**已被 [`AiScopeRegistry::
/// claim_action`] 拦掉（一次性消费语义）；这里的「同 actionId 返同一步 id」
/// 只是第二道保险（登记簿自身保持幂等，绝不产生第二条计划条目）。
fn register_plan_step(
    entry: &AiScopeRegistryEntry,
    action_id: &str,
    command: &str,
) -> Result<String, String> {
    let mut plans = entry.plans.lock().unwrap();
    if let Some(existing) = plans.iter().find(|p| p.action_id == action_id) {
        return Ok(existing.step_id.clone());
    }
    if plans.len() >= AI_SCOPE_MAX_PLAN_STEPS {
        return Err(format!(
            "AI exec rejected: plan budget exhausted ({AI_SCOPE_MAX_PLAN_STEPS}): open a new scope"
        ));
    }
    let step_id = plan_step_id(action_id);
    plans.push(AiPlanStep {
        step_id: step_id.clone(),
        action_id: action_id.to_string(),
        command: command.to_string(),
    });
    Ok(step_id)
}

/// 执行面：按会话模式分派。
///
/// * `plan`（默认）：**只登记计划步骤**——绝不打开 exec 通道、绝不碰任何写端
///   （零执行、零副作用）；返回 `planned = true` + 步骤 id。
/// * `manual`：本步同样**只登记不执行**（真正执行是第二步的前端确认流）。
/// * `auto`：本步**直接拒**（主机授权表是第三步）——绝不"先跑起来"。
///
/// 闸门顺序（2026-11-04 修补 A2/A3）：
/// 1. 静态校验（坏命令不登记计划、不消耗任何预算）；
/// 2. 库锁定 → 拒；
/// 3. **作用域有效性**（在册 + 未过期）→ 拒——错误面先说作用域的问题，
///    不用「auto 未启用」盖住真实原因；
/// 4. **模式判定**（auto → 拒）；
/// 5. 本地会话无执行权 → 拒；运行时身份复核（被替换/移除 → 拒）；
/// 6. **一次性消费 actionId**（claim 面，与 insert 同款纪律）→ 同一 actionId
///    第二次调用即拒「already consumed」；
/// 7. 登记计划步骤（只登记不执行）。
///
/// 本地会话（kind=local）**一律不给执行权**（设计裁定：本地是用户自己的
/// 机器与交互 shell，AI 在其中自动跑命令的误操作代价最高）。
async fn exec_scope(
    state: &AppState,
    vault: &Vault,
    scope_id: &str,
    action_id: &str,
    command: &str,
    mode: AiExecMode,
) -> Result<AiScopeExecOutcome, String> {
    // 静态校验先行：坏命令不登记计划、不消耗任何预算。
    validate_single_line_text(command, "exec")?;
    validate_action_id(action_id)?;
    if vault.is_locked() {
        return Err("AI exec rejected: vault locked".into());
    }
    // 作用域有效性**先于**模式判定（错误面一致：作用域无效就说作用域无效）。
    let entry = state.ai_scopes.valid(scope_id)?;
    // 模式闸门在后端（前端传值只作提示）：auto 本步未启用 → 直接拒。
    let message = match mode {
        AiExecMode::Plan => "recorded in the plan; not executed (plan mode)",
        AiExecMode::Manual => "recorded for confirmation; not executed (manual mode)",
        AiExecMode::Auto => return Err("AI exec rejected: auto mode is not enabled yet".into()),
    };
    // 本地会话无执行权：只给只读上下文。
    if entry.target.kind == AiSessionKind::Local {
        return Err(
            "AI exec rejected: local terminal sessions never grant AI execution rights".into(),
        );
    }
    // 运行时身份复核（被替换/移除 → 拒；此时仍未产生任何副作用）。
    verify_runtime(state, &entry, "exec")?;
    // **一次性消费 actionId**（登记计划之前 claim）：同一 actionId 第二次调用
    // 即拒「already consumed」——重放窗口在登记前就关闭（与 insert 面同款
    // 纪律：claim 是 await 前的同步动作，重放并发也只放行一次）。
    state.ai_scopes.claim_action(&entry, action_id)?;
    // 只登记计划步骤：不开 exec 通道、不碰写端。
    let step_id = register_plan_step(&entry, action_id, command)?;
    Ok(AiScopeExecOutcome {
        executed: false,
        planned: true,
        step_id,
        message: message.to_string(),
    })
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

/// 只读：列目录（`ai_scope_list_dir(scopeId, path)`）——**仅 SSH 走 SFTP**；
/// 本地会话一律拒（不开放主机文件读取面）。作用域绑定 + 路径规则双闸（绝对
/// 路径、无 `..` 段、canonical 终判落在作用域只读根内）。
#[tauri::command]
pub(crate) async fn ai_scope_list_dir(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    scope_id: String,
    path: String,
) -> Result<AiScopeListing, String> {
    list_dir_scope(&state, &vault.0, &scope_id, &path).await
}

/// 只读：读文件（`ai_scope_read_file(scopeId, path)`）——**仅 SSH 走 SFTP**；
/// 本地会话一律拒（不开放主机文件读取面）。路径规则沿用 read_file 口径
/// （绝对路径、无 `..` 段、canonical 终判落在作用域只读根内），读取带超时
/// 与字节上限（超软上限截断 + `truncated` 标记）。
#[tauri::command]
pub(crate) async fn ai_scope_read_file(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    scope_id: String,
    path: String,
) -> Result<AiScopeFile, String> {
    read_file_scope(&state, &vault.0, &scope_id, &path).await
}

/// 执行类：按模式分派（`ai_scope_exec(scopeId, actionId, command, mode)`）。
///
/// * `plan`（默认）：**只登记计划步骤**（`planned = true` + 步骤 id）——绝不
///   打开 exec 通道、绝不写任何写端。
/// * `manual`：本步同样只登记（真执行是第二步）。
/// * `auto`：本步直接拒（"auto 尚未启用"，主机授权表在第三步）。
///
/// 本地会话（kind=local）一律拒——本地不给 AI 执行权。
#[tauri::command]
pub(crate) async fn ai_scope_exec(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    scope_id: String,
    action_id: String,
    command: String,
    mode: AiExecMode,
) -> Result<AiScopeExecOutcome, String> {
    exec_scope(&state, &vault.0, &scope_id, &action_id, &command, mode).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Write};
    use std::sync::atomic::AtomicUsize;
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

        /// 执行面直驱（按模式分派；plan 档只登记不执行）。
        async fn exec(
            &self,
            scope: &AiScope,
            action: &str,
            command: &str,
            mode: AiExecMode,
        ) -> Result<AiScopeExecOutcome, String> {
            exec_scope(
                &self.state,
                &self.vault,
                &scope.scope_id,
                action,
                command,
                mode,
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
            let channels = Arc::new(AtomicUsize::new(0));
            let server = tokio::spawn({
                let channels = Arc::clone(&channels);
                async move {
                    let (stream, _) = listener.accept().await.unwrap();
                    let handler = SshHandler {
                        bytes: sink,
                        channels,
                    };
                    let running = russh::server::run_stream(config, stream, handler)
                        .await
                        .unwrap();
                    let _ = running.await;
                }
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
                channels,
                server,
            }
        }
    }

    struct SshFixture {
        id: String,
        endpoint: String,
        bytes: Arc<Mutex<Vec<u8>>>,
        /// 服务端已开的 session 通道数（PTY 通道占 1；exec/SFTP 每开一条 +1）
        /// ——"plan 档零执行"的断言面：登记计划后该计数**不得**增长。
        channels: Arc<AtomicUsize>,
        server: tokio::task::JoinHandle<()>,
    }

    impl Drop for SshFixture {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    struct SshHandler {
        bytes: Arc<Mutex<Vec<u8>>>,
        channels: Arc<AtomicUsize>,
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
            self.channels.fetch_add(1, Ordering::SeqCst);
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

    // -----------------------------------------------------------------------
    // Ask Ottr 执行模式 · 第一步（Plan 档）：只读面 + 执行面
    // -----------------------------------------------------------------------

    /// plan 档 = **零执行**：不开 exec 通道、不写任何写端；只登记计划步骤。
    #[tokio::test]
    async fn plan_mode_exec_records_a_step_and_touches_nothing() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let channels_before = ssh.channels.load(Ordering::SeqCst);
        let outcome = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Plan)
            .await
            .unwrap();
        assert!(!outcome.executed, "plan 档绝不执行");
        assert!(outcome.planned, "plan 档只产计划");
        assert!(
            outcome.step_id.starts_with("ai-step-"),
            "{}",
            outcome.step_id
        );
        assert_eq!(
            ssh.channels.load(Ordering::SeqCst),
            channels_before,
            "plan 档绝不开新通道（exec/SFTP 通道数不得增长）"
        );
        assert!(ssh.bytes.lock().unwrap().is_empty(), "plan 档绝不写写端");
        // 重放同一 actionId → **拒**（actionId 是一次性消费的，见
        // exec_action_id_is_consumed_once）：重放窗口在登记计划前就关闭。
        let replay = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Plan)
            .await
            .unwrap_err();
        assert!(replay.contains("already consumed"), "{replay}");
    }

    /// actionId 是**一次性**的：同一 actionId 第二次调用即拒「already
    /// consumed」（A2 裁定：登记计划之前就消费——重放不可能产生第二条计划
    /// 步骤，也不可能在第二步真执行时被重放）。
    #[tokio::test]
    async fn exec_action_id_is_consumed_once() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let first = f
            .exec(&scope, "action-once", "whoami", AiExecMode::Plan)
            .await
            .unwrap();
        assert!(first.planned);
        // 同一 actionId 再来一次（哪怕命令不同）→ 拒
        let err = f
            .exec(&scope, "action-once", "id", AiExecMode::Plan)
            .await
            .unwrap_err();
        assert!(err.contains("already consumed"), "{err}");
        // 换档重放同样拒（消费是跨档的）
        let err = f
            .exec(&scope, "action-once", "whoami", AiExecMode::Manual)
            .await
            .unwrap_err();
        assert!(err.contains("already consumed"), "{err}");
        // 新 actionId 仍可登记（预算没被误伤）
        let second = f
            .exec(&scope, "action-two", "whoami", AiExecMode::Plan)
            .await
            .unwrap();
        assert_ne!(second.step_id, first.step_id);
        assert!(ssh.bytes.lock().unwrap().is_empty());
    }

    /// manual 档本步同样**只登记不执行**（真执行是第二步）。
    #[tokio::test]
    async fn manual_mode_also_only_records_the_step() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let channels_before = ssh.channels.load(Ordering::SeqCst);
        let outcome = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Manual)
            .await
            .unwrap();
        assert!(!outcome.executed);
        assert!(outcome.planned);
        assert!(!outcome.step_id.is_empty());
        assert_eq!(ssh.channels.load(Ordering::SeqCst), channels_before);
        assert!(ssh.bytes.lock().unwrap().is_empty());
    }

    /// auto 档本步直接拒（"auto 尚未启用"——主机授权表在第三步）。
    #[tokio::test]
    async fn auto_mode_is_rejected_before_anything_runs() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let channels_before = ssh.channels.load(Ordering::SeqCst);
        let err = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Auto)
            .await
            .unwrap_err();
        assert!(err.contains("auto"), "{err}");
        assert_eq!(ssh.channels.load(Ordering::SeqCst), channels_before);
        assert!(ssh.bytes.lock().unwrap().is_empty());
    }

    /// 错误面顺序（2026-11-04 修补 A3）：**作用域有效性先于模式判定**——
    /// 作用域无效就说作用域无效（不拿「auto 未启用」盖住真实原因）；作用域
    /// 有效才谈模式。
    #[tokio::test]
    async fn auto_mode_reports_scope_problems_before_mode_problems() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        // 不存在的 scope + auto → 报作用域无效（不报「auto 未启用」）
        let err = exec_scope(
            &f.state,
            &f.vault,
            "ai-scope-does-not-exist",
            "action-1",
            "whoami",
            AiExecMode::Auto,
        )
        .await
        .unwrap_err();
        assert!(err.contains("AI scope not found"), "{err}");
        assert!(!err.contains("auto"), "{err}");
        // 已撤销的 scope + auto → 同样报作用域无效
        f.state.ai_scopes.revoke(&scope.scope_id);
        let err = f
            .exec(&scope, "action-2", "whoami", AiExecMode::Auto)
            .await
            .unwrap_err();
        assert!(err.contains("AI scope not found"), "{err}");
        // 有效 scope + auto → 报 auto 未启用
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let err = f
            .exec(&scope, "action-3", "whoami", AiExecMode::Auto)
            .await
            .unwrap_err();
        assert!(err.contains("auto mode is not enabled yet"), "{err}");
    }

    /// 未知 mode 在反序列化面即被拒（后端不接受"未知 mode"）。
    #[test]
    fn unknown_exec_mode_never_reaches_the_command() {
        assert!(serde_json::from_value::<AiExecMode>(serde_json::json!("turbo")).is_err());
        assert!(serde_json::from_value::<AiExecMode>(serde_json::json!("")).is_err());
        for (mode, wire) in [
            (AiExecMode::Plan, "plan"),
            (AiExecMode::Auto, "auto"),
            (AiExecMode::Manual, "manual"),
        ] {
            assert_eq!(
                serde_json::to_value(mode).unwrap(),
                serde_json::json!(wire),
                "档位序列化面必须是前端约定的小写名"
            );
            assert_eq!(
                serde_json::from_value::<AiExecMode>(serde_json::json!(wire)).unwrap(),
                mode
            );
        }
    }

    /// 命令静态校验四类拒：空 / 多行 / 控制字符 / 超长（plan 档也要校验——
    /// 它会进计划清单）。
    #[tokio::test]
    async fn exec_rejects_empty_multiline_control_and_oversized_commands() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let bad = [
            String::new(),
            "whoami\nid".to_string(),
            "whoami\rid".to_string(),
            "a\tb".to_string(),
            "a\0b".to_string(),
            "\u{1b}[31mwhoami".to_string(),
            "a\u{2028}b".to_string(),
            "x".repeat(INSERT_MAX_BYTES + 1),
        ];
        for (i, command) in bad.iter().enumerate() {
            let err = f
                .exec(&scope, &format!("bad-{i}"), command, AiExecMode::Plan)
                .await
                .unwrap_err();
            assert!(err.starts_with("AI exec rejected"), "{err}");
        }
        // 空 actionId 同样拒（它是幂等键）。
        assert!(
            f.exec(&scope, "", "whoami", AiExecMode::Plan)
                .await
                .is_err()
        );
        assert!(ssh.bytes.lock().unwrap().is_empty());
    }

    /// 作用域撤销 / 过期 / 被替换 → 一律拒（零副作用）。
    #[tokio::test]
    async fn exec_rejects_revoked_expired_and_replaced_scopes() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        // 撤销
        f.state.ai_scopes.revoke(&scope.scope_id);
        assert!(
            f.exec(&scope, "revoked", "whoami", AiExecMode::Plan)
                .await
                .is_err()
        );
        // 被替换（同 rustId、换 runtime_id）
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let replacement = f.ssh(Some(42), "user").await;
        let old = {
            let mut sessions = f.state.sessions.lock().unwrap();
            let mut new = sessions.remove(&replacement.id).unwrap();
            new.writer = Arc::clone(&sessions[&ssh.id].writer);
            sessions.insert(ssh.id.clone(), new).unwrap()
        };
        assert!(
            f.exec(&scope, "replaced", "whoami", AiExecMode::Plan)
                .await
                .is_err()
        );
        old.cancel.notify_one();
        // 过期（TTL=0：登记即过期）
        let mut f = Fixture::new();
        Arc::get_mut(&mut f.state).unwrap().ai_scopes = Arc::new(AiScopeRegistry {
            ttl: Duration::ZERO,
            ..Default::default()
        });
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        assert!(
            f.exec(&scope, "expired", "whoami", AiExecMode::Plan)
                .await
                .is_err()
        );
        assert!(ssh.bytes.lock().unwrap().is_empty());
    }

    /// 库锁定 → 拒（执行面与只读面同款）。
    #[tokio::test]
    async fn locked_vault_rejects_exec_and_reads() {
        let f = Fixture::password();
        f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        f.vault.lock();
        assert!(
            f.exec(&scope, "locked", "pwd", AiExecMode::Plan)
                .await
                .is_err()
        );
        assert!(
            read_file_scope(&f.state, &f.vault, &scope.scope_id, "/etc/hosts")
                .await
                .is_err()
        );
        assert!(
            list_dir_scope(&f.state, &f.vault, &scope.scope_id, "/etc")
                .await
                .is_err()
        );
    }

    /// 本地会话**不给执行权**：plan 档同样拒（连登记都不登记）。
    #[tokio::test]
    async fn local_sessions_never_grant_execution_rights() {
        let f = Fixture::new();
        let bytes = f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        for mode in [AiExecMode::Plan, AiExecMode::Manual, AiExecMode::Auto] {
            let err = f.exec(&scope, "local", "pwd", mode).await.unwrap_err();
            assert!(err.starts_with("AI exec rejected"), "{err}");
        }
        assert!(bytes.lock().unwrap().is_empty());
    }

    /// 本地会话**不开放主机文件读取面**（2026-11-04 修补 A1）：读文件 / 列
    /// 目录一律拒，且**零文件读取副作用**（内容一个字节都不回）。
    ///
    /// 为什么必须关：本地只读根曾被实现自选为「Ottr 进程用户的整个 HOME」，
    /// 等于把 `~/.ssh`、`~/.aws`、`~/.kube/config`、`~/.gnupg` 默认交给外部
    /// 模型，而脱敏层覆盖不到那些形态（client-key-data / PGP 私钥块）。
    #[tokio::test]
    async fn local_sessions_never_expose_host_file_reads() {
        let f = Fixture::new();
        f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        // 造一份「就在本机、路径合法、内容敏感」的文件——它必须读不出来。
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("secret.txt"), b"top-secret-token").unwrap();
        let file_path = root.path().join("secret.txt").to_str().unwrap().to_string();
        let dir_path = root.path().to_str().unwrap().to_string();

        let err = read_file_scope(&f.state, &f.vault, &scope.scope_id, &file_path)
            .await
            .unwrap_err();
        assert!(err.contains("local terminal sessions"), "{err}");
        assert!(!err.contains("top-secret-token"), "{err}");
        let err = list_dir_scope(&f.state, &f.vault, &scope.scope_id, &dir_path)
            .await
            .unwrap_err();
        assert!(err.contains("local terminal sessions"), "{err}");
        assert!(!err.contains("secret.txt"), "{err}");
        // 零读取副作用：文件内容与条目名都没进过返回值（上面两处断言已覆盖
        // 「回包不含内容」；这里再钉一次「拒绝发生在任何 IO 之前」——路径
        // 合法也照样拒，说明不是路径规则挡下的）。
        assert!(LOCAL_READ_DENIED.contains("local terminal sessions"));
    }

    /// 远端路径规则（静态面先于任何 IO）：相对路径 / `..` 段 / NUL 一律拒。
    #[tokio::test]
    async fn remote_path_rules_reject_relative_dotdot_and_nul() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        for path in ["relative/path", "/var/../etc/passwd", "a\0b", ""] {
            let err = read_file_scope(&f.state, &f.vault, &scope.scope_id, path)
                .await
                .unwrap_err();
            assert!(err.starts_with("AI read rejected"), "{err}");
            let err = list_dir_scope(&f.state, &f.vault, &scope.scope_id, path)
                .await
                .unwrap_err();
            assert!(err.starts_with("AI read rejected"), "{err}");
        }
    }

    /// 目录边界精确到路径段（`/tmp2` 不匹配 `/tmp`；根目录特判）。
    #[test]
    fn scope_root_matching_is_segment_exact() {
        assert!(path_within("/tmp/a", "/tmp"));
        assert!(path_within("/tmp", "/tmp"));
        assert!(!path_within("/tmp2/a", "/tmp"));
        assert!(path_within("/anything", "/"));
        assert!(!path_within("relative", "/"));
    }

    /// 载荷序列化面：camelCase 字段名（前端消费面的契约）。
    #[test]
    fn read_and_exec_payloads_use_camel_case_fields() {
        let listing = AiScopeListing {
            path: "/tmp".into(),
            entries: vec![AiScopeEntry {
                name: "a".into(),
                is_dir: false,
                size: 3,
            }],
        };
        let json = serde_json::to_value(&listing).unwrap();
        assert_eq!(json["path"], "/tmp");
        assert_eq!(json["entries"][0]["name"], "a");
        assert_eq!(json["entries"][0]["isDir"], false);
        assert_eq!(json["entries"][0]["size"], 3);

        let file = AiScopeFile {
            path: "/tmp/a".into(),
            size: 3,
            content: "abc".into(),
            truncated: false,
        };
        let json = serde_json::to_value(&file).unwrap();
        assert_eq!(json["path"], "/tmp/a");
        assert_eq!(json["size"], 3);
        assert_eq!(json["content"], "abc");
        assert_eq!(json["truncated"], false);

        let outcome = AiScopeExecOutcome {
            executed: false,
            planned: true,
            step_id: "ai-step-x".into(),
            message: "m".into(),
        };
        let json = serde_json::to_value(&outcome).unwrap();
        assert_eq!(json["executed"], false);
        assert_eq!(json["planned"], true);
        assert_eq!(json["stepId"], "ai-step-x");
        assert_eq!(json["message"], "m");
    }
}
